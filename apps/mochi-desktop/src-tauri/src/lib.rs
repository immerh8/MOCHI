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
pub mod dragout;
pub mod extract;
pub mod folders;
pub mod foreign;
pub mod formats;
pub mod help;
pub mod ipc;
pub mod jobs;
pub mod launch;
mod picker;
pub mod quick;
pub mod recent;
pub mod rekey;
pub mod route;
pub mod search;
pub mod self_test;
pub mod update;
pub mod write;

use std::sync::Arc;

/// Build and run the application until its last window closes.
pub fn run() -> Result<(), tauri::Error> {
    let archives = Arc::new(browse::Archives::default());
    let recents = Arc::new(recent::Recents::default());
    archives.set_recents(Arc::clone(&recents));
    let staging = Arc::new(write::Staging::default());
    let drops = Arc::new(write::DropWatch::default());
    let destination = Arc::new(extract::Destination::default());
    let foreign = Arc::new(foreign::Foreign::default());
    foreign.set_recents(Arc::clone(&recents));
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
    let quick = quick::Quick::new();
    let launches = Arc::new(launch::Launches::new(
        Arc::clone(&archives),
        Arc::clone(&destination),
        Arc::clone(&foreign),
        Arc::clone(&quick),
    ));
    let window_staging = Arc::clone(&staging);
    let window_drops = Arc::clone(&drops);
    let second_launches = Arc::clone(&launches);
    let first_launches = Arc::clone(&launches);
    let setup_updates = Arc::clone(&updates);
    let setup_recents = Arc::clone(&recents);
    let setup_folders = Arc::clone(&destination);
    let setup_quick = Arc::clone(&quick);
    let event_quick = Arc::clone(&quick);
    tauri::Builder::default()
        // First, so that a second process hands over before anything else
        // starts. Its arguments are parsed and validated in Rust like the
        // first launch's (`launch`). "Open with MOCHI" brings the main window
        // forward (from the worker, which creates it if only a compact window
        // is open); every other verb opens only the compact window. This
        // callback may run on the event loop, so it creates no window itself.
        .plugin(tauri_plugin_single_instance::init(
            move |_app, argv, cwd| match launch::from_forwarded(&argv, &cwd) {
                Ok(None) => second_launches.focus(),
                parsed => second_launches.submit(parsed),
            },
        ))
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
        .manage(recents)
        .manage(quick)
        .on_window_event(move |window, event| {
            // Items dragged from the file manager arrive here, in Rust. Only
            // the main window takes them: the compact window is not an add
            // panel.
            if let tauri::WindowEvent::DragDrop(drag) = event {
                if window.label() == MAIN_LABEL {
                    write::on_drag_drop(drag, &window_staging, &window_drops);
                }
            }
            // Closing the compact window stops its job.
            if matches!(event, tauri::WindowEvent::Destroyed) && window.label() == QUICK_LABEL {
                event_quick.closed();
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
            commands::plan_extract_default,
            commands::extract_wizard_setup,
            commands::browse_extract_folder,
            commands::plan_extract_to,
            commands::plan_extract_foreign_to,
            commands::discard_extract_folder,
            commands::recent_archives,
            commands::forget_recent_archives,
            commands::open_recent,
            commands::open_dropped_archive,
            commands::stage_dropped_archive,
            commands::show_in_folder,
            commands::open_foreign_archive,
            commands::close_foreign_archive,
            commands::foreign_children,
            commands::foreign_search,
            commands::plan_extract_foreign,
            commands::watch_launches,
            commands::watch_quick,
            commands::quick_passphrase,
            commands::quick_cancel,
            commands::quick_show_folder,
            commands::quick_close,
            commands::quick_choose_location,
            commands::quick_add_submit,
            commands::set_archive_format,
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
            commands::open_user_guide,
            dragout::drag_out,
            dragout::drag_out_foreign
        ])
        .setup(move |app| {
            // The opt-in crash log (D7): off until the user turns it on.
            use tauri::Manager;
            let crash_log = crashlog::CrashLog::open(app.path().app_local_data_dir()?);
            crashlog::install(Arc::clone(&crash_log));
            app.manage(crash_log);
            setup_quick.set_host(Arc::new(Windows {
                app: app.handle().clone(),
            }));
            // The shell's arguments for this first launch. A quick verb opens
            // only the compact window; the main one is made if it is needed.
            let first = launch::from_environment();
            if !matches!(&first, Ok(Some(l)) if l.verb.is_quick()) {
                build_main(app)?;
            }
            {
                use tauri::Manager;
                let dir = app.path().app_config_dir()?;
                setup_recents.configure(&dir);
                setup_folders.history.configure(&dir);
                setup_updates.configure(
                    dir,
                    Arc::new(update::PluginBackend::new(app.handle().clone())),
                );
            }
            first_launches.submit(first);
            // Drag-out folders left by an earlier run (an hour old or more).
            dragout::sweep_in_background(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())?
        .run(|app, event| {
            // The same sweep at exit.
            if matches!(event, tauri::RunEvent::Exit) {
                dragout::sweep_on_exit(app);
            }
        });
    Ok(())
}

/// The main window's label, which `capabilities/main.json` grants.
const MAIN_LABEL: &str = "main";

/// The compact window's label, which `capabilities/quick.json` grants.
const QUICK_LABEL: &str = "quick";

/// Build the main window. Built here rather than in `tauri.conf.json` so
/// that test builds can configure WebView2 for WebDriver (`automation`).
fn build_main<M: tauri::Manager<tauri::Wry>>(manager: &M) -> tauri::Result<()> {
    let builder =
        tauri::WebviewWindowBuilder::new(manager, MAIN_LABEL, tauri::WebviewUrl::default())
            .title("MOCHI")
            .inner_size(1000.0, 680.0)
            // The toolbar is one row of buttons and the list needs room: below
            // this the page would have to scroll sideways.
            .min_inner_size(720.0, 480.0);
    automation::configure(builder).build()?;
    Ok(())
}

/// The windows, for the launch worker and the quick-verb worker (never the
/// event loop: creating a window there can deadlock on Windows).
struct Windows {
    app: tauri::AppHandle,
}

impl Windows {
    fn bring_forward(&self, label: &str) -> bool {
        use tauri::Manager;
        match self.app.get_webview_window(label) {
            Some(window) => {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
                true
            }
            None => false,
        }
    }
}

impl quick::WindowHost for Windows {
    fn show_quick(&self, size: quick::QuickSize) {
        use tauri::Manager;
        // The Add form is taller than a job's progress and result.
        let (width, height) = match size {
            quick::QuickSize::Compact => (460.0, 280.0),
            quick::QuickSize::Form => (480.0, 470.0),
        };
        if let Some(window) = self.app.get_webview_window(QUICK_LABEL) {
            let _ = window.set_size(tauri::LogicalSize::new(width, height));
        }
        if self.bring_forward(QUICK_LABEL) {
            return;
        }
        // The same page as the main window, told apart by the fragment.
        let builder = tauri::WebviewWindowBuilder::new(
            &self.app,
            QUICK_LABEL,
            tauri::WebviewUrl::App("index.html#quick".into()),
        )
        .title("MOCHI")
        .inner_size(width, height)
        .resizable(false)
        .maximizable(false)
        .center()
        .focused(true);
        // If it cannot be made the job still runs; its result is kept for a
        // window that opens later.
        let _ = automation::configure(builder).build();
    }

    fn close_quick(&self) {
        use tauri::Manager;
        if let Some(window) = self.app.get_webview_window(QUICK_LABEL) {
            let _ = window.destroy();
        }
    }

    fn show_main(&self) {
        if !self.bring_forward(MAIN_LABEL) {
            let _ = build_main(&self.app);
        }
    }

    fn open_folder(&self, folder: &std::path::Path) -> std::io::Result<()> {
        use help::Opener;
        #[cfg(feature = "e2e")]
        if let Some(log) = std::env::var_os("MOCHI_E2E_OPEN_LOG") {
            return help::RecordingOpener(log.into()).open(folder);
        }
        help::OsOpener.open(folder)
    }
}
