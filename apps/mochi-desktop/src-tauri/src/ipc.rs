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
    /// D4 "Test archive": verify the chosen archive (`choose_check_subject`)
    /// read-only with `mochi_core::verify`, as `mochi verify` (or `mochi
    /// fsck` with `deep`) does. The webview names no path.
    TestArchive {
        subject: SubjectId,
        level: CheckLevel,
        /// Also open every commit at its own footer and recover every replay
        /// segment (`fsck`).
        deep: bool,
    },
    /// D4: plan a repair of the chosen archive (`mochi_core::repair`,
    /// read-only), with the copies chosen through `repair_setup` and, when
    /// `salvage`, the bounded salvage scan (step 7).
    PlanRepair {
        subject: SubjectId,
        salvage: bool,
        /// With `salvage`: the archive to keep when the scan finds several
        /// (64 hexadecimal digits). Typed by the user.
        archive_id: Option<String>,
    },
    /// D4: write the approved plan into the new file chosen through
    /// `repair_setup` (never the source, never an existing file), then
    /// re-verify it (`mochi_core::repair::apply`).
    ApplyRepair {
        subject: SubjectId,
        /// The plan the user reviewed and approved.
        plan: PlanId,
        accept_retention_loss: bool,
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
        /// Set by the test and repair jobs (D4).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        check: Option<Box<CheckResult>>,
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

// ---- D4: test, health, and repair -------------------------------------------
//
// The archive to test or repair, the copies, and the new file are chosen in
// native dialogs shown from Rust and kept there; the webview refers to them by
// ID. Reports are converted from `mochi_core::report::Report` (schema v1) for
// display, and the exact JSON core produced travels with them (`json`) and is
// what "Export report JSON" writes. Archive-supplied text inside findings and
// plans crosses as [`NameText`].

/// Identifies the archive chosen for testing, health, or repair.
pub type SubjectId = u32;
/// Identifies a report kept for export.
pub type ReportId = u32;
/// Identifies a repair plan kept for approval.
pub type PlanId = u32;

/// The verification levels `mochi verify --level` offers that this build
/// runs (spec §20.1). Inventory, search, and disaster recovery are
/// `UNSUPPORTED` in 1.0 and not offered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum CheckLevel {
    Structural,
    Referential,
    StoredIntegrity,
    ContentIntegrity,
    Restoration,
}

/// Where the archive to test or repair comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "from", rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum SubjectSource {
    /// The native open dialog, shown from Rust (any file: an archive too
    /// damaged, or an Encrypted one, cannot be opened in the browser).
    Dialog,
    /// The file of an archive open in the browser.
    OpenArchive { handle: ArchiveHandle },
    /// The new archive the last repair wrote.
    RepairOutput,
}

/// The archive chosen for testing, health, or repair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct SubjectView {
    pub id: SubjectId,
    /// The file's name on this computer (the user's, not archive data).
    pub file_name: String,
}

/// A spec §20.4 status value, spelled as in the report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum StatusView {
    Pass,
    Fail,
    Degraded,
    Unknown,
    Overdue,
    Unsupported,
}

/// One health dimension of a report (spec §20.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct DimensionView {
    /// As in the report (`integrity`, `key_availability`, …).
    pub dimension: String,
    pub status: StatusView,
    /// The report's policy requires it.
    pub required: bool,
}

/// One finding of a report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct FindingView {
    /// A registered error code.
    pub code: String,
    /// `info`, `warning`, or `error`.
    pub severity: String,
    pub message: Option<NameText>,
    pub expected: Option<NameText>,
    pub observed: Option<NameText>,
    /// The commits affected, as an inclusive range.
    pub affected: Option<SeqRangeView>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct SeqRangeView {
    #[ts(type = "number")]
    pub first: u64,
    #[ts(type = "number")]
    pub last: u64,
}

/// Something a report did not check, or a note, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct ReportNoteView {
    pub item: NameText,
    pub reason: NameText,
}

/// Objects and bytes checked versus expected, as decimal strings; `null`
/// means not measured, which is not zero.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct CoverageView {
    pub expected_objects: Option<String>,
    pub checked_objects: Option<String>,
    pub expected_bytes: Option<String>,
    pub checked_bytes: Option<String>,
    pub evidence_age_seconds: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum ReportKind {
    /// "Test archive" (`verify`, or `fsck` when deep).
    Test,
    /// The health summary (`mochi_core::health`).
    Health,
}

/// A report schema v1 (spec §20.5) for display, and its exact JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct ReportView {
    /// Pass to `export_report`.
    pub report_id: ReportId,
    pub kind: ReportKind,
    /// The file that was checked (the user's name for it).
    pub file_name: String,
    /// Also opened every commit and recovered every segment (`fsck`).
    pub deep: bool,
    /// The archive is Encrypted and was checked without its key (stored
    /// integrity only; names, content, and recoverability need the
    /// passphrase, which the app cannot take until D5).
    pub keyless: bool,
    pub schema_version: u32,
    pub archive_id: Option<String>,
    pub checked_commit: Option<String>,
    pub expected_head: Option<String>,
    /// `none`, `user`, or `local-history`.
    pub freshness_anchor: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    /// As in the report (`restoration`, `stored_integrity`, …).
    pub level: String,
    pub scope: Option<NameText>,
    /// In the report's order.
    pub dimensions: Vec<DimensionView>,
    pub overall_status: StatusView,
    pub policy_result: StatusView,
    pub exit_code: u8,
    pub operational_error: bool,
    pub coverage: CoverageView,
    pub findings: Vec<FindingView>,
    pub skipped: Vec<ReportNoteView>,
    /// The report exactly as `mochi verify --json` prints it (one line and a
    /// newline). "Export report JSON" writes these bytes unchanged.
    pub json: String,
}

/// The health summary (spec §20.3, §21; `mochi_core::health::assess`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct HealthView {
    pub report: ReportView,
    /// Evidence records of this archive that this app recorded since it
    /// started (nothing is saved; plan D4 "Gap").
    pub records: u32,
}

/// What the copies, the new file, and the plan of a repair are.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct RepairSetupView {
    /// File names of the independent copies, in the order given (step 5).
    pub copies: Vec<String>,
    /// File name of the new archive the repair would write, if chosen.
    pub output: Option<String>,
}

/// Changes to a repair's setup. Files are chosen in native dialogs shown from
/// Rust.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "action", rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum RepairSetupAction {
    /// Show the open dialog and add the chosen file as a copy (`--copy`).
    AddCopy,
    RemoveCopy {
        index: u32,
    },
    ClearCopies,
    /// Show the save dialog for the new archive.
    ChooseOutput,
    /// Only report the setup.
    Show,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum RepairOutcomeView {
    /// Every snapshot and entry the archive's history holds, with retention.
    Complete,
    /// Something is left out, or the bounded salvage scan was used.
    Partial,
    /// Nothing can be written.
    NothingRecoverable,
}

/// One rung of the §22 ladder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct LadderStepView {
    pub step: u8,
    pub name: String,
    /// `used`, `not_needed`, `not_available`, `not_attempted`, or
    /// `incomplete`.
    pub status: String,
    pub detail: NameText,
}

/// A snapshot the plan writes, one commit of the new archive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct PlannedSnapshotView {
    #[ts(type = "number")]
    pub seq: u64,
    /// `null` before a chain break: the commit record is not trusted.
    pub commit_id: Option<String>,
    pub entries: String,
    pub omitted: String,
    /// `image` or `snapshot_manifest`.
    pub catalog: String,
    /// `chain`, `copy_confirmed`, or `salvage`.
    pub trust: String,
}

/// A snapshot that is not written, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct LostSnapshotView {
    #[ts(type = "number")]
    pub seq: u64,
    pub commit_id: Option<String>,
    pub code: String,
    pub reason: NameText,
}

/// An entry left out of every written snapshot that held it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct OmittedView {
    pub path: NameText,
    /// `file` or `directory`.
    pub kind: String,
    /// The snapshots that held it.
    #[ts(type = "Array<number>")]
    pub snapshots: Vec<u64>,
    pub code: String,
    pub reason: NameText,
}

/// What a repair does with the source's retention state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum RetentionView {
    Carried {
        holds: u32,
        /// Holds on snapshots that are lost: they are lost too.
        holds_lost: u32,
        expired: u32,
    },
    /// Not rebuildable: applying needs the user to accept writing the new
    /// archive with no holds and nothing expired.
    Unresolved { code: String, reason: NameText },
}

/// An independent copy (step 5) and what it did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct CopyView {
    pub file_name: String,
    /// `used`, `not_needed`, `not_available`, or `unreadable`.
    pub status: String,
    pub frames_donated: String,
    pub detail: NameText,
}

/// The parity scan (step 6) of an archive with a recovery record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct ParityView {
    pub declared_percent: Option<u16>,
    pub shards_damaged: String,
    pub shards_rebuilt: String,
    pub groups_beyond_capacity: String,
}

/// The bounded salvage scan (step 7), when it ran.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct SalvageView {
    pub confirmed_commits: String,
    /// Never recovered: nothing confirms their publication.
    pub unconfirmed_commits: String,
    pub orphan_data_objects: String,
    pub limit_reached: bool,
}

/// A repair plan (`mochi_core::repair::RepairPlan`) for review. Nothing was
/// written to make it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct RepairPlanView {
    /// Pass to `ApplyRepair` to approve exactly this plan.
    pub plan_id: PlanId,
    pub file_name: String,
    pub outcome: RepairOutcomeView,
    /// As `mochi repair plan` exits: 0 complete, 2 partial, 1 nothing.
    pub exit_code: u8,
    pub archive_id: Option<String>,
    /// How the head was found: `eof`, `scan`, or `null` when none was.
    pub head_found_by: Option<String>,
    #[ts(type = "number | null")]
    pub head_seq: Option<u64>,
    /// `clean`, `uncommitted`, or `unresolved`, and how many bytes.
    pub tail_state: Option<String>,
    pub tail_len: Option<String>,
    /// The first trusted commit after a break in the chain, and why.
    #[ts(type = "number | null")]
    pub chain_break_at: Option<u64>,
    pub chain_break_reason: Option<NameText>,
    pub ladder: Vec<LadderStepView>,
    pub snapshots: Vec<PlannedSnapshotView>,
    pub lost: Vec<LostSnapshotView>,
    /// The first entries left out (at most 1,000); the total is always given.
    pub omitted: Vec<OmittedView>,
    pub omitted_total: String,
    pub manifest_failures: u32,
    /// `null` when nothing is recoverable.
    pub retention: Option<RetentionView>,
    pub parity: Option<ParityView>,
    pub copies: Vec<CopyView>,
    pub donations: String,
    pub salvage: Option<SalvageView>,
    /// A snapshot the plan writes rests on the salvage scan.
    pub salvage_used: bool,
    pub damage_found: bool,
}

/// One commit a repair wrote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct RepairedCommitView {
    #[ts(type = "number")]
    pub source_seq: u64,
    #[ts(type = "number")]
    pub new_seq: u64,
    pub entries: String,
    pub omitted: String,
    pub trust: String,
}

/// The independent verification of the new archive before it was published
/// (spec §22.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct ReverificationView {
    pub level: String,
    pub overall_status: StatusView,
    pub policy_result: StatusView,
    pub exit_code: u8,
    pub findings: String,
}

/// What a repair wrote (`mochi_core::repair::RepairReport`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct RepairResultView {
    pub outcome: RepairOutcomeView,
    pub exit_code: u8,
    /// The new file (the user's name for it).
    pub file_name: String,
    pub new_archive_id: String,
    pub new_len: String,
    pub commits: Vec<RepairedCommitView>,
    pub lost: Vec<LostSnapshotView>,
    pub omitted: Vec<OmittedView>,
    pub omitted_total: String,
    pub profile_constraints_lost: Vec<String>,
    pub retention_loss_accepted: bool,
    pub reverification: ReverificationView,
    pub durability_note: Option<String>,
    pub source_kept: bool,
    pub salvage_used: bool,
}

/// What a D4 job produced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum CheckResult {
    Test { report: ReportView },
    Plan { plan: RepairPlanView },
    Repair { result: RepairResultView },
}
