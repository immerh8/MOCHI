//! Q54 (owner decision 2026-10-06; spec Annex B D17, B.2.7): the publication
//! lock is an OS lock on a separate lock file, `<archive>.mochi-lock`.
//!
//! On the real filesystem: writers are excluded through every alias the
//! lock-file name resolves; the lock file's existence is not ownership; and
//! readers, which take no lock, read the committed snapshot while a writer
//! is in the middle of an append. On Windows that last one failed before
//! (error 33: the writer's lock covered the archive itself).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use mochi_core::job::{CancellationToken, JobContext, ProgressEvent, ProgressSink};
use mochi_core::publish::{open_head, phase, ArchiveWriter, ReadOptions, TailPolicy};
use mochi_core::storage::os::{lock_file_path, OsReadStorage, OsStorage, LOCK_FILE_SUFFIX};
use mochi_core::ErrorCode;
use mochi_testkit::archive::{build, read_state, scripted_history, test_options, Job, Step};
use mochi_testkit::SeqIds;

const NAME: &str = "a.mochi";

/// A directory holding an archive with the first `n` scripted commits.
fn archive(n: usize) -> (tempfile::TempDir, PathBuf, Vec<Step>) {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join(NAME);
    let steps = scripted_history();
    build(OsStorage::create_new(&file).unwrap(), 7, &steps[..n]).unwrap();
    (tmp, file, steps)
}

fn writer(path: &Path) -> mochi_core::Result<ArchiveWriter<OsStorage>> {
    ArchiveWriter::open_append(
        OsStorage::open_existing(path)?,
        Box::new(SeqIds::new(9)),
        test_options(),
        TailPolicy::Refuse,
    )
    .map(|(w, _)| w)
}

fn lock_path(dir: &Path) -> PathBuf {
    dir.join(format!("{NAME}{LOCK_FILE_SUFFIX}"))
}

/// Every alias the lock-file name resolves reaches one lock: `.` and `..`
/// segments, a symbolic link (Unix), a hard link (Unix, through the
/// archive's own `flock`), and a different case on a case-insensitive
/// filesystem (Windows). The holder is excluded through all of them, and
/// the next writer gets the lock once the holder closes.
#[test]
fn q54_a_writer_excludes_every_alias() {
    let (tmp, file, _) = archive(2);
    std::fs::create_dir(tmp.path().join("sub")).unwrap();
    let mut aliases = vec![
        file.clone(),
        tmp.path().join(".").join(NAME),
        tmp.path().join("sub").join("..").join(NAME),
    ];
    for alias in &aliases {
        assert_eq!(
            lock_file_path(alias).unwrap(),
            lock_file_path(&file).unwrap()
        );
    }
    #[cfg(unix)]
    {
        let link = tmp.path().join("sub").join("link.mochi");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert_eq!(
            lock_file_path(&link).unwrap(),
            lock_file_path(&file).unwrap()
        );
        aliases.push(link);
        let hard = tmp.path().join("sub").join("hard.mochi");
        std::fs::hard_link(&file, &hard).unwrap();
        aliases.push(hard);
    }
    #[cfg(windows)]
    aliases.push(tmp.path().join(NAME.to_uppercase()));

    let holder = writer(&file).unwrap();
    for alias in &aliases {
        let e = writer(alias).map(|_| ()).unwrap_err();
        assert_eq!(e.code, ErrorCode::LockConflict, "{}: {e}", alias.display());
    }
    holder.close().unwrap();
    for alias in &aliases {
        writer(alias).unwrap().close().unwrap();
    }
}

/// The lock file's existence is not ownership: a leftover lock file nobody
/// holds does not block a writer, and closing a writer leaves the file in
/// place, empty. Only the OS lock on it excludes.
#[test]
fn q54_lock_file_existence_is_not_ownership() {
    let (tmp, file, steps) = archive(2);
    let lock = lock_path(tmp.path());
    assert!(lock.exists(), "the creating writer's lock file stays");
    assert_eq!(std::fs::metadata(&lock).unwrap().len(), 0);

    // A missing lock file is simply created again.
    std::fs::remove_file(&lock).unwrap();
    let w = writer(&file).unwrap();
    w.close().unwrap();
    assert!(lock.exists(), "unlocking never removes the lock file");
    assert_eq!(std::fs::metadata(&lock).unwrap().len(), 0);

    // Someone else holding the OS lock on the lock file excludes writers.
    let other = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&lock)
        .unwrap();
    other.try_lock().unwrap();
    let e = writer(&file).map(|_| ()).unwrap_err();
    assert_eq!(e.code, ErrorCode::LockConflict);
    other.unlock().unwrap();

    // Dropping a writer without closing it releases the lock too.
    let mut w = writer(&file).unwrap();
    w.commit(steps[2].tx.clone(), &Job::new().ctx()).unwrap();
    drop(w);
    writer(&file).unwrap().close().unwrap();
    assert_eq!(std::fs::metadata(&lock).unwrap().len(), 0);
    let r = OsReadStorage::open(&file).unwrap();
    let head = open_head(&r, &ReadOptions::default()).unwrap();
    assert_eq!(read_state(&r, &head).unwrap(), steps[2].after);
}

/// What a reader saw at one point of the writer's commit.
#[derive(Debug)]
struct Seen {
    phase: &'static str,
    seq: u64,
    state_matches: bool,
    second_writer: Option<ErrorCode>,
}

/// At each phase, opens the archive read-only (no lock), reads the head and
/// every file, and tries a second writer.
struct ReadDuringAppend<'a> {
    file: &'a Path,
    before: &'a Step,
    after: &'a Step,
    seen: Mutex<Vec<Seen>>,
}

impl ProgressSink for ReadDuringAppend<'_> {
    fn report(&self, e: &ProgressEvent) {
        let r = OsReadStorage::open(self.file).unwrap();
        let head = open_head(&r, &ReadOptions::default())
            .unwrap_or_else(|err| panic!("{}: reader failed: {err}", e.phase));
        let state = read_state(&r, &head)
            .unwrap_or_else(|err| panic!("{}: reading files failed: {err}", e.phase));
        let want = if head.seq() == 1 {
            &self.before.after
        } else {
            &self.after.after
        };
        let second_writer = writer(self.file).map(|_| ()).err().map(|e| e.code);
        self.seen.lock().unwrap().push(Seen {
            phase: e.phase,
            seq: head.seq(),
            state_matches: state == *want,
            second_writer,
        });
    }
}

/// **Q54 evidence.** While a writer appends (content written, checkpoint
/// and commit record written, footer about to be appended and about to be
/// synced), a reader without any lock opens the archive and reads the last
/// committed snapshot exactly; a second writer is refused throughout. Before
/// the footer is appended the reader sees the previous head; once it is
/// appended, the new one. Never anything in between.
#[test]
fn q54_readers_see_the_committed_snapshot_during_an_append() {
    let (_tmp, file, steps) = archive(2);
    let mut w = writer(&file).unwrap();

    // Between commits, with the lock held: readers are not blocked.
    let r = OsReadStorage::open(&file).unwrap();
    let head = open_head(&r, &ReadOptions::default()).unwrap();
    assert_eq!(head.seq(), 1);
    assert_eq!(read_state(&r, &head).unwrap(), steps[1].after);

    let sink = ReadDuringAppend {
        file: &file,
        before: &steps[1],
        after: &steps[2],
        seen: Mutex::new(Vec::new()),
    };
    let cancel = CancellationToken::new();
    let ctx = JobContext {
        progress: &sink,
        cancel: &cancel,
    };
    w.commit(steps[2].tx.clone(), &ctx).unwrap();
    let seen = sink.seen.into_inner().unwrap();

    for p in [
        phase::CONTENT,
        phase::COMMIT_RECORD,
        phase::FOOTER,
        phase::SYNC_FOOTER,
    ] {
        assert!(seen.iter().any(|s| s.phase == p), "phase {p} not observed");
    }
    let mut footer_seen = false;
    for s in &seen {
        assert!(s.state_matches, "{s:?}");
        assert_eq!(s.second_writer, Some(ErrorCode::LockConflict), "{s:?}");
        footer_seen |= s.phase == phase::SYNC_FOOTER;
        // The footer is appended after FOOTER and before SYNC_FOOTER.
        let want = if footer_seen { 2 } else { 1 };
        assert_eq!(s.seq, want, "{s:?}");
    }
    w.close().unwrap();
}

/// Creation (D13) takes the final name's lock file before the archive
/// becomes visible, and keeps it: a second writer is refused while the
/// creating writer lives, and a reader can read the new archive meanwhile
/// (on Windows the temporary file's own lock is released at publication).
#[test]
fn q54_a_created_archive_is_locked_and_readable() {
    use mochi_core::storage::os::OsDir;
    let tmp = tempfile::tempdir().unwrap();
    let mut dir = OsDir::open(tmp.path()).unwrap();
    let steps = scripted_history();
    let (w, _) = ArchiveWriter::<OsStorage>::create_in(
        &mut dir,
        NAME,
        Box::new(SeqIds::new(7)),
        test_options(),
        steps[0].tx.clone(),
        &Job::new().ctx(),
    )
    .unwrap();
    let file = tmp.path().join(NAME);
    let e = writer(&file).map(|_| ()).unwrap_err();
    assert_eq!(e.code, ErrorCode::LockConflict);
    let r = OsReadStorage::open(&file).unwrap();
    let head = open_head(&r, &ReadOptions::default()).unwrap();
    assert_eq!(read_state(&r, &head).unwrap(), steps[0].after);

    // Another process holding the final name's lock: nothing is created.
    let other_name = "b.mochi";
    let lock = tmp.path().join(format!("{other_name}{LOCK_FILE_SUFFIX}"));
    let held = std::fs::File::create(&lock).unwrap();
    held.try_lock().unwrap();
    let e = ArchiveWriter::<OsStorage>::create_in(
        &mut dir,
        other_name,
        Box::new(SeqIds::new(8)),
        test_options(),
        steps[0].tx.clone(),
        &Job::new().ctx(),
    )
    .map(|_| ())
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::LockConflict, "{e}");
    assert!(!tmp.path().join(other_name).exists());
    let leftovers = std::fs::read_dir(tmp.path())
        .unwrap()
        .filter(|e| {
            let n = e.as_ref().unwrap().file_name();
            n.to_string_lossy().ends_with(".mochi-tmp")
        })
        .count();
    assert_eq!(leftovers, 0, "the temporary file was removed");
    drop(held);
    w.close().unwrap();
    writer(&file).unwrap().close().unwrap();
}

// ---- Orphan lock files (owner decision 2026-10-19; spec B.2.16) -------------

/// `<name>.mochi-lock` in `dir`.
fn lock_of(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}{LOCK_FILE_SUFFIX}"))
}

/// An empty lock file for an archive that is not there.
fn orphan(dir: &Path, name: &str) -> PathBuf {
    let p = lock_of(dir, name);
    std::fs::File::create(&p).unwrap();
    p
}

/// Creates `name` in `dir` through the D13 path and returns its writer.
fn create(dir: &Path, name: &str, seed: u64) -> mochi_core::Result<ArchiveWriter<OsStorage>> {
    use mochi_core::storage::os::OsDir;
    let steps = scripted_history();
    ArchiveWriter::<OsStorage>::create_in(
        &mut OsDir::open(dir).unwrap(),
        name,
        Box::new(SeqIds::new(seed)),
        test_options(),
        steps[0].tx.clone(),
        &Job::new().ctx(),
    )
    .map(|(w, _)| w)
}

/// Trigger 1: a writer that opens an archive for appending removes the
/// orphans beside it, and only those.
#[cfg(unix)]
#[test]
fn orphan_is_removed_when_a_writer_appends() {
    let (tmp, file, _) = archive(2);
    let gone = orphan(tmp.path(), "gone.mochi");
    let other = orphan(tmp.path(), "other.mochi");
    let w = writer(&file).unwrap();
    assert!(!gone.exists() && !other.exists());
    assert!(
        lock_path(tmp.path()).exists(),
        "the writer's own file stays"
    );
    w.close().unwrap();
    assert!(lock_path(tmp.path()).exists(), "closing never removes it");
}

/// Trigger 2: creating an archive does the same, once it is published.
#[cfg(unix)]
#[test]
fn orphan_is_removed_when_an_archive_is_created() {
    let tmp = tempfile::tempdir().unwrap();
    let gone = orphan(tmp.path(), "gone.mochi");
    let w = create(tmp.path(), NAME, 7).unwrap();
    assert!(!gone.exists());
    assert!(lock_path(tmp.path()).exists());
    w.close().unwrap();
}

/// A lock file whose archive exists is never removed, whatever else a sweep
/// finds; neither is one held by another handle, one with bytes, a link, a
/// directory, or anything that is not a lock file; sub-directories are not
/// entered.
#[cfg(unix)]
#[test]
fn only_unheld_empty_regular_orphans_go() {
    let (tmp, file, _) = archive(2);
    let dir = tmp.path();

    // Archive present (a dangling symbolic link counts as present).
    let kept = lock_of(dir, "kept.mochi");
    std::fs::write(dir.join("kept.mochi"), b"x").unwrap();
    std::fs::File::create(&kept).unwrap();
    let dangling = lock_of(dir, "dangling.mochi");
    std::os::unix::fs::symlink(dir.join("nowhere"), dir.join("dangling.mochi")).unwrap();
    std::fs::File::create(&dangling).unwrap();

    // Held by someone else.
    let held = orphan(dir, "held.mochi");
    let holder = std::fs::File::open(&held).unwrap();
    holder.try_lock().unwrap();

    // Not what a lock file is: bytes, a link, a directory, other names.
    let bytes = lock_of(dir, "bytes.mochi");
    std::fs::write(&bytes, b"user data").unwrap();
    let link = lock_of(dir, "link.mochi");
    std::os::unix::fs::symlink(&bytes, &link).unwrap();
    let as_dir = lock_of(dir, "dir.mochi");
    std::fs::create_dir(&as_dir).unwrap();
    let bare = dir.join(LOCK_FILE_SUFFIX);
    std::fs::File::create(&bare).unwrap();
    let other = dir.join("notes.txt");
    std::fs::File::create(&other).unwrap();
    std::fs::create_dir(dir.join("sub")).unwrap();
    let nested = orphan(&dir.join("sub"), "deep.mochi");

    writer(&file).unwrap().close().unwrap();
    for p in [
        &kept, &dangling, &held, &bytes, &link, &as_dir, &bare, &other, &nested,
    ] {
        assert!(p.symlink_metadata().is_ok(), "{} was removed", p.display());
    }

    // Released, the held one is an orphan like any other.
    drop(holder);
    writer(&file).unwrap().close().unwrap();
    assert!(!held.exists());
    assert!(kept.exists() && nested.exists());
}

/// Cleanup never fails the user's operation: a sweep that cannot remove
/// (read-only directory), cannot read the directory, or meets odd entries
/// leaves the writer working.
#[cfg(unix)]
#[test]
fn a_failing_sweep_never_fails_the_operation() {
    use mochi_core::storage::os::sweep_orphan_lock_files;
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(sweep_orphan_lock_files(Path::new("/nonexistent/mochi")), 0);

    let (tmp, file, steps) = archive(2);
    let gone = orphan(tmp.path(), "gone.mochi");
    let mode = std::fs::metadata(tmp.path()).unwrap().permissions().mode();
    std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
    // Root ignores directory permissions, so only assert the failure path
    // where it really is one.
    let removable = std::fs::File::create(tmp.path().join("probe")).is_ok();
    let mut w = writer(&file).unwrap();
    w.commit(steps[2].tx.clone(), &Job::new().ctx()).unwrap();
    w.close().unwrap();
    std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(mode)).unwrap();
    if !removable {
        assert!(gone.exists(), "nothing could be removed");
    }
}

/// B/C race (spec B.2.16): B opened the orphan, the cleaner unlinks it (B
/// held no lock yet), then B locks the dead inode while C creates and locks
/// a fresh file. B must not keep that lock: creators racing a sweeper end
/// with exactly one winner and one lock holder, never two.
#[cfg(unix)]
#[test]
fn creators_racing_a_sweeper_never_both_win() {
    use mochi_core::storage::os::sweep_orphan_lock_files;
    use std::sync::atomic::{AtomicBool, Ordering};
    let tmp = tempfile::tempdir().unwrap();
    for round in 0..60 {
        let name = format!("r{round}.mochi");
        let (dir, name) = (tmp.path(), &name);
        orphan(tmp.path(), name);
        let stop = AtomicBool::new(false);
        let outcomes = std::thread::scope(|s| {
            let sweeper = s.spawn(|| {
                while !stop.load(Ordering::Relaxed) {
                    sweep_orphan_lock_files(tmp.path());
                }
            });
            let creators: Vec<_> = (0..4u64)
                .map(|i| s.spawn(move || create(dir, name, 100 + i).map(|w| w.close().unwrap())))
                .collect();
            let out: Vec<_> = creators.into_iter().map(|c| c.join().unwrap()).collect();
            stop.store(true, Ordering::Relaxed);
            sweeper.join().unwrap();
            out
        });
        let won = outcomes.iter().filter(|o| o.is_ok()).count();
        assert_eq!(won, 1, "round {round}: {outcomes:?}");
        for e in outcomes.iter().filter_map(|o| o.as_ref().err()) {
            assert!(
                matches!(
                    e.code,
                    ErrorCode::DestinationExists | ErrorCode::LockConflict
                ),
                "round {round}: {e}"
            );
        }
        // The winner's archive is intact and its lock file is the only one.
        let r = OsReadStorage::open(tmp.path().join(name)).unwrap();
        open_head(&r, &ReadOptions::default()).unwrap();
        assert!(lock_of(tmp.path(), name).exists());
    }
}

// ---- Windows: hidden lock files, no sweep -----------------------------------

#[cfg(windows)]
fn attributes(p: &Path) -> u32 {
    use std::os::windows::fs::MetadataExt;
    std::fs::metadata(p).unwrap().file_attributes()
}

#[cfg(windows)]
const HIDDEN: u32 = 0x2;

/// A lock file this build creates is hidden, for a created archive and for
/// an append that has to create it; reopening the hidden file works and
/// does not change it.
#[cfg(windows)]
#[test]
fn windows_created_lock_file_is_hidden_and_reopens() {
    let tmp = tempfile::tempdir().unwrap();
    let w = create(tmp.path(), NAME, 7).unwrap();
    assert_ne!(attributes(&lock_path(tmp.path())) & HIDDEN, 0);
    w.close().unwrap();
    writer(&tmp.path().join(NAME)).unwrap().close().unwrap();
    assert_ne!(attributes(&lock_path(tmp.path())) & HIDDEN, 0);
    assert_eq!(std::fs::metadata(lock_path(tmp.path())).unwrap().len(), 0);

    // Deleted by the user, an append creates it again, hidden.
    std::fs::remove_file(lock_path(tmp.path())).unwrap();
    writer(&tmp.path().join(NAME)).unwrap().close().unwrap();
    assert_ne!(attributes(&lock_path(tmp.path())) & HIDDEN, 0);
}

/// A visible lock file from an earlier build keeps working and stays
/// visible; an orphan is not swept on Windows.
#[cfg(windows)]
#[test]
fn windows_visible_lock_file_still_works_and_nothing_is_swept() {
    let (tmp, file, steps) = archive(2);
    let lock = lock_path(tmp.path());
    std::fs::remove_file(&lock).unwrap();
    std::fs::File::create(&lock).unwrap();
    assert_eq!(attributes(&lock) & HIDDEN, 0);
    let gone = orphan(tmp.path(), "gone.mochi");
    let mut w = writer(&file).unwrap();
    w.commit(steps[2].tx.clone(), &Job::new().ctx()).unwrap();
    w.close().unwrap();
    assert_eq!(attributes(&lock) & HIDDEN, 0, "attributes are not touched");
    assert!(gone.exists(), "Windows has no orphan sweep");
}
