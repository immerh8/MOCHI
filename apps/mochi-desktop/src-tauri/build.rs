//! Tauri build script. The app's own commands are declared here, so each
//! one needs an explicit `allow-…` permission in `capabilities/` before the
//! webview may call it (least privilege, AGENTS.md "Tauri v2 rules").
//!
//! Visual C++ runtime (Windows): static in release builds, so the shipped
//! app needs no VC++ redistributable, and dynamic otherwise. Tauri's static
//! mode writes an empty `msvcrt.lib` into this crate's `OUT_DIR` and adds
//! that directory to the native search path; Cargo passes every build
//! script's search paths to every doctest of a workspace-wide `cargo test`,
//! so the stub would replace the real C runtime in other crates' doctests
//! (`mochi-format`'s failed to link on Windows CI). A machine that builds
//! debug binaries has the MSVC toolchain, and with it the runtime.

fn main() {
    let release = std::env::var("PROFILE").is_ok_and(|p| p == "release");
    let manifest = tauri_build::AppManifest::new().commands(&[
        "start_job",
        "cancel_job",
        "open_archive",
        "unlock_archive",
        "cancel_unlock",
        "list_envelopes",
        "unlock_check_subject",
        "close_archive",
        "open_snapshot",
        "list_children",
        "entry_details",
        "watch_drops",
        "staged_sources",
        "stage_sources",
        "unstage_source",
        "clear_staged",
        "choose_destination",
        "plan_extract",
        "open_foreign_archive",
        "close_foreign_archive",
        "foreign_children",
        "foreign_search",
        "plan_extract_foreign",
        "watch_launches",
        "watch_quick",
        "quick_passphrase",
        "quick_cancel",
        "quick_show_folder",
        "quick_close",
        "choose_check_subject",
        "health_report",
        "export_report",
        "repair_setup",
        "get_update_settings",
        "set_update_settings",
        "check_for_update",
        "get_crash_settings",
        "set_crash_settings",
        "read_crash_log",
        "export_crash_log",
        "clear_crash_log",
        "open_user_guide",
        "plan_extract_default",
        "discard_extract_folder",
        "recent_archives",
        "forget_recent_archives",
        "open_recent",
        "open_dropped_archive",
        "stage_dropped_archive",
        "show_in_folder",
        "drag_out",
        "drag_out_foreign",
    ]);
    let windows = tauri_build::WindowsAttributes::new().static_vc_runtime(release);
    let attributes = tauri_build::Attributes::new()
        .app_manifest(manifest)
        .windows_attributes(windows);
    tauri_build::try_build(attributes).unwrap_or_else(|e| {
        eprintln!("tauri-build failed: {e:#}");
        std::process::exit(1)
    });
}
