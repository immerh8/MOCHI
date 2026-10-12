//! Tauri commands: thin adapters over the job runner (AGENTS.md).

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

use crate::ipc::{IpcError, JobEvent, JobId, JobRequest};
use crate::jobs::{EventSink, JobRegistry};

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
