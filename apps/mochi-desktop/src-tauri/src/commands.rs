//! Tauri commands: thin adapters over the job runner and `mochi-core`
//! (AGENTS.md). Archive work runs on the blocking pool, never on the async
//! runtime.

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::browse::Archives;
use crate::check::{Checks, SubjectPick};
use crate::crashlog::{CrashLog, Settings, MAX_READ_BYTES};
use crate::extract::Destination;
use crate::foreign::Foreign;
use crate::ipc::{
    ArchiveFormat, ArchiveHandle, ArchiveSummary, ChildrenPage, CrashLogView, CrashSettingsView,
    DropEvent, EntryDetails, EnvelopeList, ExtractPlan, ForeignArchiveSummary, ForeignChildrenPage,
    ForeignExtractPlan, ForeignSearchResult, HealthView, IpcError, JobEvent, JobId, JobRequest,
    OpenOutcome, PathKey, PendingId, RepairSetupAction, RepairSetupView, ReportId, Secret,
    ShowTarget, SnapshotView, SourcePick, StageOutcome, StagedView, SubjectId, SubjectSource,
    SubjectView,
};
use crate::jobs::{EventSink, JobRegistry};
use crate::launch::{LaunchEvent, LaunchSink, Launches};
use crate::quick::{Quick, QuickAddRequest, QuickEvent, QuickLocation, QuickSink};
use crate::recent::{RecentView, Recents};
use crate::update::{UpdateCheckView, UpdateSettingsView, Updates};
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

impl QuickSink for Channel<QuickEvent> {
    fn send(&self, event: QuickEvent) -> bool {
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

/// Run `work` on the blocking pool and wait for it (the work reports an
/// [`IpcError`] itself).
async fn blocking_ipc<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, IpcError> + Send + 'static,
) -> Result<T, IpcError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| IpcError {
            code: mochi_core::ErrorCode::Cancelled.as_str().to_owned(),
            message: "the operation stopped before it finished".to_owned(),
        })?
}

/// Ask the user for an archive in the native open dialog (in Rust; the
/// webview never names a path) and open it read-only: a MOCHI archive, or a
/// ZIP, 7z, RAR, tar, tar.gz or tar.zst archive (`crate::route`; a file that
/// starts like a MOCHI archive is one whatever its name). An Encrypted MOCHI
/// archive waits in Rust for `unlock_archive` (D5); a foreign archive that
/// needs a password is `foreign_password` and is retried with
/// `open_foreign_archive`. `null` if the user cancelled the dialog.
#[tauri::command]
pub async fn open_archive(
    app: AppHandle,
    archives: State<'_, Arc<Archives>>,
    foreign: State<'_, Arc<Foreign>>,
) -> Result<Option<OpenOutcome>, IpcError> {
    let archives = Arc::clone(&archives);
    let foreign = Arc::clone(&foreign);
    blocking_ipc(move || match crate::picker::pick_archive(&app) {
        None => Ok(None),
        Some(path) => crate::route::open_path(&archives, &foreign, &path).map(Some),
    })
    .await
}

/// The archives opened lately, for the start screen (names only).
#[tauri::command]
pub fn recent_archives(recents: State<'_, Arc<Recents>>) -> Vec<RecentView> {
    recents.view()
}

/// Empty the recent list.
#[tauri::command]
pub fn forget_recent_archives(recents: State<'_, Arc<Recents>>) {
    recents.clear();
}

/// Open entry `index` of the recent list, a MOCHI or a foreign archive
/// (both are recorded). The window names no path.
#[tauri::command]
pub async fn open_recent(
    index: u32,
    recents: State<'_, Arc<Recents>>,
    archives: State<'_, Arc<Archives>>,
    foreign: State<'_, Arc<Foreign>>,
) -> Result<OpenOutcome, IpcError> {
    let recents = Arc::clone(&recents);
    let archives = Arc::clone(&archives);
    let foreign = Arc::clone(&foreign);
    blocking_ipc(move || {
        let path = usize::try_from(index)
            .ok()
            .and_then(|i| recents.get(i))
            .ok_or_else(|| IpcError {
                code: mochi_core::ErrorCode::InvalidArgument.as_str().to_owned(),
                message: "that archive is no longer in the recent list".to_owned(),
            })?;
        crate::route::open_path(&archives, &foreign, &path)
    })
    .await
}

/// Open the archive file just dropped on the window (`DropEvent::Archive`): a
/// `.mochi` file or a foreign archive, routed as `open_archive` routes. `null`
/// if there is none waiting.
#[tauri::command]
pub async fn open_dropped_archive(
    staging: State<'_, Arc<Staging>>,
    archives: State<'_, Arc<Archives>>,
    foreign: State<'_, Arc<Foreign>>,
) -> Result<Option<OpenOutcome>, IpcError> {
    let staging = Arc::clone(&staging);
    let archives = Arc::clone(&archives);
    let foreign = Arc::clone(&foreign);
    blocking_ipc(move || match staging.take_dropped_archive() {
        None => Ok(None),
        Some(path) => crate::route::open_path(&archives, &foreign, &path).map(Some),
    })
    .await
}

/// Stage the archive file just dropped on the window as an ordinary source to
/// add, instead of opening it (the window uses this when a MOCHI archive is
/// open and the user drops, say, a ZIP to store it). The file is the one Rust
/// holds for `DropEvent::Archive`; the window names no path. An error if none
/// is waiting or it cannot be staged.
#[tauri::command]
pub async fn stage_dropped_archive(
    staging: State<'_, Arc<Staging>>,
) -> Result<StagedView, IpcError> {
    let staging = Arc::clone(&staging);
    blocking_ipc(move || staging.stage_dropped_archive()).await
}

/// Show a folder in the operating system's file manager.
#[tauri::command]
pub async fn show_in_folder(
    what: ShowTarget,
    archives: State<'_, Arc<Archives>>,
    destination: State<'_, Arc<Destination>>,
    staging: State<'_, Arc<Staging>>,
) -> Result<(), IpcError> {
    let archives = Arc::clone(&archives);
    let destination = Arc::clone(&destination);
    let staging = Arc::clone(&staging);
    tauri::async_runtime::spawn_blocking(move || {
        let folder = match what {
            ShowTarget::ExtractDestination => destination.get().ok_or_else(|| {
                mochi_core::MochiError::new(
                    mochi_core::ErrorCode::InvalidArgument,
                    "no folder has been chosen yet",
                )
            }),
            ShowTarget::LastExport => staging.last_export_folder().ok_or_else(|| {
                mochi_core::MochiError::new(
                    mochi_core::ErrorCode::InvalidArgument,
                    "no archive has been written yet",
                )
            }),
            ShowTarget::Archive { handle } => archives.path(handle).and_then(|p| {
                p.parent().map(std::path::Path::to_path_buf).ok_or_else(|| {
                    mochi_core::MochiError::new(
                        mochi_core::ErrorCode::InvalidArgument,
                        "this archive's folder is not known",
                    )
                })
            }),
        }
        .map_err(IpcError::from)?;
        crate::help::open_folder(&folder)
    })
    .await
    .map_err(|_| IpcError {
        code: mochi_core::ErrorCode::Cancelled.as_str().to_owned(),
        message: "the operation stopped before it finished".to_owned(),
    })?
}

/// Open the Encrypted archive that is waiting for `pending` with the
/// passphrase (D5). The passphrase crosses IPC here, once; it goes into a
/// zeroizing key session in Rust and is not returned, logged, or kept
/// anywhere else. A wrong passphrase is `KEY_UNAVAILABLE` ("the passphrase
/// did not open this archive"), never a statement about the archive.
#[tauri::command]
pub async fn unlock_archive(
    pending: PendingId,
    passphrase: Secret,
    archives: State<'_, Arc<Archives>>,
) -> Result<ArchiveSummary, IpcError> {
    let archives = Arc::clone(&archives);
    blocking(move || archives.unlock(pending, &passphrase)).await
}

/// Stop waiting for a passphrase. `false` if it was not waiting.
#[tauri::command]
pub fn cancel_unlock(pending: PendingId, archives: State<'_, Arc<Archives>>) -> bool {
    archives.cancel_pending(pending)
}

/// The head's key envelopes of an open Encrypted archive (D5; `mochi rekey
/// --list`, which needs no key).
#[tauri::command]
pub async fn list_envelopes(
    handle: ArchiveHandle,
    archives: State<'_, Arc<Archives>>,
) -> Result<EnvelopeList, IpcError> {
    let archives = Arc::clone(&archives);
    blocking(move || crate::rekey::envelopes(&archives, handle)).await
}

/// Give the chosen Encrypted archive its passphrase for testing and repair
/// (D5). The passphrase crosses here, once, into a zeroizing key session kept
/// in Rust. A wrong one is `KEY_UNAVAILABLE` and changes nothing.
#[tauri::command]
pub async fn unlock_check_subject(
    subject: SubjectId,
    passphrase: Secret,
    checks: State<'_, Arc<Checks>>,
) -> Result<SubjectView, IpcError> {
    let checks = Arc::clone(&checks);
    blocking(move || checks.unlock_subject(subject, &passphrase)).await
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

/// Listen for the compact window's job (D6 quick verbs): progress, a request
/// for a passphrase, and the result. Anything that arrived before this call
/// is delivered now. Only the `quick` window may call it.
#[tauri::command]
pub fn watch_quick(on_event: Channel<QuickEvent>, quick: State<'_, Arc<Quick>>) {
    quick.watch(Arc::new(on_event));
}

/// The passphrase the compact window asked for. It goes straight to the
/// waiting job and is not kept.
#[tauri::command]
pub fn quick_passphrase(passphrase: Secret, quick: State<'_, Arc<Quick>>) -> Result<(), IpcError> {
    quick.passphrase(passphrase).map_err(IpcError::from)
}

/// Stop the compact window's job.
#[tauri::command]
pub fn quick_cancel(quick: State<'_, Arc<Quick>>) {
    quick.cancel();
}

/// Open the folder the compact window's job wrote into, in the file manager.
/// The webview names no path: Rust remembers it.
#[tauri::command]
pub fn quick_show_folder(quick: State<'_, Arc<Quick>>) -> Result<(), IpcError> {
    quick.show_folder().map_err(IpcError::from)
}

/// The Add form's Browse…: show the save dialog (in Rust) for the format the
/// form is set to, and keep the folder it returns. The webview learns only the
/// folder's display text and the file name. `null` if the user cancelled.
/// Only the `quick` window may call it.
#[tauri::command]
pub async fn quick_choose_location(
    app: AppHandle,
    name: String,
    format: ArchiveFormat,
    quick: State<'_, Arc<Quick>>,
) -> Result<Option<QuickLocation>, IpcError> {
    let quick = Arc::clone(&quick);
    blocking(move || {
        let suggested = quick.suggested_location(&name, format)?;
        match crate::picker::pick_destination(&app, Some(&suggested), format) {
            Some(path) => quick.set_location(&path, format).map(Some),
            None => Ok(None),
        }
    })
    .await
}

/// OK on the Add form. The request is checked in Rust; a refusal (a name that
/// exists, a bad name, options the format does not have) is returned and the
/// form stays open. The passphrase, if any, crosses IPC here, once. Only the
/// `quick` window may call it.
#[tauri::command]
pub fn quick_add_submit(
    request: QuickAddRequest,
    quick: State<'_, Arc<Quick>>,
) -> Result<(), IpcError> {
    quick.submit_add(request).map_err(IpcError::from)
}

/// Close the compact window.
#[tauri::command]
pub fn quick_close(quick: State<'_, Arc<Quick>>) {
    if let Some(host) = quick.host() {
        host.close_quick();
    }
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
        let suggested = staging.suggested_destination();
        let format = staging.format();
        Ok(
            crate::picker::pick_destination(&app, suggested.as_deref(), format)
                .map(|path| staging.set_destination(path)),
        )
    })
    .await
}

/// Choose the format of the next new archive (plan O31). The names the window
/// shows (the default and a destination already chosen) follow its extension.
/// MOCHI-only options are the window's to show or hide; the jobs refuse a
/// combination that does not exist.
#[tauri::command]
pub fn set_archive_format(format: ArchiveFormat, staging: State<'_, Arc<Staging>>) -> StagedView {
    staging.set_format(format)
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
                Some(folder) => {
                    // The unused new folder of the default plan is not needed now.
                    destination.discard_made();
                    Some(folder)
                }
                None => return Ok(None),
            }
        } else {
            None
        };
        crate::extract::plan(&archives, &destination, picked, handle, seq, &keys).map(Some)
    })
    .await
}

/// Plan an extraction into a new folder next to the archive, named after it
/// (the default of "Extract"): no dialog. The folder is made now, and removed
/// again by `discard_extract_folder` if the plan is closed unused. Nothing is
/// extracted.
#[tauri::command]
pub async fn plan_extract_default(
    handle: ArchiveHandle,
    seq: u32,
    keys: Vec<PathKey>,
    archives: State<'_, Arc<Archives>>,
    destination: State<'_, Arc<Destination>>,
) -> Result<ExtractPlan, IpcError> {
    let archives = Arc::clone(&archives);
    let destination = Arc::clone(&destination);
    blocking(move || crate::extract::plan_default(&archives, &destination, handle, seq, &keys))
        .await
}

/// The user's Desktop folder, from Tauri's path resolver (Rust only).
fn desktop_folder(app: &AppHandle) -> mochi_core::Result<std::path::PathBuf> {
    app.path().desktop_dir().map_err(|_| {
        mochi_core::MochiError::new(
            mochi_core::ErrorCode::InvalidArgument,
            "this computer has no Desktop folder; use Extract to... instead",
        )
    })
}

/// Quick extract (WinRAR's "Extract to Desktop"): make a new folder named
/// after the archive on the Desktop (`name`, `name (2)`, ...; never an
/// existing one) and plan extracting `keys` (empty: everything) into it. The
/// webview names no path; it starts the extraction itself with `start_job`,
/// which writes into the folder Rust remembers. Nothing is extracted here.
#[tauri::command]
pub async fn plan_extract_desktop(
    app: AppHandle,
    handle: ArchiveHandle,
    seq: u32,
    keys: Vec<PathKey>,
    archives: State<'_, Arc<Archives>>,
    destination: State<'_, Arc<Destination>>,
) -> Result<ExtractPlan, IpcError> {
    let archives = Arc::clone(&archives);
    let destination = Arc::clone(&destination);
    blocking(move || {
        let desktop = desktop_folder(&app)?;
        crate::extract::plan_in_new_folder(&archives, &destination, &desktop, handle, seq, &keys)
    })
    .await
}

/// `plan_extract_desktop` for an open ZIP, 7z, RAR, or tar archive.
#[tauri::command]
pub async fn plan_extract_foreign_desktop(
    app: AppHandle,
    handle: ArchiveHandle,
    keys: Vec<PathKey>,
    foreign: State<'_, Arc<Foreign>>,
    destination: State<'_, Arc<Destination>>,
) -> Result<ForeignExtractPlan, IpcError> {
    let foreign = Arc::clone(&foreign);
    let destination = Arc::clone(&destination);
    blocking(move || {
        let desktop = desktop_folder(&app)?;
        foreign.plan_in_new_folder(&destination, &desktop, handle, &keys)
    })
    .await
}

/// Remove the new folder a default plan made, if nothing was extracted into it.
#[tauri::command]
pub fn discard_extract_folder(destination: State<'_, Arc<Destination>>) {
    destination.discard_made();
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

/// Open a ZIP, 7z, RAR, tar, tar.gz or tar.zst archive read-only (D8). Rust shows the
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

/// Search the names of every entry of an open foreign archive for `query`
/// (a byte substring of the full path; ASCII case folded when `ignore_case`).
/// Names only, never contents. At most 1000 hits come back; the total is
/// always given.
#[tauri::command]
pub async fn foreign_search(
    handle: ArchiveHandle,
    query: String,
    ignore_case: bool,
    foreign: State<'_, Arc<Foreign>>,
) -> Result<ForeignSearchResult, IpcError> {
    let foreign = Arc::clone(&foreign);
    blocking(move || foreign.search(handle, &query, ignore_case)).await
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

/// T13: the update settings (the opt-in start-up check, off by default) and
/// what this build can do with an update.
#[tauri::command]
pub fn get_update_settings(updates: State<'_, Arc<Updates>>) -> UpdateSettingsView {
    updates.settings()
}

/// T13: turn the start-up check on or off.
#[tauri::command]
pub async fn set_update_settings(
    check_on_start: bool,
    updates: State<'_, Arc<Updates>>,
) -> Result<UpdateSettingsView, IpcError> {
    let updates = Arc::clone(&updates);
    blocking(move || updates.set_check_on_start(check_on_start)).await
}

/// T13: ask the update server whether a newer version exists. The request is
/// made here, in Rust, to the endpoint fixed in `tauri.conf.json`.
/// `automatic` marks the check made when the app starts: Rust makes no
/// request for it unless the user turned the setting on. Nothing is
/// downloaded; the install is the `install_update` job, after the user
/// confirms the version shown.
#[tauri::command]
pub async fn check_for_update(
    automatic: bool,
    updates: State<'_, Arc<Updates>>,
) -> Result<UpdateCheckView, IpcError> {
    let updates = Arc::clone(&updates);
    blocking(move || Ok(updates.check(automatic))).await
}

// ---- D7: the opt-in crash log -------------------------------------------------

fn crash_view(log: &CrashLog) -> CrashSettingsView {
    let settings = log.settings();
    let status = log.status();
    CrashSettingsView {
        enabled: settings.enabled,
        include_details: settings.include_details,
        entries: status.entries,
        bytes: status.bytes,
    }
}

/// The crash-log switches and what the log holds (D7). Both switches start off.
#[tauri::command]
pub async fn get_crash_settings(
    log: State<'_, Arc<CrashLog>>,
) -> Result<CrashSettingsView, IpcError> {
    let log = Arc::clone(&log);
    blocking(move || Ok(crash_view(&log))).await
}

/// Change the crash-log switches (D7). Nothing is sent anywhere either way.
#[tauri::command]
pub async fn set_crash_settings(
    enabled: bool,
    include_details: bool,
    log: State<'_, Arc<CrashLog>>,
) -> Result<CrashSettingsView, IpcError> {
    let log = Arc::clone(&log);
    blocking(move || {
        log.set(Settings {
            enabled,
            include_details,
        })?;
        Ok(crash_view(&log))
    })
    .await
}

/// The newest part of the local crash log, to read in the window (D7).
#[tauri::command]
pub async fn read_crash_log(log: State<'_, Arc<CrashLog>>) -> Result<CrashLogView, IpcError> {
    let log = Arc::clone(&log);
    blocking(move || {
        let (text, truncated) = log.read(MAX_READ_BYTES);
        Ok(CrashLogView {
            text,
            truncated,
            entries: log.status().entries,
        })
    })
    .await
}

/// Save a copy of the crash log to a new file the user picks (D7). Returns
/// the file's name, or `null` if the user cancelled the dialog.
#[tauri::command]
pub async fn export_crash_log(
    app: AppHandle,
    log: State<'_, Arc<CrashLog>>,
) -> Result<Option<String>, IpcError> {
    let log = Arc::clone(&log);
    blocking(move || {
        let Some(path) = crate::picker::pick_crash_log_destination(&app) else {
            return Ok(None);
        };
        crate::check::write_new_file(&path, &log.export_bytes())?;
        Ok(Some(
            path.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
        ))
    })
    .await
}

/// Delete the local crash log (D7). The switches stay as they are.
#[tauri::command]
pub async fn clear_crash_log(log: State<'_, Arc<CrashLog>>) -> Result<CrashSettingsView, IpcError> {
    let log = Arc::clone(&log);
    blocking(move || {
        log.clear()?;
        Ok(crash_view(&log))
    })
    .await
}

/// Help, User guide (audit F8): open the bundled guide with the operating system's handler.
/// The webview names no path: Rust resolves the installed resource (`help`).
#[tauri::command]
pub async fn open_user_guide(app: AppHandle) -> Result<(), IpcError> {
    tauri::async_runtime::spawn_blocking(move || crate::help::open_user_guide_for(&app))
        .await
        .map_err(|_| IpcError {
            code: mochi_core::ErrorCode::Cancelled.as_str().to_owned(),
            message: "the operation stopped before it finished".to_owned(),
        })?
}
