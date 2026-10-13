//! Choosing an archive to open (plan D1). The native dialog runs in Rust, so
//! the webview never names a path and needs no dialog or filesystem
//! permission (least privilege, AGENTS.md "Tauri v2 rules"): the only file the
//! app reads is one the user picked in the operating system's own dialog.

use std::path::PathBuf;

use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;

/// Show the open dialog and wait for the user. `None` if they cancelled.
/// Blocks: call it off the async runtime.
pub fn pick_archive<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    #[cfg(feature = "e2e")]
    if let Some(path) = crate::automation::next_pick() {
        return Some(path);
    }
    app.dialog()
        .file()
        .set_title("Open a MOCHI archive")
        .add_filter("MOCHI archive", &["mochi"])
        .blocking_pick_file()?
        .into_path()
        .ok()
}
