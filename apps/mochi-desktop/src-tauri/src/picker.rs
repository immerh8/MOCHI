//! Choosing an archive to open (plan D1). The native dialog runs in Rust, so
//! the webview never names a path and needs no dialog or filesystem
//! permission (least privilege, AGENTS.md "Tauri v2 rules"): the only file the
//! app reads is one the user picked in the operating system's own dialog.

use std::path::PathBuf;

use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;

use crate::ipc::SourcePick;

/// Extensions the foreign reader opens (a name is a hint; the helper decides).
const FOREIGN_EXTENSIONS: [&str; 10] = [
    "zip", "7z", "rar", "tar", "tgz", "gz", "tzst", "zst", "001", "z01",
];

/// Show the open dialog for any archive MOCHI opens (MOCHI, ZIP, 7z, RAR, tar,
/// tar.gz, tar.zst) and wait for the user. `None` if they cancelled. The first
/// filter lists them all; the others narrow it to one format. Blocks: call it
/// off the async runtime.
pub fn pick_archive<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    #[cfg(feature = "e2e")]
    if let Some(path) = crate::automation::next_pick() {
        return Some(path);
    }
    let mut all = vec!["mochi"];
    all.extend(FOREIGN_EXTENSIONS);
    app.dialog()
        .file()
        .set_title("Open an archive")
        .add_filter("Archives", &all)
        .add_filter("MOCHI archive", &["mochi"])
        .add_filter("ZIP", &["zip"])
        .add_filter("7z", &["7z", "001"])
        .add_filter("RAR", &["rar"])
        .add_filter("tar, tar.gz, tar.zst", &["tar", "tgz", "gz", "tzst", "zst"])
        .add_filter("All files", &["*"])
        .blocking_pick_file()?
        .into_path()
        .ok()
}

/// Show the open dialog for a foreign archive (plan D8). `None` if the user
/// cancelled. Blocks: call it off the async runtime.
pub fn pick_foreign_archive<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    #[cfg(feature = "e2e")]
    if let Some(path) = crate::automation::next_pick() {
        return Some(path);
    }
    app.dialog()
        .file()
        .set_title("Open a ZIP, 7z, RAR or tar archive (read-only)")
        .add_filter("ZIP, 7z, RAR, tar", &FOREIGN_EXTENSIONS)
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
/// cancelled. The `.mochi` extension is added when the name has none. The
/// dialog starts in `suggested`'s folder with its name filled in, when given.
/// Blocks: call it off the async runtime.
pub fn pick_destination<R: Runtime>(
    app: &AppHandle<R>,
    suggested: Option<&std::path::Path>,
) -> Option<PathBuf> {
    #[cfg(feature = "e2e")]
    if let Some(path) = crate::automation::next_pick() {
        return Some(with_extension(path));
    }
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Save the new archive as")
        .set_file_name("archive.mochi")
        .add_filter("MOCHI archive", &["mochi"]);
    if let Some(suggested) = suggested {
        if let Some(dir) = suggested.parent() {
            dialog = dialog.set_directory(dir);
        }
        if let Some(name) = suggested.file_name().and_then(|n| n.to_str()) {
            dialog = dialog.set_file_name(name);
        }
    }
    let path = dialog.blocking_save_file()?.into_path().ok()?;
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

/// Show the open dialog for the archive to test or repair (plan D4). Any
/// file can be chosen: a damaged archive may not end in `.mochi`. `None` if
/// the user cancelled. Blocks: call it off the async runtime.
pub fn pick_check_subject<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    #[cfg(feature = "e2e")]
    if let Some(path) = crate::automation::next_pick() {
        return Some(path);
    }
    app.dialog()
        .file()
        .set_title("Choose an archive to test or repair")
        .add_filter("MOCHI archive", &["mochi"])
        .add_filter("All files", &["*"])
        .blocking_pick_file()?
        .into_path()
        .ok()
}

/// Show the open dialog for an independent copy of the archive being
/// repaired (plan D4, `--copy`). `None` if the user cancelled. Blocks.
pub fn pick_copy<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    #[cfg(feature = "e2e")]
    if let Some(path) = crate::automation::next_pick() {
        return Some(path);
    }
    app.dialog()
        .file()
        .set_title("Choose an independent copy of the same archive")
        .add_filter("MOCHI archive", &["mochi"])
        .add_filter("All files", &["*"])
        .blocking_pick_file()?
        .into_path()
        .ok()
}

/// Show the save dialog for the new archive a repair writes (plan D4).
/// `None` if the user cancelled. Blocks.
pub fn pick_repair_output<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    #[cfg(feature = "e2e")]
    if let Some(path) = crate::automation::next_pick() {
        return Some(with_extension(path));
    }
    let path = app
        .dialog()
        .file()
        .set_title("Save the new archive as")
        .set_file_name("new-archive.mochi")
        .add_filter("MOCHI archive", &["mochi"])
        .blocking_save_file()?
        .into_path()
        .ok()?;
    Some(with_extension(path))
}

/// Show the save dialog for an exported report (plan D4). `None` if the user
/// cancelled. Blocks.
pub fn pick_report_destination<R: Runtime>(app: &AppHandle<R>, suggested: &str) -> Option<PathBuf> {
    #[cfg(feature = "e2e")]
    if let Some(path) = crate::automation::next_pick() {
        return Some(path);
    }
    app.dialog()
        .file()
        .set_title("Export the report (JSON)")
        .set_file_name(suggested)
        .add_filter("JSON report", &["json"])
        .blocking_save_file()?
        .into_path()
        .ok()
}

/// Show the save dialog for an exported crash log (plan D7). `None` if the
/// user cancelled. Blocks.
pub fn pick_crash_log_destination<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    #[cfg(feature = "e2e")]
    if let Some(path) = crate::automation::next_pick() {
        return Some(path);
    }
    app.dialog()
        .file()
        .set_title("Export the crash log (text)")
        .set_file_name("mochi-crash-log.txt")
        .add_filter("Text", &["txt"])
        .blocking_save_file()?
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
