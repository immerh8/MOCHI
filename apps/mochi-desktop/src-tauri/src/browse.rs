//! Archive browsing (plan D1): opened archives, their snapshots, and paged
//! listings, as IPC types. Thin over `mochi-core` (AGENTS.md): opening,
//! verification, history, retention, and the paged index
//! ([`mochi_core::browse::SnapshotIndex`]) all live there; this module keeps
//! sessions and converts results. It is independent of Tauri, so it is tested
//! without a window.
//!
//! Reading only: archives are opened through `OsReadStorage` (spec §20.2,
//! AGENTS.md "Verification is read-only"), and nothing here writes.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use mochi_core::browse::{BrowseEntry, Children, SnapshotIndex, MAX_PAGE};
use mochi_core::catalog::namespace::{EntryKind, FileVersionId};
use mochi_core::catalog::path::ArchivePath;
use mochi_core::manifest::{
    Attributes, WINDOWS_ARCHIVE, WINDOWS_HIDDEN, WINDOWS_READONLY, WINDOWS_SYSTEM,
};
use mochi_core::publish::{
    commit_history, open_at_footer, open_head, promised_attributes, segment_state, CatalogSource,
    HistoryEntry, OpenedHead, ReadOptions,
};
use mochi_core::storage::os::OsReadStorage;
use mochi_core::timestamp::Timestamp;
use mochi_core::{ErrorCode, MochiError, Result};

use crate::ipc::{
    ArchiveHandle, ArchiveSummary, AttributesView, CatalogSourceView, ChildrenPage, CommitView,
    EntryDetails, EntryKindView, EntryRow, IpcError, NameText, PathKey, PosixView, ProfileView,
    SnapshotView,
};

/// Archives one process keeps open at once. The UI shows one and closes it
/// before opening the next; the margin covers a reload that lost a handle.
pub const MAX_OPEN: usize = 4;

/// Snapshots kept open per archive (the head and the one being looked at).
const SNAPSHOTS_KEPT: usize = 2;

/// One opened snapshot: its verified commit, its index, and its promised
/// attributes once something asked for them.
struct View {
    seq: u64,
    head: OpenedHead,
    index: SnapshotIndex,
    attributes: Option<std::result::Result<BTreeMap<FileVersionId, Attributes>, MochiError>>,
}

impl View {
    fn open(head: OpenedHead) -> Result<Self> {
        let index = SnapshotIndex::build(&head.catalog)?;
        // The index counts in u32 (`SnapshotIndex::build` refuses more).
        Ok(View {
            seq: head.seq(),
            head,
            index,
            attributes: None,
        })
    }
}

struct Session {
    /// The file this session reads (D2 appends to it through this path).
    path: PathBuf,
    src: OsReadStorage,
    opts: ReadOptions,
    history: Vec<HistoryEntry>,
    /// Most recently used last.
    views: VecDeque<View>,
}

impl Session {
    /// The opened snapshot `seq`, opening it if it is not kept, with the
    /// storage and options it was opened through.
    fn view(&mut self, seq: u64) -> Result<(&mut View, &OsReadStorage, &ReadOptions)> {
        let Session {
            src,
            opts,
            history,
            views,
            ..
        } = self;
        if let Some(i) = views.iter().position(|v| v.seq == seq) {
            if let Some(v) = views.remove(i) {
                views.push_back(v);
            }
        } else {
            let entry = history
                .iter()
                .find(|e| e.commit.seq == seq)
                .ok_or_else(|| invalid(format!("this archive has no commit {seq}")))?;
            let view = View::open(open_at_footer(src, entry.footer_offset, opts)?)?;
            if views.len() >= SNAPSHOTS_KEPT {
                views.pop_front();
            }
            views.push_back(view);
        }
        // Both branches leave the requested view last; `views` is not empty.
        let last = views.len() - 1;
        Ok((&mut views[last], src, opts))
    }
}

/// The archives this process has open, by handle.
#[derive(Default)]
pub struct Archives {
    inner: Mutex<Registry>,
}

#[derive(Default)]
struct Registry {
    last: ArchiveHandle,
    open: HashMap<ArchiveHandle, Arc<Mutex<Session>>>,
}

fn invalid(what: impl Into<String>) -> MochiError {
    MochiError::new(ErrorCode::InvalidArgument, what)
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // A poisoned lock means a thread panicked while holding it. Sessions are
    // read-only caches; the next request rebuilds whatever it needs.
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A [`PathKey`] back to an archive path. Never trusted: it is checked as
/// hex and as a path, and a path the snapshot lacks is refused later.
pub fn parse_key(key: &str) -> Result<ArchivePath> {
    let bad = || invalid("not a path key");
    let b = key.as_bytes();
    if b.is_empty() || !b.len().is_multiple_of(2) {
        return Err(bad());
    }
    let digit = |c: u8| (c as char).to_digit(16).ok_or_else(bad);
    let bytes = b
        .chunks_exact(2)
        .map(|p| u8::try_from(digit(p[0])? * 16 + digit(p[1])?).map_err(|_| bad()))
        .collect::<Result<Vec<u8>>>()?;
    ArchivePath::from_stored(&bytes).map_err(|_| bad())
}

fn kind(k: EntryKind) -> EntryKindView {
    match k {
        EntryKind::File => EntryKindView::File,
        EntryKind::Directory => EntryKindView::Directory,
    }
}

fn count(n: u64) -> u32 {
    // Bounded by the entry count, which `SnapshotIndex::build` keeps in u32.
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn row(e: &BrowseEntry) -> EntryRow {
    EntryRow {
        key: hex(e.path.as_stored()),
        name: NameText::of(e.name()),
        kind: kind(e.kind),
        size: e.logical_len.to_string(),
        child_dirs: count(e.child_dirs),
        child_files: count(e.child_files),
    }
}

fn time(secs: i64, nanos: u32) -> Option<String> {
    Timestamp::from_unix(secs, nanos)
        .ok()
        .map(|t| t.to_string())
}

fn attributes_view(a: &Attributes) -> AttributesView {
    AttributesView::Recorded {
        posix: a.posix.map(|p| PosixView {
            mode: p.mode,
            uid: p.uid,
            gid: p.gid,
        }),
        windows: a.windows.map(|bits| {
            [
                (WINDOWS_READONLY, "read-only"),
                (WINDOWS_HIDDEN, "hidden"),
                (WINDOWS_SYSTEM, "system"),
                (WINDOWS_ARCHIVE, "archive"),
            ]
            .iter()
            .filter(|(bit, _)| bits & bit != 0)
            .map(|(_, name)| (*name).to_owned())
            .collect()
        }),
        mtime: a.mtime.and_then(|m| time(m.secs, m.nanos)),
    }
}

impl Archives {
    fn session(&self, handle: ArchiveHandle) -> Result<Arc<Mutex<Session>>> {
        lock(&self.inner)
            .open
            .get(&handle)
            .cloned()
            .ok_or_else(|| invalid("that archive is not open (it was closed)"))
    }

    /// Archives open now.
    pub fn open_count(&self) -> usize {
        lock(&self.inner).open.len()
    }

    /// Open the archive at `path` read-only: its history (every commit
    /// record, chained back to commit 0), its head fully verified as every
    /// open is, and retention at the head.
    pub fn open(&self, path: &Path, opts: ReadOptions) -> Result<ArchiveSummary> {
        if self.open_count() >= MAX_OPEN {
            return Err(MochiError::new(
                ErrorCode::LimitExceeded,
                format!("at most {MAX_OPEN} archives can be open at once; close one first"),
            ));
        }
        let (summary, session) = Self::load(path, opts)?;
        let mut reg = lock(&self.inner);
        let handle = reg.last.checked_add(1).ok_or_else(|| {
            MochiError::new(
                ErrorCode::LimitExceeded,
                "this process has opened the maximum number of archives; restart the app",
            )
        })?;
        reg.last = handle;
        reg.open.insert(handle, Arc::new(Mutex::new(session)));
        Ok(ArchiveSummary { handle, ..summary })
    }

    /// The file an open archive was opened from.
    pub fn path(&self, handle: ArchiveHandle) -> Result<PathBuf> {
        Ok(lock(&*self.session(handle)?).path.clone())
    }

    /// Read the archive at the same path again, under the same handle: after
    /// a commit, so the timeline and snapshots show it. The old session is
    /// replaced only once the new one has fully opened.
    pub fn reopen(&self, handle: ArchiveHandle) -> Result<ArchiveSummary> {
        let (path, opts) = {
            let session = self.session(handle)?;
            let s = lock(&session);
            (s.path.clone(), s.opts.clone())
        };
        let (summary, session) = Self::load(&path, opts)?;
        let mut reg = lock(&self.inner);
        match reg.open.get_mut(&handle) {
            Some(slot) => *slot = Arc::new(Mutex::new(session)),
            None => return Err(invalid("that archive is not open (it was closed)")),
        }
        Ok(ArchiveSummary { handle, ..summary })
    }

    /// Read `path` into a session and its summary (handle 0 until
    /// registered).
    fn load(path: &Path, opts: ReadOptions) -> Result<(ArchiveSummary, Session)> {
        let src = OsReadStorage::open(path).map_err(MochiError::from)?;
        let history = commit_history(&src, &opts)?;
        let head = open_head(&src, &opts)?;
        if head.descriptor.encrypted() && head.unlocked.is_none() {
            return Err(MochiError::new(
                ErrorCode::KeyUnavailable,
                "this archive is encrypted; opening encrypted archives in the desktop app \
                 arrives with passphrase entry (plan D5). The command-line tool can open it",
            ));
        }
        let retention = segment_state(&src, &head, &opts).map(|s| s.retention);
        let head_seq = head.seq();
        let roots = retention.as_ref().ok().map(|r| r.roots(head_seq));
        let commits = history
            .iter()
            .map(|e| {
                let seq = e.commit.seq;
                CommitView {
                    seq,
                    commit_id: e.commit_id.to_hex(),
                    time: e.commit.time.and_then(|t| time(t.secs, t.nanos)),
                    checkpoint: e.commit.metadata.is_checkpoint(),
                    retained: roots.as_ref().map(|r| r.contains(&seq)),
                    expired: retention.as_ref().ok().map(|r| r.expired.contains(&seq)),
                    holds: retention
                        .as_ref()
                        .map(|r| {
                            r.holds
                                .iter()
                                .filter(|(_, s)| **s == seq)
                                .map(|(label, _)| NameText::of(label))
                                .collect()
                        })
                        .unwrap_or_default(),
                }
            })
            .collect();
        let profile = head.descriptor.profile();
        let summary = ArchiveSummary {
            handle: 0,
            file_name: path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            archive_id: head.commit.archive_id.to_hex(),
            profile: ProfileView {
                tar_compatible: profile.tar_compatible,
                encrypted: profile.encrypted,
                redundancy_percent: profile.redundancy,
            },
            commits,
            retention_error: retention.err().map(IpcError::from),
        };
        let mut views = VecDeque::new();
        views.push_back(View::open(head)?);
        let session = Session {
            path: path.to_path_buf(),
            src,
            opts,
            history,
            views,
        };
        Ok((summary, session))
    }

    /// Close an archive. `false` if it was not open.
    pub fn close(&self, handle: ArchiveHandle) -> bool {
        lock(&self.inner).open.remove(&handle).is_some()
    }

    /// Open (or reuse) snapshot `seq` of an open archive.
    pub fn snapshot(&self, handle: ArchiveHandle, seq: u64) -> Result<SnapshotView> {
        let session = self.session(handle)?;
        let mut s = lock(&session);
        let (v, _, _) = s.view(seq)?;
        let (root_dirs, root_files) = v.index.counts(None)?;
        Ok(SnapshotView {
            seq: v.seq,
            commit_id: v.head.commit_id.to_hex(),
            entries: count(v.index.len() as u64),
            root_dirs: count(root_dirs),
            root_files: count(root_files),
            catalog_source: match &v.head.catalog_source {
                CatalogSource::Image => CatalogSourceView::Image,
                CatalogSource::SnapshotManifest { image_error } => {
                    CatalogSourceView::SnapshotManifest {
                        image_error: IpcError::from(image_error.clone()),
                    }
                }
            },
        })
    }

    /// Children `offset .. offset + limit` of `dir` (the root for `None`) in
    /// snapshot `seq`; subdirectories only with `directories_only`.
    pub fn children(
        &self,
        handle: ArchiveHandle,
        seq: u64,
        dir: Option<&str>,
        directories_only: bool,
        offset: u32,
        limit: u32,
    ) -> Result<ChildrenPage> {
        let dir = dir.map(parse_key).transpose()?;
        let limit = usize::try_from(limit).unwrap_or(MAX_PAGE + 1);
        let session = self.session(handle)?;
        let mut s = lock(&session);
        let (v, _, _) = s.view(seq)?;
        let which = if directories_only {
            Children::Directories
        } else {
            Children::All
        };
        let page = v
            .index
            .children(dir.as_ref(), which, u64::from(offset), limit)?;
        Ok(ChildrenPage {
            total: count(page.total),
            offset,
            entries: page.entries.into_iter().map(row).collect(),
        })
    }

    /// Details of the entry at `key` in snapshot `seq`. Attributes are read
    /// from the snapshot's manifests on first use; if they cannot be, they
    /// are reported unavailable, never guessed.
    pub fn details(&self, handle: ArchiveHandle, seq: u64, key: &PathKey) -> Result<EntryDetails> {
        let path = parse_key(key)?;
        let session = self.session(handle)?;
        let mut s = lock(&session);
        let (v, src, opts) = s.view(seq)?;
        let e = v
            .index
            .entry(&path)
            .ok_or_else(|| invalid("no such entry in this snapshot"))?
            .clone();
        let attributes = {
            let head = &v.head;
            let all = v
                .attributes
                .get_or_insert_with(|| promised_attributes(src, head, opts));
            match all {
                Ok(map) => match map.get(&e.version) {
                    Some(a) => attributes_view(a),
                    None => AttributesView::Unavailable {
                        error: IpcError {
                            code: ErrorCode::RecordInvalid.as_str().to_owned(),
                            message: "the manifests record no attributes for this version"
                                .to_owned(),
                        },
                    },
                },
                Err(err) => AttributesView::Unavailable {
                    error: IpcError::from(err.clone()),
                },
            }
        };
        Ok(EntryDetails {
            key: key.clone(),
            path: NameText::of(e.path.as_stored()),
            kind: kind(e.kind),
            size: e.logical_len.to_string(),
            content_hash: e.content_hash.map(|h| h.to_hex()),
            file_version_id: hex(e.version.as_bytes()),
            attributes,
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use std::path::PathBuf;

    use mochi_core::job::JobContext;
    use mochi_core::manifest::{Mtime, PosixAttributes};
    use mochi_core::publish::{ArchiveWriter, CheckpointPolicy, Transaction};
    use mochi_core::storage::os::OsStorage;
    use mochi_testkit::archive::{build, encrypted_options, scripted_history, test_options, Job};
    use mochi_testkit::SeqIds;

    use super::*;

    fn scripted(dir: &tempfile::TempDir) -> PathBuf {
        let path = dir.path().join("scripted.mochi");
        build(
            OsStorage::create_new(&path).unwrap(),
            7,
            &scripted_history(),
        )
        .unwrap();
        path
    }

    fn key(s: &[u8]) -> String {
        hex(s)
    }

    fn names(page: &ChildrenPage) -> Vec<String> {
        page.entries.iter().map(|e| e.name.text.clone()).collect()
    }

    #[test]
    fn an_archive_opens_with_its_history_and_head_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let archives = Archives::default();
        let s = archives
            .open(&scripted(&dir), ReadOptions::default())
            .unwrap();
        assert_eq!(s.file_name, "scripted.mochi");
        let seqs: Vec<u64> = s.commits.iter().map(|c| c.seq).collect();
        assert_eq!(seqs, [0, 1, 2]);
        assert!(s.commits.iter().all(|c| c.checkpoint));
        assert!(s.retention_error.is_none());
        assert!(s.commits.iter().all(|c| c.retained == Some(true)));
        assert_eq!(
            s.profile,
            ProfileView {
                tar_compatible: false,
                encrypted: false,
                redundancy_percent: None
            }
        );

        // The head, against the scripted model (independent of the catalog).
        let model = scripted_history().last().unwrap().after.clone();
        let snap = archives.snapshot(s.handle, 2).unwrap();
        assert_eq!(snap.entries as usize, model.len());
        assert_eq!(snap.catalog_source, CatalogSourceView::Image);
        let root = archives.children(s.handle, 2, None, false, 0, 100).unwrap();
        let mut expected_root: Vec<String> = model
            .keys()
            .filter(|k| !k.contains(&b'/'))
            .map(|k| String::from_utf8(k.clone()).unwrap())
            .collect();
        expected_root.sort();
        let mut got = names(&root);
        got.sort();
        assert_eq!(got, expected_root);
        assert_eq!(root.entries[0].kind, EntryKindView::Directory, "dirs first");
        assert_eq!(root.total as usize, expected_root.len());
    }

    #[test]
    fn earlier_snapshots_show_their_own_namespace() {
        let dir = tempfile::tempdir().unwrap();
        let archives = Archives::default();
        let s = archives
            .open(&scripted(&dir), ReadOptions::default())
            .unwrap();
        let steps = scripted_history();
        for (seq, step) in steps.iter().enumerate() {
            let seq = seq as u64;
            let mut got = Vec::new();
            // Walk the whole tree through pages of 2, as the UI would.
            let mut dirs = vec![None::<String>];
            while let Some(d) = dirs.pop() {
                let mut offset = 0;
                loop {
                    let page = archives
                        .children(s.handle, seq, d.as_deref(), false, offset, 2)
                        .unwrap();
                    if page.entries.is_empty() {
                        break;
                    }
                    offset += page.entries.len() as u32;
                    for e in page.entries {
                        if e.kind == EntryKindView::Directory {
                            dirs.push(Some(e.key.clone()));
                        }
                        got.push(parse_key(&e.key).unwrap().as_stored().to_vec());
                    }
                }
            }
            got.sort();
            let want: Vec<Vec<u8>> = step.after.keys().cloned().collect();
            assert_eq!(got, want, "snapshot {seq}");
        }
    }

    #[test]
    fn details_carry_the_recorded_hash_and_attributes() {
        let dir = tempfile::tempdir().unwrap();
        let archives = Archives::default();
        let s = archives
            .open(&scripted(&dir), ReadOptions::default())
            .unwrap();
        let model = scripted_history().last().unwrap().after.clone();
        let hostile = b"<img src=x onerror=alert(1)>";
        let d = archives.details(s.handle, 2, &key(hostile)).unwrap();
        assert_eq!(d.path.text, "<img src=x onerror=alert(1)>");
        assert!(d.path.verbatim);
        let mochi_testkit::archive::Content::File(bytes) = &model[hostile.as_slice()] else {
            panic!("a file in the model")
        };
        assert_eq!(d.size, bytes.len().to_string());
        assert_eq!(
            d.content_hash.as_deref(),
            Some(blake3::hash(bytes).to_hex().as_str()),
            "plain BLAKE3 of the content (O20), computed here independently"
        );
        let AttributesView::Recorded { posix, mtime, .. } = d.attributes else {
            panic!("attributes recorded: {:?}", d.attributes)
        };
        assert_eq!(
            posix,
            Some(PosixView {
                mode: 0o644,
                uid: 1000,
                gid: 1000
            })
        );
        assert!(mtime.is_some());
        let docs = archives.details(s.handle, 2, &key(b"docs")).unwrap();
        assert_eq!(docs.kind, EntryKindView::Directory);
        assert_eq!(docs.content_hash, None);
    }

    #[test]
    fn untrusted_requests_are_refused_with_invalid_argument() {
        let dir = tempfile::tempdir().unwrap();
        let archives = Archives::default();
        let s = archives
            .open(&scripted(&dir), ReadOptions::default())
            .unwrap();
        let h = s.handle;
        let code = |r: Result<ChildrenPage>| r.unwrap_err().code;
        assert_eq!(
            code(archives.children(h, 9, None, false, 0, 10)),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            code(archives.children(h, 2, None, false, 0, 0)),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            code(archives.children(h, 2, None, false, 0, MAX_PAGE as u32 + 1)),
            ErrorCode::InvalidArgument
        );
        for bad in ["", "zz", "6", "2f", "646f6373", "big"] {
            let r = archives.children(h, 2, Some(bad), false, 0, 10);
            // "646f6373" is `docs`, a valid directory: the one that succeeds.
            if bad == "646f6373" {
                assert!(r.is_ok());
            } else {
                assert_eq!(code(r), ErrorCode::InvalidArgument, "{bad:?}");
            }
        }
        // A file is not a directory; an absent path is not an entry.
        assert_eq!(
            code(archives.children(h, 2, Some(&key(b"big")), false, 0, 10)),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            archives.details(h, 2, &key(b"nope")).unwrap_err().code,
            ErrorCode::InvalidArgument
        );
        assert!(archives.close(h));
        assert!(!archives.close(h));
        assert_eq!(
            code(archives.children(h, 2, None, false, 0, 10)),
            ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn open_archives_are_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let path = scripted(&dir);
        let archives = Archives::default();
        for _ in 0..MAX_OPEN {
            archives.open(&path, ReadOptions::default()).unwrap();
        }
        let e = archives.open(&path, ReadOptions::default()).unwrap_err();
        assert_eq!(e.code, ErrorCode::LimitExceeded);
        assert_eq!(archives.open_count(), MAX_OPEN);
    }

    #[test]
    fn files_that_are_not_archives_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("not.mochi");
        std::fs::write(&path, b"this is not an archive").unwrap();
        let archives = Archives::default();
        assert!(archives.open(&path, ReadOptions::default()).is_err());
        assert!(archives
            .open(&dir.path().join("missing.mochi"), ReadOptions::default())
            .is_err());
        assert_eq!(archives.open_count(), 0);
    }

    #[test]
    fn an_encrypted_archive_needs_a_passphrase_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("enc.mochi");
        let mut w = ArchiveWriter::create(
            OsStorage::create_new(&path).unwrap(),
            Box::new(SeqIds::new(3)),
            encrypted_options(&["correct horse"]),
        )
        .unwrap();
        let job = Job::new();
        let mut tx = Transaction::new();
        tx.put_file(
            mochi_testkit::archive::path("secret.txt"),
            b"x".to_vec(),
            Attributes::default(),
        );
        w.commit(tx, &job.ctx()).unwrap();
        w.close().unwrap();
        let e = Archives::default()
            .open(&path, ReadOptions::default())
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::KeyUnavailable);
    }

    /// Names that are not UTF-8, and control and bidi characters, cross as
    /// an escaped rendering plus an exact key that round-trips.
    #[test]
    fn hostile_names_are_escaped_and_keys_are_exact() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("names.mochi");
        let mut w = ArchiveWriter::create(
            OsStorage::create_new(&path).unwrap(),
            Box::new(SeqIds::new(5)),
            test_options(),
        )
        .unwrap();
        let attrs = Attributes {
            posix: Some(PosixAttributes {
                mode: 0o600,
                uid: 0,
                gid: 0,
            }),
            windows: Some(WINDOWS_HIDDEN | WINDOWS_READONLY),
            mtime: Some(Mtime {
                secs: 1_700_000_000,
                nanos: 0,
            }),
        };
        let raw: [&[u8]; 4] = [
            b"bad\xff\xfename",
            b"esc\x1b[31mred",
            "rtl\u{202E}gpj.exe".as_bytes(),
            b"line\nbreak",
        ];
        let mut tx = Transaction::new();
        for r in raw {
            tx.put_file(ArchivePath::from_stored(r).unwrap(), r.to_vec(), attrs);
        }
        let job = Job::new();
        w.commit(tx, &job.ctx()).unwrap();
        w.close().unwrap();
        let archives = Archives::default();
        let s = archives.open(&path, ReadOptions::default()).unwrap();
        let page = archives.children(s.handle, 0, None, false, 0, 10).unwrap();
        assert_eq!(page.total, 4);
        for e in &page.entries {
            assert!(!e.name.verbatim, "{:?} was escaped", e.name.text);
            assert!(!e.name.text.chars().any(char::is_control));
            let stored = parse_key(&e.key).unwrap();
            assert!(raw.contains(&stored.as_stored()));
            let d = archives.details(s.handle, 0, &e.key).unwrap();
            assert_eq!(d.size, stored.as_stored().len().to_string());
            let AttributesView::Recorded { windows, .. } = d.attributes else {
                panic!("recorded")
            };
            assert_eq!(
                windows,
                Some(vec!["read-only".to_owned(), "hidden".to_owned()])
            );
        }
        assert_eq!(
            names(&page),
            [
                "bad\\xff\\xfename",
                "esc\\u{1b}[31mred",
                "line\\u{a}break",
                "rtl\\u{202e}gpj.exe"
            ]
        );
    }

    /// Plan D1 exit, library side: a 100,000-entry snapshot is browsed a
    /// page at a time; no page exceeds the limit, and every entry is reached.
    #[test]
    fn a_hundred_thousand_entries_browse_in_bounded_pages() {
        const FILES: u32 = 100_000;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.mochi");
        let mut w = ArchiveWriter::create(
            OsStorage::create_new(&path).unwrap(),
            Box::new(SeqIds::new(11)),
            test_options(),
        )
        .unwrap();
        w.set_checkpoint_policy(CheckpointPolicy::EveryCommit)
            .unwrap();
        let mut tx = Transaction::new();
        tx.put_dir(mochi_testkit::archive::path("many"), Attributes::default());
        for i in 0..FILES {
            tx.put_file(
                ArchivePath::from_stored(format!("many/f{i:06}").as_bytes()).unwrap(),
                Vec::new(),
                Attributes::default(),
            );
        }
        let job = Job::new();
        let ctx: JobContext<'_> = job.ctx();
        w.commit(tx, &ctx).unwrap();
        w.close().unwrap();

        let archives = Archives::default();
        let s = archives.open(&path, ReadOptions::default()).unwrap();
        let snap = archives.snapshot(s.handle, 0).unwrap();
        assert_eq!(snap.entries, FILES + 1);
        let many = key(b"many");
        let mut seen = 0u32;
        let mut last: Option<String> = None;
        loop {
            let page = archives
                .children(s.handle, 0, Some(&many), false, seen, MAX_PAGE as u32)
                .unwrap();
            assert_eq!(page.total, FILES);
            assert!(page.entries.len() <= MAX_PAGE);
            if page.entries.is_empty() {
                break;
            }
            for e in &page.entries {
                assert!(last.as_deref() < Some(e.name.text.as_str()), "ordered");
                last = Some(e.name.text.clone());
            }
            seen += page.entries.len() as u32;
        }
        assert_eq!(seen, FILES);
        // A page deep in the directory is as small as the first.
        let deep = archives
            .children(s.handle, 0, Some(&many), false, 99_990, 50)
            .unwrap();
        assert_eq!(deep.entries.len(), 10);
        assert_eq!(deep.entries[0].name.text, "f099990");
    }
}
