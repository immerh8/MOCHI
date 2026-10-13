//! Choosing an archive to open (plan D1). The native dialog runs in Rust, so
//! the webview never names a path and needs no dialog or filesystem
//! permission (least privilege, AGENTS.md "Tauri v2 rules"): the only file the
//! app reads is one the user picked in the operating system's own dialog.

use std::path::PathBuf;

use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;

use crate::ipc::SourcePick;

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

/// Show the dialog that chooses sources to add (plan D2). `None` if the user
/// cancelled. Blocks: call it off the async runtime.
pub fn pick_sources<R: Runtime>(app: &AppHandle<R>, what: SourcePick) -> Option<Vec<PathBuf>> {
    #[cfg(feature = "e2e")]
    if let Some(path) = crate::automation::next_pick() {
        return Some(vec![path]);
    }
    let dialog = app.dialog().file();
    match what {
        SourcePick::Files => Some(
            dialog
                .set_title("Choose files to add")
                .blocking_pick_files()?
                .into_iter()
                .filter_map(|p| p.into_path().ok())
                .collect(),
        ),
        SourcePick::Folder => Some(vec![dialog
            .set_title("Choose a folder to add")
            .blocking_pick_folder()?
            .into_path()
            .ok()?]),
    }
}

/// Show the save dialog for a new archive (plan D2). `None` if the user
/// cancelled. The `.mochi` extension is added when the name has none.
/// Blocks: call it off the async runtime.
pub fn pick_destination<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    #[cfg(feature = "e2e")]
    if let Some(path) = crate::automation::next_pick() {
        return Some(with_extension(path));
    }
    let path = app
        .dialog()
        .file()
        .set_title("Create a MOCHI archive")
        .set_file_name("archive.mochi")
        .add_filter("MOCHI archive", &["mochi"])
        .blocking_save_file()?
        .into_path()
        .ok()?;
    Some(with_extension(path))
}

/// Show the folder dialog for an extraction (plan D3). `None` if the user
/// cancelled. Blocks: call it off the async runtime.
pub fn pick_extract_folder<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    #[cfg(feature = "e2e")]
    if let Some(path) = crate::automation::next_pick() {
        return Some(path);
    }
    app.dialog()
        .file()
        .set_title("Extract to…")
        .blocking_pick_folder()?
        .into_path()
        .ok()
}

/// `path` with `.mochi` appended when it has no extension.
pub fn with_extension(mut path: PathBuf) -> PathBuf {
    if path.extension().is_none() {
        path.set_extension("mochi");
    }
    path
}

#[cfg(test)]
mod tests {
    use super::with_extension;
    use std::path::PathBuf;

    #[test]
    fn a_destination_without_an_extension_gets_mochi() {
        assert_eq!(
            with_extension(PathBuf::from("/x/backup")),
            PathBuf::from("/x/backup.mochi")
        );
        assert_eq!(
            with_extension(PathBuf::from("/x/a.zip")),
            PathBuf::from("/x/a.zip"),
            "an extension the user typed is theirs"
        );
    }
}
