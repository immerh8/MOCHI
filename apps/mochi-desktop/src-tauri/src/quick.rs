//! The shell's quick verbs (plan D6, owner decision 2026-10-16): "Extract
//! here", "Extract to new folder", and "Add to archive" run at once in a small
//! compact window, not in the full browser.
//!
//! # Rules
//!
//! * **Paths stay in Rust.** The compact window hears [`QuickEvent`]s (names,
//!   counts, a progress phase) and sends back a passphrase, a cancel, "show in
//!   folder", and "close". It never receives or sends a path; the folder
//!   "Show in folder" opens is the one Rust remembers.
//! * **Nothing is overwritten, and nothing is written into a name that
//!   exists.** The extract engine never replaces a file; before it starts,
//!   the whole snapshot is looked at first, and if anything would
//!   collide with a name already there nothing is written and the same
//!   archive is handed to the main window's extract plan
//!   ([`MainPort::hand_over_extract`]), which is the screen where the user
//!   decides. "Extract to new folder" never reuses a folder: it makes
//!   `<name>`, `<name> (2)`, … with `create_dir`, which fails if the name
//!   exists. "Add to archive" never replaces a file: it picks `<name>.mochi`,
//!   `<name> (2).mochi`, … and creation itself refuses an existing name
//!   (`DESTINATION_EXISTS`), so a file that appears in between is not
//!   replaced either.
//! * **The default profile and preset only** for "Add to archive" (`--add-now`):
//!   Core profile (not TAR compatible, not encrypted, no recovery record),
//!   Balanced compression. Choosing anything else is "Add to archive…"
//!   (`--add`), which opens the form below in this same window.
//! * **The Add form (owner decision 2026-10-20, plan O31).** `--add` opens
//!   a small WinRAR-style form here instead of the main window's add panel: a
//!   name, Browse… (a save dialog shown from Rust), the format (`.mochi`, ZIP,
//!   tar, tar.gz, tar.zst), the compression level, and, for `.mochi` only,
//!   encryption and a recovery record. The folder is the one Rust chose (next
//!   to the first item) or the one the dialog returned; the webview sends a
//!   plain file name and never a path. Launches that arrive while the form is
//!   open join it (their items are added to the same archive); the form waits
//!   for OK or Cancel, and closing the window cancels it. An existing file is
//!   never replaced: the form refuses the name and asks for another.
//! * **No secret on a command line.** An Encrypted archive asks for its
//!   passphrase in the compact window; it crosses IPC once, into a zeroizing
//!   [`Secret`], and a wrong one asks again (`KEY_UNAVAILABLE`).
//! * **Honest results (spec §23.3).** A new archive is a `LOCAL_COMMITTED`
//!   commit on this computer, and the result says no more. An extraction is
//!   not a verification. A cancelled extraction leaves the files already
//!   written, each complete; a cancelled creation leaves no archive.
//!
//! One job runs at a time, in arrival order, on its own worker thread
//! (`launch.rs`), so a long extraction never blocks the shell's other verbs.

use std::collections::VecDeque;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use mochi_core::job::{CancellationToken, JobContext, ProgressEvent, ProgressSink};
use mochi_core::keys::KeySession;
use mochi_core::publish::ReadOptions;
use mochi_core::restore::{preflight_selected, ExceptionKind};
use mochi_core::storage::os::OsRestoreDir;
use mochi_core::{ErrorCode, MochiError, Result};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::browse::{head_encrypted, Archives};
use crate::extract::{self, Destination};
use crate::ipc::{
    ArchiveFormat, ArchiveSummary, CompressionPreset, ConflictChoice, IpcError, JobRequest,
    NameText, Secret,
};
use crate::write::{JobDone, Services, Staging};

/// Events kept for a window that is not listening yet.
const MAX_PENDING: usize = 64;

/// Names tried before giving up (`name`, `name (2)`, …).
const MAX_NAME_TRIES: u32 = 1000;

/// What a quick job does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum QuickAction {
    ExtractHere,
    ExtractToFolder,
    Add,
}

/// What the compact window is told.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "event", rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum QuickEvent {
    /// A job began. `subject` is the archive (extract) or the first item
    /// (add); `items` is how many items an add carries.
    Started {
        action: QuickAction,
        subject: NameText,
        items: u32,
    },
    /// The archive is Encrypted: ask for its passphrase. `wrong` after a
    /// passphrase that did not open it.
    NeedPassphrase {
        wrong: bool,
    },
    /// "Add to archive…": show the form. `items` and `subject` describe what
    /// was chosen (sent again, changed, when another launch joins the form);
    /// `name`, `folder` and `format` are the form's starting values.
    AddPrompt {
        items: u32,
        subject: NameText,
        /// The suggested file name, with its extension.
        name: String,
        /// The folder the archive will be made in, as display text.
        folder: NameText,
        format: ArchiveFormat,
    },
    Progress {
        phase: String,
        #[ts(type = "number")]
        completed: u64,
        #[ts(type = "number | null")]
        total: Option<u64>,
    },
    /// Something in the way: nothing was written, and the extract plan for
    /// the same archive is open in the main window.
    Fallback {
        #[ts(type = "number")]
        conflicts: u64,
        destination: NameText,
    },
    /// The job did what it was asked. Not a verification.
    Done {
        action: QuickAction,
        /// The new archive, or the folder extracted into.
        name: NameText,
        /// Its full path, as display text.
        location: NameText,
        #[ts(type = "number")]
        files: u64,
        #[ts(type = "number")]
        directories: u64,
        #[ts(type = "number")]
        bytes: u64,
        /// Entries (extract) or items (add) that were not stored.
        #[ts(type = "number")]
        skipped: u64,
        /// The first reason, as text.
        note: Option<String>,
        /// `LOCAL_COMMITTED` for a new archive; `null` for an extraction.
        status: Option<String>,
        /// The directory entry is not confirmed durable (degraded).
        durability_note: Option<String>,
        /// What a new archive was written as (`mochi` for an extraction, which
        /// has no archive format of its own). Not `mochi` means a plain ZIP or
        /// tar file (plan O31): `status` is then `null` and nothing here is a
        /// commit or a verification.
        format: ArchiveFormat,
        /// The size of the file written; `0` for an extraction.
        #[ts(type = "number")]
        output_bytes: u64,
    },
    Cancelled {
        action: QuickAction,
    },
    Failed {
        code: String,
        message: String,
    },
    /// The job unwound without a result.
    Aborted {
        message: String,
    },
}

/// Where quick events go (a Tauri `Channel` in the app).
pub trait QuickSink: Send + Sync + 'static {
    /// `false` once nobody listens.
    fn send(&self, event: QuickEvent) -> bool;
}

/// The windows and the file manager, so that this module is tested without
/// a display. Called from worker threads only (never the event loop).
pub trait WindowHost: Send + Sync + 'static {
    /// Show the compact window (create it if it is not open) at `size`.
    fn show_quick(&self, size: QuickSize);
    /// Close the compact window.
    fn close_quick(&self);
    /// Show the main window (create it if it is not open): the launch needs
    /// the full window.
    fn show_main(&self);
    /// Open a folder in the file manager.
    fn open_folder(&self, folder: &Path) -> std::io::Result<()>;
    /// Make the archive window `label` (a new window, placed down and to the
    /// right of `opener`) and show it. `false` if it could not be made.
    fn create_window(&self, _label: &str, _opener: Option<&str>) -> bool {
        false
    }
    /// Bring the archive window `label` forward. `false` if there is none.
    fn focus_window(&self, _label: &str) -> bool {
        false
    }
    /// Set the title of the window `label` (plain text).
    fn set_title(&self, _label: &str, _title: &str) {}
}

/// How big the compact window is: a job's progress and result, or the form.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuickSize {
    Compact,
    Form,
}

/// What a quick job needs from the main window's side.
pub trait MainPort {
    fn archives(&self) -> &Archives;
    /// Show the extract plan for the open `archive` into `folder` in the main
    /// window (nothing is written until the user confirms there).
    fn hand_over_extract(&self, archive: ArchiveSummary, folder: PathBuf);
}

/// A unit of work for the quick worker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuickJob {
    Extract {
        action: QuickAction,
        path: PathBuf,
    },
    /// `--add-now`: a new `.mochi` archive at once, next to the items.
    Add {
        paths: Vec<PathBuf>,
    },
    /// `--add`: the form first, then the archive it describes.
    AddDialog {
        paths: Vec<PathBuf>,
    },
}

/// What the form's OK sends (the webview names no path: `name` is one file
/// name, and the folder is the one Rust holds).
#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct QuickAddRequest {
    pub name: String,
    pub format: ArchiveFormat,
    /// The compression level; ignored for plain `.tar`.
    pub level: CompressionPreset,
    /// Only for `.mochi`: crosses IPC once, into a zeroizing type.
    #[serde(default)]
    #[ts(optional)]
    pub passphrase: Option<Secret>,
    /// Only for `.mochi`: a recovery record of this many percent (1 to 100).
    #[serde(default)]
    #[ts(optional)]
    pub recovery_percent: Option<u16>,
}

/// Where the form's Browse… put the archive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct QuickLocation {
    /// The folder, as display text.
    pub folder: NameText,
    /// The file name, with the chosen format's extension.
    pub name: String,
}

/// The form while it waits: what was chosen and where the archive goes.
struct Prompt {
    paths: Vec<PathBuf>,
    dir: PathBuf,
    /// The worker waits on the other end; `None` means cancelled.
    tx: Sender<Option<Submit>>,
}

/// What OK hands the worker.
struct Submit {
    paths: Vec<PathBuf>,
    target: PathBuf,
    request: QuickAddRequest,
}

#[derive(Default)]
struct Delivery {
    sink: Option<Arc<dyn QuickSink>>,
    pending: VecDeque<QuickEvent>,
}

#[derive(Default)]
struct Control {
    cancel: Option<CancellationToken>,
    /// Set while a passphrase is awaited; `None` sent means cancelled.
    passphrase: Option<Sender<Option<Secret>>>,
    /// Set while the Add form waits for OK.
    prompt: Option<Prompt>,
    /// What "Show in folder" opens.
    folder: Option<PathBuf>,
}

/// The compact window's state: its event stream and the running job.
#[derive(Default)]
pub struct Quick {
    host: OnceLock<Arc<dyn WindowHost>>,
    delivery: Mutex<Delivery>,
    control: Mutex<Control>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // Only queues, handles, and a path live behind these locks.
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn invalid(what: impl Into<String>) -> MochiError {
    MochiError::new(ErrorCode::InvalidArgument, what)
}

fn path_text(path: &Path) -> NameText {
    let shown = crate::help::for_shell(path);
    local_path_text(&shown.to_string_lossy(), cfg!(windows))
}

/// A local path as display text. A backslash in a Windows path is the separator, not a name
/// character: escaping it as `\\` would show `C:\\Users\\...`. There, each component is escaped
/// and the separators are kept.
fn local_path_text(text: &str, windows: bool) -> NameText {
    if !windows {
        return NameText::of(text.as_bytes());
    }
    let parts: Vec<NameText> = text
        .split('\\')
        .map(|p| NameText::of(p.as_bytes()))
        .collect();
    NameText {
        text: parts
            .iter()
            .map(|p| p.text.as_str())
            .collect::<Vec<_>>()
            .join("\\"),
        verbatim: parts.iter().all(|p| p.verbatim),
    }
}

fn file_name_text(path: &Path) -> NameText {
    let name = path.file_name().unwrap_or(path.as_os_str());
    NameText::of(name.to_string_lossy().as_bytes())
}

/// `<stem><ext>` for attempt 1, then `<stem> (2)<ext>`, `<stem> (3)<ext>`, …
fn candidate(stem: &str, ext: &str, attempt: u32) -> String {
    if attempt <= 1 {
        format!("{stem}{ext}")
    } else {
        format!("{stem} ({attempt}){ext}")
    }
}

/// The first of the candidates that `taken` does not claim.
pub fn unique_name(stem: &str, ext: &str, taken: &dyn Fn(&str) -> bool) -> Option<String> {
    (1..=MAX_NAME_TRIES)
        .map(|n| candidate(stem, ext, n))
        .find(|name| !taken(name))
}

/// Anything but "certainly not there" counts as taken.
fn exists(path: &Path) -> bool {
    !matches!(std::fs::symlink_metadata(path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
}

/// A new folder `<stem>`, `<stem> (2)`, … in `parent`. `create_dir` fails if
/// the name exists, so an existing folder or file is never reused.
fn create_unique_dir(parent: &Path, stem: &str) -> Result<PathBuf> {
    for attempt in 1..=MAX_NAME_TRIES {
        let folder = parent.join(candidate(stem, "", attempt));
        match std::fs::create_dir(&folder) {
            Ok(()) => return Ok(folder),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => {
                return Err(MochiError::new(
                    ErrorCode::IoError,
                    format!("the folder {} could not be created: {e}", folder.display()),
                ))
            }
        }
    }
    Err(invalid(format!(
        "no free folder name for {stem} in {}",
        parent.display()
    )))
}

/// Where a new archive for `paths` goes and what it is called: next to the
/// item (named for it) or, for several, in their folder (named for it).
pub fn add_target(paths: &[PathBuf]) -> Result<(PathBuf, String)> {
    let first = paths.first().ok_or_else(|| invalid("nothing to add"))?;
    let dir = first
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| {
            invalid(format!(
                "{} has no folder to put the archive in",
                first.display()
            ))
        })?;
    let stem = if paths.len() == 1 {
        let name = if std::fs::metadata(first).is_ok_and(|m| m.is_dir()) {
            first.file_name()
        } else {
            first.file_stem()
        };
        name.map(|n| n.to_string_lossy().into_owned())
    } else {
        dir.file_name().map(|n| n.to_string_lossy().into_owned())
    };
    let stem = stem
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "archive".to_owned());
    Ok((dir.to_path_buf(), stem))
}

/// Forwards `mochi-core` progress to the window.
struct Forward<'a>(&'a Quick);

impl ProgressSink for Forward<'_> {
    fn report(&self, event: &ProgressEvent) {
        self.0.emit(QuickEvent::Progress {
            phase: event.phase.to_owned(),
            completed: event.completed,
            total: event.total,
        });
    }
}

impl Quick {
    pub fn new() -> Arc<Quick> {
        Arc::new(Quick::default())
    }

    /// Give it the windows (once, at start-up).
    pub fn set_host(&self, host: Arc<dyn WindowHost>) {
        let _ = self.host.set(host);
    }

    pub fn host(&self) -> Option<Arc<dyn WindowHost>> {
        self.host.get().cloned()
    }

    fn emit(&self, event: QuickEvent) {
        let mut d = lock(&self.delivery);
        if matches!(
            event,
            QuickEvent::Started { .. } | QuickEvent::AddPrompt { .. }
        ) {
            // A new job (or a changed form): what an earlier window never heard
            // is obsolete.
            d.pending.clear();
        }
        if let Some(sink) = d.sink.clone() {
            if sink.send(event.clone()) {
                return;
            }
            d.sink = None;
        }
        // A job that ended as cancelled with nobody to tell (the window was
        // closed, which is what cancels it) leaves nothing to replay to the
        // next window.
        if matches!(event, QuickEvent::Cancelled { .. }) {
            return;
        }
        let progress = matches!(event, QuickEvent::Progress { .. });
        if progress && matches!(d.pending.back(), Some(QuickEvent::Progress { .. })) {
            d.pending.pop_back();
        }
        if d.pending.len() >= MAX_PENDING {
            d.pending.pop_front();
        }
        d.pending.push_back(event);
    }

    /// Listen with `sink` and hand it what arrived before there was one.
    pub fn watch(&self, sink: Arc<dyn QuickSink>) {
        let mut d = lock(&self.delivery);
        while let Some(event) = d.pending.pop_front() {
            if !sink.send(event.clone()) {
                d.pending.push_front(event);
                return;
            }
        }
        d.sink = Some(sink);
    }

    /// The passphrase the window asked for. It goes straight to the waiting
    /// job; nothing keeps it.
    pub fn passphrase(&self, secret: Secret) -> Result<()> {
        let tx = lock(&self.control)
            .passphrase
            .take()
            .ok_or_else(|| invalid("no archive is waiting for a passphrase"))?;
        tx.send(Some(secret))
            .map_err(|_| invalid("the archive is no longer waiting for a passphrase"))
    }

    /// Stop the running job (also ends a wait for a passphrase).
    pub fn cancel(&self) {
        let mut c = lock(&self.control);
        if let Some(token) = &c.cancel {
            token.cancel();
        }
        if let Some(tx) = c.passphrase.take() {
            let _ = tx.send(None);
        }
        if let Some(prompt) = c.prompt.take() {
            let _ = prompt.tx.send(None);
        }
    }

    /// Pause (`true`) or resume the running job; `false` if none is running.
    /// It waits at its next safe point; cancelling still ends it.
    pub fn set_paused(&self, paused: bool) -> bool {
        match &lock(&self.control).cancel {
            Some(token) if paused => {
                token.pause();
                true
            }
            Some(token) => {
                token.resume();
                true
            }
            None => false,
        }
    }

    /// The compact window went away: cancel and forget it.
    pub fn closed(&self) {
        self.cancel();
        let mut d = lock(&self.delivery);
        d.sink = None;
        d.pending.clear();
    }

    /// Open the folder the last job wrote into.
    pub fn show_folder(&self) -> Result<()> {
        let folder = lock(&self.control)
            .folder
            .clone()
            .ok_or_else(|| invalid("there is no folder to show"))?;
        let host = self
            .host()
            .ok_or_else(|| invalid("the file manager is not available"))?;
        host.open_folder(&crate::help::for_shell(&folder))
            .map_err(|e| {
                MochiError::new(
                    ErrorCode::IoError,
                    format!("the folder could not be opened: {e}"),
                )
            })
    }

    /// Ask the window for a passphrase. `None` when the job was cancelled
    /// (or the window went away) first.
    fn ask_passphrase(&self, wrong: bool, token: &CancellationToken) -> Option<Secret> {
        let (tx, rx) = channel();
        lock(&self.control).passphrase = Some(tx);
        if token.check().is_err() {
            lock(&self.control).passphrase = None;
            return None;
        }
        self.emit(QuickEvent::NeedPassphrase { wrong });
        rx.recv().ok().flatten()
    }

    /// Show the compact window and tell it a job began.
    fn begin(&self, action: QuickAction, subject: NameText, items: u32) {
        if let Some(host) = self.host() {
            host.show_quick(QuickSize::Compact);
        }
        self.emit(QuickEvent::Started {
            action,
            subject,
            items,
        });
    }

    fn begin_add(&self, paths: &[PathBuf]) {
        self.begin(
            QuickAction::Add,
            paths
                .first()
                .map(|p| file_name_text(p))
                .unwrap_or_else(|| NameText::of(b"")),
            u32::try_from(paths.len()).unwrap_or(u32::MAX),
        );
    }

    /// Run one job to its end, reporting to the window. Never panics: an
    /// unwind becomes a `Failed` event, so the worker survives.
    pub fn run(&self, job: &QuickJob, main: &dyn MainPort) {
        let token = CancellationToken::new();
        {
            let mut c = lock(&self.control);
            c.cancel = Some(token.clone());
            c.passphrase = None;
            c.prompt = None;
            c.folder = None;
        }
        let action = match job {
            QuickJob::Extract { action, .. } => *action,
            QuickJob::Add { .. } | QuickJob::AddDialog { .. } => QuickAction::Add,
        };
        let outcome = catch_unwind(AssertUnwindSafe(|| match job {
            QuickJob::Extract { action, path } => {
                self.begin(*action, file_name_text(path), 1);
                self.extract(main, *action, path, &token)
            }
            QuickJob::Add { paths } => {
                self.begin_add(paths);
                self.add(paths, &token)
            }
            QuickJob::AddDialog { paths } => match self.prompt(paths) {
                Ok(Some(submit)) => {
                    self.begin_add(&submit.paths);
                    self.add_chosen(submit, &token)
                }
                Ok(None) => Ok(QuickEvent::Cancelled { action }),
                Err(e) => {
                    self.begin_add(paths);
                    Err(e)
                }
            },
        }));
        let event = match outcome {
            Ok(Ok(event)) => event,
            Ok(Err(e)) if e.code == ErrorCode::Cancelled => QuickEvent::Cancelled { action },
            Ok(Err(e)) => QuickEvent::Failed {
                code: e.code.as_str().to_owned(),
                message: e.message,
            },
            Err(_) => QuickEvent::Aborted {
                message: "the job stopped unexpectedly without a result".to_owned(),
            },
        };
        {
            let mut c = lock(&self.control);
            c.cancel = None;
            c.prompt = None;
        }
        self.emit(event);
    }

    // ---- the Add form (`--add`) ------------------------------------------------

    /// The event that describes the form for `prompt`.
    fn prompt_event(paths: &[PathBuf], dir: &Path, name: String) -> QuickEvent {
        QuickEvent::AddPrompt {
            items: u32::try_from(paths.len()).unwrap_or(u32::MAX),
            subject: paths
                .first()
                .map(|p| file_name_text(p))
                .unwrap_or_else(|| NameText::of(b"")),
            name,
            folder: path_text(dir),
            format: ArchiveFormat::Mochi,
        }
    }

    /// Show the form and wait for OK. `None` when the user cancelled or closed
    /// the window. The items are looked at first, so a form is never shown for
    /// nothing.
    fn prompt(&self, paths: &[PathBuf]) -> Result<Option<Submit>> {
        let staged = Staging::default().add(paths);
        if staged.staged.items.is_empty() {
            return Err(invalid(
                staged
                    .problems
                    .first()
                    .map(|p| p.message.clone())
                    .unwrap_or_else(|| "nothing to add".to_owned()),
            ));
        }
        let (dir, stem) = add_target(paths)?;
        // The same naming rule as `--add-now`: next to the items, never a name
        // that exists.
        let name = unique_name(&stem, ArchiveFormat::Mochi.extension(), &|n| {
            exists(&dir.join(n))
        })
        .ok_or_else(|| {
            invalid(format!(
                "no free archive name for {stem} in {}",
                dir.display()
            ))
        })?;
        let (tx, rx) = channel();
        let event = Self::prompt_event(paths, &dir, name);
        lock(&self.control).prompt = Some(Prompt {
            paths: paths.to_vec(),
            dir,
            tx,
        });
        if let Some(host) = self.host() {
            host.show_quick(QuickSize::Form);
        }
        self.emit(event);
        Ok(rx.recv().ok().flatten())
    }

    /// Another launch arrived while the form is open: its items join the
    /// archive being named. `false` when no form is open (the caller queues a
    /// form of its own).
    pub fn extend_prompt(&self, more: &[PathBuf]) -> bool {
        let event = {
            let mut c = lock(&self.control);
            let Some(prompt) = c.prompt.as_mut() else {
                return false;
            };
            for p in more {
                if !prompt.paths.contains(p) {
                    prompt.paths.push(p.clone());
                }
            }
            // The name and folder in the event are only starting values; the
            // window keeps what the user typed.
            Self::prompt_event(&prompt.paths, &prompt.dir, String::new())
        };
        self.emit(event);
        true
    }

    /// The suggested place for Browse…: the form's folder and a name in the
    /// format asked for.
    pub fn suggested_location(&self, name: &str, format: ArchiveFormat) -> Result<PathBuf> {
        let c = lock(&self.control);
        let prompt = c
            .prompt
            .as_ref()
            .ok_or_else(|| invalid("no archive is waiting to be named"))?;
        let typed = crate::formats::check_archive_name(name).unwrap_or("archive");
        Ok(prompt.dir.join(format.name_for(typed)))
    }

    /// The user chose `path` with Browse…: the archive goes in its folder, and
    /// the window is told the folder and the name.
    pub fn set_location(&self, path: &Path, format: ArchiveFormat) -> Result<QuickLocation> {
        let path = format.path_for(path);
        let dir = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .ok_or_else(|| invalid("that place has no folder"))?
            .to_path_buf();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| invalid("that place has no file name"))?;
        let mut c = lock(&self.control);
        let prompt = c
            .prompt
            .as_mut()
            .ok_or_else(|| invalid("no archive is waiting to be named"))?;
        let folder = path_text(&dir);
        prompt.dir = dir;
        Ok(QuickLocation { folder, name })
    }

    /// OK on the form. The request is checked here, in Rust, and refused with a
    /// reason the window shows (the form stays open); only a request that can
    /// be carried out reaches the worker. Nothing is written yet.
    pub fn submit_add(&self, request: QuickAddRequest) -> Result<()> {
        let typed = crate::formats::check_archive_name(&request.name).map_err(invalid)?;
        let file_name = request.format.name_for(typed);
        if request.format != ArchiveFormat::Mochi
            && (request.passphrase.is_some() || request.recovery_percent.is_some())
        {
            return Err(MochiError::new(
                ErrorCode::UnsupportedFeature,
                "encryption and a recovery record are for .mochi archives only; ZIP and tar \
                 files are written without them",
            ));
        }
        if let Some(secret) = &request.passphrase {
            // The error never contains the passphrase.
            secret.passphrase()?;
        }
        if let Some(p) = request.recovery_percent {
            if !(1..=100).contains(&p) {
                return Err(invalid("a recovery record takes 1 to 100 percent"));
            }
        }
        let mut c = lock(&self.control);
        let dir = c
            .prompt
            .as_ref()
            .map(|p| p.dir.clone())
            .ok_or_else(|| invalid("no archive is waiting to be named"))?;
        let target = dir.join(&file_name);
        if exists(&target) {
            return Err(MochiError::new(
                ErrorCode::DestinationExists,
                format!(
                    "{file_name} already exists in that folder. Choose another name; MOCHI does \
                     not replace files."
                ),
            ));
        }
        let Some(prompt) = c.prompt.take() else {
            return Err(invalid("no archive is waiting to be named"));
        };
        prompt
            .tx
            .send(Some(Submit {
                paths: prompt.paths,
                target,
                request,
            }))
            .map_err(|_| invalid("the form is no longer waiting"))
    }

    /// Open the archive, asking for a passphrase if it is Encrypted.
    /// `None` when the user cancelled that.
    fn open_archive(
        &self,
        main: &dyn MainPort,
        path: &Path,
        token: &CancellationToken,
    ) -> Result<Option<ArchiveSummary>> {
        match std::fs::metadata(path) {
            Ok(m) if m.is_file() => {}
            Ok(_) => return Err(invalid(format!("{} is not a file", path.display()))),
            Err(e) => {
                return Err(MochiError::new(
                    ErrorCode::IoError,
                    format!("{} cannot be read: {e}", path.display()),
                ))
            }
        }
        let archives = main.archives();
        if !head_encrypted(path) {
            return archives.open(path, ReadOptions::default()).map(Some);
        }
        let mut wrong = false;
        loop {
            let Some(secret) = self.ask_passphrase(wrong, token) else {
                return Ok(None);
            };
            let Ok(passphrase) = secret.passphrase() else {
                wrong = true;
                continue;
            };
            let read = ReadOptions {
                keys: Some(KeySession::single(passphrase)),
                ..ReadOptions::default()
            };
            match archives.open(path, read) {
                Ok(summary) => return Ok(Some(summary)),
                Err(e) if e.code == ErrorCode::KeyUnavailable => wrong = true,
                Err(e) => return Err(e),
            }
        }
    }

    fn extract(
        &self,
        main: &dyn MainPort,
        action: QuickAction,
        path: &Path,
        token: &CancellationToken,
    ) -> Result<QuickEvent> {
        let Some(summary) = self.open_archive(main, path, token)? else {
            return Ok(QuickEvent::Cancelled { action });
        };
        let result = self.extract_open(main, action, path, &summary, token);
        // A hand-over keeps the archive open for the main window's plan.
        if !matches!(result, Ok(QuickEvent::Fallback { .. })) {
            main.archives().close(summary.handle);
        }
        result
    }

    fn extract_open(
        &self,
        main: &dyn MainPort,
        action: QuickAction,
        path: &Path,
        summary: &ArchiveSummary,
        token: &CancellationToken,
    ) -> Result<QuickEvent> {
        let archives = main.archives();
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .ok_or_else(|| invalid("the archive has no folder to extract into"))?;
        let folder = match action {
            QuickAction::ExtractHere => parent.to_path_buf(),
            QuickAction::ExtractToFolder => {
                let stem = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| invalid("the archive has no name to make a folder from"))?;
                create_unique_dir(parent, &stem)?
            }
            QuickAction::Add => return Err(invalid("not an extract")),
        };
        lock(&self.control).folder = Some(folder.clone());
        let seq = summary
            .commits
            .last()
            .and_then(|c| u32::try_from(c.seq).ok())
            .ok_or_else(|| invalid("the archive has no commits"))?;
        let destination = Destination::default();
        destination.set(folder.clone());
        // Look at the whole snapshot before writing anything. Only a name that
        // is already taken (or that the folder treats as another entry's) sends
        // the user to the plan; a name this file system cannot hold is skipped
        // by the engine and listed in the result.
        let (_src, head, _opts) = archives.open_for_read(summary.handle, u64::from(seq))?;
        let mut root = OsRestoreDir::open(&folder)?;
        let (pre, _entries) = preflight_selected(&head, &[], &mut root)?;
        let collisions = pre
            .exceptions
            .iter()
            .filter(|(_, kind)| matches!(kind, ExceptionKind::Collision))
            .count();
        if collisions > 0 {
            main.hand_over_extract(summary.clone(), folder.clone());
            return Ok(QuickEvent::Fallback {
                conflicts: collisions as u64,
                destination: path_text(&folder),
            });
        }
        // The engine never overwrites; if something appears after the look, it
        // is skipped and reported, not replaced.
        let request = JobRequest::ExtractArchive {
            handle: summary.handle,
            seq,
            keys: Vec::new(),
            on_conflict: ConflictChoice::SkipConflicts,
        };
        extract::validate(archives, &destination, &request)?;
        let progress = Forward(self);
        let ctx = JobContext {
            progress: &progress,
            cancel: token,
        };
        let done = extract::run(archives, &destination, &request, &ctx)?;
        let view = done
            .extract
            .ok_or_else(|| invalid("the extraction produced no report"))?;
        Ok(QuickEvent::Done {
            action,
            name: file_name_text(&folder),
            location: path_text(&folder),
            files: view.files,
            directories: view.directories,
            bytes: view.bytes,
            skipped: view.not_extracted_total,
            note: view.not_extracted.first().map(|e| e.reason.text.clone()),
            status: None,
            durability_note: view.durability_note,
            format: ArchiveFormat::Mochi,
            output_bytes: 0,
        })
    }

    fn add(&self, paths: &[PathBuf], token: &CancellationToken) -> Result<QuickEvent> {
        // A private selection: the main window's staged set is not touched.
        let staging = Arc::new(Staging::default());
        let staged = staging.add(paths);
        if staged.staged.items.is_empty() {
            return Err(invalid(
                staged
                    .problems
                    .first()
                    .map(|p| p.message.clone())
                    .unwrap_or_else(|| "nothing to add".to_owned()),
            ));
        }
        let (dir, stem) = add_target(paths)?;
        let services = Services {
            staging: Arc::clone(&staging),
            ..Services::default()
        };
        let request = JobRequest::CreateArchive {
            preset: CompressionPreset::Balanced,
            tar_compatible: false,
            passphrase: None,
            recovery_percent: None,
        };
        for attempt in 1..=MAX_NAME_TRIES {
            let target = dir.join(candidate(&stem, ".mochi", attempt));
            if exists(&target) {
                continue;
            }
            match self.create_at(&services, &request, &target, &staged.problems, token) {
                // Created in the meantime by someone else: never replaced.
                Err(e) if e.code == ErrorCode::DestinationExists => continue,
                other => return other,
            }
        }
        Err(invalid(format!(
            "no free archive name for {stem} in {}",
            dir.display()
        )))
    }

    /// OK on the form: write the archive it describes, at the name it chose.
    fn add_chosen(&self, submit: Submit, token: &CancellationToken) -> Result<QuickEvent> {
        let Submit {
            paths,
            target,
            request,
        } = submit;
        let staging = Arc::new(Staging::default());
        let staged = staging.add(&paths);
        if staged.staged.items.is_empty() {
            return Err(invalid(
                staged
                    .problems
                    .first()
                    .map(|p| p.message.clone())
                    .unwrap_or_else(|| "nothing to add".to_owned()),
            ));
        }
        staging.set_format(request.format);
        let services = Services {
            staging: Arc::clone(&staging),
            ..Services::default()
        };
        let QuickAddRequest {
            format,
            level,
            passphrase,
            recovery_percent,
            ..
        } = request;
        let job = if format == ArchiveFormat::Mochi {
            JobRequest::CreateArchive {
                preset: level,
                tar_compatible: false,
                passphrase,
                recovery_percent,
            }
        } else {
            JobRequest::ExportArchive { format, level }
        };
        self.create_at(&services, &job, &target, &staged.problems, token)
    }

    /// Run a create or export job into `target` and describe what it wrote.
    fn create_at(
        &self,
        services: &Services,
        request: &JobRequest,
        target: &Path,
        problems: &[IpcError],
        token: &CancellationToken,
    ) -> Result<QuickEvent> {
        services.staging.set_destination(target.to_path_buf());
        services.validate(request)?;
        let progress = Forward(self);
        let ctx = JobContext {
            progress: &progress,
            cancel: token,
        };
        let done: JobDone = match services.run(request, &ctx) {
            Some(done) => done?,
            None => return Err(invalid("the create job is not routed")),
        };
        let dir = target.parent().map(Path::to_path_buf).unwrap_or_default();
        lock(&self.control).folder = Some(dir);
        if let Some(commit) = done.commit {
            let skipped = commit.skipped.len() as u64 + problems.len() as u64;
            let note = commit
                .skipped
                .first()
                .map(|s| format!("{}: {}", s.path.text, s.reason))
                .or_else(|| problems.first().map(|p| p.message.clone()));
            return Ok(QuickEvent::Done {
                action: QuickAction::Add,
                name: file_name_text(target),
                location: path_text(target),
                files: commit.files,
                directories: commit.directories,
                bytes: commit.bytes,
                skipped,
                note,
                status: Some(commit.status),
                durability_note: commit.durability_note,
                format: ArchiveFormat::Mochi,
                output_bytes: 0,
            });
        }
        let export = done
            .export
            .ok_or_else(|| invalid("the create produced no report"))?;
        let skipped = export.skipped.len() as u64 + problems.len() as u64;
        let note = export
            .skipped
            .first()
            .map(|s| format!("{}: {}", s.path.text, s.reason))
            .or_else(|| problems.first().map(|p| p.message.clone()));
        Ok(QuickEvent::Done {
            action: QuickAction::Add,
            name: export.name,
            location: export.location,
            files: export.files,
            directories: export.directories,
            bytes: export.bytes,
            skipped,
            note,
            status: None,
            durability_note: export.durability_note,
            format: export.format,
            output_bytes: export.output_bytes,
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    #[test]
    fn a_windows_path_keeps_its_separators_and_still_escapes_names() {
        let p = local_path_text("C:\\Users\\me\\a\u{1b}b", true);
        assert_eq!(
            p.text,
            "C:\\Users\\me\\a\u{1b}b".replace('\u{1b}', "\\u{1b}")
        );
        assert!(!p.verbatim);
        let q = local_path_text(r"C:\Users\me", true);
        assert_eq!(q.text, r"C:\Users\me");
        assert!(q.verbatim);
        assert_eq!(local_path_text(r"/a\b", false).text, r"/a\\b");
    }

    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    struct Sink(Mutex<Vec<QuickEvent>>, AtomicBool);

    impl Sink {
        fn live() -> Arc<Sink> {
            Arc::new(Sink(Mutex::default(), AtomicBool::new(true)))
        }
        fn events(&self) -> Vec<QuickEvent> {
            self.0.lock().unwrap().clone()
        }
    }

    impl QuickSink for Sink {
        fn send(&self, event: QuickEvent) -> bool {
            if !self.1.load(Ordering::SeqCst) {
                return false;
            }
            self.0.lock().unwrap().push(event);
            true
        }
    }

    #[derive(Default)]
    struct Host {
        calls: Mutex<Vec<String>>,
    }

    impl WindowHost for Host {
        fn show_quick(&self, size: QuickSize) {
            self.calls
                .lock()
                .unwrap()
                .push(format!("show_quick {size:?}"));
        }
        fn close_quick(&self) {
            self.calls.lock().unwrap().push("close_quick".into());
        }
        fn show_main(&self) {
            self.calls.lock().unwrap().push("show_main".into());
        }
        fn open_folder(&self, folder: &Path) -> std::io::Result<()> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("open {}", folder.display()));
            Ok(())
        }
    }

    #[derive(Default)]
    struct Main {
        archives: Archives,
        handed: Mutex<Vec<(String, PathBuf)>>,
    }

    impl MainPort for Main {
        fn archives(&self) -> &Archives {
            &self.archives
        }
        fn hand_over_extract(&self, archive: ArchiveSummary, folder: PathBuf) {
            self.handed
                .lock()
                .unwrap()
                .push((archive.file_name, folder));
        }
    }

    fn quick() -> (Arc<Quick>, Arc<Host>, Arc<Sink>) {
        let q = Quick::new();
        let host = Arc::new(Host::default());
        q.set_host(host.clone());
        let sink = Sink::live();
        q.watch(sink.clone());
        (q, host, sink)
    }

    fn archive(dir: &Path, name: &str, files: &[(&str, &[u8])]) -> PathBuf {
        use mochi_core::catalog::path::ArchivePath;
        use mochi_core::manifest::Attributes;
        use mochi_core::publish::{ArchiveWriter, Transaction};
        use mochi_core::storage::os::OsStorage;
        use mochi_testkit::archive::{test_options, Job};
        use mochi_testkit::SeqIds;
        let path = dir.join(name);
        let mut w = ArchiveWriter::create(
            OsStorage::create_new(&path).unwrap(),
            Box::new(SeqIds::new(9)),
            test_options(),
        )
        .unwrap();
        let mut tx = Transaction::new();
        for (n, bytes) in files {
            tx.put_file(
                ArchivePath::from_stored(n.as_bytes()).unwrap(),
                bytes.to_vec(),
                Attributes::default(),
            );
        }
        w.commit(tx, &Job::new().ctx()).unwrap();
        w.close().unwrap();
        path
    }

    fn last(sink: &Sink) -> QuickEvent {
        sink.events().last().cloned().unwrap()
    }

    #[test]
    fn names_skip_what_is_taken_and_count_from_two() {
        assert_eq!(candidate("a", ".mochi", 1), "a.mochi");
        assert_eq!(candidate("a", ".mochi", 2), "a (2).mochi");
        let taken = |n: &str| ["a.mochi", "a (2).mochi"].contains(&n);
        assert_eq!(unique_name("a", ".mochi", &taken).unwrap(), "a (3).mochi");
        assert_eq!(unique_name("b", ".mochi", &taken).unwrap(), "b.mochi");
        assert!(unique_name("a", "", &|_| true).is_none());
    }

    #[test]
    fn an_archive_is_named_for_its_item_or_for_the_folder_of_several() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("report.final.txt");
        let sub = dir.path().join("v1.2");
        std::fs::write(&file, b"x").unwrap();
        std::fs::create_dir(&sub).unwrap();
        assert_eq!(
            add_target(std::slice::from_ref(&file)).unwrap(),
            (dir.path().to_path_buf(), "report.final".to_owned())
        );
        // A folder keeps its whole name: "v1.2" is not "v1" plus an extension.
        assert_eq!(add_target(std::slice::from_ref(&sub)).unwrap().1, "v1.2");
        let folder_name = dir
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(add_target(&[file, sub]).unwrap().1, folder_name);
        assert!(add_target(&[]).is_err());
        assert!(add_target(&[PathBuf::from("bare")]).is_err());
    }

    #[test]
    fn extract_here_writes_the_files_and_never_replaces_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = archive(
            dir.path(),
            "docs.mochi",
            &[("a.txt", b"alpha"), ("b.txt", b"bravo")],
        );
        let (q, host, sink) = quick();
        let main = Main::default();
        q.run(
            &QuickJob::Extract {
                action: QuickAction::ExtractHere,
                path: path.clone(),
            },
            &main,
        );
        let events = sink.events();
        assert!(matches!(
            &events[0],
            QuickEvent::Started { action: QuickAction::ExtractHere, subject, .. }
                if subject.text == "docs.mochi"
        ));
        let QuickEvent::Done {
            files,
            skipped,
            status,
            ..
        } = last(&sink)
        else {
            panic!("{events:?}")
        };
        assert_eq!((files, skipped, status), (2, 0, None));
        assert_eq!(std::fs::read(dir.path().join("a.txt")).unwrap(), b"alpha");
        assert_eq!(main.archives.open_count(), 0, "the handle is closed");
        assert_eq!(host.calls.lock().unwrap()[0], "show_quick Compact");
        // "Show in folder" opens the folder Rust remembers.
        q.show_folder().unwrap();
        assert_eq!(
            host.calls.lock().unwrap().last().unwrap(),
            &format!("open {}", dir.path().display())
        );
    }

    #[test]
    fn a_collision_writes_nothing_and_falls_back_to_the_main_windows_plan() {
        let dir = tempfile::tempdir().unwrap();
        let path = archive(
            dir.path(),
            "docs.mochi",
            &[("a.txt", b"alpha"), ("b.txt", b"bravo")],
        );
        std::fs::write(dir.path().join("b.txt"), b"mine").unwrap();
        let (q, _host, sink) = quick();
        let main = Main::default();
        q.run(
            &QuickJob::Extract {
                action: QuickAction::ExtractHere,
                path,
            },
            &main,
        );
        let QuickEvent::Fallback { conflicts, .. } = last(&sink) else {
            panic!("{:?}", sink.events())
        };
        assert_eq!(conflicts, 1);
        // Nothing at all was written, not even the file without a collision,
        // and the user's file is as it was.
        assert!(!dir.path().join("a.txt").exists());
        assert_eq!(std::fs::read(dir.path().join("b.txt")).unwrap(), b"mine");
        let handed = main.handed.lock().unwrap().clone();
        assert_eq!(
            handed,
            vec![("docs.mochi".to_owned(), dir.path().to_path_buf())]
        );
        assert_eq!(main.archives.open_count(), 1, "kept open for the plan");
    }

    #[test]
    fn extract_to_new_folder_never_reuses_a_folder_or_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = archive(dir.path(), "docs.mochi", &[("a.txt", b"alpha")]);
        std::fs::create_dir(dir.path().join("docs")).unwrap();
        std::fs::write(dir.path().join("docs (2)"), b"a file in the way").unwrap();
        std::fs::write(dir.path().join("docs").join("a.txt"), b"mine").unwrap();
        let (q, _host, sink) = quick();
        let main = Main::default();
        q.run(
            &QuickJob::Extract {
                action: QuickAction::ExtractToFolder,
                path,
            },
            &main,
        );
        let QuickEvent::Done { name, files, .. } = last(&sink) else {
            panic!("{:?}", sink.events())
        };
        assert_eq!(name.text, "docs (3)");
        assert_eq!(files, 1);
        assert_eq!(
            std::fs::read(dir.path().join("docs (3)").join("a.txt")).unwrap(),
            b"alpha"
        );
        assert_eq!(
            std::fs::read(dir.path().join("docs").join("a.txt")).unwrap(),
            b"mine"
        );
        assert_eq!(
            std::fs::read(dir.path().join("docs (2)")).unwrap(),
            b"a file in the way"
        );
    }

    #[test]
    fn a_missing_or_unreadable_archive_is_a_failure_in_the_compact_window() {
        let dir = tempfile::tempdir().unwrap();
        let junk = dir.path().join("junk.mochi");
        std::fs::write(&junk, b"this is not an archive").unwrap();
        for path in [
            dir.path().join("missing.mochi"),
            junk,
            dir.path().to_path_buf(),
        ] {
            let (q, _host, sink) = quick();
            q.run(
                &QuickJob::Extract {
                    action: QuickAction::ExtractHere,
                    path,
                },
                &Main::default(),
            );
            assert!(
                matches!(last(&sink), QuickEvent::Failed { .. }),
                "{:?}",
                sink.events()
            );
        }
        // Nothing was written next to them.
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn add_creates_next_to_the_item_with_a_free_name_and_says_local_committed() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.txt");
        std::fs::write(&file, b"hello").unwrap();
        let taken = dir.path().join("notes.mochi");
        std::fs::write(&taken, b"not an archive, but mine").unwrap();
        let (q, _host, sink) = quick();
        q.run(&QuickJob::Add { paths: vec![file] }, &Main::default());
        let QuickEvent::Done {
            name,
            files,
            status,
            skipped,
            ..
        } = last(&sink)
        else {
            panic!("{:?}", sink.events())
        };
        assert_eq!(name.text, "notes (2).mochi");
        assert_eq!((files, skipped), (1, 0));
        assert_eq!(status.as_deref(), Some("LOCAL_COMMITTED"));
        assert_eq!(std::fs::read(&taken).unwrap(), b"not an archive, but mine");
        assert!(dir.path().join("notes (2).mochi").is_file());
        // The archive is a real one, with the Core profile.
        let archives = Archives::default();
        let a = archives
            .open(&dir.path().join("notes (2).mochi"), ReadOptions::default())
            .unwrap();
        assert!(!a.profile.encrypted && !a.profile.tar_compatible);
        assert_eq!(a.profile.redundancy_percent, None);
    }

    #[test]
    fn several_items_make_one_archive_named_for_their_folder() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("trip");
        std::fs::create_dir(&folder).unwrap();
        let (a, b) = (folder.join("a.txt"), folder.join("b.txt"));
        std::fs::write(&a, b"a").unwrap();
        std::fs::write(&b, b"b").unwrap();
        let (q, _host, sink) = quick();
        q.run(&QuickJob::Add { paths: vec![a, b] }, &Main::default());
        let QuickEvent::Done { name, files, .. } = last(&sink) else {
            panic!("{:?}", sink.events())
        };
        assert_eq!(name.text, "trip.mochi");
        assert_eq!(files, 2);
        assert!(matches!(
            &sink.events()[0],
            QuickEvent::Started { items: 2, .. }
        ));
    }

    #[test]
    fn adding_nothing_that_exists_fails_and_creates_no_archive() {
        let dir = tempfile::tempdir().unwrap();
        let (q, _host, sink) = quick();
        q.run(
            &QuickJob::Add {
                paths: vec![dir.path().join("missing.txt")],
            },
            &Main::default(),
        );
        assert!(matches!(last(&sink), QuickEvent::Failed { .. }));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn events_before_the_window_listens_wait_and_progress_is_coalesced() {
        let q = Quick::new();
        q.emit(QuickEvent::Started {
            action: QuickAction::Add,
            subject: NameText::of(b"a"),
            items: 1,
        });
        for i in 0..200 {
            q.emit(QuickEvent::Progress {
                phase: "import".into(),
                completed: i,
                total: None,
            });
        }
        let sink = Sink::live();
        q.watch(sink.clone());
        let events = sink.events();
        assert_eq!(events.len(), 2, "{events:?}");
        assert!(matches!(
            &events[1],
            QuickEvent::Progress { completed: 199, .. }
        ));
        // A new job forgets what the old window never heard.
        q.emit(QuickEvent::Cancelled {
            action: QuickAction::Add,
        });
        sink.1.store(false, Ordering::SeqCst);
        q.emit(QuickEvent::Cancelled {
            action: QuickAction::Add,
        });
        q.emit(QuickEvent::Started {
            action: QuickAction::Add,
            subject: NameText::of(b"b"),
            items: 1,
        });
        let next = Sink::live();
        q.watch(next.clone());
        assert_eq!(next.events().len(), 1);
    }

    #[test]
    fn a_passphrase_with_nobody_waiting_is_refused() {
        let q = Quick::new();
        assert!(q.passphrase(Secret::new("x")).is_err());
        assert!(q.show_folder().is_err());
        // Cancel with nothing running is harmless.
        q.cancel();
        q.closed();
    }

    #[test]
    fn closing_the_window_while_a_passphrase_is_awaited_ends_the_job() {
        let dir = tempfile::tempdir().unwrap();
        let path = encrypted_archive(dir.path(), "secret.mochi", "correct horse");
        let (q, _host, sink) = quick();
        let q2 = Arc::clone(&q);
        let handle = std::thread::spawn(move || {
            q2.run(
                &QuickJob::Extract {
                    action: QuickAction::ExtractHere,
                    path,
                },
                &Main::default(),
            );
        });
        wait_for(&sink, |e| {
            matches!(e, QuickEvent::NeedPassphrase { wrong: false })
        });
        q.closed();
        handle.join().unwrap();
        assert!(!dir.path().join("a.txt").exists());
    }

    #[test]
    fn an_encrypted_archive_asks_again_after_a_wrong_passphrase_then_extracts() {
        let dir = tempfile::tempdir().unwrap();
        let path = encrypted_archive(dir.path(), "secret.mochi", "correct horse");
        let (q, _host, sink) = quick();
        let q2 = Arc::clone(&q);
        let handle = std::thread::spawn(move || {
            q2.run(
                &QuickJob::Extract {
                    action: QuickAction::ExtractHere,
                    path,
                },
                &Main::default(),
            );
        });
        wait_for(&sink, |e| {
            matches!(e, QuickEvent::NeedPassphrase { wrong: false })
        });
        q.passphrase(Secret::new("battery staple")).unwrap();
        wait_for(&sink, |e| {
            matches!(e, QuickEvent::NeedPassphrase { wrong: true })
        });
        // Nothing was written for the wrong one.
        assert!(!dir.path().join("a.txt").exists());
        q.passphrase(Secret::new("correct horse")).unwrap();
        handle.join().unwrap();
        assert!(
            matches!(last(&sink), QuickEvent::Done { files: 1, .. }),
            "{:?}",
            sink.events()
        );
        assert_eq!(std::fs::read(dir.path().join("a.txt")).unwrap(), b"alpha");
    }

    fn wait_for(sink: &Sink, want: impl Fn(&QuickEvent) -> bool) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !sink.events().iter().any(&want) {
            assert!(std::time::Instant::now() < deadline, "{:?}", sink.events());
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    /// An Encrypted archive holding `a.txt`, written through the same
    /// create job the app uses.
    fn encrypted_archive(dir: &Path, name: &str, passphrase: &str) -> PathBuf {
        let src = tempfile::tempdir().unwrap();
        let file = src.path().join("a.txt");
        std::fs::write(&file, b"alpha").unwrap();
        let staging = Arc::new(Staging::default());
        staging.add(&[file]);
        staging.set_destination(dir.join(name));
        let services = Services {
            staging,
            ..Services::default()
        };
        let request = JobRequest::CreateArchive {
            preset: CompressionPreset::Fast,
            tar_compatible: false,
            passphrase: Some(Secret::new(passphrase)),
            recovery_percent: None,
        };
        services.validate(&request).unwrap();
        let token = CancellationToken::new();
        let ctx = JobContext {
            progress: &mochi_core::job::NullProgress,
            cancel: &token,
        };
        services.run(&request, &ctx).unwrap().unwrap();
        dir.join(name)
    }

    // ---- the Add form ------------------------------------------------------

    fn request(name: &str, format: ArchiveFormat) -> QuickAddRequest {
        QuickAddRequest {
            name: name.to_owned(),
            format,
            level: CompressionPreset::Fast,
            passphrase: None,
            recovery_percent: None,
        }
    }

    /// Run the form on a worker thread, as the launch worker does; returns
    /// once the form is showing.
    fn open_form(q: &Arc<Quick>, sink: &Sink, paths: Vec<PathBuf>) -> std::thread::JoinHandle<()> {
        let worker = Arc::clone(q);
        let handle = std::thread::spawn(move || {
            worker.run(&QuickJob::AddDialog { paths }, &Main::default());
        });
        wait_for(sink, |e| {
            matches!(e, QuickEvent::AddPrompt { .. } | QuickEvent::Failed { .. })
        });
        handle
    }

    fn two_files() -> (tempfile::TempDir, Vec<PathBuf>) {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("notes.txt");
        let b = dir.path().join("more.txt");
        std::fs::write(&a, b"hello").unwrap();
        std::fs::write(&b, b"world!").unwrap();
        (dir, vec![a, b])
    }

    #[test]
    fn the_form_waits_and_writes_nothing_until_ok() {
        let (dir, paths) = two_files();
        std::fs::write(dir.path().join("notes.mochi"), b"mine").unwrap();
        let (q, host, sink) = quick();
        let handle = open_form(&q, &sink, paths);
        let QuickEvent::AddPrompt {
            items,
            subject,
            name,
            format,
            ..
        } = last(&sink)
        else {
            panic!("{:?}", sink.events())
        };
        // The name is the --add-now rule: the folder's name for several items.
        assert_eq!(items, 2);
        assert_eq!(subject.text, "notes.txt");
        let folder = dir
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(name, format!("{folder}.mochi"));
        assert_eq!(format, ArchiveFormat::Mochi);
        assert!(host
            .calls
            .lock()
            .unwrap()
            .contains(&"show_quick Form".to_owned()));
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 3);
        assert!(!sink
            .events()
            .iter()
            .any(|e| matches!(e, QuickEvent::Started { .. })));
        q.submit_add(request("both", ArchiveFormat::Zip)).unwrap();
        handle.join().unwrap();
        let QuickEvent::Done {
            name,
            files,
            bytes,
            format,
            status,
            output_bytes,
            ..
        } = last(&sink)
        else {
            panic!("{:?}", sink.events())
        };
        assert_eq!(name.text, "both.zip");
        assert_eq!(
            (files, bytes, format, status),
            (2, 11, ArchiveFormat::Zip, None)
        );
        assert_eq!(
            output_bytes,
            std::fs::metadata(dir.path().join("both.zip"))
                .unwrap()
                .len()
        );
        // The result window shrinks back to the compact size for the job.
        assert!(host
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|c| c == "show_quick Compact"));
        q.show_folder().unwrap();
    }

    #[test]
    fn every_format_is_written_with_its_own_extension_whatever_the_name_typed() {
        for (format, typed, want) in [
            (ArchiveFormat::Zip, "box", "box.zip"),
            (ArchiveFormat::Tar, "box.zip", "box.tar"),
            (ArchiveFormat::TarGz, "box.mochi", "box.tar.gz"),
            (ArchiveFormat::TarZst, "box.tar.gz", "box.tar.zst"),
            (ArchiveFormat::Mochi, "box.tar", "box.mochi"),
        ] {
            let (dir, paths) = two_files();
            let (q, _host, sink) = quick();
            let handle = open_form(&q, &sink, paths);
            q.submit_add(request(typed, format)).unwrap();
            handle.join().unwrap();
            let QuickEvent::Done {
                name,
                files,
                status,
                format: written,
                ..
            } = last(&sink)
            else {
                panic!("{format:?}: {:?}", sink.events())
            };
            assert_eq!(name.text, want);
            assert_eq!((files, written), (2, format));
            // A commit status only for .mochi; a plain file claims no more.
            assert_eq!(
                status.is_some(),
                format == ArchiveFormat::Mochi,
                "{format:?}"
            );
            assert!(dir.path().join(want).is_file());
        }
    }

    #[test]
    fn a_name_in_the_way_is_refused_and_the_form_stays_open() {
        let (dir, paths) = two_files();
        std::fs::write(dir.path().join("taken.zip"), b"mine").unwrap();
        let (q, _host, sink) = quick();
        let handle = open_form(&q, &sink, paths);
        let e = q
            .submit_add(request("taken", ArchiveFormat::Zip))
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::DestinationExists);
        assert!(e.message.contains("taken.zip") && e.message.contains("not replace"));
        assert_eq!(
            std::fs::read(dir.path().join("taken.zip")).unwrap(),
            b"mine"
        );
        // Still waiting: another name works.
        assert!(!handle.is_finished());
        q.submit_add(request("free", ArchiveFormat::Zip)).unwrap();
        handle.join().unwrap();
        assert!(matches!(last(&sink), QuickEvent::Done { .. }));
        assert_eq!(
            std::fs::read(dir.path().join("taken.zip")).unwrap(),
            b"mine"
        );
    }

    #[test]
    fn a_bad_request_is_refused_before_the_worker_hears_of_it() {
        let (_dir, paths) = two_files();
        let (q, _host, sink) = quick();
        let handle = open_form(&q, &sink, paths);
        for bad in ["", "a/b", "..", "x*"] {
            let e = q.submit_add(request(bad, ArchiveFormat::Zip)).unwrap_err();
            assert_eq!(e.code, ErrorCode::InvalidArgument, "{bad:?}");
        }
        // Encryption and a recovery record are for .mochi only; ZIP says so.
        let mut r = request("x", ArchiveFormat::Zip);
        r.passphrase = Some(Secret::new("hunter2"));
        let e = q.submit_add(r).unwrap_err();
        assert_eq!(e.code, ErrorCode::UnsupportedFeature);
        assert!(!e.message.contains("hunter2"));
        let mut r = request("x", ArchiveFormat::TarGz);
        r.recovery_percent = Some(10);
        assert_eq!(
            q.submit_add(r).unwrap_err().code,
            ErrorCode::UnsupportedFeature
        );
        let mut r = request("x", ArchiveFormat::Mochi);
        r.recovery_percent = Some(0);
        assert_eq!(
            q.submit_add(r).unwrap_err().code,
            ErrorCode::InvalidArgument
        );
        let mut r = request("x", ArchiveFormat::Mochi);
        r.passphrase = Some(Secret::new(""));
        let e = q.submit_add(r).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidArgument);
        assert!(!handle.is_finished(), "the form is still open");
        q.cancel();
        handle.join().unwrap();
    }

    #[test]
    fn an_encrypted_mochi_archive_with_a_recovery_record_comes_from_the_form() {
        let (dir, paths) = two_files();
        let (q, _host, sink) = quick();
        let handle = open_form(&q, &sink, paths);
        let mut r = request("secret", ArchiveFormat::Mochi);
        r.passphrase = Some(Secret::new("correct horse"));
        r.recovery_percent = Some(10);
        q.submit_add(r).unwrap();
        handle.join().unwrap();
        let QuickEvent::Done { status, format, .. } = last(&sink) else {
            panic!("{:?}", sink.events())
        };
        assert_eq!(status.as_deref(), Some("LOCAL_COMMITTED"));
        assert_eq!(format, ArchiveFormat::Mochi);
        assert!(crate::browse::head_encrypted(
            &dir.path().join("secret.mochi")
        ));
    }

    #[test]
    fn cancel_and_closing_end_the_form_and_write_nothing() {
        for close in [false, true] {
            let (dir, paths) = two_files();
            let (q, _host, sink) = quick();
            let handle = open_form(&q, &sink, paths);
            if close {
                q.closed();
            } else {
                q.cancel();
            }
            handle.join().unwrap();
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
            // The form is gone: OK now has nothing to answer.
            let e = q.submit_add(request("x", ArchiveFormat::Zip)).unwrap_err();
            assert_eq!(e.code, ErrorCode::InvalidArgument);
        }
    }

    #[test]
    fn browse_keeps_the_folder_and_the_extension_follows_the_format() {
        let (dir, paths) = two_files();
        let other = tempfile::tempdir().unwrap();
        let (q, _host, sink) = quick();
        let handle = open_form(&q, &sink, paths);
        let suggested = q.suggested_location("Pics", ArchiveFormat::TarZst).unwrap();
        assert_eq!(suggested, dir.path().join("Pics.tar.zst"));
        // A name that cannot be used falls back to a plain one for the dialog.
        let suggested = q.suggested_location("a/b", ArchiveFormat::Zip).unwrap();
        assert_eq!(suggested, dir.path().join("archive.zip"));
        let at = q
            .set_location(&other.path().join("Chosen.mochi"), ArchiveFormat::Zip)
            .unwrap();
        assert_eq!(at.name, "Chosen.zip");
        // The display form of a Windows temp path can differ from `path()`
        // (verbatim prefix, short names), so compare the folder's own name.
        let leaf = other.path().file_name().unwrap().to_string_lossy();
        assert!(at.folder.text.ends_with(&*leaf), "{}", at.folder.text);
        q.submit_add(request("Chosen", ArchiveFormat::Zip)).unwrap();
        handle.join().unwrap();
        assert!(other.path().join("Chosen.zip").is_file());
        assert!(!dir.path().join("Chosen.zip").exists());
        // "Show in folder" opens the folder that was chosen.
        assert!(matches!(last(&sink), QuickEvent::Done { .. }));
    }

    #[test]
    fn items_that_join_the_open_form_are_in_the_archive_once() {
        let (dir, paths) = two_files();
        let third = dir.path().join("third.txt");
        std::fs::write(&third, b"3").unwrap();
        let (q, _host, sink) = quick();
        let handle = open_form(&q, &sink, vec![paths[0].clone()]);
        assert!(q.extend_prompt(&[paths[1].clone(), paths[0].clone(), third]));
        wait_for(&sink, |e| {
            matches!(e, QuickEvent::AddPrompt { items: 3, .. })
        });
        q.submit_add(request("all", ArchiveFormat::Tar)).unwrap();
        handle.join().unwrap();
        assert!(matches!(last(&sink), QuickEvent::Done { files: 3, .. }));
        // With no form open there is nothing to join.
        assert!(!q.extend_prompt(&[paths[0].clone()]));
    }

    #[test]
    fn a_form_for_nothing_that_exists_is_a_failure_not_a_form() {
        let dir = tempfile::tempdir().unwrap();
        let (q, _host, sink) = quick();
        let handle = open_form(&q, &sink, vec![dir.path().join("gone")]);
        handle.join().unwrap();
        assert!(
            matches!(last(&sink), QuickEvent::Failed { .. }),
            "{:?}",
            sink.events()
        );
        assert!(!q.extend_prompt(&[dir.path().join("x")]));
    }

    #[test]
    fn a_cancelled_export_leaves_no_file_and_says_cancelled() {
        // Cancelling after OK, while the archive is being written.
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("big.bin");
        std::fs::write(&big, vec![7u8; 3_000_000]).unwrap();
        let (q, _host, sink) = quick();
        let handle = open_form(&q, &sink, vec![big]);
        q.submit_add(request("big", ArchiveFormat::TarGz)).unwrap();
        // Cancel as soon as the job has started (progress or not, the next safe
        // point stops it).
        wait_for(&sink, |e| matches!(e, QuickEvent::Started { .. }));
        q.cancel();
        handle.join().unwrap();
        match last(&sink) {
            QuickEvent::Cancelled { .. } => {
                assert_eq!(
                    std::fs::read_dir(dir.path()).unwrap().count(),
                    1,
                    "no archive, no temporary file"
                );
            }
            // The job may win the race on a fast machine; then it is complete.
            QuickEvent::Done { .. } => assert!(dir.path().join("big.tar.gz").is_file()),
            other => panic!("{other:?}"),
        }
    }
}
