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
