//! The MOCHI desktop application (plan §7, phase D0).
//!
//! Commands are thin adapters (AGENTS.md "Tauri v2 rules"): they validate
//! input, call into `mochi-core` or the job runner, and return typed
//! results. No format logic lives here or in the UI. The IPC types are
//! generated into `ui/src/ipc/generated/` by `ts-rs` when the tests run;
//! CI fails if the checked-in copies are stale.

pub mod commands;
pub mod ipc;
pub mod jobs;
pub mod self_test;

use std::sync::Arc;

/// Build and run the application until its last window closes.
pub fn run() -> Result<(), tauri::Error> {
    tauri::Builder::default()
        .manage(Arc::new(jobs::JobRegistry::default()))
        .invoke_handler(tauri::generate_handler![
            commands::start_job,
            commands::cancel_job
        ])
        .run(tauri::generate_context!())
}
