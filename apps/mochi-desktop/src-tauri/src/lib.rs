//! The MOCHI desktop application (plan §7, phase D0).
//!
//! Commands are thin adapters (AGENTS.md "Tauri v2 rules"): they validate
//! input, call into `mochi-core` or the job runner, and return typed
//! results. No format logic lives here or in the UI. The IPC types are
//! generated into `ui/src/ipc/generated/` by `ts-rs` when the tests run;
//! CI fails if the checked-in copies are stale.

mod automation;
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
        .setup(|app| {
            main_window(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
}

/// The one window, labelled `main` (the label `capabilities/main.json`
/// grants). Built here rather than in `tauri.conf.json` so that test
/// builds can configure WebView2 for WebDriver (`automation`).
fn main_window(app: &mut tauri::App) -> tauri::Result<()> {
    let builder = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
        .title("MOCHI")
        .inner_size(900.0, 640.0);
    automation::configure(builder).build()?;
    Ok(())
}
