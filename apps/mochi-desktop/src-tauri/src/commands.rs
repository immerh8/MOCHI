//! Tauri commands: thin adapters over the job runner and `mochi-core`
//! (AGENTS.md). Archive work runs on the blocking pool, never on the async
//! runtime.

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::browse::Archives;
use crate::check::{Checks, SubjectPick};
use crate::extract::Destination;
use crate::foreign::Foreign;
use crate::ipc::{
    ArchiveHandle, ArchiveSummary, ChildrenPage, DropEvent, EntryDetails, ExtractPlan,
    ForeignArchiveSummary, ForeignChildrenPage, ForeignExtractPlan, HealthView, IpcError, JobEvent,
    JobId, JobRequest, PathKey, RepairSetupAction, RepairSetupView, ReportId, SnapshotView,
    SourcePick, StageOutcome, StagedView, SubjectId, SubjectSource, SubjectView,
};
use crate::jobs::{EventSink, JobRegistry};
use crate::launch::{LaunchEvent, LaunchSink, Launches};
use crate::write::{DropSink, DropWatch, Staging};

impl DropSink for Channel<DropEvent> {
    fn send(&self, event: DropEvent) -> bool {
        Channel::send(self, event).is_ok()
    }
}

impl LaunchSink for Channel<LaunchEvent> {
    fn send(&self, event: LaunchEvent) -> bool {
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

/// Listen for what the shell asked the app to do (D6): open an archive,
/// extract one, add files. Rust receives the arguments, opens or stages
/// itself, and the webview hears that an archive was opened or why a launch
/// failed. Anything that arrived before this call is delivered now.
#[tauri::command]
pub fn watch_launches(on_launch: Channel<LaunchEvent>, launches: State<'_, Arc<Launches>>) {
    launches.watch(Arc::new(on_launch));
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
/// `null` if the user cancelled the dialog (an earlier choice is not reused).
#[tauri::command]
pub async fn choose_destination(
    app: AppHandle,
    staging: State<'_, Arc<Staging>>,
) -> Result<Option<StagedView>, IpcError> {
    let staging = Arc::clone(&staging);
    blocking(move || {
        Ok(crate::picker::pick_destination(&app).map(|path| staging.set_destination(path)))
    })
    .await
}

/// Plan an extraction (D3): optionally show the native folder dialog (in
/// Rust; the webview never names a path), then say what extracting `keys` of
/// snapshot `seq` would meet there, before anything is written. `null` if
/// the user cancelled the dialog. With `pick` false the folder chosen earlier
/// is checked again.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn plan_extract(
    app: AppHandle,
    handle: ArchiveHandle,
    seq: u32,
    keys: Vec<PathKey>,
    pick: bool,
    archives: State<'_, Arc<Archives>>,
    destination: State<'_, Arc<Destination>>,
) -> Result<Option<ExtractPlan>, IpcError> {
    let archives = Arc::clone(&archives);
    let destination = Arc::clone(&destination);
    blocking(move || {
        let picked = if pick {
            match crate::picker::pick_extract_folder(&app) {
                Some(folder) => Some(folder),
                None => return Ok(None),
            }
        } else {
            None
        };
        crate::extract::plan(&archives, &destination, picked, handle, seq, &keys).map(Some)
    })
    .await
}

/// Choose the archive to test, check, or repair (D4): the native open dialog
/// (in Rust; the webview never names a path), the file of an archive open in
/// the browser, or the new archive the last repair wrote. `null` if the user
/// cancelled the dialog. Nothing is read yet.
#[tauri::command]
pub async fn choose_check_subject(
    app: AppHandle,
    from: SubjectSource,
    archives: State<'_, Arc<Archives>>,
    checks: State<'_, Arc<Checks>>,
) -> Result<Option<SubjectView>, IpcError> {
    let archives = Arc::clone(&archives);
    let checks = Arc::clone(&checks);
    blocking(move || {
        let pick = match from {
            SubjectSource::Dialog => match crate::picker::pick_check_subject(&app) {
                Some(path) => SubjectPick::Path(path),
                None => return Ok(None),
            },
            SubjectSource::OpenArchive { handle } => SubjectPick::OpenArchive(handle),
            SubjectSource::RepairOutput => SubjectPick::RepairOutput,
        };
        checks.choose_subject(&archives, pick).map(Some)
    })
    .await
}

/// The health summary of the chosen archive (D4; `mochi health`): recorded
/// evidence judged at the current head. Runs no check and writes nothing.
#[tauri::command]
pub async fn health_report(
    subject: SubjectId,
    checks: State<'_, Arc<Checks>>,
) -> Result<HealthView, IpcError> {
    let checks = Arc::clone(&checks);
    blocking(move || checks.health(subject)).await
}

/// Export a report (D4): the native save dialog (in Rust), then the exact
/// report v1 JSON that core produced, written to a new file. Returns the
/// file's name, or `null` if the user cancelled the dialog.
#[tauri::command]
pub async fn export_report(
    app: AppHandle,
    report: ReportId,
    checks: State<'_, Arc<Checks>>,
) -> Result<Option<String>, IpcError> {
    let checks = Arc::clone(&checks);
    blocking(move || {
        let (suggested, json) = checks.report_json(report)?;
        let Some(path) = crate::picker::pick_report_destination(&app, &suggested) else {
            return Ok(None);
        };
        crate::check::write_new_file(&path, json.as_bytes())?;
        Ok(Some(
            path.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
        ))
    })
    .await
}

/// Change a repair's setup (D4): add a copy or choose the new file in a
/// native dialog (in Rust), remove a copy, or just report the setup.
#[tauri::command]
pub async fn repair_setup(
    app: AppHandle,
    action: RepairSetupAction,
    checks: State<'_, Arc<Checks>>,
) -> Result<RepairSetupView, IpcError> {
    let checks = Arc::clone(&checks);
    blocking(move || {
        let picked = match action {
            RepairSetupAction::AddCopy => crate::picker::pick_copy(&app),
            RepairSetupAction::ChooseOutput => crate::picker::pick_repair_output(&app),
            _ => None,
        };
        checks.setup(action, picked)
    })
    .await
}

/// Open a ZIP, 7z, RAR, tar or tar.gz archive read-only (D8). Rust shows the
/// native dialog, so the webview names no path. `retry` re-uses the file whose
/// password was asked for last (kept in Rust) instead of showing the dialog
/// again; `password` is used for this call and kept in the open session only.
/// `null` if the user cancelled the dialog. A password is never an argument to
/// the helper and never logged.
#[tauri::command]
pub async fn open_foreign_archive(
    app: AppHandle,
    retry: bool,
    password: Option<String>,
    foreign: State<'_, Arc<Foreign>>,
) -> Result<Option<ForeignArchiveSummary>, IpcError> {
    let foreign = Arc::clone(&foreign);
    tauri::async_runtime::spawn_blocking(move || {
        let path = if retry {
            foreign.pending().ok_or_else(|| IpcError {
                code: mochi_core::ErrorCode::InvalidArgument.as_str().to_owned(),
                message: "there is no archive waiting for a password".to_owned(),
            })?
        } else {
            match crate::picker::pick_foreign_archive(&app) {
                Some(p) => p,
                None => return Ok(None),
            }
        };
        foreign
            .open(&path, password.map(String::into_bytes))
            .map(Some)
    })
    .await
    .map_err(|_| IpcError {
        code: mochi_core::ErrorCode::Cancelled.as_str().to_owned(),
        message: "the operation stopped before it finished".to_owned(),
    })?
}

/// Close a foreign archive (and forget its password). `false` if not open.
#[tauri::command]
pub fn close_foreign_archive(handle: ArchiveHandle, foreign: State<'_, Arc<Foreign>>) -> bool {
    foreign.close(handle)
}

/// One page of a foreign archive's directory (`dir` null for the root).
#[tauri::command]
pub async fn foreign_children(
    handle: ArchiveHandle,
    dir: Option<PathKey>,
    offset: u32,
    limit: u32,
    foreign: State<'_, Arc<Foreign>>,
) -> Result<ForeignChildrenPage, IpcError> {
    let foreign = Arc::clone(&foreign);
    blocking(move || foreign.children(handle, dir.as_deref(), offset, limit)).await
}

/// Plan extracting `keys` of a foreign archive: optionally show the native
/// folder dialog (in Rust), then say what would collide or be skipped, before
/// anything is written. `null` if the user cancelled the dialog.
#[tauri::command]
pub async fn plan_extract_foreign(
    app: AppHandle,
    handle: ArchiveHandle,
    keys: Vec<PathKey>,
    pick: bool,
    foreign: State<'_, Arc<Foreign>>,
    destination: State<'_, Arc<Destination>>,
) -> Result<Option<ForeignExtractPlan>, IpcError> {
    let foreign = Arc::clone(&foreign);
    let destination = Arc::clone(&destination);
    blocking(move || {
        let picked = if pick {
            match crate::picker::pick_extract_folder(&app) {
                Some(folder) => Some(folder),
                None => return Ok(None),
            }
        } else {
            None
        };
        foreign.plan(&destination, picked, handle, &keys).map(Some)
    })
    .await
}
