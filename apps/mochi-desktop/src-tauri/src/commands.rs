//! Tauri commands: thin adapters over the job runner and `mochi-core`
//! (AGENTS.md). Archive work runs on the blocking pool, never on the async
//! runtime.

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::browse::Archives;
use crate::ipc::{
    ArchiveHandle, ArchiveSummary, ChildrenPage, DropEvent, EntryDetails, IpcError, JobEvent,
    JobId, JobRequest, PathKey, SnapshotView, SourcePick, StageOutcome, StagedView,
};
use crate::jobs::{EventSink, JobRegistry};
use crate::write::{DropSink, DropWatch, Staging};

impl DropSink for Channel<DropEvent> {
    fn send(&self, event: DropEvent) -> bool {
        Channel::send(self, event).is_ok()
    }
}

impl EventSink for Channel<JobEvent> {
    fn send(&self, event: JobEvent) -> bool {
        Channel::send(self, event).is_ok()
    }
}

/// Start a job. Returns its ID at once; events stream over `on_event`.
/// CPU-bound or blocking work runs on the blocking pool, never on the async
/// runtime.
#[tauri::command]
pub async fn start_job(
    request: JobRequest,
    on_event: Channel<JobEvent>,
    jobs: State<'_, Arc<JobRegistry>>,
) -> Result<JobId, IpcError> {
    jobs.start(
        request,
        Arc::new(on_event),
        Box::new(|work| {
            tauri::async_runtime::spawn_blocking(work);
        }),
    )
}

/// Request cancellation of a running job. `false` if it is not running.
#[tauri::command]
pub fn cancel_job(job_id: JobId, jobs: State<'_, Arc<JobRegistry>>) -> bool {
    jobs.cancel(job_id)
}

/// Run `work` on the blocking pool and wait for it.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> mochi_core::Result<T> + Send + 'static,
) -> Result<T, IpcError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| IpcError {
            code: mochi_core::ErrorCode::Cancelled.as_str().to_owned(),
            message: "the operation stopped before it finished".to_owned(),
        })?
        .map_err(IpcError::from)
}

/// Ask the user for an archive in the native open dialog (in Rust; the
/// webview never names a path) and open it read-only. `null` if the user
/// cancelled the dialog.
#[tauri::command]
pub async fn open_archive(
    app: AppHandle,
    archives: State<'_, Arc<Archives>>,
) -> Result<Option<ArchiveSummary>, IpcError> {
    let archives = Arc::clone(&archives);
    blocking(move || match crate::picker::pick_archive(&app) {
        None => Ok(None),
        Some(path) => archives
            .open(&path, mochi_core::publish::ReadOptions::default())
            .map(Some),
    })
    .await
}

/// Close an archive. `false` if it was not open.
#[tauri::command]
pub fn close_archive(handle: ArchiveHandle, archives: State<'_, Arc<Archives>>) -> bool {
    archives.close(handle)
}

/// Open (or reuse) one snapshot of an open archive.
#[tauri::command]
pub async fn open_snapshot(
    handle: ArchiveHandle,
    seq: u32,
    archives: State<'_, Arc<Archives>>,
) -> Result<SnapshotView, IpcError> {
    let archives = Arc::clone(&archives);
    blocking(move || archives.snapshot(handle, u64::from(seq))).await
}

/// One page of a directory's children (`dir` null for the root).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn list_children(
    handle: ArchiveHandle,
    seq: u32,
    dir: Option<PathKey>,
    directories_only: bool,
    offset: u32,
    limit: u32,
    archives: State<'_, Arc<Archives>>,
) -> Result<ChildrenPage, IpcError> {
    let archives = Arc::clone(&archives);
    blocking(move || {
        archives.children(
            handle,
            u64::from(seq),
            dir.as_deref(),
            directories_only,
            offset,
            limit,
        )
    })
    .await
}

/// Details of one entry.
#[tauri::command]
pub async fn entry_details(
    handle: ArchiveHandle,
    seq: u32,
    key: PathKey,
    archives: State<'_, Arc<Archives>>,
) -> Result<EntryDetails, IpcError> {
    let archives = Arc::clone(&archives);
    blocking(move || archives.details(handle, u64::from(seq), &key)).await
}

/// Listen for items dropped on the window (D2). Rust receives the window's
/// drop event and stages the paths itself; the webview hears only names.
#[tauri::command]
pub fn watch_drops(on_drop: Channel<DropEvent>, watch: State<'_, Arc<DropWatch>>) {
    watch.set(Arc::new(on_drop));
}

/// What is staged to add.
#[tauri::command]
pub fn staged_sources(staging: State<'_, Arc<Staging>>) -> StagedView {
    staging.view()
}

/// Show the native dialog for files or a folder (in Rust; the webview never
/// names a path) and stage the choice. Cancelling changes nothing.
#[tauri::command]
pub async fn stage_sources(
    app: AppHandle,
    pick: SourcePick,
    staging: State<'_, Arc<Staging>>,
) -> Result<StageOutcome, IpcError> {
    let staging = Arc::clone(&staging);
    blocking(move || {
        Ok(match crate::picker::pick_sources(&app, pick) {
            Some(paths) => staging.add(&paths),
            None => StageOutcome {
                staged: staging.view(),
                problems: Vec::new(),
            },
        })
    })
    .await
}

/// Take item `index` out of the staged set.
#[tauri::command]
pub fn unstage_source(
    index: u32,
    staging: State<'_, Arc<Staging>>,
) -> Result<StagedView, IpcError> {
    let index = usize::try_from(index).unwrap_or(usize::MAX);
    staging.remove(index).map_err(IpcError::from)
}

/// Empty the staged set and forget the chosen destination.
#[tauri::command]
pub fn clear_staged(staging: State<'_, Arc<Staging>>) -> StagedView {
    staging.clear()
}

/// Show the save dialog for a new archive (in Rust) and remember the choice.
/// Cancelling changes nothing.
#[tauri::command]
pub async fn choose_destination(
    app: AppHandle,
    staging: State<'_, Arc<Staging>>,
) -> Result<StagedView, IpcError> {
    let staging = Arc::clone(&staging);
    blocking(move || {
        Ok(match crate::picker::pick_destination(&app) {
            Some(path) => staging.set_destination(path),
            None => staging.view(),
        })
    })
    .await
}
