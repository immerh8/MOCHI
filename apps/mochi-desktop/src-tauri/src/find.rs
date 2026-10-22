//! MOCHI Find: search the file names inside every `.mochi` archive under some
//! folders (plan D5 extension; spec §19.1 discovery, §23.3 #8 coverage).
//!
//! # How it works
//!
//! * **Scopes.** The user picks folders (the shell's "Find in MOCHI archives",
//!   the desktop entry, or the in-app picker). Rust holds the paths; the window
//!   sees them as text to show and never sends one back.
//! * **Scan** (a job: [`mochi_core::job::JobContext`] progress and
//!   cancellation, forwarded over a `Channel` as [`FindEvent`]). One thread
//!   walks the folders for `*.mochi` files; a bounded pool opens each archive
//!   **read-only** through `mochi_core` ([`open_head`], which hash-verifies the
//!   catalog image before it is opened, then [`search`] over the head with an
//!   empty query). No file content is read or hashed. The entry names, kinds
//!   and sizes of each archive's head snapshot are kept in memory.
//! * **Cache.** Per-archive name lists live for the session, keyed by
//!   (path, size, modified time). A new query is answered from memory; a new
//!   scan re-reads only archives whose key changed. There is no on-disk cache.
//! * **Query** ([`Finder::query`]): a name substring (ASCII/Unicode
//!   case-insensitive, matched against the last path component), or a glob when
//!   the text has `*` or `?` (matched against the whole component). Text with a
//!   `/` is matched against the whole path inside the archive.
//! * **Coverage** (§23.3 #8). Every result carries what was searched and what
//!   was not: archives that are Encrypted (names cannot be read without the
//!   passphrase), damaged, unreadable, not MOCHI archives, in an unsupported
//!   format, or too large to hold; folders that could not be read; linked
//!   folders that were not followed; limits that stopped the walk; and whether
//!   the scan was stopped. Zero matches with any of those is **incomplete**,
//!   never "no matches" (`complete` is `false`).
//!
//! # Rules kept
//!
//! * Archives are untrusted: names cross as escaped [`NameText`]; nothing here
//!   is parsed except through `mochi_core`.
//! * Read-only: archives are opened with `OsReadStorage`, never for writing.
//! * No symbolic link or junction is followed (no loop is possible); depth,
//!   folder, archive and name counts are bounded.
//! * An Encrypted archive is never opened with a key here: Find has no
//!   passphrase, and says so.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use mochi_core::catalog::namespace::EntryKind;
use mochi_core::job::{CancellationToken, JobContext, NullProgress, ProgressEvent, ProgressSink};
use mochi_core::publish::{open_head, ReadOptions};
use mochi_core::search::{search, Query, SnapshotScope};
use mochi_core::storage::os::OsReadStorage;
use mochi_core::{ErrorCode, MochiError};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use ts_rs::TS;

use crate::browse::{hex, kind};
use crate::commands::Win;
use crate::ipc::{DialogText, EntryKindView, IpcError, NameText, OpenOutcome};
use crate::jobs::Spawner;
use crate::launch::Launches;

/// Progress phase of the scan: `completed` is archives finished, `total` the
/// archives found once the walk is over.
pub const PHASE: &str = "find_scan";

/// Deepest folder level walked below a scope.
pub const MAX_DEPTH: usize = 48;
/// Most folders walked in one scan.
pub const MAX_FOLDERS: u64 = 200_000;
/// Most archives found in one scan.
pub const MAX_ARCHIVES: usize = 20_000;
/// Most names one archive may hold for Find (a bigger one is "too large").
pub const MAX_ENTRIES_PER_ARCHIVE: usize = 1_000_000;
/// Most names one scan holds in memory across all archives.
pub const MAX_ENTRIES_TOTAL: usize = 3_000_000;
/// Most scope folders.
pub const MAX_SCOPES: usize = 64;
/// Most workers opening archives at once.
pub const MAX_WORKERS: usize = 8;
/// Hits that cross IPC. More are counted (`total_hits`) and the UI says so.
pub const MAX_HITS_SHOWN: usize = 1_000;
/// Archives listed by name in the coverage; the rest are counted.
pub const MAX_SKIPPED_SHOWN: usize = 200;
/// The longest query accepted, in bytes.
pub const MAX_QUERY_BYTES: usize = 1_024;
/// Fewest milliseconds between two progress events (the last is always sent).
const PROGRESS_EVERY: Duration = Duration::from_millis(120);

fn invalid(what: impl Into<String>) -> IpcError {
    IpcError {
        code: ErrorCode::InvalidArgument.as_str().to_owned(),
        message: what.into(),
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // Only plain data lives behind these locks; a panic elsewhere leaves it usable.
    m.lock().unwrap_or_else(|p| p.into_inner())
}

// ---- what is kept per archive --------------------------------------------

/// What identifies one version of an archive file for the cache.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Stamp {
    size: u64,
    mtime: Option<SystemTime>,
}

impl Stamp {
    fn of(meta: &std::fs::Metadata) -> Stamp {
        Stamp {
            size: meta.len(),
            mtime: meta.modified().ok(),
        }
    }

    fn modified_ms(&self) -> Option<i64> {
        let d = self.mtime?.duration_since(UNIX_EPOCH).ok()?;
        i64::try_from(d.as_millis()).ok()
    }
}

struct Slot {
    start: u32,
    len: u32,
    size: u64,
    dir: bool,
}

/// The names of one archive's head snapshot: one byte arena and one slot per
/// entry, in the catalog's path order.
#[derive(Default)]
pub struct ArchiveIndex {
    names: Vec<u8>,
    slots: Vec<Slot>,
}

impl ArchiveIndex {
    fn push(&mut self, path: &[u8], size: u64, dir: bool) -> bool {
        let (Ok(start), Ok(len)) = (u32::try_from(self.names.len()), u32::try_from(path.len()))
        else {
            return false;
        };
        if start.checked_add(len).is_none() {
            return false;
        }
        self.names.extend_from_slice(path);
        self.slots.push(Slot {
            start,
            len,
            size,
            dir,
        });
        true
    }

    /// Number of entries (files and folders).
    pub fn len(&self) -> usize {
        self.slots.len()
    }

    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }

    fn path(&self, slot: &Slot) -> &[u8] {
        let start = slot.start as usize;
        self.names
            .get(start..start + slot.len as usize)
            .unwrap_or_default()
    }
}

/// Why an archive could not be searched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Skip {
    /// The file does not start like a MOCHI archive.
    NotMochi,
    /// Encrypted: names are sealed without the passphrase, which Find never has.
    Encrypted,
    /// A draft or newer format this build does not read.
    Unsupported { code: String },
    /// Damaged, truncated, or otherwise refused by `mochi_core`.
    Damaged { code: String, message: String },
    /// Too many names to hold in memory.
    TooLarge,
    /// The file could not be opened or read.
    Unreadable { message: String },
}

#[derive(Clone)]
enum Outcome {
    Indexed(Arc<ArchiveIndex>),
    Skipped(Skip),
}

/// Open one archive read-only and list the names of its head snapshot. Only
/// cancellation is an `Err`; every other failure is the archive's `Skip`.
fn index_archive(path: &Path, cancel: &CancellationToken) -> Result<Outcome, MochiError> {
    if !crate::route::has_mochi_magic(path) {
        return Ok(Outcome::Skipped(Skip::NotMochi));
    }
    let src = match OsReadStorage::open(path) {
        Ok(s) => s,
        Err(e) => {
            return Ok(Outcome::Skipped(Skip::Unreadable {
                message: MochiError::from(e).message,
            }))
        }
    };
    // No keys: an Encrypted archive opens structurally and stays sealed.
    let opts = ReadOptions::default();
    let skip = |e: MochiError| match e.code {
        ErrorCode::Cancelled => Err(e),
        ErrorCode::KeyUnavailable => Ok(Outcome::Skipped(Skip::Encrypted)),
        ErrorCode::UnsupportedFeature => Ok(Outcome::Skipped(Skip::Unsupported {
            code: e.code.as_str().to_owned(),
        })),
        ErrorCode::IoError => Ok(Outcome::Skipped(Skip::Unreadable { message: e.message })),
        code => Ok(Outcome::Skipped(Skip::Damaged {
            code: code.as_str().to_owned(),
            message: e.message,
        })),
    };
    let head = match open_head(&src, &opts) {
        Ok(h) => h,
        Err(e) => return skip(e),
    };
    if head.descriptor.encrypted() && head.unlocked.is_none() {
        return Ok(Outcome::Skipped(Skip::Encrypted));
    }
    let ctx = JobContext {
        progress: &NullProgress,
        cancel,
    };
    let result = match search(
        &src,
        &head,
        SnapshotScope::Head,
        &Query::default(),
        &opts,
        &ctx,
    ) {
        Ok(r) => r,
        Err(e) => return skip(e),
    };
    if !result.coverage.complete() {
        let reason = result
            .coverage
            .unavailable
            .first()
            .map(|u| u.error.clone())
            .unwrap_or_else(|| {
                MochiError::new(
                    ErrorCode::CatalogInvalid,
                    "the head snapshot was not covered",
                )
            });
        return skip(reason);
    }
    if result.hits.len() > MAX_ENTRIES_PER_ARCHIVE {
        return Ok(Outcome::Skipped(Skip::TooLarge));
    }
    let mut index = ArchiveIndex::default();
    index.slots.reserve(result.hits.len());
    for h in &result.hits {
        let dir = h.kind == EntryKind::Directory;
        if !index.push(h.path.as_stored(), h.logical_len, dir) {
            return Ok(Outcome::Skipped(Skip::TooLarge));
        }
    }
    Ok(Outcome::Indexed(Arc::new(index)))
}

// ---- the cache and one run -------------------------------------------------

#[derive(Default)]
struct CacheInner {
    map: HashMap<PathBuf, (Stamp, Outcome)>,
    entries: usize,
}

/// Name lists kept for the session, keyed by path and checked against size and
/// modified time. Failures that may be temporary (`Unreadable`) are not kept.
#[derive(Default)]
pub struct Cache {
    inner: Mutex<CacheInner>,
}

impl Cache {
    fn get(&self, path: &Path, stamp: &Stamp) -> Option<Outcome> {
        let c = lock(&self.inner);
        match c.map.get(path) {
            Some((s, o)) if s == stamp => Some(o.clone()),
            _ => None,
        }
    }

    fn put(&self, path: &Path, stamp: Stamp, outcome: &Outcome) {
        let n = match outcome {
            Outcome::Indexed(ix) => ix.len(),
            Outcome::Skipped(Skip::Unreadable { .. }) => return,
            Outcome::Skipped(_) => 0,
        };
        let mut c = lock(&self.inner);
        if let Some((_, Outcome::Indexed(old))) = c.map.remove(path) {
            c.entries = c.entries.saturating_sub(old.len());
        }
        // A cache is only a cache: when it would outgrow the budget it starts over.
        if c.entries.saturating_add(n) > MAX_ENTRIES_TOTAL {
            c.map.clear();
            c.entries = 0;
        }
        c.entries += n;
        c.map.insert(path.to_path_buf(), (stamp, outcome.clone()));
    }

    /// Forget everything (the "Scan again" button).
    pub fn clear(&self) {
        let mut c = lock(&self.inner);
        c.map.clear();
        c.entries = 0;
    }

    /// Archives held.
    pub fn len(&self) -> usize {
        lock(&self.inner).map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// A limit that stopped the walk early.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum FindLimit {
    Depth,
    Folders,
    Archives,
}

#[derive(Default, Clone)]
struct Walk {
    folders: u64,
    unreadable: u64,
    links: u64,
    limit: Option<FindLimit>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum FindState {
    /// No scan has run.
    Idle,
    Running,
    Complete,
    /// Stopped by the user: what was found so far is searchable, and incomplete.
    Cancelled,
    Failed,
}

struct Record {
    path: PathBuf,
    stamp: Stamp,
    /// `None` while the archive waits to be opened.
    outcome: Option<Outcome>,
}

struct RunInner {
    records: Vec<Record>,
    walk: Walk,
    state: FindState,
    failure: Option<String>,
    from_cache: u64,
}

/// One scan and what it found. The window refers to it by `id`.
pub struct RunState {
    id: u32,
    scopes: Vec<PathBuf>,
    inner: Mutex<RunInner>,
    found: AtomicUsize,
    done: AtomicUsize,
    held: AtomicUsize,
    walk_done: AtomicBool,
}

impl RunState {
    fn new(id: u32, scopes: Vec<PathBuf>) -> Self {
        RunState {
            id,
            scopes,
            inner: Mutex::new(RunInner {
                records: Vec::new(),
                walk: Walk::default(),
                state: FindState::Running,
                failure: None,
                from_cache: 0,
            }),
            found: AtomicUsize::new(0),
            done: AtomicUsize::new(0),
            held: AtomicUsize::new(0),
            walk_done: AtomicBool::new(false),
        }
    }
}

/// Bounds of a scan (tests lower them).
#[derive(Debug, Clone)]
pub struct Limits {
    pub depth: usize,
    pub folders: u64,
    pub archives: usize,
    pub entries_total: usize,
    pub workers: usize,
}

impl Default for Limits {
    fn default() -> Self {
        let cpus = std::thread::available_parallelism().map_or(2, usize::from);
        Limits {
            depth: MAX_DEPTH,
            folders: MAX_FOLDERS,
            archives: MAX_ARCHIVES,
            entries_total: MAX_ENTRIES_TOTAL,
            workers: cpus.clamp(2, MAX_WORKERS),
        }
    }
}

fn is_archive_name(name: &std::ffi::OsStr) -> bool {
    Path::new(name)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("mochi"))
}

/// Walk the scopes, registering each `.mochi` file and sending its record
/// index to the workers. Symbolic links and junctions are counted, not followed.
fn walk(
    run: &RunState,
    limits: &Limits,
    ctx: &JobContext<'_>,
    tx: &std::sync::mpsc::SyncSender<usize>,
) {
    let mut stats = Walk::default();
    let mut stack: Vec<(PathBuf, usize)> =
        run.scopes.iter().rev().map(|p| (p.clone(), 0)).collect();
    'dirs: while let Some((dir, depth)) = stack.pop() {
        if ctx.cancel.is_cancelled() {
            break;
        }
        if stats.folders >= limits.folders {
            stats.limit = Some(FindLimit::Folders);
            break;
        }
        stats.folders += 1;
        let Ok(read) = std::fs::read_dir(&dir) else {
            stats.unreadable += 1;
            continue;
        };
        let mut subdirs: Vec<PathBuf> = Vec::new();
        let mut archives: Vec<(PathBuf, Stamp)> = Vec::new();
        for entry in read {
            let Ok(entry) = entry else {
                stats.unreadable += 1;
                continue;
            };
            let Ok(ft) = entry.file_type() else {
                stats.unreadable += 1;
                continue;
            };
            if ft.is_symlink() {
                // A linked folder or file is not followed: it cannot loop, and
                // the coverage says so.
                if is_archive_name(&entry.file_name())
                    || std::fs::metadata(entry.path()).is_ok_and(|m| m.is_dir())
                {
                    stats.links += 1;
                }
            } else if ft.is_dir() {
                if depth >= limits.depth {
                    stats.limit = Some(FindLimit::Depth);
                } else {
                    subdirs.push(entry.path());
                }
            } else if ft.is_file() && is_archive_name(&entry.file_name()) {
                match entry.metadata() {
                    Ok(meta) => archives.push((entry.path(), Stamp::of(&meta))),
                    Err(_) => stats.unreadable += 1,
                }
            }
        }
        // Archives of a folder in name order, then its subfolders in name
        // order: results appear in a steady order.
        archives.sort_by(|a, b| a.0.cmp(&b.0));
        for (path, stamp) in archives {
            let idx = {
                let mut inner = lock(&run.inner);
                if inner.records.len() >= limits.archives {
                    stats.limit = Some(FindLimit::Archives);
                    break 'dirs;
                }
                inner.records.push(Record {
                    path,
                    stamp,
                    outcome: None,
                });
                inner.records.len() - 1
            };
            run.found.fetch_add(1, Ordering::SeqCst);
            ctx.report(PHASE, run.done.load(Ordering::SeqCst) as u64, None);
            if tx.send(idx).is_err() {
                break 'dirs;
            }
        }
        subdirs.sort();
        stack.extend(subdirs.into_iter().rev().map(|p| (p, depth + 1)));
    }
    lock(&run.inner).walk = stats;
    run.walk_done.store(true, Ordering::SeqCst);
}

/// Open one registered archive (from the cache when its stamp is unchanged)
/// and store the outcome.
fn process(
    cache: &Cache,
    run: &RunState,
    limits: &Limits,
    ctx: &JobContext<'_>,
    idx: usize,
) -> Result<(), MochiError> {
    ctx.check_cancelled()?;
    let (path, stamp) = {
        let inner = lock(&run.inner);
        let Some(r) = inner.records.get(idx) else {
            return Ok(());
        };
        (r.path.clone(), r.stamp)
    };
    let (mut outcome, cached) = match cache.get(&path, &stamp) {
        Some(o) => (o, true),
        None => (index_archive(&path, ctx.cancel)?, false),
    };
    if let Outcome::Indexed(ix) = &outcome {
        let n = ix.len();
        if run.held.fetch_add(n, Ordering::SeqCst).saturating_add(n) > limits.entries_total {
            run.held.fetch_sub(n, Ordering::SeqCst);
            outcome = Outcome::Skipped(Skip::TooLarge);
        }
    }
    if !cached {
        cache.put(&path, stamp, &outcome);
    }
    {
        let mut inner = lock(&run.inner);
        if cached {
            inner.from_cache += 1;
        }
        if let Some(r) = inner.records.get_mut(idx) {
            r.outcome = Some(outcome);
        }
    }
    let done = run.done.fetch_add(1, Ordering::SeqCst) + 1;
    let total = run
        .walk_done
        .load(Ordering::SeqCst)
        .then(|| run.found.load(Ordering::SeqCst) as u64);
    ctx.report(PHASE, done as u64, total);
    Ok(())
}

/// Scan the run's scopes: one walking thread, `limits.workers` opening
/// archives. `Err(CANCELLED)` if cancelled; what was found stays in `run`.
pub fn scan(
    cache: &Cache,
    run: &RunState,
    limits: &Limits,
    ctx: &JobContext<'_>,
) -> Result<(), MochiError> {
    let (tx, rx) = sync_channel::<usize>(256);
    let rx = Mutex::new(rx);
    std::thread::scope(|s| {
        for _ in 0..limits.workers.max(1) {
            s.spawn(|| loop {
                let next = lock(&rx).recv();
                let Ok(idx) = next else { return };
                if process(cache, run, limits, ctx, idx).is_err() {
                    // Cancelled: drain without working so the walker never blocks.
                    while lock(&rx).recv().is_ok() {}
                    return;
                }
            });
        }
        walk(run, limits, ctx, &tx);
        drop(tx);
    });
    // The walk is over even if it was cut short: report the final count.
    let total = run.found.load(Ordering::SeqCst) as u64;
    ctx.report(PHASE, run.done.load(Ordering::SeqCst) as u64, Some(total));
    ctx.check_cancelled()
}

// ---- matching --------------------------------------------------------------

/// What a query asks for. Names match as bytes of the stored path (O24); the
/// only normalization is case folding, applied to the comparison only.
#[derive(Debug, Clone)]
pub struct Matcher {
    kind: MatcherKind,
    ignore_case: bool,
    whole_path: bool,
}

#[derive(Debug, Clone)]
enum MatcherKind {
    Any,
    Substring { raw: Vec<u8>, lower: String },
    Glob(Vec<char>),
}

fn chars_of(bytes: &[u8], ignore_case: bool) -> Vec<char> {
    match std::str::from_utf8(bytes) {
        Ok(s) if ignore_case => s.chars().flat_map(char::to_lowercase).collect(),
        Ok(s) => s.chars().collect(),
        Err(_) => bytes
            .iter()
            .map(|&b| {
                if ignore_case {
                    char::from(b.to_ascii_lowercase())
                } else {
                    char::from(b)
                }
            })
            .collect(),
    }
}

/// `*` matches any run, `?` any one character; the pattern covers the whole text.
fn glob(p: &[char], t: &[char]) -> bool {
    let (mut pi, mut ti) = (0usize, 0usize);
    let mut star: Option<usize> = None;
    let mut mark = 0usize;
    while ti < t.len() {
        match p.get(pi) {
            Some('*') => {
                star = Some(pi);
                mark = ti;
                pi += 1;
            }
            Some(&c) if c == '?' || c == t[ti] => {
                pi += 1;
                ti += 1;
            }
            _ => match star {
                Some(s) => {
                    pi = s + 1;
                    mark += 1;
                    ti = mark;
                }
                None => return false,
            },
        }
    }
    while p.get(pi) == Some(&'*') {
        pi += 1;
    }
    pi == p.len()
}

impl Matcher {
    /// `text` is the user's query. Empty matches everything.
    pub fn new(text: &str, ignore_case: bool) -> Matcher {
        let text = text.trim();
        let whole_path = text.contains('/');
        let kind = if text.is_empty() {
            MatcherKind::Any
        } else if text.contains(['*', '?']) {
            MatcherKind::Glob(chars_of(text.as_bytes(), ignore_case))
        } else {
            MatcherKind::Substring {
                raw: text.as_bytes().to_vec(),
                lower: text.to_lowercase(),
            }
        };
        Matcher {
            kind,
            ignore_case,
            whole_path,
        }
    }

    /// Whether the stored path `path` matches.
    pub fn matches(&self, path: &[u8]) -> bool {
        let target = if self.whole_path {
            path
        } else {
            path.rsplit(|&b| b == b'/').next().unwrap_or(path)
        };
        match &self.kind {
            MatcherKind::Any => true,
            MatcherKind::Glob(p) => glob(p, &chars_of(target, self.ignore_case)),
            MatcherKind::Substring { raw, lower } => {
                if !self.ignore_case {
                    return contains(target, raw, false);
                }
                if lower.is_ascii() {
                    return contains(target, lower.as_bytes(), true);
                }
                match std::str::from_utf8(target) {
                    Ok(s) => s.to_lowercase().contains(lower.as_str()),
                    Err(_) => contains(target, raw, false),
                }
            }
        }
    }
}

fn contains(hay: &[u8], needle: &[u8], fold: bool) -> bool {
    if needle.is_empty() {
        return true;
    }
    if needle.len() > hay.len() {
        return false;
    }
    hay.windows(needle.len()).any(|w| {
        if fold {
            w.eq_ignore_ascii_case(needle)
        } else {
            w == needle
        }
    })
}

/// The matches in one archive: how many, and the first few as slot numbers.
type Matched = (u64, Vec<u32>);

/// (matches, the first `cap` of them as slot numbers) in one archive.
fn matches_in(ix: &ArchiveIndex, m: &Matcher, cap: usize) -> Matched {
    let mut count = 0u64;
    let mut first = Vec::new();
    for (i, slot) in ix.slots.iter().enumerate() {
        if m.matches(ix.path(slot)) {
            count += 1;
            if first.len() < cap {
                first.push(u32::try_from(i).unwrap_or(u32::MAX));
            }
        }
    }
    (count, first)
}

// ---- what crosses IPC ------------------------------------------------------

/// A folder to search, as text to show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct FindScopeView {
    pub index: u32,
    pub path: String,
}

/// One matching entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct FindHit {
    /// Which scan, and which archive of it: what `find_open_hit` takes.
    pub run: u32,
    pub archive: u32,
    /// The archive file on this computer, as text to show.
    pub archive_path: String,
    /// The archive file's modified time, milliseconds since 1970 (the archive's
    /// catalog records no per-entry time that Find reads).
    #[ts(type = "number | null")]
    pub archive_modified_ms: Option<i64>,
    /// The entry's full path inside the archive (archive-supplied: escaped text).
    pub path: NameText,
    /// The path's exact stored bytes, hex: for opening the entry's folder.
    pub key: String,
    pub kind: EntryKindView,
    /// Decimal string; `"0"` for a folder.
    pub size: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum FindSkipReason {
    NotMochi,
    Encrypted,
    Unsupported,
    Damaged,
    TooLarge,
    Unreadable,
}

/// An archive that could not be searched, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct FindSkippedView {
    pub archive: u32,
    pub path: String,
    pub reason: FindSkipReason,
    /// The stable error code, when `mochi_core` gave one.
    pub code: Option<String>,
    /// `mochi_core`'s sentence (it can quote archive content: escaped text).
    pub message: Option<NameText>,
}

/// What a scan covered and what it did not (spec §19.3, §23.3 #8).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct FindCoverageView {
    pub run: u32,
    pub state: FindState,
    /// `true` only when the scan finished, every archive found was searched,
    /// every folder was read, nothing was left unfollowed, and no limit was hit:
    /// the only state in which "no matches" means none.
    pub complete: bool,
    #[ts(type = "number")]
    pub folders_visited: u64,
    #[ts(type = "number")]
    pub folders_unreadable: u64,
    /// Linked folders or archives that were not followed.
    #[ts(type = "number")]
    pub links_not_followed: u64,
    pub limit: Option<FindLimit>,
    #[ts(type = "number")]
    pub archives_found: u64,
    /// Archives whose names were searched.
    #[ts(type = "number")]
    pub archives_searched: u64,
    /// Archives found but not yet opened (a scan that is running or was stopped).
    #[ts(type = "number")]
    pub archives_pending: u64,
    /// Of `archives_searched`, how many came from the session's cache.
    #[ts(type = "number")]
    pub archives_from_cache: u64,
    #[ts(type = "number")]
    pub archives_skipped: u64,
    /// The first [`MAX_SKIPPED_SHOWN`] of them.
    pub skipped: Vec<FindSkippedView>,
    #[ts(type = "number")]
    pub names_searched: u64,
    pub scopes: Vec<String>,
    /// A failure that ended the scan, if one did.
    pub failure: Option<String>,
    /// Always `true`: only names are searched, never file content (§19.2).
    pub content_not_searched: bool,
}

/// A query's hits (at most [`MAX_HITS_SHOWN`]) and the coverage they were drawn from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct FindResultView {
    pub hits: Vec<FindHit>,
    /// All matches, shown or not.
    #[ts(type = "number")]
    pub total_hits: u64,
    pub coverage: FindCoverageView,
}

/// What the scan job tells the window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "event", rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum FindEvent {
    Started {
        run: u32,
    },
    /// Archives finished and, once the walk is over, the number found. The
    /// window then asks `find_query` again; the numbers are not the coverage.
    Progress {
        run: u32,
        #[ts(type = "number")]
        completed: u64,
        #[ts(type = "number | null")]
        total: Option<u64>,
    },
    Finished {
        run: u32,
        state: FindState,
    },
}

/// Where scan events go (a Tauri `Channel` in the app).
pub trait FindSink: Send + Sync + 'static {
    /// `false` once nobody listens (the scan is then cancelled).
    fn send(&self, event: FindEvent) -> bool;
}

impl FindSink for Channel<FindEvent> {
    fn send(&self, event: FindEvent) -> bool {
        Channel::send(self, event).is_ok()
    }
}

/// Forwards `mochi_core` progress as [`FindEvent::Progress`], at most one per
/// [`PROGRESS_EVERY`] (the last always goes).
struct Forward<'a> {
    run: u32,
    sink: &'a dyn FindSink,
    token: &'a CancellationToken,
    last: Mutex<Option<Instant>>,
}

impl ProgressSink for Forward<'_> {
    fn report(&self, event: &ProgressEvent) {
        let last_of_all = event.total == Some(event.completed);
        {
            let mut last = lock(&self.last);
            let now = Instant::now();
            if !last_of_all && last.is_some_and(|t| now.duration_since(t) < PROGRESS_EVERY) {
                return;
            }
            *last = Some(now);
        }
        if !self.sink.send(FindEvent::Progress {
            run: self.run,
            completed: event.completed,
            total: event.total,
        }) {
            self.token.cancel();
        }
    }
}

// ---- the finder -------------------------------------------------------------

#[derive(Default)]
struct FinderInner {
    scopes: Vec<PathBuf>,
    run: Option<Arc<RunState>>,
    token: Option<CancellationToken>,
    last_run: u32,
}

/// Scope folders, the session's cache, and the latest scan.
#[derive(Default)]
pub struct Finder {
    inner: Mutex<FinderInner>,
    cache: Arc<Cache>,
    limits: Mutex<Option<Limits>>,
}

/// The folders as the scan walks them: absolute, existing, without a folder
/// that lies inside another one in the list, and without duplicates.
fn normalize(paths: Vec<PathBuf>, existing: &[PathBuf]) -> Vec<PathBuf> {
    let key = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let mut all: Vec<(PathBuf, PathBuf)> = existing
        .iter()
        .chain(paths.iter())
        .filter(|p| p.is_absolute() && p.is_dir())
        .map(|p| (p.clone(), key(p)))
        .collect();
    let mut out: Vec<(PathBuf, PathBuf)> = Vec::new();
    // Shortest first, so a folder is kept before the ones inside it.
    all.sort_by_key(|(_, k)| k.components().count());
    for (p, k) in all {
        if !out.iter().any(|(_, ok)| k.starts_with(ok)) {
            out.push((p, k));
        }
    }
    // Back to the order the user gave them.
    let order = |p: &PathBuf| {
        existing
            .iter()
            .chain(paths.iter())
            .position(|x| x == p)
            .unwrap_or(usize::MAX)
    };
    out.sort_by_key(|(p, _)| order(p));
    out.into_iter().map(|(p, _)| p).collect()
}

fn scope_views(scopes: &[PathBuf]) -> Vec<FindScopeView> {
    scopes
        .iter()
        .enumerate()
        .map(|(i, p)| FindScopeView {
            index: u32::try_from(i).unwrap_or(u32::MAX),
            path: p.display().to_string(),
        })
        .collect()
}

/// An entry of a scanned archive, as the window asks to be shown it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundEntry {
    /// The exact stored path, hex.
    pub key: String,
    pub path: NameText,
    pub kind: EntryKindView,
}

impl Finder {
    /// A finder that shares `cache` with others (one per window).
    pub fn new(cache: Arc<Cache>) -> Finder {
        Finder {
            cache,
            ..Finder::default()
        }
    }

    /// A finder with other bounds (tests).
    pub fn with_limits(limits: Limits) -> Finder {
        Finder {
            limits: Mutex::new(Some(limits)),
            ..Finder::default()
        }
    }

    fn limits(&self) -> Limits {
        lock(&self.limits).clone().unwrap_or_default()
    }

    pub fn cache(&self) -> &Cache {
        &self.cache
    }

    /// The entry `key` (a hit's `key`) of archive `archive` of scan `run`,
    /// checked against the names the scan read.
    pub fn entry_of(&self, run: u32, archive: u32, key: &str) -> Result<FoundEntry, IpcError> {
        let stored = crate::browse::parse_key(key)
            .map_err(IpcError::from)?
            .as_stored()
            .to_vec();
        let current = self
            .current()
            .filter(|r| r.id == run)
            .ok_or_else(|| invalid("that result belongs to an earlier scan; search again"))?;
        let index = {
            let inner = lock(&current.inner);
            match inner.records.get(archive as usize).map(|r| &r.outcome) {
                Some(Some(Outcome::Indexed(ix))) => Arc::clone(ix),
                _ => return Err(invalid("that archive is not in the scan")),
            }
        };
        let slot = index
            .slots
            .iter()
            .find(|s| index.path(s) == stored.as_slice())
            .ok_or_else(|| invalid("that entry is not in the archive"))?;
        Ok(FoundEntry {
            key: hex(&stored),
            path: NameText::of(&stored),
            kind: kind(if slot.dir {
                EntryKind::Directory
            } else {
                EntryKind::File
            }),
        })
    }

    pub fn scopes(&self) -> Vec<FindScopeView> {
        scope_views(&lock(&self.inner).scopes)
    }

    /// Replace the folders (what a shell launch does). Paths that are not
    /// existing absolute folders are left out; an error if none is left.
    pub fn set_scopes(&self, paths: Vec<PathBuf>) -> Result<Vec<FindScopeView>, IpcError> {
        let scopes = normalize(paths, &[]);
        if scopes.is_empty() {
            return Err(invalid("none of the given paths is a folder"));
        }
        let mut st = lock(&self.inner);
        st.scopes = scopes.into_iter().take(MAX_SCOPES).collect();
        Ok(scope_views(&st.scopes))
    }

    /// Add folders to the list. Duplicates and folders inside one already
    /// listed are left out; a listed folder that lies inside a new one is replaced.
    pub fn add_scopes(&self, paths: Vec<PathBuf>) -> Result<Vec<FindScopeView>, IpcError> {
        let mut st = lock(&self.inner);
        let merged = normalize(paths, &st.scopes);
        if merged.len() > MAX_SCOPES {
            return Err(invalid(format!(
                "at most {MAX_SCOPES} folders can be searched at once"
            )));
        }
        st.scopes = merged;
        Ok(scope_views(&st.scopes))
    }

    pub fn remove_scope(&self, index: usize) -> Vec<FindScopeView> {
        let mut st = lock(&self.inner);
        if index < st.scopes.len() {
            st.scopes.remove(index);
        }
        scope_views(&st.scopes)
    }

    /// Start a scan of the current folders. A scan still running is cancelled
    /// first. `fresh` forgets the cache. The work runs through `spawn`; events
    /// go to `sink`: `started`, progress, then exactly one `finished`.
    pub fn start(
        self: &Arc<Self>,
        fresh: bool,
        sink: Arc<dyn FindSink>,
        spawn: Box<Spawner>,
    ) -> Result<u32, IpcError> {
        let (run, token) = {
            let mut st = lock(&self.inner);
            if st.scopes.is_empty() {
                return Err(invalid("choose at least one folder to search"));
            }
            let id = st.last_run.checked_add(1).ok_or_else(|| IpcError {
                code: ErrorCode::LimitExceeded.as_str().to_owned(),
                message: "this process has run the maximum number of scans; restart the app".into(),
            })?;
            st.last_run = id;
            if let Some(old) = st.token.take() {
                old.cancel();
            }
            let run = Arc::new(RunState::new(id, st.scopes.clone()));
            let token = CancellationToken::new();
            st.run = Some(Arc::clone(&run));
            st.token = Some(token.clone());
            (run, token)
        };
        if fresh {
            self.cache.clear();
        }
        let id = run.id;
        let finder = Arc::clone(self);
        spawn(Box::new(move || finder.run_scan(&run, &token, &sink)));
        Ok(id)
    }

    fn run_scan(&self, run: &Arc<RunState>, token: &CancellationToken, sink: &Arc<dyn FindSink>) {
        struct Finish<'a> {
            run: &'a RunState,
            sink: &'a dyn FindSink,
            state: Option<FindState>,
        }
        impl Drop for Finish<'_> {
            fn drop(&mut self) {
                let state = self.state.take().unwrap_or(FindState::Failed);
                {
                    let mut inner = lock(&self.run.inner);
                    inner.state = state.clone();
                    if state == FindState::Failed && inner.failure.is_none() {
                        inner.failure = Some("the scan stopped unexpectedly".to_owned());
                    }
                }
                self.sink.send(FindEvent::Finished {
                    run: self.run.id,
                    state,
                });
            }
        }
        let mut finish = Finish {
            run,
            sink: sink.as_ref(),
            state: None,
        };
        if !sink.send(FindEvent::Started { run: run.id }) {
            token.cancel();
        }
        let progress = Forward {
            run: run.id,
            sink: sink.as_ref(),
            token,
            last: Mutex::new(None),
        };
        let ctx = JobContext {
            progress: &progress,
            cancel: token,
        };
        let result = scan(&self.cache, run, &self.limits(), &ctx);
        finish.state = Some(match result {
            Ok(()) => FindState::Complete,
            Err(e) if e.code == ErrorCode::Cancelled => FindState::Cancelled,
            Err(e) => {
                lock(&run.inner).failure = Some(e.message);
                FindState::Failed
            }
        });
        drop(finish);
        let mut st = lock(&self.inner);
        if st.run.as_ref().is_some_and(|r| r.id == run.id) {
            st.token = None;
        }
    }

    /// Stop the running scan. `false` if none is running.
    pub fn cancel(&self) -> bool {
        match &lock(&self.inner).token {
            Some(t) => {
                t.cancel();
                true
            }
            None => false,
        }
    }

    fn current(&self) -> Option<Arc<RunState>> {
        lock(&self.inner).run.clone()
    }

    /// The coverage of the latest scan (idle if none has run).
    pub fn coverage(&self) -> FindCoverageView {
        match self.current() {
            Some(run) => coverage_of(&run),
            None => FindCoverageView {
                run: 0,
                state: FindState::Idle,
                complete: false,
                folders_visited: 0,
                folders_unreadable: 0,
                links_not_followed: 0,
                limit: None,
                archives_found: 0,
                archives_searched: 0,
                archives_pending: 0,
                archives_from_cache: 0,
                archives_skipped: 0,
                skipped: Vec::new(),
                names_searched: 0,
                scopes: scope_views(&lock(&self.inner).scopes)
                    .into_iter()
                    .map(|s| s.path)
                    .collect(),
                failure: None,
                content_not_searched: true,
            },
        }
    }

    /// Entries of the latest scan whose names match `text`. Blocking: call it
    /// off the async runtime. Empty text matches nothing here (the window shows
    /// only the coverage); it is not a listing.
    pub fn query(&self, text: &str) -> Result<FindResultView, IpcError> {
        if text.len() > MAX_QUERY_BYTES {
            return Err(invalid(format!(
                "a search takes at most {MAX_QUERY_BYTES} bytes of text"
            )));
        }
        let coverage = self.coverage();
        let Some(run) = self.current() else {
            return Ok(FindResultView {
                hits: Vec::new(),
                total_hits: 0,
                coverage,
            });
        };
        if text.trim().is_empty() {
            return Ok(FindResultView {
                hits: Vec::new(),
                total_hits: 0,
                coverage,
            });
        }
        let matcher = Matcher::new(text, true);
        // The searchable archives, in archive path order.
        let mut sets: Vec<(usize, PathBuf, Stamp, Arc<ArchiveIndex>)> = {
            let inner = lock(&run.inner);
            inner
                .records
                .iter()
                .enumerate()
                .filter_map(|(i, r)| match &r.outcome {
                    Some(Outcome::Indexed(ix)) => {
                        Some((i, r.path.clone(), r.stamp, Arc::clone(ix)))
                    }
                    _ => None,
                })
                .collect()
        };
        sets.sort_by(|a, b| a.1.cmp(&b.1));
        let per_archive = search_all(&sets, &matcher);
        let mut total = 0u64;
        let mut hits = Vec::new();
        for ((idx, path, stamp, ix), (count, slots)) in sets.iter().zip(per_archive) {
            total = total.saturating_add(count);
            for s in slots {
                if hits.len() >= MAX_HITS_SHOWN {
                    break;
                }
                let Some(slot) = ix.slots.get(s as usize) else {
                    continue;
                };
                let stored = ix.path(slot);
                hits.push(FindHit {
                    run: run.id,
                    archive: u32::try_from(*idx).unwrap_or(u32::MAX),
                    archive_path: path.display().to_string(),
                    archive_modified_ms: stamp.modified_ms(),
                    path: NameText::of(stored),
                    key: hex(stored),
                    kind: kind(if slot.dir {
                        EntryKind::Directory
                    } else {
                        EntryKind::File
                    }),
                    size: slot.size.to_string(),
                });
            }
        }
        Ok(FindResultView {
            hits,
            total_hits: total,
            coverage,
        })
    }

    /// The archive of a hit, if it is still the one that was scanned: the same
    /// scan, and the file's size and modified time unchanged.
    pub fn archive_for_open(&self, run: u32, archive: u32) -> Result<PathBuf, IpcError> {
        let (path, stamp) = self.record(run, archive)?;
        match std::fs::metadata(&path) {
            Ok(m) if m.is_file() && Stamp::of(&m) == stamp => Ok(path),
            Ok(_) => Err(invalid(
                "this archive changed after it was scanned; scan again to find its current names",
            )),
            Err(e) => Err(IpcError {
                code: ErrorCode::IoError.as_str().to_owned(),
                message: format!("this archive cannot be read any more: {e}"),
            }),
        }
    }

    /// The folder that holds the archive of a hit.
    pub fn archive_folder(&self, run: u32, archive: u32) -> Result<PathBuf, IpcError> {
        let (path, _) = self.record(run, archive)?;
        path.parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| invalid("this archive's folder is not known"))
    }

    fn record(&self, run: u32, archive: u32) -> Result<(PathBuf, Stamp), IpcError> {
        let current = self
            .current()
            .filter(|r| r.id == run)
            .ok_or_else(|| invalid("that result belongs to an earlier scan; search again"))?;
        let inner = lock(&current.inner);
        inner
            .records
            .get(archive as usize)
            .map(|r| (r.path.clone(), r.stamp))
            .ok_or_else(|| invalid("that archive is not in the scan"))
    }
}

/// Match every set; large ones on several threads. One result per set, in order.
fn search_all(sets: &[(usize, PathBuf, Stamp, Arc<ArchiveIndex>)], m: &Matcher) -> Vec<Matched> {
    let names: usize = sets.iter().map(|s| s.3.len()).sum();
    let workers = if names < 100_000 {
        1
    } else {
        std::thread::available_parallelism()
            .map_or(2, usize::from)
            .clamp(1, MAX_WORKERS)
    };
    if workers == 1 {
        return sets
            .iter()
            .map(|s| matches_in(&s.3, m, MAX_HITS_SHOWN))
            .collect();
    }
    let next = AtomicUsize::new(0);
    let out: Mutex<Vec<Option<Matched>>> = Mutex::new(vec![None; sets.len()]);
    std::thread::scope(|s| {
        for _ in 0..workers {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::SeqCst);
                let Some(set) = sets.get(i) else { return };
                let r = matches_in(&set.3, m, MAX_HITS_SHOWN);
                if let Some(slot) = lock(&out).get_mut(i) {
                    *slot = Some(r);
                }
            });
        }
    });
    out.into_inner()
        .unwrap_or_else(|p| p.into_inner())
        .into_iter()
        .map(Option::unwrap_or_default)
        .collect()
}

fn skipped_view(idx: usize, r: &Record, skip: &Skip) -> FindSkippedView {
    let (reason, code, message) = match skip {
        Skip::NotMochi => (FindSkipReason::NotMochi, None, None),
        Skip::Encrypted => (FindSkipReason::Encrypted, None, None),
        Skip::Unsupported { code } => (FindSkipReason::Unsupported, Some(code.clone()), None),
        Skip::Damaged { code, message } => (
            FindSkipReason::Damaged,
            Some(code.clone()),
            Some(NameText::of(message.as_bytes())),
        ),
        Skip::TooLarge => (FindSkipReason::TooLarge, None, None),
        Skip::Unreadable { message } => (
            FindSkipReason::Unreadable,
            None,
            Some(NameText::of(message.as_bytes())),
        ),
    };
    FindSkippedView {
        archive: u32::try_from(idx).unwrap_or(u32::MAX),
        path: r.path.display().to_string(),
        reason,
        code,
        message,
    }
}

fn coverage_of(run: &RunState) -> FindCoverageView {
    let inner = lock(&run.inner);
    let mut searched = 0u64;
    let mut pending = 0u64;
    let mut names = 0u64;
    let mut skipped_total = 0u64;
    let mut skipped = Vec::new();
    for (i, r) in inner.records.iter().enumerate() {
        match &r.outcome {
            None => pending += 1,
            Some(Outcome::Indexed(ix)) => {
                searched += 1;
                names = names.saturating_add(ix.len() as u64);
            }
            Some(Outcome::Skipped(s)) => {
                skipped_total += 1;
                if skipped.len() < MAX_SKIPPED_SHOWN {
                    skipped.push(skipped_view(i, r, s));
                }
            }
        }
    }
    let complete = inner.state == FindState::Complete
        && pending == 0
        && skipped_total == 0
        && inner.walk.unreadable == 0
        && inner.walk.links == 0
        && inner.walk.limit.is_none();
    FindCoverageView {
        run: run.id,
        state: inner.state.clone(),
        complete,
        folders_visited: inner.walk.folders,
        folders_unreadable: inner.walk.unreadable,
        links_not_followed: inner.walk.links,
        limit: inner.walk.limit,
        archives_found: inner.records.len() as u64,
        archives_searched: searched,
        archives_pending: pending,
        archives_from_cache: inner.from_cache,
        archives_skipped: skipped_total,
        skipped,
        names_searched: names,
        scopes: run.scopes.iter().map(|p| p.display().to_string()).collect(),
        failure: inner.failure.clone(),
        content_not_searched: true,
    }
}

// ---- commands ----------------------------------------------------------------

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, IpcError> + Send + 'static,
) -> Result<T, IpcError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| IpcError {
            code: ErrorCode::Cancelled.as_str().to_owned(),
            message: "the operation stopped before it finished".to_owned(),
        })?
}

/// The folders to search (this window's own).
#[tauri::command]
pub fn find_scopes(win: Win) -> Vec<FindScopeView> {
    win.state.finder.scopes()
}

/// Ask for folders in the native dialog (in Rust) and add them. `null` if the
/// user cancelled.
#[tauri::command]
pub async fn find_choose_folders(
    app: AppHandle,
    text: Option<DialogText>,
    win: Win,
) -> Result<Option<Vec<FindScopeView>>, IpcError> {
    let finder = Arc::clone(&win.state.finder);
    let text = text.unwrap_or_default();
    blocking(move || match crate::picker::pick_folders(&app, &text) {
        None => Ok(None),
        Some(paths) => finder.add_scopes(paths).map(Some),
    })
    .await
}

/// Take a folder off the list.
#[tauri::command]
pub fn find_remove_scope(index: u32, win: Win) -> Vec<FindScopeView> {
    win.state.finder.remove_scope(index as usize)
}

/// Scan the folders. Returns the scan's number at once; events stream over
/// `on_event`. `fresh` forgets what the session cached.
#[tauri::command]
pub async fn find_start(
    fresh: bool,
    on_event: Channel<FindEvent>,
    win: Win,
) -> Result<u32, IpcError> {
    win.state.finder.start(
        fresh,
        Arc::new(on_event),
        Box::new(|work| {
            tauri::async_runtime::spawn_blocking(work);
        }),
    )
}

/// Stop the scan. `false` if none is running.
#[tauri::command]
pub fn find_cancel(win: Win) -> bool {
    win.state.finder.cancel()
}

/// Names matching `text` in the latest scan, with its coverage.
#[tauri::command]
pub async fn find_query(text: String, win: Win) -> Result<FindResultView, IpcError> {
    let finder = Arc::clone(&win.state.finder);
    blocking(move || finder.query(&text)).await
}

/// Open the archive of a hit (read-only) and show the entry `key` in it. The
/// archive opens where archives open (`Launches::open_hit_in_window`): in this
/// window if it is empty, in the window that already has it, else in a new
/// one. The answer is `Opened` for this window to show, or `Elsewhere`. The
/// window names no path.
#[tauri::command]
pub async fn find_open_hit(
    run: u32,
    archive: u32,
    key: String,
    win: Win,
    launches: State<'_, Arc<Launches>>,
) -> Result<OpenOutcome, IpcError> {
    let finder = Arc::clone(&win.state.finder);
    let launches = Arc::clone(&launches);
    let label = win.label.clone();
    blocking(move || {
        let path = finder.archive_for_open(run, archive)?;
        let entry = finder.entry_of(run, archive, &key)?;
        launches.open_hit_in_window(&label, &path, entry)
    })
    .await
}

/// Show the folder that holds the archive of a hit.
#[tauri::command]
pub async fn find_show_folder(run: u32, archive: u32, win: Win) -> Result<(), IpcError> {
    let finder = Arc::clone(&win.state.finder);
    blocking(move || crate::help::open_folder(&finder.archive_folder(run, archive)?)).await
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use std::sync::atomic::AtomicU32;

    use crate::browse::Archives;
    use mochi_core::manifest::Attributes;
    use mochi_core::publish::{ArchiveWriter, Transaction};
    use mochi_core::storage::os::OsStorage;
    use mochi_testkit::archive::{encrypted_options, path as apath, test_options, Job};
    use mochi_testkit::SeqIds;

    use super::*;

    /// Records events; `listening = false` simulates a closed window.
    #[derive(Default)]
    struct Recorder {
        events: Mutex<Vec<FindEvent>>,
        deaf: AtomicBool,
    }

    impl FindSink for Recorder {
        fn send(&self, event: FindEvent) -> bool {
            lock(&self.events).push(event);
            !self.deaf.load(Ordering::SeqCst)
        }
    }

    static SEED: AtomicU32 = AtomicU32::new(100);

    fn write_archive(
        path: &Path,
        files: &[&str],
        opts: Option<mochi_core::publish::WriterOptions>,
    ) {
        let mut w = ArchiveWriter::create(
            OsStorage::create_new(path).unwrap(),
            Box::new(SeqIds::new(u64::from(SEED.fetch_add(1, Ordering::SeqCst)))),
            opts.unwrap_or_else(test_options),
        )
        .unwrap();
        let mut tx = Transaction::new();
        for f in files {
            // Directories are explicit entries (spec §10.2): write each parent.
            let mut dir = String::new();
            for part in f.split('/').take(f.matches('/').count()) {
                if !dir.is_empty() {
                    dir.push('/');
                }
                dir.push_str(part);
                tx.put_dir(apath(&dir), Attributes::default());
            }
            tx.put_file(apath(f), f.as_bytes().to_vec(), Attributes::default());
        }
        w.commit(tx, &Job::new().ctx()).unwrap();
        w.close().unwrap();
    }

    /// root/{a.mochi, deep/er/b.mochi, enc/secret.mochi (encrypted), bad.mochi
    /// (truncated), fake.mochi (not an archive), note.txt}
    fn tree() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        std::fs::create_dir_all(r.join("deep/er")).unwrap();
        std::fs::create_dir_all(r.join("enc")).unwrap();
        write_archive(
            &r.join("a.mochi"),
            &["Report.pdf", "docs/invoice.txt"],
            None,
        );
        write_archive(
            &r.join("deep/er/b.mochi"),
            &["photos/Holiday.JPG", "report-2.txt"],
            None,
        );
        write_archive(
            &r.join("enc/secret.mochi"),
            &["hidden-report.txt"],
            Some(encrypted_options(&["pw one"])),
        );
        write_archive(&r.join("good-for-bad.mochi"), &["x.txt"], None);
        let bytes = std::fs::read(r.join("good-for-bad.mochi")).unwrap();
        std::fs::remove_file(r.join("good-for-bad.mochi")).unwrap();
        std::fs::write(r.join("bad.mochi"), &bytes[..bytes.len() / 2]).unwrap();
        std::fs::write(r.join("fake.mochi"), b"this is not an archive at all").unwrap();
        std::fs::write(r.join("note.txt"), b"report").unwrap();
        dir
    }

    fn inline() -> Box<Spawner> {
        Box::new(|work| work())
    }

    fn scan_now(finder: &Arc<Finder>) -> (u32, Arc<Recorder>) {
        let sink = Arc::new(Recorder::default());
        let id = finder
            .start(false, Arc::clone(&sink) as Arc<dyn FindSink>, inline())
            .unwrap();
        (id, sink)
    }

    fn reasons(c: &FindCoverageView) -> Vec<(String, FindSkipReason)> {
        let mut v: Vec<(String, FindSkipReason)> = c
            .skipped
            .iter()
            .map(|s| {
                (
                    Path::new(&s.path)
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    s.reason,
                )
            })
            .collect();
        v.sort_by(|a, b| a.0.cmp(&b.0));
        v
    }

    #[test]
    fn a_scan_finds_names_in_nested_archives_and_reports_what_it_could_not_search() {
        let dir = tree();
        let finder = Arc::new(Finder::default());
        finder.set_scopes(vec![dir.path().to_path_buf()]).unwrap();
        let (id, sink) = scan_now(&finder);

        let r = finder.query("report").unwrap();
        // Report.pdf (a), report-2.txt (b): the encrypted archive's name is not searchable.
        let names: Vec<&str> = r.hits.iter().map(|h| h.path.text.as_str()).collect();
        assert_eq!(names, ["Report.pdf", "report-2.txt"]);
        assert_eq!(r.total_hits, 2);
        assert!(r.hits.iter().all(|h| h.run == id));
        assert!(r.hits[0].archive_path.ends_with("a.mochi"));
        assert!(r.hits[1].archive_path.ends_with("b.mochi"));
        assert_eq!(r.hits[0].kind, EntryKindView::File);
        assert_eq!(r.hits[0].size, "10");

        let c = &r.coverage;
        assert_eq!(c.state, FindState::Complete);
        assert_eq!(c.archives_found, 5);
        assert_eq!(c.archives_searched, 2);
        assert_eq!(c.archives_skipped, 3);
        assert!(!c.complete, "skipped archives make the search incomplete");
        assert_eq!(
            reasons(c),
            [
                ("bad.mochi".to_owned(), FindSkipReason::Damaged),
                ("fake.mochi".to_owned(), FindSkipReason::NotMochi),
                ("secret.mochi".to_owned(), FindSkipReason::Encrypted),
            ]
        );
        assert!(c
            .skipped
            .iter()
            .all(|s| s.reason != FindSkipReason::Damaged || s.code.is_some()));
        assert!(c.content_not_searched);
        assert!(c.names_searched >= 6);

        let events = lock(&sink.events).clone();
        assert_eq!(events.first(), Some(&FindEvent::Started { run: id }));
        assert_eq!(
            events.last(),
            Some(&FindEvent::Finished {
                run: id,
                state: FindState::Complete
            })
        );
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, FindEvent::Finished { .. }))
                .count(),
            1
        );
        assert!(events.iter().any(|e| matches!(
            e,
            FindEvent::Progress {
                total: Some(5),
                completed: 5,
                ..
            }
        )));
    }

    #[test]
    fn zero_matches_with_skipped_archives_is_incomplete_never_no_matches() {
        let dir = tree();
        let finder = Arc::new(Finder::default());
        finder.set_scopes(vec![dir.path().to_path_buf()]).unwrap();
        scan_now(&finder);
        let r = finder.query("zzz-nothing-like-this").unwrap();
        assert_eq!(r.total_hits, 0);
        assert!(!r.coverage.complete);
        assert_eq!(r.coverage.archives_skipped, 3);
    }

    #[test]
    fn a_clean_scan_is_complete() {
        let dir = tempfile::tempdir().unwrap();
        write_archive(&dir.path().join("only.mochi"), &["x/y.txt"], None);
        let finder = Arc::new(Finder::default());
        finder.set_scopes(vec![dir.path().to_path_buf()]).unwrap();
        scan_now(&finder);
        let none = finder.query("nope").unwrap();
        assert_eq!(none.total_hits, 0);
        assert!(
            none.coverage.complete,
            "a full scan with no match means none"
        );
        let some = finder.query("Y.TXT").unwrap();
        assert_eq!(some.total_hits, 1);
        assert_eq!(some.hits[0].path.text, "x/y.txt");
        // The folder `x` is a name too.
        let dirs = finder.query("x").unwrap();
        assert!(dirs.hits.iter().any(|h| h.kind == EntryKindView::Directory));
    }

    #[test]
    fn queries_match_names_globs_and_paths() {
        let dir = tree();
        let finder = Arc::new(Finder::default());
        finder.set_scopes(vec![dir.path().to_path_buf()]).unwrap();
        scan_now(&finder);
        let paths = |q: &str| -> Vec<String> {
            finder
                .query(q)
                .unwrap()
                .hits
                .iter()
                .map(|h| h.path.text.clone())
                .collect()
        };
        assert_eq!(paths("holiday"), ["photos/Holiday.JPG"]);
        assert_eq!(paths("*.jpg"), ["photos/Holiday.JPG"]);
        assert_eq!(paths("report-?.txt"), ["report-2.txt"]);
        assert_eq!(paths("invoice.t*"), ["docs/invoice.txt"]);
        // A glob covers the whole name: "report" alone is a substring, "rep*" a prefix.
        assert_eq!(paths("rep*"), ["Report.pdf", "report-2.txt"]);
        assert!(paths("ep*").is_empty());
        // Text with a slash is matched against the path inside the archive.
        assert_eq!(paths("docs/inv"), ["docs/invoice.txt"]);
        assert!(paths("").is_empty(), "empty text is not a listing");
    }

    #[test]
    fn matcher_folds_case_for_unicode_and_leaves_bytes_that_are_not_text_alone() {
        let m = Matcher::new("ÉCOLE", true);
        assert!(m.matches("docs/école.txt".as_bytes()));
        assert!(!Matcher::new("ÉCOLE", false).matches("école.txt".as_bytes()));
        let raw = Matcher::new("a?", true);
        assert!(raw.matches(b"dir/A\xff"));
        assert!(Matcher::new("*", true).matches(b""));
        assert!(!Matcher::new("a?c", true).matches(b"ac"));
        assert!(Matcher::new("*a*b*", true).matches(b"xxAyyBzz"));
    }

    #[test]
    fn hostile_names_cross_as_escaped_text_with_exact_keys() {
        let dir = tempfile::tempdir().unwrap();
        let names = [
            "<img src=x onerror=alert(1)>.txt",
            "evil\u{202e}gpj.exe",
            "tab\tnew\nline.txt",
        ];
        write_archive(&dir.path().join("h.mochi"), &names, None);
        let finder = Arc::new(Finder::default());
        finder.set_scopes(vec![dir.path().to_path_buf()]).unwrap();
        scan_now(&finder);
        let r = finder.query("*").unwrap();
        assert_eq!(r.total_hits, 3);
        for h in &r.hits {
            assert!(
                !h.path.text.contains(['\n', '\t', '\u{202e}']),
                "{:?}",
                h.path
            );
            assert!(h.key.chars().all(|c| c.is_ascii_hexdigit()));
        }
        assert!(r.hits.iter().any(|h| !h.path.verbatim));
        assert!(r
            .hits
            .iter()
            .any(|h| h.path.text == "<img src=x onerror=alert(1)>.txt" && h.path.verbatim));
    }

    #[test]
    fn a_second_scan_uses_the_cache_until_the_file_changes() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.mochi");
        let b = dir.path().join("b.mochi");
        write_archive(&a, &["one.txt"], None);
        write_archive(&b, &["two.txt"], None);
        let finder = Arc::new(Finder::default());
        finder.set_scopes(vec![dir.path().to_path_buf()]).unwrap();
        scan_now(&finder);
        assert_eq!(finder.coverage().archives_from_cache, 0);
        assert_eq!(finder.cache().len(), 2);

        scan_now(&finder);
        let c = finder.coverage();
        assert_eq!((c.archives_searched, c.archives_from_cache), (2, 2));
        assert_eq!(finder.query("two").unwrap().total_hits, 1);

        // A changed modified time is a different key: that archive is read again.
        let f = std::fs::OpenOptions::new().write(true).open(&a).unwrap();
        f.set_modified(SystemTime::now() + Duration::from_secs(3600))
            .unwrap();
        drop(f);
        scan_now(&finder);
        let c = finder.coverage();
        assert_eq!((c.archives_searched, c.archives_from_cache), (2, 1));

        // "Scan again" (fresh) forgets everything.
        let sink = Arc::new(Recorder::default());
        finder
            .start(true, sink as Arc<dyn FindSink>, inline())
            .unwrap();
        assert_eq!(finder.coverage().archives_from_cache, 0);
    }

    #[test]
    fn a_replaced_archive_is_read_again_and_its_old_hit_cannot_be_opened() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.mochi");
        write_archive(&a, &["old-name.txt"], None);
        let finder = Arc::new(Finder::default());
        finder.set_scopes(vec![dir.path().to_path_buf()]).unwrap();
        let (id, _) = scan_now(&finder);
        let hit = finder.query("old-name").unwrap().hits.remove(0);
        assert_eq!(finder.archive_for_open(id, hit.archive).unwrap(), a);

        std::fs::remove_file(&a).unwrap();
        write_archive(&a, &["new-name-longer.txt"], None);
        let e = finder.archive_for_open(id, hit.archive).unwrap_err();
        assert_eq!(e.code, "INVALID_ARGUMENT");
        assert!(e.message.contains("changed"), "{}", e.message);

        scan_now(&finder);
        assert_eq!(finder.query("old-name").unwrap().total_hits, 0);
        assert_eq!(finder.query("new-name").unwrap().total_hits, 1);
        // A hit of the earlier scan is refused outright.
        assert!(finder.archive_for_open(id, hit.archive).is_err());
    }

    #[test]
    fn a_scan_can_be_cancelled_and_says_it_is_incomplete() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..6 {
            write_archive(&dir.path().join(format!("{i}.mochi")), &["f.txt"], None);
        }
        let finder = Arc::new(Finder::default());
        finder.set_scopes(vec![dir.path().to_path_buf()]).unwrap();
        // A listener that is gone cancels the scan after its first event.
        let sink = Arc::new(Recorder::default());
        sink.deaf.store(true, Ordering::SeqCst);
        finder
            .start(false, Arc::clone(&sink) as Arc<dyn FindSink>, inline())
            .unwrap();
        let c = finder.coverage();
        assert_eq!(c.state, FindState::Cancelled);
        assert!(!c.complete);
        assert!(c.archives_searched < 6 || c.archives_pending > 0 || c.archives_found < 6);
        let events = lock(&sink.events).clone();
        assert_eq!(
            events.last(),
            Some(&FindEvent::Finished {
                run: c.run,
                state: FindState::Cancelled
            })
        );
        // The user's Cancel does the same while a scan runs in the background.
        assert!(!finder.cancel(), "nothing is running now");
        let finder = Arc::new(Finder::default());
        finder.set_scopes(vec![dir.path().to_path_buf()]).unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<Box<dyn FnOnce() + Send>>();
        let sink2 = Arc::new(Recorder::default());
        finder
            .start(
                false,
                Arc::clone(&sink2) as Arc<dyn FindSink>,
                Box::new(move |work| {
                    let _ = tx.send(work);
                }),
            )
            .unwrap();
        assert!(finder.cancel(), "a started scan can be cancelled");
        rx.recv().unwrap()();
        assert_eq!(finder.coverage().state, FindState::Cancelled);
        let r = finder.query("f.txt").unwrap();
        assert!(!r.coverage.complete);
    }

    #[test]
    fn a_new_scan_cancels_the_one_before() {
        let dir = tempfile::tempdir().unwrap();
        write_archive(&dir.path().join("a.mochi"), &["f.txt"], None);
        let finder = Arc::new(Finder::default());
        finder.set_scopes(vec![dir.path().to_path_buf()]).unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<Box<dyn FnOnce() + Send>>();
        let first_sink = Arc::new(Recorder::default());
        let tx2 = tx.clone();
        let first = finder
            .start(
                false,
                Arc::clone(&first_sink) as Arc<dyn FindSink>,
                Box::new(move |w| {
                    let _ = tx2.send(w);
                }),
            )
            .unwrap();
        let (second, _) = {
            let sink = Arc::new(Recorder::default());
            let id = finder
                .start(false, sink.clone() as Arc<dyn FindSink>, inline())
                .unwrap();
            (id, sink)
        };
        assert!(second > first);
        // The first scan's work runs late: it ends cancelled and changes nothing current.
        rx.recv().unwrap()();
        let events = lock(&first_sink.events).clone();
        assert_eq!(
            events.last(),
            Some(&FindEvent::Finished {
                run: first,
                state: FindState::Cancelled
            })
        );
        assert_eq!(finder.coverage().run, second);
        assert_eq!(finder.coverage().state, FindState::Complete);
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_links_are_counted_not_followed_and_a_loop_cannot_hang_the_walk() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        write_archive(&root.join("sub/a.mochi"), &["a-name.txt"], None);
        // A loop back to the root, and a link to a folder outside it.
        std::os::unix::fs::symlink(&root, root.join("sub/loop")).unwrap();
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        write_archive(&outside.join("o.mochi"), &["outside-name.txt"], None);
        std::os::unix::fs::symlink(&outside, root.join("link-out")).unwrap();
        let finder = Arc::new(Finder::default());
        finder.set_scopes(vec![root]).unwrap();
        scan_now(&finder);
        assert_eq!(finder.query("a-name").unwrap().total_hits, 1);
        let r = finder.query("outside-name").unwrap();
        assert_eq!(r.total_hits, 0);
        assert_eq!(r.coverage.links_not_followed, 2);
        assert!(
            !r.coverage.complete,
            "unfollowed links are said, not hidden"
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_folder_is_counted_and_makes_the_search_incomplete() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let locked = dir.path().join("locked");
        std::fs::create_dir_all(&locked).unwrap();
        write_archive(&locked.join("hidden.mochi"), &["h.txt"], None);
        write_archive(&dir.path().join("ok.mochi"), &["ok.txt"], None);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let finder = Arc::new(Finder::default());
        finder.set_scopes(vec![dir.path().to_path_buf()]).unwrap();
        scan_now(&finder);
        let c = finder.coverage();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        if c.folders_unreadable == 0 {
            // Running as root: permissions do not apply, nothing to assert.
            return;
        }
        assert_eq!(c.folders_unreadable, 1);
        assert!(!c.complete);
        assert_eq!(c.archives_searched, 1);
    }

    #[test]
    fn limits_stop_the_walk_and_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..5 {
            write_archive(&dir.path().join(format!("{i}.mochi")), &["f.txt"], None);
        }
        let finder = Arc::new(Finder::with_limits(Limits {
            archives: 3,
            workers: 2,
            ..Limits::default()
        }));
        finder.set_scopes(vec![dir.path().to_path_buf()]).unwrap();
        scan_now(&finder);
        let c = finder.coverage();
        assert_eq!(c.limit, Some(FindLimit::Archives));
        assert_eq!(c.archives_found, 3);
        assert!(!c.complete);

        let deep = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(deep.path().join("a/b/c")).unwrap();
        write_archive(&deep.path().join("a/b/c/d.mochi"), &["f.txt"], None);
        let finder = Arc::new(Finder::with_limits(Limits {
            depth: 1,
            ..Limits::default()
        }));
        finder.set_scopes(vec![deep.path().to_path_buf()]).unwrap();
        scan_now(&finder);
        let c = finder.coverage();
        assert_eq!(c.limit, Some(FindLimit::Depth));
        assert_eq!(c.archives_found, 0);
        assert!(!c.complete);
    }

    #[test]
    fn archives_that_do_not_fit_in_memory_are_too_large_not_silently_dropped() {
        let dir = tempfile::tempdir().unwrap();
        write_archive(
            &dir.path().join("a.mochi"),
            &["1.txt", "2.txt", "3.txt"],
            None,
        );
        write_archive(
            &dir.path().join("b.mochi"),
            &["4.txt", "5.txt", "6.txt"],
            None,
        );
        let finder = Arc::new(Finder::with_limits(Limits {
            entries_total: 4,
            workers: 1,
            ..Limits::default()
        }));
        finder.set_scopes(vec![dir.path().to_path_buf()]).unwrap();
        scan_now(&finder);
        let c = finder.coverage();
        assert_eq!(c.archives_searched, 1);
        assert_eq!(c.skipped.len(), 1);
        assert_eq!(c.skipped[0].reason, FindSkipReason::TooLarge);
        assert!(!c.complete);
    }

    #[test]
    fn scopes_are_deduplicated_nested_ones_dropped_and_non_folders_refused() {
        let dir = tempfile::tempdir().unwrap();
        let outer = dir.path().join("outer");
        let inner = outer.join("inner");
        let other = dir.path().join("other");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let file = dir.path().join("f.txt");
        std::fs::write(&file, b"x").unwrap();
        let finder = Finder::default();
        let v = finder
            .set_scopes(vec![
                inner.clone(),
                other.clone(),
                outer.clone(),
                outer.clone(),
                file,
            ])
            .unwrap();
        let shown: Vec<&str> = v.iter().map(|s| s.path.as_str()).collect();
        assert_eq!(shown, [other.to_str().unwrap(), outer.to_str().unwrap()]);
        assert_eq!(v[1].index, 1);
        // Adding a folder inside a listed one changes nothing; removing works by position.
        let v = finder.add_scopes(vec![inner]).unwrap();
        assert_eq!(v.len(), 2);
        let v = finder.remove_scope(0);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].path, outer.display().to_string());
        assert!(finder
            .set_scopes(vec![
                PathBuf::from("relative/dir"),
                dir.path().join("missing")
            ])
            .is_err());
        // The earlier list is kept after a refusal.
        assert_eq!(finder.scopes().len(), 1);
        let none = Arc::new(Finder::default());
        let e = none
            .start(false, Arc::new(Recorder::default()), inline())
            .unwrap_err();
        assert_eq!(e.code, "INVALID_ARGUMENT");
    }

    #[test]
    fn a_query_before_any_scan_and_an_overlong_one_are_handled() {
        let finder = Finder::default();
        let r = finder.query("x").unwrap();
        assert_eq!(r.coverage.state, FindState::Idle);
        assert!(!r.coverage.complete);
        assert_eq!(r.total_hits, 0);
        let e = finder.query(&"a".repeat(MAX_QUERY_BYTES + 1)).unwrap_err();
        assert_eq!(e.code, "INVALID_ARGUMENT");
    }

    #[test]
    fn hits_are_capped_but_counted() {
        let dir = tempfile::tempdir().unwrap();
        let files: Vec<String> = (0..MAX_HITS_SHOWN + 25)
            .map(|i| format!("n{i:05}.txt"))
            .collect();
        let refs: Vec<&str> = files.iter().map(String::as_str).collect();
        write_archive(&dir.path().join("many.mochi"), &refs, None);
        let finder = Arc::new(Finder::default());
        finder.set_scopes(vec![dir.path().to_path_buf()]).unwrap();
        scan_now(&finder);
        let r = finder.query("n0").unwrap();
        assert_eq!(r.hits.len(), MAX_HITS_SHOWN);
        assert_eq!(r.total_hits as usize, MAX_HITS_SHOWN + 25);
    }

    #[test]
    fn find_opens_the_archive_it_found_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.mochi");
        write_archive(&a, &["x/y.txt"], None);
        let before = std::fs::read(&a).unwrap();
        let finder = Arc::new(Finder::default());
        finder.set_scopes(vec![dir.path().to_path_buf()]).unwrap();
        let (id, _) = scan_now(&finder);
        let hit = finder.query("y.txt").unwrap().hits.remove(0);
        let path = finder.archive_for_open(id, hit.archive).unwrap();
        let archives = Archives::default();
        let OpenOutcome::Opened { archive } = archives.open_or_pend(&path).unwrap() else {
            panic!("expected an opened archive");
        };
        assert_eq!(archive.file_name, "a.mochi");
        assert_eq!(finder.archive_folder(id, hit.archive).unwrap(), dir.path());
        assert_eq!(
            std::fs::read(&a).unwrap(),
            before,
            "scanning writes nothing"
        );
    }

    /// Not a cost claim in the spec; a measurement for the report. Archives are made once, then
    /// the scan (cold: opens every archive), the same scan again (warm: the cache), and queries.
    /// `cargo test -p mochi-desktop --release find_scale -- --ignored --nocapture`
    #[test]
    #[ignore = "benchmark: builds many archives"]
    fn find_scale() {
        let archives = 60usize;
        let per = 2_000usize;
        let dir = tempfile::tempdir().unwrap();
        for a in 0..archives {
            let sub = dir.path().join(format!("d{}", a % 6));
            std::fs::create_dir_all(&sub).unwrap();
            let files: Vec<String> = (0..per)
                .map(|i| format!("dir{}/file-{a}-{i:05}.dat", i % 20))
                .collect();
            let refs: Vec<&str> = files.iter().map(String::as_str).collect();
            write_archive(&sub.join(format!("a{a}.mochi")), &refs, None);
        }
        let finder = Arc::new(Finder::default());
        finder.set_scopes(vec![dir.path().to_path_buf()]).unwrap();
        let t = Instant::now();
        scan_now(&finder);
        let cold = t.elapsed();
        let t = Instant::now();
        scan_now(&finder);
        let warm = t.elapsed();
        let c = finder.coverage();
        let t = Instant::now();
        let r = finder.query("file-7-0123").unwrap();
        let q1 = t.elapsed();
        let t = Instant::now();
        let r2 = finder.query("*-00042.dat").unwrap();
        let q2 = t.elapsed();
        println!(
            "find_scale: {} archives, {} names; cold scan {cold:?}, warm scan {warm:?} ({} from cache); query {q1:?} ({} hits), glob {q2:?} ({} hits)",
            c.archives_searched, c.names_searched, c.archives_from_cache, r.total_hits, r2.total_hits
        );
        assert!(c.complete);
    }
}
