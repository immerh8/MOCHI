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
    },
    /// Stopped at a safe point because cancellation was requested.
    Cancelled,
    /// Ended with an error; `code` is a registered `mochi-core` error code.
    Failed {
        code: String,
        message: String,
    },
    /// Ended without producing a result (an internal fault). Never a
    /// statement about any archive.
    Aborted {
        message: String,
    },
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
