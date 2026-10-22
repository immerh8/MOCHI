//! Operating-system integration (plan D6, decision O10): what the app does
//! when the shell starts it with arguments, whether that is the first launch
//! or a second one that the single-instance plugin forwards here.
//!
//! # Rules
//!
//! * **Paths from the OS stay in Rust.** The webview is told that an archive
//!   was opened (an [`ArchiveSummary`], as `open_archive` returns) or what the
//!   problem was. It never receives, and never sends, a path.
//! * **Two kinds of verb (owner decision 2026-10-16, replacing "nothing runs
//!   silently"; amended 2026-10-20).** The *panel verb* "Open with MOCHI"
//!   opens an archive read-only in the main window's browser. *Quick verbs*
//!   run in a small compact window ([`crate::quick`]; progress, then a
//!   one-line result with "Show in folder" and Close) and never open the main
//!   window: "Extract here" and "Extract to new folder" (`--extract-here`,
//!   `--extract-to-folder`), "Add to archive" (`--add-now`, at once), and
//!   "Add to archive…" (`--add`, a small form first: name, Browse…, format,
//!   level, `.mochi` options, OK and Cancel; nothing is written until OK). A quick verb
//!   never overwrites: when anything in the way exists, nothing is written and
//!   the extract plan for the same archive opens in the main window instead
//!   (the panel verb's screen, with the folder chosen in Rust). Explorer starts
//!   one process per selected item, so `--add-now` and `--add` launches that
//!   arrive within [`ADD_BATCH_WINDOW`] of each other are collected into one
//!   archive; a later `--add` launch joins the form while it is still open.
//! * **No secret on a command line.** There is no option for a passphrase;
//!   a passphrase option is refused by name, and the refusal never repeats an
//!   option's value. Encrypted archives ask for the passphrase in the window.
//! * **Arguments are untrusted.** Every path is checked (empty, NUL, length,
//!   Windows device namespace, a verb's path count) before anything touches
//!   the file system, and a launch that does not parse changes nothing.
//! * **Foreign formats are not parsed here.** A ZIP, 7z, RAR, tar, tar.gz, or
//!   tar.zst path (by extension, [`foreign_kind`], unless the file starts with
//!   the MOCHI descriptor frame: `crate::route`) goes to the same open path as the
//!   in-app "Open foreign archive" button ([`Foreign::open`], plan D8): the
//!   isolated helper lists it and the window shows the read-only foreign
//!   browser. An archive that needs a password is remembered in Rust
//!   (`Foreign::pending`) and the window asks for it, once, exactly as it
//!   does for the in-app path. What D8 does not support (a split ZIP, an SFX,
//!   an unsupported method) comes back as the helper's typed refusal.
//! * **Extract verbs are for `.mochi`.** `--extract-here` and
//!   `--extract-to-folder` on a foreign archive extract nothing, choose no
//!   folder, and open no compact window: the archive is opened for browsing,
//!   with a plain sentence that extraction from the shell is for `.mochi`
//!   archives. The user extracts
//!   from the foreign browser's own buttons, which show the plan first.
//!
//! # Command line
//!
//! ```text
//! mochi-desktop [VERB] [--] PATH...
//!   (no verb)               open PATH read-only (what a file manager passes)
//!   --open                  the same, explicitly ("Open with MOCHI")
//!   --extract-here          quick: extract PATH into the archive's folder
//!   --extract-to-folder     quick: extract PATH into a new folder named for it
//!   --add                   quick: the Add form for PATH... (name, format, OK)
//!   --add-now               quick: add PATH... to a new archive next to it
//!   --find                  MOCHI Find: search the names inside every .mochi under
//!                           the folders PATH... (none: open Find as it was left)
//! ```
//!
//! `--` ends the options, so a path that starts with `-` is still a path.

use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::browse::Archives;
use crate::extract::Destination;
use crate::find::Finder;
use crate::foreign::Foreign;
use crate::ipc::{ArchiveSummary, ForeignArchiveSummary, IpcError};
use crate::quick::{MainPort, Quick, QuickAction, QuickJob};
use crate::write::MAX_STAGED;

/// Longest path accepted from the command line, in bytes (Windows allows
/// 32,767 UTF-16 units; Linux 4,096).
pub const MAX_PATH_BYTES: usize = 32 * 1024;

/// Events kept for a window that is not listening yet.
const MAX_PENDING: usize = 64;

/// How long after the last `--add-now` launch the worker waits for another
/// before it adds what it has collected. Explorer starts one process per
/// selected item; the second and later ones reach this process through the
/// single-instance plugin, a few tens of milliseconds apart.
pub const ADD_BATCH_WINDOW: Duration = Duration::from_millis(500);

/// What the shell asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verb {
    Open,
    ExtractHere,
    ExtractToFolder,
    Add,
    AddNow,
    /// MOCHI Find: search the file names inside every `.mochi` archive under
    /// the given folders. Opens the main window's Find tool; not a quick verb.
    Find,
}

impl Verb {
    /// Quick verbs run in the compact window and never open the main one.
    pub fn is_quick(self) -> bool {
        matches!(
            self,
            Verb::ExtractHere | Verb::ExtractToFolder | Verb::Add | Verb::AddNow
        )
    }
}

impl Verb {
    fn from_option(name: &str) -> Option<Verb> {
        Some(match name {
            "--open" => Verb::Open,
            "--extract-here" => Verb::ExtractHere,
            "--extract-to-folder" => Verb::ExtractToFolder,
            "--add" => Verb::Add,
            "--add-now" => Verb::AddNow,
            "--find" => Verb::Find,
            _ => return None,
        })
    }
}

/// A parsed, validated launch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub verb: Verb,
    /// Absolute when the launch carried a working directory; never empty.
    pub paths: Vec<PathBuf>,
}

/// Why a launch was refused: one sentence that is safe to show (it never
/// repeats an option's value).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchError(pub String);

impl std::fmt::Display for LaunchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn refuse<T>(what: impl Into<String>) -> Result<T, LaunchError> {
    Err(LaunchError(what.into()))
}

/// The name part of an option (`--x=value` → `--x`), so that a value, which
/// could be a secret, is never echoed.
fn option_name(arg: &str) -> &str {
    arg.split('=').next().unwrap_or(arg)
}

fn looks_like_secret_option(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    ["pass", "pwd", "secret", "key", "token"]
        .iter()
        .any(|w| lower.contains(w))
}

fn check_path(arg: &OsStr, cwd: &Path) -> Result<PathBuf, LaunchError> {
    let lossy = arg.to_string_lossy();
    if arg.is_empty() {
        return refuse("an empty path was given");
    }
    if arg.len() > MAX_PATH_BYTES {
        return refuse("a path is too long");
    }
    if lossy.contains('\0') {
        return refuse("a path contains a NUL character");
    }
    // `\\.\` names a device (a pipe, a disk): reading one can block forever.
    if lossy.starts_with(r"\\.\") {
        return refuse("a Windows device path was given; name a file instead");
    }
    let path = PathBuf::from(arg);
    if path.is_absolute() {
        return Ok(path);
    }
    if !cwd.is_absolute() {
        return refuse("a relative path was given without a working directory");
    }
    Ok(cwd.join(path))
}

/// Parse the arguments after the program name. `Ok(None)` when there are
/// none (a plain start). Relative paths are made absolute against `cwd`,
/// which for a second instance is the second process's directory.
pub fn parse<S: AsRef<OsStr>>(args: &[S], cwd: &Path) -> Result<Option<Launch>, LaunchError> {
    let mut verb: Option<Verb> = None;
    let mut paths: Vec<PathBuf> = Vec::new();
    let mut options_done = false;
    for arg in args {
        let arg = arg.as_ref();
        let text = arg.to_str();
        if !options_done {
            if text == Some("--") {
                options_done = true;
                continue;
            }
            if let Some(t) = text.filter(|t| t.starts_with('-') && t.len() > 1) {
                let name = option_name(t);
                if looks_like_secret_option(name) {
                    return refuse(
                        "a passphrase cannot be given on the command line; the window asks for it",
                    );
                }
                let Some(v) = Verb::from_option(name).filter(|_| name == t) else {
                    return refuse(format!("unknown option {name}"));
                };
                if verb.is_some() {
                    return refuse(
                        "only one of --open, --extract-here, --extract-to-folder, --add, --add-now, --find",
                    );
                }
                verb = Some(v);
                continue;
            }
        }
        if paths.len() >= MAX_STAGED {
            return refuse(format!("at most {MAX_STAGED} paths can be given at once"));
        }
        paths.push(check_path(arg, cwd)?);
    }
    let verb = verb.unwrap_or(Verb::Open);
    match (verb, paths.len()) {
        (_, 0) if args.is_empty() => Ok(None),
        // Find without a folder (the app-menu launcher) opens the Find tool.
        (Verb::Find, _) => Ok(Some(Launch { verb, paths })),
        (_, 0) => refuse("the command needs a path"),
        (Verb::Add | Verb::AddNow, _) | (_, 1) => Ok(Some(Launch { verb, paths })),
        _ => refuse("one archive at a time: give a single path"),
    }
}

/// The arguments of this process, without the program name.
pub fn from_environment() -> Result<Option<Launch>, LaunchError> {
    let mut args: Vec<OsString> = std::env::args_os().skip(1).collect();
    if args.is_empty() {
        args = crate::automation::launch_args();
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    parse(&args, &cwd)
}

/// The arguments a second instance forwards (`argv[0]` first, as the
/// plugin delivers them) and its working directory.
pub fn from_forwarded(argv: &[String], cwd: &str) -> Result<Option<Launch>, LaunchError> {
    parse(argv.get(1..).unwrap_or_default(), Path::new(cwd))
}

// ---- what the window hears ------------------------------------------------

/// What the window is told about a launch. No path crosses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "event", rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum LaunchEvent {
    /// An archive was opened read-only; show it. With `extract`, the folder
    /// to extract into is already chosen in Rust and the window shows the
    /// extract plan for the whole snapshot (nothing is written until the
    /// user confirms it).
    Opened {
        archive: ArchiveSummary,
        extract: bool,
    },
    /// A ZIP, 7z, RAR, tar, or tar.gz was opened read-only (plan D8); show
    /// the foreign browser on it. Nothing here says it was verified.
    ForeignOpened { archive: ForeignArchiveSummary },
    /// The foreign archive needs a password (or the one given was wrong). Rust
    /// remembers the file; the window asks and retries with the password, which
    /// crosses IPC once, in that call.
    ForeignPassword { wrong: bool },
    /// MOCHI Find was asked for (`--find`). Rust holds the folders (`folders`
    /// of them, possibly none); the window opens the Find tool and, when there
    /// are folders, starts the scan. No path crosses.
    Find { folders: u32 },
    /// The launch could not be carried out, in one sentence.
    Problem { message: String },
}

/// Where launch events go (a Tauri `Channel` in the app).
pub trait LaunchSink: Send + Sync + 'static {
    /// `false` once nobody listens.
    fn send(&self, event: LaunchEvent) -> bool;
}

#[derive(Default)]
struct Delivery {
    sink: Option<Arc<dyn LaunchSink>>,
    pending: VecDeque<LaunchEvent>,
}

/// What a launch needs besides its arguments.
struct Inner {
    archives: Arc<Archives>,
    destination: Arc<Destination>,
    foreign: Arc<Foreign>,
    quick: Arc<Quick>,
    delivery: Mutex<Delivery>,
    /// MOCHI Find's folders and scan; set once at start-up (`set_finder`).
    finder: OnceLock<Arc<Finder>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // Only queues and a channel handle live behind these locks.
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// What the launch worker is asked to do.
enum Item {
    Launch(Result<Launch, LaunchError>),
    /// A second start with no arguments: just bring the window forward.
    ShowMain,
}

/// Handles launches in the order they arrive, on one worker thread, so that
/// opening an archive never blocks the async runtime or the single-instance
/// callback, and two quick launches cannot overtake each other. Quick jobs
/// (extract, add now) run on a second worker, one at a time, so that a long
/// extraction never holds up the shell's other verbs.
pub struct Launches {
    inner: Arc<Inner>,
    queue: Mutex<Sender<Item>>,
}

impl Launches {
    pub fn new(
        archives: Arc<Archives>,
        destination: Arc<Destination>,
        foreign: Arc<Foreign>,
        quick: Arc<Quick>,
    ) -> Launches {
        Self::with_batch_window(archives, destination, foreign, quick, ADD_BATCH_WINDOW)
    }

    /// [`Launches::new`] with another collection window for `--add-now` and `--add`.
    pub fn with_batch_window(
        archives: Arc<Archives>,
        destination: Arc<Destination>,
        foreign: Arc<Foreign>,
        quick: Arc<Quick>,
        batch_window: Duration,
    ) -> Launches {
        let inner = Arc::new(Inner {
            archives,
            destination,
            foreign,
            quick,
            delivery: Mutex::default(),
            finder: OnceLock::new(),
        });
        let (quick_tx, quick_rx) = channel::<QuickJob>();
        let quick_worker = Arc::clone(&inner);
        // Both threads end when `Launches` (the only sender) is dropped.
        std::thread::spawn(move || {
            for job in quick_rx {
                quick_worker.quick.run(&job, &*quick_worker);
            }
        });
        let (tx, rx) = channel::<Item>();
        let worker = Arc::clone(&inner);
        std::thread::spawn(move || {
            let mut later: VecDeque<Item> = VecDeque::new();
            loop {
                let item = match later.pop_front() {
                    Some(item) => item,
                    None => match rx.recv() {
                        Ok(item) => item,
                        Err(_) => return,
                    },
                };
                match item {
                    Item::ShowMain => worker.show_main(),
                    Item::Launch(Ok(mut launch))
                        if matches!(launch.verb, Verb::AddNow | Verb::Add) =>
                    {
                        // Collect the launches of one selection into one
                        // archive: wait until none has arrived for a window.
                        // Only launches of the same verb are collected;
                        // anything else that arrives meanwhile keeps its
                        // place, after this one.
                        loop {
                            match rx.recv_timeout(batch_window) {
                                Ok(Item::Launch(Ok(more))) if more.verb == launch.verb => {
                                    for p in more.paths {
                                        if !launch.paths.contains(&p) {
                                            launch.paths.push(p);
                                        }
                                    }
                                }
                                Ok(other) => later.push_back(other),
                                Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {
                                    break
                                }
                            }
                        }
                        worker.handle(Ok(launch), &quick_tx);
                    }
                    Item::Launch(launch) => worker.handle(launch, &quick_tx),
                }
            }
        });
        Launches {
            inner,
            queue: Mutex::new(tx),
        }
    }

    /// Give `--find` the Find state it sets the folders of. Once; later calls
    /// change nothing.
    pub fn set_finder(&self, finder: Arc<Finder>) {
        let _ = self.inner.finder.set(finder);
    }

    /// Queue a launch (or its refusal) to be handled. No arguments: nothing
    /// to do.
    pub fn submit(&self, item: Result<Option<Launch>, LaunchError>) {
        let item = match item {
            Ok(None) => return,
            Ok(Some(launch)) => Ok(launch),
            Err(e) => Err(e),
        };
        // A send fails only if the worker is gone (a panic); nothing to do.
        let _ = lock(&self.queue).send(Item::Launch(item));
    }

    /// A second start with no arguments: bring the main window forward
    /// (creating it if only a compact window is open).
    pub fn focus(&self) {
        let _ = lock(&self.queue).send(Item::ShowMain);
    }

    /// Listen with `sink` and hand it what arrived before there was one.
    pub fn watch(&self, sink: Arc<dyn LaunchSink>) {
        let mut d = lock(&self.inner.delivery);
        while let Some(event) = d.pending.pop_front() {
            if !sink.send(event.clone()) {
                d.pending.push_front(event);
                return;
            }
        }
        d.sink = Some(sink);
    }

    /// Handle one launch now, on the calling thread (tests). Quick verbs run
    /// to their end here too.
    #[cfg(test)]
    fn handle_now(&self, item: Result<Launch, LaunchError>) {
        let (tx, rx) = channel::<QuickJob>();
        self.inner.handle(item, &tx);
        drop(tx);
        for job in rx {
            self.inner.quick.run(&job, &*self.inner);
        }
    }
}

impl MainPort for Inner {
    fn archives(&self) -> &Archives {
        &self.archives
    }

    fn hand_over_extract(&self, archive: ArchiveSummary, folder: PathBuf) {
        self.destination.set(folder);
        self.emit(LaunchEvent::Opened {
            archive,
            extract: true,
        });
    }
}

impl Inner {
    fn show_main(&self) {
        if let Some(host) = self.quick.host() {
            host.show_main();
        }
    }

    /// Queue an event for the main window and bring it forward: whatever
    /// reached here needs the full window.
    fn emit(&self, event: LaunchEvent) {
        {
            let mut d = lock(&self.delivery);
            let sent = match d.sink.clone() {
                Some(sink) if sink.send(event.clone()) => true,
                Some(_) => {
                    d.sink = None;
                    false
                }
                None => false,
            };
            if !sent {
                if d.pending.len() >= MAX_PENDING {
                    d.pending.pop_front();
                }
                d.pending.push_back(event);
            }
        }
        self.show_main();
    }

    fn problem(&self, message: impl Into<String>) {
        self.emit(LaunchEvent::Problem {
            message: message.into(),
        });
    }

    fn handle(&self, item: Result<Launch, LaunchError>, quick: &Sender<QuickJob>) {
        let launch = match item {
            Ok(l) => l,
            Err(e) => {
                return self.problem(format!(
                    "MOCHI was started with arguments it cannot use: {e}."
                ))
            }
        };
        match launch.verb {
            Verb::Add => {
                // A form that is still open takes the items; otherwise a form
                // of its own is queued behind whatever the quick worker is
                // doing.
                if !self.quick.extend_prompt(&launch.paths) {
                    // A send fails only if the quick worker is gone (a panic).
                    let _ = quick.send(QuickJob::AddDialog {
                        paths: launch.paths,
                    });
                }
            }
            Verb::AddNow => {
                // A send fails only if the quick worker is gone (a panic).
                let _ = quick.send(QuickJob::Add {
                    paths: launch.paths,
                });
            }
            Verb::Find => self.find(&launch.paths),
            Verb::Open => {
                // `parse` guarantees exactly one path for these verbs.
                if let Some(path) = launch.paths.first() {
                    self.open(path);
                }
            }
            Verb::ExtractHere | Verb::ExtractToFolder => {
                let Some(path) = launch.paths.first() else {
                    return;
                };
                if crate::route::route(path) == crate::route::Route::Foreign {
                    return self.open_foreign(true, path);
                }
                let action = if launch.verb == Verb::ExtractHere {
                    QuickAction::ExtractHere
                } else {
                    QuickAction::ExtractToFolder
                };
                let _ = quick.send(QuickJob::Extract {
                    action,
                    path: path.clone(),
                });
            }
        }
    }

    /// `--find`: take the folders (when any were given) and tell the window to
    /// open Find. A path that is not an existing folder is left out; if none is
    /// left the current folders are kept and the problem is said.
    fn find(&self, paths: &[PathBuf]) {
        let Some(finder) = self.finder.get() else {
            return self.problem("MOCHI Find is not available.");
        };
        if !paths.is_empty() {
            if let Err(e) = finder.set_scopes(paths.to_vec()) {
                return self.problem(format!(
                    "MOCHI Find needs a folder to search: {}.",
                    e.message
                ));
            }
        }
        self.emit(LaunchEvent::Find {
            folders: u32::try_from(finder.scopes().len()).unwrap_or(u32::MAX),
        });
    }

    fn open(&self, path: &Path) {
        let shown = path.display();
        if crate::route::route(path) == crate::route::Route::Foreign {
            return self.open_foreign(false, path);
        }
        match std::fs::metadata(path) {
            Ok(m) if m.is_file() => {}
            Ok(_) => return self.problem(format!("{shown} is not a file.")),
            Err(e) => return self.problem(format!("{shown} cannot be read: {e}.")),
        }
        // An Encrypted archive needs its passphrase (D5), which the shell verbs
        // cannot carry: say so instead of failing with a misleading code.
        if crate::browse::head_encrypted(path) {
            return self.problem(format!(
                "{shown} is encrypted. Use Open archive… in MOCHI and enter its passphrase; \
                 the shell's open verb cannot ask for one."
            ));
        }
        match self
            .archives
            .open(path, mochi_core::publish::ReadOptions::default())
        {
            Ok(archive) => self.emit(LaunchEvent::Opened {
                archive,
                extract: false,
            }),
            Err(e) => {
                let e = IpcError::from(e);
                self.problem(format!(
                    "{shown} could not be opened ({}): {}",
                    e.code, e.message
                ));
            }
        }
    }
}

impl Inner {
    /// Open a foreign archive for browsing through the in-app path
    /// ([`Foreign::open`]); the password, if any, is asked for in the window.
    /// `extract_verb`: the shell asked to extract, which is for `.mochi` only.
    fn open_foreign(&self, extract_verb: bool, path: &Path) {
        let shown = path.display();
        match std::fs::metadata(path) {
            Ok(m) if m.is_file() => {}
            Ok(_) => return self.problem(format!("{shown} is not a file.")),
            Err(e) => return self.problem(format!("{shown} cannot be read: {e}.")),
        }
        match self.foreign.open(path, None) {
            Ok(archive) => {
                if extract_verb {
                    self.problem(format!(
                        "{shown}: extracting from the shell is for .mochi archives. \
                         It is open for browsing; use Extract in the foreign archive section."
                    ));
                }
                self.emit(LaunchEvent::ForeignOpened { archive });
            }
            Err(e) if e.code == mochi_foreign::ErrorCode::PasswordRequired.as_str() => {
                self.emit(LaunchEvent::ForeignPassword { wrong: false });
            }
            Err(e) => self.problem(format!(
                "{shown} could not be opened ({}): {}",
                e.code, e.message
            )),
        }
    }
}

/// The foreign format a name suggests, by extension only. A name is a hint
/// for routing, never proof: the helper decides what the bytes are.
pub fn foreign_kind(path: &Path) -> Option<&'static str> {
    let name = path.file_name()?.to_string_lossy().to_ascii_lowercase();
    const SUFFIXES: [(&str, &str); 9] = [
        (".zip", "ZIP"),
        (".7z", "7z"),
        (".rar", "RAR"),
        (".tar.gz", "tar.gz"),
        (".tgz", "tar.gz"),
        (".tar.zst", "tar.zst"),
        (".tzst", "tar.zst"),
        (".tar", "tar"),
        (".gz", "gzip"),
    ];
    SUFFIXES
        .iter()
        .find(|(suffix, _)| name.ends_with(suffix))
        .map(|(_, kind)| *kind)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn cwd() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\work")
        } else {
            PathBuf::from("/work")
        }
    }

    fn abs(p: &str) -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(format!(r"C:\{p}"))
        } else {
            PathBuf::from(format!("/{p}"))
        }
    }

    fn parsed(args: &[&str]) -> Result<Option<Launch>, LaunchError> {
        parse(args, &cwd())
    }

    #[test]
    fn no_arguments_is_a_plain_start() {
        assert_eq!(parsed(&[]), Ok(None));
    }

    #[test]
    fn a_bare_path_opens_it_and_each_verb_is_recognised() {
        let a = abs("a.mochi").to_string_lossy().into_owned();
        let l = parsed(&[&a]).unwrap().unwrap();
        assert_eq!(l.verb, Verb::Open);
        assert_eq!(l.paths, vec![abs("a.mochi")]);
        for (opt, verb) in [
            ("--open", Verb::Open),
            ("--extract-here", Verb::ExtractHere),
            ("--extract-to-folder", Verb::ExtractToFolder),
            ("--add", Verb::Add),
            ("--add-now", Verb::AddNow),
        ] {
            let l = parsed(&[opt, "--", &a]).unwrap().unwrap();
            assert_eq!(l.verb, verb);
            assert_eq!(l.paths, vec![abs("a.mochi")]);
        }
    }

    #[test]
    fn a_relative_path_is_resolved_against_the_launchers_directory() {
        let l = parsed(&["--open", "x/y.mochi"]).unwrap().unwrap();
        assert_eq!(l.paths, vec![cwd().join("x/y.mochi")]);
        // A relative path with no usable directory is refused.
        assert!(parse(&["y.mochi"], Path::new("")).is_err());
    }

    #[test]
    fn unknown_verbs_and_options_are_refused_by_name() {
        for bad in ["--extract", "--ADD", "--add=1", "-x", "--verb", "--help"] {
            let e = parsed(&[bad, "a.mochi"]).unwrap_err();
            assert!(e.0.contains("unknown option"), "{bad}: {e}");
        }
        // A lone dash is a path, as it is everywhere.
        assert!(parsed(&["-"]).unwrap().is_some());
    }

    #[test]
    fn a_passphrase_option_is_refused_and_its_value_never_echoed() {
        for bad in [
            "--passphrase=hunter2",
            "--password=hunter2",
            "--passphrase-env=PW",
            "--key=hunter2",
            "--Passphrase=hunter2",
        ] {
            let e = parsed(&[bad, "a.mochi"]).unwrap_err();
            assert!(e.0.contains("passphrase"), "{bad}: {e}");
            assert!(
                !e.0.contains("hunter2") && !e.0.contains("PW"),
                "{bad}: {e}"
            );
        }
        // The next argument is not read as a path once an option failed.
        assert!(parsed(&["--passphrase", "hunter2"]).is_err());
    }

    #[test]
    fn unknown_option_errors_do_not_echo_values() {
        let e = parsed(&["--frobnicate=hunter2"]).unwrap_err();
        assert!(
            e.0.contains("--frobnicate") && !e.0.contains("hunter2"),
            "{e}"
        );
    }

    #[test]
    fn hostile_paths_are_refused_or_kept_as_plain_data() {
        assert!(parsed(&[""]).is_err(), "empty");
        assert!(parsed(&["a\0b"]).is_err(), "NUL");
        assert!(parsed(&[r"\\.\pipe\mochi"]).is_err(), "device path");
        let long = "a".repeat(MAX_PATH_BYTES + 1);
        assert!(parsed(&[long.as_str()]).is_err(), "too long");
        let many: Vec<String> = (0..=MAX_STAGED).map(|i| format!("f{i}")).collect();
        let mut args = vec!["--add".to_owned()];
        args.extend(many);
        assert!(parse(&args, &cwd()).is_err(), "too many");
        // After `--`, a path that looks like an option is a path.
        let l = parsed(&["--open", "--", "--passphrase=x"])
            .unwrap()
            .unwrap();
        assert_eq!(l.paths, vec![cwd().join("--passphrase=x")]);
        // Shell metacharacters, newlines, bidi controls, and `..` are bytes
        // of a name, not syntax: kept exactly, never expanded or normalised.
        let odd = "a; rm -rf ~ | b\n\u{202e}gpj.mochi";
        let l = parsed(&["--open", "--", odd]).unwrap().unwrap();
        assert_eq!(l.paths, vec![cwd().join(odd)]);
        let l = parsed(&["--open", "--", "../up/../x.mochi"])
            .unwrap()
            .unwrap();
        assert_eq!(l.paths, vec![cwd().join("../up/../x.mochi")]);
    }

    #[cfg(unix)]
    #[test]
    fn a_path_that_is_not_utf8_survives() {
        use std::os::unix::ffi::OsStringExt;
        let raw = OsString::from_vec(b"/tmp/bad\xffname.mochi".to_vec());
        let l = parse(std::slice::from_ref(&raw), &cwd()).unwrap().unwrap();
        assert_eq!(l.paths, vec![PathBuf::from(raw)]);
    }

    #[test]
    fn verbs_check_their_path_counts_and_do_not_combine() {
        assert!(parsed(&["--open"]).is_err(), "a verb needs a path");
        assert!(parsed(&["--add"]).is_err());
        assert!(parsed(&["--add-now"]).is_err());
        assert!(
            parsed(&["--extract-here", "a", "b"]).is_err(),
            "one archive"
        );
        assert!(parsed(&["a.mochi", "b.mochi"]).is_err(), "one archive");
        assert!(parsed(&["--open", "--add", "a"]).is_err(), "one verb");
        let l = parsed(&["--add", "a", "b", "c"]).unwrap().unwrap();
        assert_eq!(l.paths.len(), 3);
        let l = parsed(&["--add-now", "a", "b"]).unwrap().unwrap();
        assert_eq!((l.verb, l.paths.len()), (Verb::AddNow, 2));
        assert!(!Verb::Open.is_quick());
        assert!(
            Verb::Add.is_quick(),
            "Add to archive... is the compact form"
        );
        assert!(Verb::ExtractHere.is_quick() && Verb::ExtractToFolder.is_quick());
        assert!(Verb::AddNow.is_quick());
    }

    #[test]
    fn find_takes_any_number_of_folders_and_none_opens_the_tool() {
        let a = abs("music").to_string_lossy().into_owned();
        let b = abs("photos").to_string_lossy().into_owned();
        let l = parsed(&["--find", "--", &a, &b]).unwrap().unwrap();
        assert_eq!(l.verb, Verb::Find);
        assert_eq!(l.paths, vec![abs("music"), abs("photos")]);
        // The Linux launcher's `%F` can expand to nothing, with or without `--`.
        for args in [&["--find"][..], &["--find", "--"][..]] {
            let l = parsed(args).unwrap().unwrap();
            assert_eq!((l.verb, l.paths.len()), (Verb::Find, 0));
        }
        // A relative folder is resolved against the launcher's directory.
        let l = parsed(&["--find", "--", "docs"]).unwrap().unwrap();
        assert_eq!(l.paths, vec![cwd().join("docs")]);
        // A folder named like an option stays a path after `--`.
        let l = parsed(&["--find", "--", "-rf"]).unwrap().unwrap();
        assert_eq!(l.paths, vec![cwd().join("-rf")]);
        assert!(!Verb::Find.is_quick(), "Find uses the main window");
        // It does not combine with another verb, and the strict checks still apply.
        assert!(parsed(&["--find", "--add", &a]).is_err());
        assert!(parsed(&["--open", "--find", &a]).is_err());
        assert!(parsed(&["--find", "--passphrase=hunter2"]).is_err());
        assert!(parsed(&["--find=1", &a]).is_err());
        assert!(parsed(&["--FIND", &a]).is_err());
        assert!(parsed(&["--find", ""]).is_err(), "an empty path");
        assert!(parsed(&["--find", "a\0b"]).is_err(), "a NUL");
        let device = r"\\.\pipe\x";
        assert!(parsed(&["--find", "--", device]).is_err(), "a device path");
        let long = "a".repeat(MAX_PATH_BYTES + 1);
        assert!(parsed(&["--find", "--", &long]).is_err());
        assert!(parse(&["--find", "--", "rel"], Path::new("")).is_err());
        let many: Vec<String> = (0..=MAX_STAGED)
            .map(|i| abs(&format!("d{i}")).to_string_lossy().into_owned())
            .collect();
        let mut args = vec!["--find", "--"];
        args.extend(many.iter().map(String::as_str));
        assert!(parse(&args, &cwd()).is_err(), "too many folders");
    }

    #[test]
    fn a_second_instances_payload_is_parsed_with_its_own_directory() {
        let argv = vec![
            "mochi-desktop".to_owned(),
            "--extract-here".to_owned(),
            "--".to_owned(),
            "one.mochi".to_owned(),
        ];
        let l = from_forwarded(&argv, &cwd().to_string_lossy())
            .unwrap()
            .unwrap();
        assert_eq!(l.verb, Verb::ExtractHere);
        assert_eq!(l.paths, vec![cwd().join("one.mochi")]);
        // Only the program name: nothing to do (the window is just focused).
        assert_eq!(from_forwarded(&["mochi-desktop".to_owned()], "/"), Ok(None));
        assert_eq!(from_forwarded(&[], "/"), Ok(None));
        // An unparsable payload is an error the window reports.
        assert!(from_forwarded(&["m".into(), "--passphrase=x".into()], "/").is_err());
    }

    #[test]
    fn foreign_formats_are_recognised_by_name_only() {
        for (name, kind) in [
            ("a.ZIP", "ZIP"),
            ("a.7z", "7z"),
            ("a.rar", "RAR"),
            ("a.tar.gz", "tar.gz"),
            ("a.tgz", "tar.gz"),
            ("a.tar.zst", "tar.zst"),
            ("a.TZST", "tar.zst"),
            ("a.tar", "tar"),
        ] {
            assert_eq!(foreign_kind(Path::new(name)), Some(kind), "{name}");
        }
        assert_eq!(foreign_kind(Path::new("a.mochi")), None);
        assert_eq!(foreign_kind(Path::new("zip")), None);
        // A bare .zst is a compressed single file, not a tar archive.
        assert_eq!(foreign_kind(Path::new("a.zst")), None);
    }

    // ---- handling --------------------------------------------------------

    struct Sink(Mutex<Vec<LaunchEvent>>, AtomicBool);

    impl Sink {
        fn live() -> Arc<Sink> {
            Arc::new(Sink(Mutex::default(), AtomicBool::new(true)))
        }
        fn events(&self) -> Vec<LaunchEvent> {
            self.0.lock().unwrap().clone()
        }
    }

    impl LaunchSink for Sink {
        fn send(&self, event: LaunchEvent) -> bool {
            if !self.1.load(Ordering::SeqCst) {
                return false;
            }
            self.0.lock().unwrap().push(event);
            true
        }
    }

    /// Collects what the compact window would hear.
    struct QSink(Mutex<Vec<crate::quick::QuickEvent>>);

    impl QSink {
        fn live() -> Arc<QSink> {
            Arc::new(QSink(Mutex::default()))
        }
        fn events(&self) -> Vec<crate::quick::QuickEvent> {
            self.0.lock().unwrap().clone()
        }
    }

    impl crate::quick::QuickSink for QSink {
        fn send(&self, event: crate::quick::QuickEvent) -> bool {
            self.0.lock().unwrap().push(event);
            true
        }
    }

    /// The helper binary next to the test executable, built on demand when
    /// only this package's tests were asked for.
    fn helper() -> PathBuf {
        let exe = std::env::current_exe().unwrap();
        let name = if cfg!(windows) {
            "mochi-foreign-helper.exe"
        } else {
            "mochi-foreign-helper"
        };
        let path = exe.parent().unwrap().parent().unwrap().join(name);
        if !path.exists() {
            let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
            let ok = std::process::Command::new(cargo)
                .args(["build", "-p", "mochi-foreign"])
                .status()
                .unwrap()
                .success();
            assert!(
                ok && path.exists(),
                "could not build the helper at {path:?}"
            );
        }
        path
    }

    fn fx(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/foreign")
            .join(name)
    }

    fn launches() -> Launches {
        launches_with().0
    }

    fn launches_with() -> (Launches, Arc<Foreign>) {
        let (l, foreign, _) = launches_full();
        (l, foreign)
    }

    fn launches_full() -> (Launches, Arc<Foreign>, Arc<Destination>) {
        let foreign = Arc::new(Foreign::default());
        foreign.set_helper(helper());
        let destination = Arc::new(Destination::default());
        let l = Launches::new(
            Arc::new(Archives::default()),
            Arc::clone(&destination),
            Arc::clone(&foreign),
            Quick::new(),
        );
        (l, foreign, destination)
    }

    fn write_archive(dir: &Path, name: &str) -> PathBuf {
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
        tx.put_file(
            ArchivePath::from_stored(b"a.txt").unwrap(),
            b"alpha".to_vec(),
            Attributes::default(),
        );
        w.commit(tx, &Job::new().ctx()).unwrap();
        w.close().unwrap();
        path
    }

    #[test]
    fn events_before_the_window_listens_wait_for_it_in_order() {
        let l = launches();
        l.handle_now(Err(LaunchError("first".into())));
        l.handle_now(Err(LaunchError("second".into())));
        let sink = Sink::live();
        l.watch(sink.clone());
        let events = sink.events();
        assert_eq!(events.len(), 2);
        assert!(
            matches!(&events[0], LaunchEvent::Problem { message } if message.contains("first"))
        );
        assert!(
            matches!(&events[1], LaunchEvent::Problem { message } if message.contains("second"))
        );
        // Later events go straight through.
        l.handle_now(Err(LaunchError("third".into())));
        assert_eq!(sink.events().len(), 3);
    }

    #[test]
    fn a_gone_listener_is_forgotten_and_the_event_kept() {
        let l = launches();
        let sink = Sink::live();
        l.watch(sink.clone());
        sink.1.store(false, Ordering::SeqCst);
        l.handle_now(Err(LaunchError("kept".into())));
        let next = Sink::live();
        l.watch(next.clone());
        assert_eq!(next.events().len(), 1);
    }

    #[test]
    fn a_foreign_archive_opens_in_the_foreign_browser_not_the_mochi_one() {
        let (l, foreign) = launches_with();
        let sink = Sink::live();
        l.watch(sink.clone());
        for name in [
            "basic_infozip.zip",
            "basic.tar",
            "basic.tar.gz",
            "7z/basic.7z",
        ] {
            l.handle_now(Ok(Launch {
                verb: Verb::Open,
                paths: vec![fx(name)],
            }));
        }
        let events = sink.events();
        let formats: Vec<&str> = events
            .iter()
            .map(|e| match e {
                LaunchEvent::ForeignOpened { archive } => archive.format.as_str(),
                other => panic!("expected ForeignOpened, got {other:?}"),
            })
            .collect();
        assert_eq!(formats.len(), 4);
        assert_eq!(formats[0], "ZIP");
        assert_eq!(formats[3], "7z");
        assert_eq!(foreign.open_count(), 4, "opened by the in-app service");
        // The foreign wording: no MOCHI health dimension is claimed.
        if let LaunchEvent::ForeignOpened { archive } = &events[0] {
            assert_eq!(archive.dimensions.recoverability, "UNSUPPORTED");
        }
    }

    #[test]
    fn extract_verbs_on_a_foreign_archive_extract_nothing_and_open_it_for_browsing() {
        let (l, foreign, dest) = launches_full();
        let sink = Sink::live();
        l.watch(sink.clone());
        let dir = tempfile::tempdir().unwrap();
        let zip = dir.path().join("photos.zip");
        std::fs::copy(fx("basic_infozip.zip"), &zip).unwrap();
        for verb in [Verb::ExtractHere, Verb::ExtractToFolder] {
            l.handle_now(Ok(Launch {
                verb,
                paths: vec![zip.clone()],
            }));
        }
        let events = sink.events();
        assert_eq!(events.len(), 4, "{events:?}");
        for pair in events.chunks(2) {
            assert!(
                matches!(&pair[0], LaunchEvent::Problem { message }
                    if message.contains("extracting from the shell is for .mochi")),
                "{pair:?}"
            );
            assert!(
                matches!(&pair[1], LaunchEvent::ForeignOpened { .. }),
                "{pair:?}"
            );
        }
        assert_eq!(foreign.open_count(), 2);
        // No folder was made and none chosen.
        assert!(!dir.path().join("photos").exists());
        assert!(dest.get().is_none());
    }

    #[test]
    fn an_encrypted_foreign_archive_asks_for_its_password_in_the_window() {
        let (l, foreign) = launches_with();
        let sink = Sink::live();
        l.watch(sink.clone());
        let p = fx("7z/enc_names.7z");
        l.handle_now(Ok(Launch {
            verb: Verb::Open,
            paths: vec![p.clone()],
        }));
        assert_eq!(
            sink.events(),
            vec![LaunchEvent::ForeignPassword { wrong: false }]
        );
        assert_eq!(foreign.open_count(), 0);
        // The retry is the in-app one: the file is remembered in Rust.
        assert_eq!(foreign.pending().as_deref(), Some(p.as_path()));
        let s = foreign.open(&p, Some(b"SECRET".to_vec())).unwrap();
        assert!(s.opened_with_password);
    }

    #[test]
    fn foreign_variants_d8_does_not_support_keep_their_typed_refusal() {
        let (l, foreign) = launches_with();
        let sink = Sink::live();
        l.watch(sink.clone());
        let dir = tempfile::tempdir().unwrap();
        // A `.zip` that is not one, and a missing file.
        let fake = dir.path().join("fake.zip");
        std::fs::copy(fx("garbage.bin"), &fake).unwrap();
        let split = dir.path().join("split.zip");
        std::fs::copy(fx("split_last.zip"), &split).unwrap();
        for path in [fake, split, dir.path().join("missing.zip")] {
            l.handle_now(Ok(Launch {
                verb: Verb::Open,
                paths: vec![path],
            }));
        }
        let events = sink.events();
        assert_eq!(events.len(), 3);
        assert!(
            matches!(&events[0], LaunchEvent::Problem { message }
                if message.contains("could not be opened (NOT_AN_ARCHIVE)")),
            "{events:?}"
        );
        assert!(
            matches!(&events[1], LaunchEvent::Problem { message }
                if message.contains("could not be opened (UNSUPPORTED")),
            "{events:?}"
        );
        assert!(
            matches!(&events[2], LaunchEvent::Problem { message } if message.contains("cannot be read"))
        );
        assert_eq!(foreign.open_count(), 0);
    }

    #[test]
    fn a_missing_file_or_a_folder_is_a_problem_not_a_crash() {
        let dir = tempfile::tempdir().unwrap();
        let l = launches();
        let sink = Sink::live();
        l.watch(sink.clone());
        l.handle_now(Ok(Launch {
            verb: Verb::Open,
            paths: vec![dir.path().join("missing.mochi")],
        }));
        l.handle_now(Ok(Launch {
            verb: Verb::Open,
            paths: vec![dir.path().to_path_buf()],
        }));
        // A file that is not an archive.
        let junk = dir.path().join("junk.mochi");
        std::fs::write(&junk, b"this is not an archive").unwrap();
        l.handle_now(Ok(Launch {
            verb: Verb::Open,
            paths: vec![junk],
        }));
        let events = sink.events();
        assert_eq!(events.len(), 3);
        assert!(
            events
                .iter()
                .all(|e| matches!(e, LaunchEvent::Problem { .. })),
            "{events:?}"
        );
    }

    #[test]
    fn open_shows_the_archive_read_only_in_the_main_window() {
        let dir = tempfile::tempdir().unwrap();
        let archive = write_archive(dir.path(), "photos.mochi");
        let l = launches();
        let sink = Sink::live();
        l.watch(sink.clone());
        l.handle_now(Ok(Launch {
            verb: Verb::Open,
            paths: vec![archive.clone()],
        }));
        let events = sink.events();
        assert_eq!(events.len(), 1, "{events:?}");
        match &events[0] {
            LaunchEvent::Opened { archive, extract } => {
                assert_eq!(archive.file_name, "photos.mochi");
                assert!(!extract);
            }
            other => panic!("{other:?}"),
        }
        assert!(l.inner.destination.get().is_none());
        // Opening is read-only: nothing was extracted.
        assert!(!dir.path().join("a.txt").exists());
    }

    #[test]
    fn find_sets_the_folders_in_rust_and_tells_the_window_only_how_many() {
        let dir = tempfile::tempdir().unwrap();
        let one = dir.path().join("one");
        let two = dir.path().join("two");
        std::fs::create_dir_all(&one).unwrap();
        std::fs::create_dir_all(&two).unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, b"x").unwrap();
        let l = launches();
        let finder = Arc::new(Finder::default());
        l.set_finder(Arc::clone(&finder));
        let sink = Sink::live();
        l.watch(sink.clone());

        l.handle_now(Ok(Launch {
            verb: Verb::Find,
            paths: vec![one.clone(), two.clone(), file.clone()],
        }));
        assert_eq!(sink.events(), vec![LaunchEvent::Find { folders: 2 }]);
        let shown: Vec<String> = finder.scopes().into_iter().map(|s| s.path).collect();
        assert_eq!(
            shown,
            vec![one.display().to_string(), two.display().to_string()],
            "a file among the paths is left out"
        );

        // No folder: the folders stay as they were and the tool opens.
        l.handle_now(Ok(Launch {
            verb: Verb::Find,
            paths: Vec::new(),
        }));
        assert_eq!(
            sink.events().last(),
            Some(&LaunchEvent::Find { folders: 2 })
        );

        // Nothing usable: said as a problem, the folders are kept.
        l.handle_now(Ok(Launch {
            verb: Verb::Find,
            paths: vec![file, dir.path().join("missing")],
        }));
        assert!(matches!(
            sink.events().last(),
            Some(LaunchEvent::Problem { message }) if message.contains("needs a folder")
        ));
        assert_eq!(finder.scopes().len(), 2);
    }

    #[test]
    fn find_without_a_finder_is_a_problem_not_a_crash() {
        let l = launches();
        let sink = Sink::live();
        l.watch(sink.clone());
        l.handle_now(Ok(Launch {
            verb: Verb::Find,
            paths: Vec::new(),
        }));
        assert!(matches!(
            sink.events().as_slice(),
            [LaunchEvent::Problem { .. }]
        ));
    }

    #[test]
    fn extract_verbs_run_in_the_compact_window_and_leave_the_main_one_alone() {
        let dir = tempfile::tempdir().unwrap();
        let archive = write_archive(dir.path(), "photos.mochi");
        let l = launches();
        let main = Sink::live();
        l.watch(main.clone());
        let compact = QSink::live();
        l.inner.quick.watch(compact.clone());
        for verb in [Verb::ExtractHere, Verb::ExtractToFolder] {
            l.handle_now(Ok(Launch {
                verb,
                paths: vec![archive.clone()],
            }));
        }
        assert!(main.events().is_empty(), "{:?}", main.events());
        let done = compact
            .events()
            .into_iter()
            .filter(|e| matches!(e, crate::quick::QuickEvent::Done { .. }))
            .count();
        assert_eq!(done, 2);
        // Written at once: here, and into a new folder named for the archive.
        assert_eq!(std::fs::read(dir.path().join("a.txt")).unwrap(), b"alpha");
        assert_eq!(
            std::fs::read(dir.path().join("photos").join("a.txt")).unwrap(),
            b"alpha"
        );
        assert!(l.inner.destination.get().is_none());
    }

    #[test]
    fn a_collision_hands_the_extract_plan_to_the_main_window() {
        let dir = tempfile::tempdir().unwrap();
        let archive = write_archive(dir.path(), "photos.mochi");
        std::fs::write(dir.path().join("a.txt"), b"mine").unwrap();
        let l = launches();
        let main = Sink::live();
        l.watch(main.clone());
        let compact = QSink::live();
        l.inner.quick.watch(compact.clone());
        l.handle_now(Ok(Launch {
            verb: Verb::ExtractHere,
            paths: vec![archive],
        }));
        assert!(matches!(
            compact.events().last(),
            Some(crate::quick::QuickEvent::Fallback { conflicts: 1, .. })
        ));
        let events = main.events();
        assert_eq!(events.len(), 1, "{events:?}");
        assert!(matches!(
            &events[0],
            LaunchEvent::Opened { extract: true, archive } if archive.file_name == "photos.mochi"
        ));
        assert_eq!(l.inner.destination.get(), Some(dir.path().to_path_buf()));
        assert_eq!(std::fs::read(dir.path().join("a.txt")).unwrap(), b"mine");
    }

    #[test]
    fn add_now_launches_in_one_selection_make_one_archive() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("trip");
        std::fs::create_dir(&folder).unwrap();
        let files: Vec<PathBuf> = ["a.txt", "b.txt", "c.txt"]
            .iter()
            .map(|n| {
                let p = folder.join(n);
                std::fs::write(&p, n.as_bytes()).unwrap();
                p
            })
            .collect();
        let l = Launches::with_batch_window(
            Arc::new(Archives::default()),
            Arc::new(Destination::default()),
            Arc::new(Foreign::default()),
            Quick::new(),
            Duration::from_millis(300),
        );
        let compact = QSink::live();
        l.inner.quick.watch(compact.clone());
        // One process per item, a few milliseconds apart, as Explorer does.
        for f in &files {
            l.submit(parse(
                &[OsStr::new("--add-now"), OsStr::new("--"), f.as_os_str()],
                &cwd(),
            ));
            std::thread::sleep(Duration::from_millis(20));
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        let done = loop {
            let events = compact.events();
            if let Some(e) = events
                .into_iter()
                .find(|e| matches!(e, crate::quick::QuickEvent::Done { .. }))
            {
                break e;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "{:?}",
                compact.events()
            );
            std::thread::sleep(Duration::from_millis(10));
        };
        let crate::quick::QuickEvent::Done { name, files, .. } = done else {
            unreachable!()
        };
        assert_eq!(name.text, "trip.mochi");
        assert_eq!(files, 3);
        // One archive, not three.
        let archives: Vec<_> = std::fs::read_dir(&folder)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".mochi"))
            .collect();
        assert_eq!(archives, ["trip.mochi"]);
    }

    #[test]
    fn a_launch_that_is_not_an_add_keeps_its_place_during_collection() {
        let dir = tempfile::tempdir().unwrap();
        let archive = write_archive(dir.path(), "a.mochi");
        let file = dir.path().join("note.txt");
        std::fs::write(&file, b"x").unwrap();
        let l = Launches::with_batch_window(
            Arc::new(Archives::default()),
            Arc::new(Destination::default()),
            Arc::new(Foreign::default()),
            Quick::new(),
            Duration::from_millis(200),
        );
        let main = Sink::live();
        l.watch(main.clone());
        let compact = QSink::live();
        l.inner.quick.watch(compact.clone());
        l.submit(parse(&[OsStr::new("--add-now"), file.as_os_str()], &cwd()));
        l.submit(parse(&[archive.as_os_str()], &cwd()));
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while (main.events().is_empty()
            || !compact
                .events()
                .iter()
                .any(|e| matches!(e, crate::quick::QuickEvent::Done { .. })))
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(matches!(&main.events()[0], LaunchEvent::Opened { .. }));
        assert!(dir.path().join("note.mochi").is_file());
    }

    #[test]
    fn a_second_launch_is_handled_in_order_by_the_worker() {
        let dir = tempfile::tempdir().unwrap();
        let a = write_archive(dir.path(), "a.mochi");
        let b = write_archive(dir.path(), "b.mochi");
        let l = launches();
        let sink = Sink::live();
        l.watch(sink.clone());
        for p in [&a, &b] {
            l.submit(parse(&[p.as_os_str()], &cwd()));
        }
        l.submit(Ok(None));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while sink.events().len() < 2 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let names: Vec<String> = sink
            .events()
            .into_iter()
            .map(|e| match e {
                LaunchEvent::Opened { archive, .. } => archive.file_name,
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(names, ["a.mochi", "b.mochi"]);
    }

    /// Wait until `want` finds an event in the compact window's stream.
    fn wait_quick(
        sink: &QSink,
        want: impl Fn(&crate::quick::QuickEvent) -> bool,
    ) -> crate::quick::QuickEvent {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(e) = sink.events().into_iter().find(|e| want(e)) {
                return e;
            }
            assert!(std::time::Instant::now() < deadline, "{:?}", sink.events());
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn add_form_launches(batch: Duration) -> (Launches, Arc<QSink>) {
        let l = Launches::with_batch_window(
            Arc::new(Archives::default()),
            Arc::new(Destination::default()),
            Arc::new(Foreign::default()),
            Quick::new(),
            batch,
        );
        let compact = QSink::live();
        l.inner.quick.watch(compact.clone());
        (l, compact)
    }

    fn zip_request(name: &str) -> crate::quick::QuickAddRequest {
        crate::quick::QuickAddRequest {
            name: name.to_owned(),
            format: crate::ipc::ArchiveFormat::Zip,
            level: crate::ipc::CompressionPreset::Balanced,
            passphrase: None,
            recovery_percent: None,
        }
    }

    #[test]
    fn add_is_a_quick_verb_and_never_opens_the_main_window() {
        assert!(Verb::Add.is_quick());
    }

    #[test]
    fn add_launches_of_one_selection_make_one_form_and_nothing_is_written_until_ok() {
        use crate::quick::QuickEvent;
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("trip");
        std::fs::create_dir(&folder).unwrap();
        let files: Vec<PathBuf> = ["a.txt", "b.txt", "c.txt"]
            .iter()
            .map(|n| {
                let p = folder.join(n);
                std::fs::write(&p, n.as_bytes()).unwrap();
                p
            })
            .collect();
        let (l, compact) = add_form_launches(Duration::from_millis(300));
        // One process per item, a few milliseconds apart, as Explorer does.
        for f in &files {
            l.submit(parse(
                &[OsStr::new("--add"), OsStr::new("--"), f.as_os_str()],
                &cwd(),
            ));
            std::thread::sleep(Duration::from_millis(20));
        }
        let QuickEvent::AddPrompt {
            items,
            name,
            folder: shown,
            ..
        } = wait_quick(&compact, |e| matches!(e, QuickEvent::AddPrompt { .. }))
        else {
            unreachable!()
        };
        assert_eq!(items, 3, "one form for the whole selection");
        assert_eq!(name, "trip.mochi", "named like --add-now");
        assert!(shown.text.ends_with("trip"), "{}", shown.text);
        let prompts = compact
            .events()
            .iter()
            .filter(|e| matches!(e, QuickEvent::AddPrompt { .. }))
            .count();
        assert_eq!(prompts, 1);
        // Nothing runs and nothing is written before OK.
        std::thread::sleep(Duration::from_millis(150));
        assert!(!compact
            .events()
            .iter()
            .any(|e| matches!(e, QuickEvent::Started { .. } | QuickEvent::Done { .. })));
        assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 3);
        // OK writes the archive the form describes, as a ZIP.
        l.inner.quick.submit_add(zip_request("trip")).unwrap();
        let QuickEvent::Done {
            name,
            files,
            format,
            status,
            ..
        } = wait_quick(&compact, |e| matches!(e, QuickEvent::Done { .. }))
        else {
            unreachable!()
        };
        assert_eq!((name.text.as_str(), files), ("trip.zip", 3));
        assert_eq!(format, crate::ipc::ArchiveFormat::Zip);
        assert_eq!(status, None, "a ZIP has no commit status");
        assert!(folder.join("trip.zip").is_file());
        assert!(!folder.join("trip.mochi").exists());
    }

    #[test]
    fn a_later_add_launch_joins_the_form_while_it_is_open() {
        use crate::quick::QuickEvent;
        let dir = tempfile::tempdir().unwrap();
        let one = dir.path().join("one.txt");
        let two = dir.path().join("two.txt");
        std::fs::write(&one, b"1").unwrap();
        std::fs::write(&two, b"22").unwrap();
        let (l, compact) = add_form_launches(Duration::from_millis(50));
        l.submit(parse(&[OsStr::new("--add"), one.as_os_str()], &cwd()));
        wait_quick(&compact, |e| {
            matches!(e, QuickEvent::AddPrompt { items: 1, .. })
        });
        // Well after the collection window: the form is open.
        std::thread::sleep(Duration::from_millis(200));
        l.submit(parse(&[OsStr::new("--add"), two.as_os_str()], &cwd()));
        wait_quick(&compact, |e| {
            matches!(e, QuickEvent::AddPrompt { items: 2, .. })
        });
        l.inner.quick.submit_add(zip_request("both")).unwrap();
        let QuickEvent::Done { files, .. } =
            wait_quick(&compact, |e| matches!(e, QuickEvent::Done { .. }))
        else {
            unreachable!()
        };
        assert_eq!(files, 2);
        assert!(dir.path().join("both.zip").is_file());
    }

    #[test]
    fn an_add_launch_after_ok_gets_a_form_of_its_own() {
        use crate::quick::QuickEvent;
        let dir = tempfile::tempdir().unwrap();
        let one = dir.path().join("one.txt");
        let two = dir.path().join("two.txt");
        std::fs::write(&one, b"1").unwrap();
        std::fs::write(&two, b"22").unwrap();
        let (l, compact) = add_form_launches(Duration::from_millis(50));
        l.submit(parse(&[OsStr::new("--add"), one.as_os_str()], &cwd()));
        wait_quick(&compact, |e| matches!(e, QuickEvent::AddPrompt { .. }));
        l.inner.quick.submit_add(zip_request("first")).unwrap();
        wait_quick(&compact, |e| matches!(e, QuickEvent::Done { .. }));
        l.submit(parse(&[OsStr::new("--add"), two.as_os_str()], &cwd()));
        // The second form carries only the second item, not the first.
        let QuickEvent::AddPrompt { items, subject, .. } = wait_quick(
            &compact,
            |e| matches!(e, QuickEvent::AddPrompt { subject, .. } if subject.text == "two.txt"),
        ) else {
            unreachable!()
        };
        assert_eq!(items, 1);
        assert_eq!(subject.text, "two.txt");
        l.inner.quick.closed();
        assert!(dir.path().join("first.zip").is_file());
        assert!(!dir.path().join("two.mochi").exists() && !dir.path().join("two.zip").exists());
    }

    #[test]
    fn closing_the_form_writes_nothing_and_frees_the_worker_for_the_next_form() {
        use crate::quick::QuickEvent;
        let dir = tempfile::tempdir().unwrap();
        let one = dir.path().join("one.txt");
        std::fs::write(&one, b"1").unwrap();
        let (l, compact) = add_form_launches(Duration::from_millis(50));
        l.submit(parse(&[OsStr::new("--add"), one.as_os_str()], &cwd()));
        wait_quick(&compact, |e| matches!(e, QuickEvent::AddPrompt { .. }));
        l.inner.quick.closed();
        // The worker ends the cancelled job (its event has no window to go to).
        std::thread::sleep(Duration::from_millis(150));
        let second = QSink::live();
        l.inner.quick.watch(second.clone());
        l.submit(parse(&[OsStr::new("--add"), one.as_os_str()], &cwd()));
        wait_quick(&second, |e| matches!(e, QuickEvent::AddPrompt { .. }));
        // What the first window never heard is not replayed to the next one.
        assert!(
            matches!(second.events()[0], QuickEvent::AddPrompt { .. }),
            "{:?}",
            second.events()
        );
        l.inner.quick.closed();
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            1,
            "only the item itself is in the folder"
        );
    }

    #[test]
    fn add_on_something_that_does_not_exist_fails_in_the_compact_window() {
        use crate::quick::QuickEvent;
        let dir = tempfile::tempdir().unwrap();
        let (l, compact) = add_form_launches(Duration::from_millis(50));
        l.submit(parse(
            &[OsStr::new("--add"), dir.path().join("gone").as_os_str()],
            &cwd(),
        ));
        let failed = wait_quick(&compact, |e| matches!(e, QuickEvent::Failed { .. }));
        assert!(matches!(failed, QuickEvent::Failed { .. }));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
