//! The MOCHI desktop application (plan §7, phases D0 to D6).
//!
//! Commands are thin adapters (AGENTS.md "Tauri v2 rules"): they validate
//! input, call into `mochi-core` or the job runner, and return typed
//! results. No format logic lives here or in the UI. The IPC types are
//! generated into `ui/src/ipc/generated/` by `ts-rs` when the tests run;
//! CI fails if the checked-in copies are stale.

mod automation;
pub mod browse;
pub mod check;
pub mod commands;
pub mod crashlog;
#[cfg(test)]
mod d5_tests;
pub mod extract;
pub mod foreign;
pub mod help;
pub mod ipc;
pub mod jobs;
pub mod launch;
mod picker;
pub mod rekey;
pub mod search;
pub mod self_test;
pub mod update;
pub mod write;

use std::sync::Arc;

/// Build and run the application until its last window closes.
pub fn run() -> Result<(), tauri::Error> {
    let archives = Arc::new(browse::Archives::default());
    let staging = Arc::new(write::Staging::default());
    let drops = Arc::new(write::DropWatch::default());
    let destination = Arc::new(extract::Destination::default());
    let foreign = Arc::new(foreign::Foreign::default());
    let checks = Arc::new(check::Checks::default());
    let updates = Arc::new(update::Updates::default());
    let jobs = Arc::new(jobs::JobRegistry::with_services(write::Services {
        archives: Arc::clone(&archives),
        staging: Arc::clone(&staging),
        destination: Arc::clone(&destination),
        foreign: Arc::clone(&foreign),
        checks: Arc::clone(&checks),
        updates: Arc::clone(&updates),
    }));
    let launches = Arc::new(launch::Launches::new(
        Arc::clone(&archives),
        Arc::clone(&staging),
        Arc::clone(&destination),
        Arc::clone(&drops),
        Arc::clone(&foreign),
    ));
    let window_staging = Arc::clone(&staging);
    let window_drops = Arc::clone(&drops);
    let second_launches = Arc::clone(&launches);
    let first_launches = Arc::clone(&launches);
    let setup_updates = Arc::clone(&updates);
    tauri::Builder::default()
        // First, so that a second process hands over before anything else
        // starts. Its arguments are parsed and validated in Rust like the
        // first launch's (`launch`), and the running window comes forward.
        .plugin(tauri_plugin_single_instance::init(move |app, argv, cwd| {
            second_launches.submit(launch::from_forwarded(&argv, &cwd));
            focus_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        // The updater is driven from Rust only (`update`): the webview is not
        // granted the plugin's permissions, so its own commands are unreachable.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(launches)
        .manage(jobs)
        .manage(archives)
        .manage(staging)
        .manage(drops)
        .manage(destination)
        .manage(foreign)
        .manage(checks)
        .manage(updates)
        .on_window_event(move |_window, event| {
            // Items dragged from the file manager arrive here, in Rust.
            if let tauri::WindowEvent::DragDrop(drag) = event {
                write::on_drag_drop(drag, &window_staging, &window_drops);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_job,
            commands::cancel_job,
            commands::open_archive,
            commands::unlock_archive,
            commands::cancel_unlock,
            commands::list_envelopes,
            commands::unlock_check_subject,
            commands::close_archive,
            commands::open_snapshot,
            commands::list_children,
            commands::entry_details,
            commands::watch_drops,
            commands::staged_sources,
            commands::stage_sources,
            commands::unstage_source,
            commands::clear_staged,
            commands::choose_destination,
            commands::plan_extract,
            commands::open_foreign_archive,
            commands::close_foreign_archive,
            commands::foreign_children,
            commands::plan_extract_foreign,
            commands::watch_launches,
            commands::choose_check_subject,
            commands::health_report,
            commands::export_report,
            commands::repair_setup,
            commands::get_update_settings,
            commands::set_update_settings,
            commands::check_for_update,
            commands::get_crash_settings,
            commands::set_crash_settings,
            commands::read_crash_log,
            commands::export_crash_log,
            commands::clear_crash_log,
            commands::open_user_guide
        ])
        .setup(move |app| {
            // The opt-in crash log (D7): off until the user turns it on.
            use tauri::Manager;
            let crash_log = crashlog::CrashLog::open(app.path().app_local_data_dir()?);
            crashlog::install(Arc::clone(&crash_log));
            app.manage(crash_log);
            main_window(app)?;
            {
                use tauri::Manager;
                let dir = app.path().app_config_dir()?;
                setup_updates.configure(
                    dir,
                    Arc::new(update::PluginBackend::new(app.handle().clone())),
                );
            }
            // The shell's arguments for this first launch.
            first_launches.submit(launch::from_environment());
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

/// Bring the window forward for a launch forwarded by a second instance.
fn focus_main(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
