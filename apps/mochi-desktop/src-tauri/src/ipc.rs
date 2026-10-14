//! Types that cross the IPC boundary. Each derives [`TS`] and is exported to
//! `ui/src/ipc/generated/` (`cargo test` writes them; never edit those files
//! by hand). Counters are `u64` in Rust and `number` in TypeScript: they
//! count steps, objects, or bytes of one job and stay far below 2^53.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Identifies one job for the lifetime of the process.
pub type JobId = u32;

/// What the UI asks the job runner to do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum JobRequest {
    /// A synthetic job with no archive I/O: `steps` steps of `step_ms`
    /// milliseconds each, reporting progress and honouring cancellation
    /// (plan D0 exit). Limits: 1 to 1,000 steps, at most 1,000 ms each.
    SelfTest { steps: u32, step_ms: u32 },
    /// D2: create a new archive at the destination the user chose
    /// (`choose_destination`) from the sources they staged (`stage_sources`,
    /// or dropped onto the window). The webview names no path.
    CreateArchive {
        preset: CompressionPreset,
        /// "Readable with standard zstd + tar" (O4): fixed at creation.
        tar_compatible: bool,
    },
    /// D2: add the staged sources to an open archive as one new commit.
    AddToArchive { handle: ArchiveHandle },
    /// D2: remove entries from an open archive's current snapshot as one
    /// new commit. Their content stays in the archive's history.
    DeleteFromArchive {
        handle: ArchiveHandle,
        /// Entries of the head snapshot, as the listing returned them.
        keys: Vec<PathKey>,
    },
    /// D3: extract entries of one snapshot of an open archive into the folder
    /// the user chose (`plan_extract` shows the native folder dialog from
    /// Rust and remembers the choice). The webview names no path.
    ExtractArchive {
        handle: ArchiveHandle,
        /// The snapshot on screen.
        seq: u32,
        /// Entries (and what is under them) as the listing returned them;
        /// empty extracts the whole snapshot.
        keys: Vec<PathKey>,
        on_conflict: ConflictChoice,
    },
    /// D8: read every entry of an open foreign archive (ZIP, 7z, RAR, tar,
    /// tar.gz) through the format's own checks and report which checks ran.
    /// Read-only; it is not a MOCHI verification.
    TestForeign { handle: ArchiveHandle },
    /// D8: extract entries of an open foreign archive into the folder the
    /// user chose (`plan_extract_foreign` remembers the choice). Every byte is
    /// written by the C6 restore rules (`mochi_core::restore_foreign`).
    ExtractForeign {
        handle: ArchiveHandle,
        /// Entries (and what is under them) as the listing returned them;
        /// empty extracts everything.
        keys: Vec<PathKey>,
        on_conflict: ConflictChoice,
    },
}

/// Everything the runner says about one job, in order: `started`, any
/// number of `progress`, then exactly one `finished`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "event", rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum JobEvent {
    Started {
        job_id: JobId,
    },
    Progress {
        job_id: JobId,
        /// A stable phase name chosen by the job.
        phase: String,
        #[ts(type = "number")]
        completed: u64,
        /// `null` while the total is not known.
        #[ts(type = "number | null")]
        total: Option<u64>,
    },
    Finished {
        job_id: JobId,
        outcome: JobOutcome,
    },
}

/// How a job ended. Only `completed` means the job did everything it was
/// asked; the UI gives no success styling to anything else (spec §23.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum JobOutcome {
    Completed {
        summary: String,
        /// Set by the jobs that publish a commit (D2).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        commit: Option<Box<CommitReport>>,
        /// Set by the extract job (D3).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        extract: Option<Box<ExtractReport>>,
        /// Set by the foreign-archive test job (D8).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        foreign_test: Option<Box<ForeignTestReport>>,
    },
    /// Stopped at a safe point because cancellation was requested.
    Cancelled,
    /// Ended with an error; `code` is a registered `mochi-core` error code.
    Failed { code: String, message: String },
    /// Ended without producing a result (an internal fault). Never a
    /// statement about any archive.
    Aborted { message: String },
}

/// An error returned by a command. `code` is a registered `mochi-core`
/// error code (`ErrorCode::as_str`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct IpcError {
    pub code: String,
    pub message: String,
}

impl From<mochi_core::MochiError> for IpcError {
    fn from(e: mochi_core::MochiError) -> Self {
        IpcError {
            code: e.code.as_str().to_owned(),
            message: e.message,
        }
    }
}

// ---- D1: browsing an archive ------------------------------------------------
//
// Archive-supplied strings (names, hold labels) cross as [`NameText`]: an
// escaped, single-line rendering (`mochi_core::text::escape`, the CLI's rule)
// that the UI shows as text only. Paths are identified by [`PathKey`], the
// stored bytes in hex, so a name that is not UTF-8 round-trips exactly.
// Sizes and other archive-derived 64-bit values are decimal strings: an
// archive is untrusted and may claim values above 2^53.

/// Identifies one opened archive for the lifetime of the process.
pub type ArchiveHandle = u32;

/// An archive path's stored bytes as lowercase hex.
pub type PathKey = String;

/// An archive-supplied string, rendered for display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct NameText {
    /// One line, control and bidi characters and non-UTF-8 bytes escaped.
    pub text: String,
    /// `false` when `text` differs from the stored bytes (something was
    /// escaped); the UI then says so.
    pub verbatim: bool,
}

impl NameText {
    pub fn of(bytes: &[u8]) -> Self {
        NameText {
            text: mochi_core::text::escape(bytes),
            verbatim: mochi_core::text::is_verbatim(bytes),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum EntryKindView {
    File,
    Directory,
}

/// The profile fixed at the archive's creation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct ProfileView {
    pub tar_compatible: bool,
    pub encrypted: bool,
    /// Parity percentage of the recovery record, if the archive has one.
    pub redundancy_percent: Option<u16>,
}

/// One commit of the published history (the snapshot timeline).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct CommitView {
    /// Commit sequence numbers are verified to run 0, 1, 2, … along the
    /// parent chain, so they count commits and stay below 2^53.
    #[ts(type = "number")]
    pub seq: u64,
    pub commit_id: String,
    /// RFC 3339 UTC, or `null` when the commit recorded no time.
    pub time: Option<String>,
    pub checkpoint: bool,
    /// `null` when retention could not be determined.
    pub retained: Option<bool>,
    pub expired: Option<bool>,
    pub holds: Vec<NameText>,
}

/// An archive opened for browsing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct ArchiveSummary {
    pub handle: ArchiveHandle,
    /// The file's name on this computer (chosen by the user, not archive data).
    pub file_name: String,
    pub archive_id: String,
    pub profile: ProfileView,
    /// Oldest first; the last one is the head.
    pub commits: Vec<CommitView>,
    /// Why retention is unknown, when it is (`retained`/`expired` are then
    /// `null` on every commit).
    pub retention_error: Option<IpcError>,
}

/// Where an opened snapshot's catalog came from (`CatalogSource`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "source", rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum CatalogSourceView {
    Image,
    /// The catalog image was damaged; the same commit's snapshot manifest
    /// stood in for it.
    SnapshotManifest {
        image_error: IpcError,
    },
}

/// One snapshot opened for browsing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct SnapshotView {
    #[ts(type = "number")]
    pub seq: u64,
    pub commit_id: String,
    /// Entries in the snapshot, directories included.
    pub entries: u32,
    pub root_dirs: u32,
    pub root_files: u32,
    pub catalog_source: CatalogSourceView,
}

/// One row of a directory listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct EntryRow {
    pub key: PathKey,
    pub name: NameText,
    pub kind: EntryKindView,
    /// Logical size in bytes, decimal; "0" for a directory.
    pub size: String,
    pub child_dirs: u32,
    pub child_files: u32,
}

/// A slice of one directory's children (`mochi_core::browse` order:
/// directories first, then files, each in name byte order).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct ChildrenPage {
    pub total: u32,
    pub offset: u32,
    pub entries: Vec<EntryRow>,
}

/// POSIX attributes as recorded (spec D6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct PosixView {
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
}

/// The promised attributes of an entry (spec §10.4.1, D6). `null` fields
/// were not recorded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum AttributesView {
    Recorded {
        posix: Option<PosixView>,
        /// Windows attribute bits MOCHI promises, by name.
        windows: Option<Vec<String>>,
        /// RFC 3339 UTC; `null` if not recorded or not representable.
        mtime: Option<String>,
    },
    /// The attributes could not be read (for example a damaged manifest);
    /// they are not guessed.
    Unavailable { error: IpcError },
}

/// Everything the details pane shows for one entry. Listing reads the
/// catalog only: the content hash is the recorded one, not a verification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct EntryDetails {
    pub key: PathKey,
    pub path: NameText,
    pub kind: EntryKindView,
    pub size: String,
    /// Plain BLAKE3 of the content (O20), hex; `null` for a directory.
    pub content_hash: Option<String>,
    pub file_version_id: String,
    pub attributes: AttributesView,
}

// ---- D2: create and add -----------------------------------------------------
//
// The webview never names a path. The user picks sources in a native dialog
// shown from Rust, or drops them on the window (Rust receives the window's
// drop event); Rust keeps the paths and the webview sees only display names.

/// How hard the compressor works (Zstandard level; spec §7 leaves the level to
/// the writer, and readers cannot tell the difference). Not a format choice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum CompressionPreset {
    /// Level 1: quickest, largest.
    Fast,
    /// The writer's default level.
    Balanced,
    /// Level 19: slowest, smallest.
    Smaller,
}

/// Which native dialog `stage_sources` shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum SourcePick {
    Files,
    Folder,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum StagedKind {
    File,
    Folder,
    /// A link, device, or other entry that is not stored (it is reported
    /// when the commit is made).
    Other,
}

/// One staged source, by the name it would have in the archive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct StagedItem {
    pub name: NameText,
    pub kind: StagedKind,
}

/// What is staged to add: the sources the next create or add would store,
/// and where a new archive would be written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct StagedView {
    pub items: Vec<StagedItem>,
    /// File name of the chosen destination for a new archive, if chosen.
    pub destination: Option<String>,
}

/// What reaches the webview about drag and drop (Rust handles the window's
/// event; the webview needs no permission to hear it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "event", rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum DropEvent {
    /// Something is being dragged over (or has left) the window.
    Hover { active: bool },
    /// Items were dropped. `staged` is the whole staged set after adding
    /// them; `problems` explains each dropped item that was not staged.
    Dropped {
        staged: StagedView,
        problems: Vec<IpcError>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum CommitOperation {
    Create,
    Add,
    Delete,
}

/// A source entry a commit left out, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct SkippedView {
    pub path: NameText,
    pub reason: String,
}

/// The commit a create, add, or delete job published. `status` is always
/// `LOCAL_COMMITTED` (spec §5.3: nothing in 1.0 reports more).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct CommitReport {
    pub operation: CommitOperation,
    pub status: String,
    #[ts(type = "number")]
    pub seq: u64,
    pub commit_id: String,
    #[ts(type = "number")]
    pub files: u64,
    #[ts(type = "number")]
    pub directories: u64,
    /// Content bytes read from the sources.
    #[ts(type = "number")]
    pub bytes: u64,
    /// Entries removed from the snapshot (a delete).
    #[ts(type = "number")]
    pub removed: u64,
    pub skipped: Vec<SkippedView>,
    /// Set when the new file's directory entry is not confirmed durable
    /// (the commit is reported degraded, never durable).
    pub durability_note: Option<String>,
    /// The archive as it now stands, reopened for browsing (same handle as
    /// before for an add or delete; a new one for a create). `null` if it
    /// could not be reopened; `reopen_error` says why.
    pub archive: Option<ArchiveSummary>,
    pub reopen_error: Option<IpcError>,
}

/// The staged set after `stage_sources`, and any source that could not be
/// staged (the rest still were).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct StageOutcome {
    pub staged: StagedView,
    pub problems: Vec<IpcError>,
}

// ---- D3: extract ------------------------------------------------------------
//
// The folder is chosen in a native dialog shown from Rust and kept there; the
// webview sees its display text and what the destination holds, never names a
// path. Archive-supplied strings cross as [`NameText`], as in D1.

/// What an extract does about names that cannot be extracted into the folder
/// (an entry with that name is already there, the folder treats two names as
/// one, or the file system cannot hold the name).
///
/// The restore engine (plan C6) has exactly one behaviour for these: the entry
/// is skipped, nothing is overwritten, and no name is changed. Keeping both
/// under a new name and replacing need engine support that does not exist
/// (plan D3 status, "Gap").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum ConflictChoice {
    /// End the job before anything is written if any entry cannot be
    /// extracted (what the plan showed was none).
    Stop,
    /// Skip those entries (and what is under a skipped folder), extract the
    /// rest, and report each one.
    SkipConflicts,
}

/// One entry that cannot be extracted into the chosen folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct ConflictView {
    pub path: NameText,
    /// `NAME_COLLISION` or `NAME_UNSUPPORTED`.
    pub code: String,
    /// Why, as one sentence.
    pub reason: String,
}

/// What extracting would meet in the chosen folder, found before anything is
/// written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct ExtractPlan {
    /// The folder the user chose (their own path, not archive data).
    pub destination: String,
    /// Entries the extraction handles: the selection, what is under it, and
    /// the folders above it.
    pub entries: u32,
    /// The first conflicts, in path order (at most 200).
    pub conflicts: Vec<ConflictView>,
    pub conflicts_total: u32,
    /// Whether the folder treats names that differ only in case as one.
    pub case_insensitive: bool,
}

/// One entry an extraction did not restore.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct NotExtractedView {
    pub path: NameText,
    /// A registered error code (`NAME_COLLISION`, `NAME_UNSUPPORTED`,
    /// `CONTENT_INTEGRITY_FAILED`, …).
    pub code: String,
    pub reason: NameText,
}

/// An attribute that was not applied to extracted entries, summarised per
/// kind (plan O6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct AttributeNote {
    /// What was not applied, in words ("owner and group", …).
    pub attribute: String,
    #[ts(type = "number")]
    pub count: u64,
    pub first_path: NameText,
    pub reason: NameText,
}

/// What an extract job did. It is not a verification: it speaks only of the
/// entries it extracted (spec §23.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct ExtractReport {
    pub destination: String,
    pub seq: u32,
    #[ts(type = "number")]
    pub files: u64,
    #[ts(type = "number")]
    pub directories: u64,
    /// Content bytes written to extracted files.
    #[ts(type = "number")]
    pub bytes: u64,
    /// The first entries not extracted (at most 1,000).
    pub not_extracted: Vec<NotExtractedView>,
    #[ts(type = "number")]
    pub not_extracted_total: u64,
    pub attribute_notes: Vec<AttributeNote>,
    /// Why no attribute was applied, when the promised attributes could not
    /// be reconstructed.
    pub attributes_unavailable: Option<NameText>,
    /// Set when the folder's directory entries are not confirmed durable.
    pub durability_note: Option<String>,
    pub case_insensitive: bool,
}

// ---- D8: foreign archives ----------------------------------------------------
//
// ZIP, 7z, RAR, tar and tar.gz open read-only. Nothing here uses MOCHI's
// verification wording or health dimensions (plan D8 rule 6): a foreign
// "test" reports the checks that ran, recoverability/freshness/retention are
// fixed at UNSUPPORTED. Names cross as `NameText`, as in D1.

/// The MOCHI health dimensions a foreign format cannot have.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct ForeignDimensionsView {
    pub recoverability: String,
    pub freshness: String,
    pub retention: String,
}

/// A foreign archive opened for browsing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct ForeignArchiveSummary {
    pub handle: ArchiveHandle,
    /// The file's name on this computer (chosen by the user).
    pub file_name: String,
    /// `ZIP`, `7z`, `RAR`, `tar`, or `tar.gz`.
    pub format: String,
    #[ts(type = "number")]
    pub entries: u64,
    /// `false` when the listing stopped early; `stop_reason` says why. A
    /// partial listing is labelled partial, never presented as the whole.
    pub complete: bool,
    pub stop_reason: Option<NameText>,
    /// Limit breaches met while listing, one sentence each.
    pub notes: Vec<String>,
    /// What this format checks per entry, in words ("CRC32 per entry").
    pub checks: String,
    /// The password the user gave opened the archive (names encrypted).
    pub opened_with_password: bool,
    /// Some entries use ZipCrypto, which is weak.
    pub weak_encryption: bool,
    pub dimensions: ForeignDimensionsView,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum ForeignKindView {
    File,
    Directory,
    /// A symbolic or hard link: listed, never extracted.
    Link,
    /// A device, pipe, or other special entry: listed, never extracted.
    Special,
}

/// One row of a foreign archive's listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct ForeignRow {
    /// Selects or descends; `null` for an entry whose name was refused (it is
    /// shown, but cannot be selected).
    pub key: Option<PathKey>,
    pub name: NameText,
    pub kind: ForeignKindView,
    /// Declared size in bytes, decimal (a claim, not a measurement).
    pub size: Option<String>,
    pub child_dirs: u32,
    pub child_files: u32,
    /// `AES-256`, `weak encryption (ZipCrypto)`, ...
    pub encryption: Option<String>,
    /// Why this entry will not be extracted, when it will not be.
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct ForeignChildrenPage {
    pub total: u32,
    pub offset: u32,
    pub entries: Vec<ForeignRow>,
}

/// What `plan_extract_foreign` found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct ForeignExtractPlan {
    pub plan: ExtractPlan,
    /// Links and special entries in the selection: always skipped.
    pub skipped_kinds: u32,
}

/// How many entries ended in one way, by the words the format's check used.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct CheckCount {
    /// "CRC32 matched", "read without error; this format has no per-entry
    /// check", "password required", ...
    pub what: String,
    #[ts(type = "number")]
    pub count: u64,
}

/// An entry whose read did not end cleanly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct ForeignProblem {
    pub path: NameText,
    pub what: NameText,
}

/// What a foreign test job found. It names the checks that ran; it is not a
/// verification and says nothing about recoverability, freshness, or
/// retention (spec §23.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct ForeignTestReport {
    pub format: String,
    #[ts(type = "number")]
    pub entries: u64,
    pub checks: Vec<CheckCount>,
    /// The first entries that did not end cleanly (at most 1,000).
    pub problems: Vec<ForeignProblem>,
    #[ts(type = "number")]
    pub problems_total: u64,
    /// The whole-stream check, where the format has one.
    pub stream_check: String,
    pub complete: bool,
    pub stop_reason: Option<NameText>,
    #[ts(type = "number")]
    pub bytes_read: u64,
    pub dimensions: ForeignDimensionsView,
}
