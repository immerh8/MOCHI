//! Tauri build script. The app's own commands are declared here, so each
//! one needs an explicit `allow-…` permission in `capabilities/` before the
//! webview may call it (least privilege, AGENTS.md "Tauri v2 rules").

fn main() {
    let manifest = tauri_build::AppManifest::new().commands(&["start_job", "cancel_job"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)).unwrap_or_else(
        |e| {
            eprintln!("tauri-build failed: {e:#}");
            std::process::exit(1)
        },
    );
}
