//! Operating-system integration (plan D6, decision O10): what the app does
//! when the shell starts it with arguments, whether that is the first launch
//! or a second one that the single-instance plugin forwards here.
//!
//! # Rules
//!
//! * **Paths from the OS stay in Rust.** The webview is told that an archive
//!   was opened (an [`ArchiveSummary`], as `open_archive` returns) or what the
//!   problem was. It never receives, and never sends, a path.
//! * **Nothing runs silently.** A verb opens an archive read-only, or stages
//!   sources, and the window then shows the existing panel: the extract plan
//!   (what would collide, and the Extract button) or the add panel. No file
//!   is written until the user presses the button there. The one exception
//!   is a folder for "Extract to folder", created empty at that point
//!   (`extract_to_folder`) so the plan has something to check.
//! * **No secret on a command line.** There is no option for a passphrase;
//!   a passphrase option is refused by name, and the refusal never repeats an
//!   option's value. Encrypted archives ask for the passphrase in the window.
//! * **Arguments are untrusted.** Every path is checked (empty, NUL, length,
//!   Windows device namespace, a verb's path count) before anything touches
//!   the file system, and a launch that does not parse changes nothing.
//! * **Foreign formats are not parsed here.** A ZIP, 7z, RAR, or tar path
//!   gets a plain "not supported yet" until the foreign-format helper
//!   (plan D8) exists.
//!
//! # Command line
//!
//! ```text
//! mochi-desktop [VERB] [--] PATH...
//!   (no verb)               open PATH read-only (what a file manager passes)
//!   --open                  the same, explicitly ("Open with MOCHI")
//!   --extract-here          open PATH, extract into the archive's folder
//!   --extract-to-folder     open PATH, extract into a folder named for it
//!   --add                   stage PATH... to add to an archive
//! ```
//!
//! `--` ends the options, so a path that starts with `-` is still a path.

use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::browse::Archives;
use crate::extract::Destination;
use crate::ipc::{ArchiveSummary, IpcError};
use crate::write::{DropWatch, Staging, MAX_STAGED};

/// Longest path accepted from the command line, in bytes (Windows allows
/// 32,767 UTF-16 units; Linux 4,096).
pub const MAX_PATH_BYTES: usize = 32 * 1024;

/// Events kept for a window that is not listening yet.
const MAX_PENDING: usize = 64;

/// What the shell asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verb {
    Open,
    ExtractHere,
    ExtractToFolder,
    Add,
}

impl Verb {
    fn from_option(name: &str) -> Option<Verb> {
        Some(match name {
            "--open" => Verb::Open,
            "--extract-here" => Verb::ExtractHere,
            "--extract-to-folder" => Verb::ExtractToFolder,
            "--add" => Verb::Add,
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
                        "only one of --open, --extract-here, --extract-to-folder, --add",
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
        (_, 0) => refuse("the command needs a path"),
        (Verb::Add, _) | (_, 1) => Ok(Some(Launch { verb, paths })),
        _ => refuse("one archive at a time: give a single path"),
    }
}

/// The arguments of this process, without the program name.
pub fn from_environment() -> Result<Option<Launch>, LaunchError> {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
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
    staging: Arc<Staging>,
    destination: Arc<Destination>,
    drops: Arc<DropWatch>,
    delivery: Mutex<Delivery>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // Only queues and a channel handle live behind these locks.
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Handles launches in the order they arrive, on one worker thread, so that
/// opening an archive never blocks the async runtime or the single-instance
/// callback, and two quick launches cannot overtake each other.
pub struct Launches {
    inner: Arc<Inner>,
    queue: Mutex<Sender<Result<Launch, LaunchError>>>,
}

impl Launches {
    pub fn new(
        archives: Arc<Archives>,
        staging: Arc<Staging>,
        destination: Arc<Destination>,
        drops: Arc<DropWatch>,
    ) -> Launches {
        let inner = Arc::new(Inner {
            archives,
            staging,
            destination,
            drops,
            delivery: Mutex::default(),
        });
        let (tx, rx) = channel::<Result<Launch, LaunchError>>();
        let worker = Arc::clone(&inner);
        // The thread ends when `Launches` (the only sender) is dropped.
        std::thread::spawn(move || {
            for item in rx {
                worker.handle(item);
            }
        });
        Launches {
            inner,
            queue: Mutex::new(tx),
        }
    }

    /// Queue a launch (or its refusal) to be handled.
    pub fn submit(&self, item: Result<Option<Launch>, LaunchError>) {
        let item = match item {
            Ok(None) => return,
            Ok(Some(launch)) => Ok(launch),
            Err(e) => Err(e),
        };
        // A send fails only if the worker is gone (a panic); nothing to do.
        let _ = lock(&self.queue).send(item);
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

    /// Handle one launch now, on the calling thread (tests).
    #[cfg(test)]
    fn handle_now(&self, item: Result<Launch, LaunchError>) {
        self.inner.handle(item);
    }
}

impl Inner {
    fn emit(&self, event: LaunchEvent) {
        let mut d = lock(&self.delivery);
        if let Some(sink) = d.sink.clone() {
            if sink.send(event.clone()) {
                return;
            }
            d.sink = None;
        }
        if d.pending.len() >= MAX_PENDING {
            d.pending.pop_front();
        }
        d.pending.push_back(event);
    }

    fn problem(&self, message: impl Into<String>) {
        self.emit(LaunchEvent::Problem {
            message: message.into(),
        });
    }

    fn handle(&self, item: Result<Launch, LaunchError>) {
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
                let outcome = self.staging.add(&launch.paths);
                self.drops.announce_staged(outcome);
            }
            Verb::Open | Verb::ExtractHere | Verb::ExtractToFolder => {
                // `parse` guarantees exactly one path for these verbs.
                if let Some(path) = launch.paths.first() {
                    self.open(launch.verb, path);
                }
            }
        }
    }

    fn open(&self, verb: Verb, path: &Path) {
        let shown = path.display();
        if let Some(kind) = foreign_kind(path) {
            return self.problem(format!(
                "{shown}: {kind} archives cannot be opened yet. MOCHI opens .mochi archives."
            ));
        }
        match std::fs::metadata(path) {
            Ok(m) if m.is_file() => {}
            Ok(_) => return self.problem(format!("{shown} is not a file.")),
            Err(e) => return self.problem(format!("{shown} cannot be read: {e}.")),
        }
        let archive = match self
            .archives
            .open(path, mochi_core::publish::ReadOptions::default())
        {
            Ok(a) => a,
            Err(e) => {
                let e = IpcError::from(e);
                return self.problem(format!(
                    "{shown} could not be opened ({}): {}",
                    e.code, e.message
                ));
            }
        };
        let extract = verb != Verb::Open;
        if extract {
            let folder = match verb {
                Verb::ExtractHere => extract_here(path),
                _ => extract_to_folder(path),
            };
            match folder {
                Ok(folder) => self.destination.set(folder),
                Err(why) => {
                    // The archive is open and shown; only the extract is off.
                    self.problem(format!("{shown}: {why}."));
                    return self.emit(LaunchEvent::Opened {
                        archive,
                        extract: false,
                    });
                }
            }
        }
        self.emit(LaunchEvent::Opened { archive, extract });
    }
}

/// The archive's own folder.
fn extract_here(archive: &Path) -> Result<PathBuf, String> {
    archive
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .ok_or_else(|| "the archive has no folder to extract into".to_owned())
}

/// A folder next to the archive named for it (`a.mochi` → `a`). Created
/// empty when it does not exist, because the plan checks an existing folder;
/// an existing folder is used as it is (the plan lists what would collide).
fn extract_to_folder(archive: &Path) -> Result<PathBuf, String> {
    let parent = extract_here(archive)?;
    let stem = archive
        .file_stem()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "the archive has no name to make a folder from".to_owned())?;
    let folder = parent.join(stem);
    match std::fs::metadata(&folder) {
        Ok(m) if m.is_dir() => Ok(folder),
        Ok(_) => Err(format!(
            "{} exists and is not a folder; choose a folder to extract into",
            folder.display()
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Not `create_dir_all`: the archive's own folder exists.
            std::fs::create_dir(&folder)
                .map(|()| folder.clone())
                .map_err(|e| format!("the folder {} could not be created: {e}", folder.display()))
        }
        Err(e) => Err(format!("{} cannot be checked: {e}", folder.display())),
    }
}

/// The foreign format a name suggests, by extension only (the helper that
/// parses them is plan D8; until then they are refused plainly).
pub fn foreign_kind(path: &Path) -> Option<&'static str> {
    let name = path.file_name()?.to_string_lossy().to_ascii_lowercase();
    const SUFFIXES: [(&str, &str); 7] = [
        (".zip", "ZIP"),
        (".7z", "7z"),
        (".rar", "RAR"),
        (".tar.gz", "tar.gz"),
        (".tgz", "tar.gz"),
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
        assert!(
            parsed(&["--extract-here", "a", "b"]).is_err(),
            "one archive"
        );
        assert!(parsed(&["a.mochi", "b.mochi"]).is_err(), "one archive");
        assert!(parsed(&["--open", "--add", "a"]).is_err(), "one verb");
        let l = parsed(&["--add", "a", "b", "c"]).unwrap().unwrap();
        assert_eq!(l.paths.len(), 3);
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
            ("a.tar", "tar"),
        ] {
            assert_eq!(foreign_kind(Path::new(name)), Some(kind), "{name}");
        }
        assert_eq!(foreign_kind(Path::new("a.mochi")), None);
        assert_eq!(foreign_kind(Path::new("zip")), None);
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

    fn launches() -> Launches {
        Launches::new(
            Arc::new(Archives::default()),
            Arc::new(Staging::default()),
            Arc::new(Destination::default()),
            Arc::new(DropWatch::default()),
        )
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
    fn a_foreign_archive_is_refused_plainly_and_never_opened() {
        let l = launches();
        let sink = Sink::live();
        l.watch(sink.clone());
        l.handle_now(Ok(Launch {
            verb: Verb::Open,
            paths: vec![abs("nowhere/x.zip")],
        }));
        let events = sink.events();
        assert!(
            matches!(&events[0], LaunchEvent::Problem { message } if message.contains("ZIP archives cannot be opened yet")),
            "{events:?}"
        );
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
    fn open_shows_the_archive_and_extract_verbs_choose_the_folder_in_rust() {
        let dir = tempfile::tempdir().unwrap();
        let archive = write_archive(dir.path(), "photos.mochi");
        let l = launches();
        let sink = Sink::live();
        l.watch(sink.clone());
        for verb in [Verb::Open, Verb::ExtractHere, Verb::ExtractToFolder] {
            l.handle_now(Ok(Launch {
                verb,
                paths: vec![archive.clone()],
            }));
        }
        let events = sink.events();
        assert_eq!(events.len(), 3, "{events:?}");
        let extract: Vec<bool> = events
            .iter()
            .map(|e| match e {
                LaunchEvent::Opened { archive, extract } => {
                    assert_eq!(archive.file_name, "photos.mochi");
                    *extract
                }
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(extract, [false, true, true]);
        // The last extract chose the sibling folder; nothing was extracted.
        assert_eq!(l.inner.destination.get(), Some(dir.path().join("photos")));
        let listing: Vec<_> = std::fs::read_dir(dir.path().join("photos"))
            .unwrap()
            .collect();
        assert!(
            listing.is_empty(),
            "opening is read-only; extracting waits for the user"
        );
        assert_eq!(l.inner.archives.open_count(), 3);
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

    #[test]
    fn add_stages_in_rust_and_announces_like_a_drop() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.txt");
        std::fs::write(&file, b"x").unwrap();
        let l = launches();
        l.handle_now(Ok(Launch {
            verb: Verb::Add,
            paths: vec![file.clone(), dir.path().join("missing")],
        }));
        // Nobody listened to drops yet: the announcement waits.
        struct Drops(Mutex<Vec<crate::ipc::DropEvent>>);
        impl crate::write::DropSink for Drops {
            fn send(&self, event: crate::ipc::DropEvent) -> bool {
                self.0.lock().unwrap().push(event);
                true
            }
        }
        let drops = Arc::new(Drops(Mutex::default()));
        l.inner.drops.set(drops.clone());
        let got = drops.0.lock().unwrap().clone();
        assert_eq!(got.len(), 1);
        let crate::ipc::DropEvent::Dropped { staged, problems } = &got[0] else {
            panic!("{got:?}")
        };
        assert_eq!(staged.items.len(), 1);
        assert_eq!(staged.items[0].name.text, "notes.txt");
        assert_eq!(problems.len(), 1, "the missing path is explained");
        assert_eq!(l.inner.staging.view().items.len(), 1);
    }

    #[test]
    fn extract_destinations_are_the_archives_folder_or_a_sibling_named_for_it() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("photos.mochi");
        assert_eq!(extract_here(&archive).unwrap(), dir.path());
        let folder = extract_to_folder(&archive).unwrap();
        assert_eq!(folder, dir.path().join("photos"));
        assert!(folder.is_dir(), "created empty so the plan can check it");
        // Again: the existing folder is used, not replaced.
        std::fs::write(folder.join("keep"), b"1").unwrap();
        assert_eq!(extract_to_folder(&archive).unwrap(), folder);
        assert!(folder.join("keep").exists());
        // A file in the way is refused, not overwritten.
        let blocked = dir.path().join("blocked.mochi");
        std::fs::write(dir.path().join("blocked"), b"file").unwrap();
        assert!(extract_to_folder(&blocked).is_err());
        assert!(extract_here(Path::new("bare.mochi")).is_err());
    }
}
