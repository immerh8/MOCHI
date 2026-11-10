//! The folders extracted into lately, for the "Extract to..." window: a short
//! list, newest first, kept by Rust in a small JSON file in the app's config
//! folder (the same place and rules as the recent archives, `recent.rs`).
//!
//! **Why Rust and not `localStorage`.** Every extraction, whichever window
//! ran it (the main window's wizard or panel, the compact window's quick
//! verbs), ends in Rust; Rust records the folder there and nowhere else
//! needs to. The compact window is a different webview with its own
//! `localStorage`, so a webview-side list would miss its extractions.
//!
//! **The webview now names a folder.** Until this window the webview never
//! held a path. "Extract to..." shows an editable folder field, so it sends
//! the text the user typed or chose, and Rust treats it as untrusted input:
//! [`validate_folder`] accepts only an absolute path of bounded length with no
//! control characters or `..`. A folder that does not exist yet is created
//! when the plan is made (owner request 2026-11-10; `extract::create_missing`,
//! each level with a no-replace `create_dir`, removed again while empty if the
//! plan is closed unused); a name that is a file is refused. The restore
//! engine then applies its own checks, and never overwrites. The list is a convenience, so a
//! missing or damaged file means an empty list, and a folder that has since
//! gone is not offered.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use mochi_core::{ErrorCode, MochiError, Result};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

const FILE: &str = "recent-extract-folders.json";

/// Folders kept, newest first.
pub const MAX_FOLDERS: usize = 8;

/// Longest folder text accepted, in characters.
pub const MAX_FOLDER_CHARS: usize = 1024;

/// What the "Extract to..." window opens with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub struct ExtractWizardSetup {
    /// The folder the field starts with: the Desktop (owner request
    /// 2026-11-10), else the one used last (empty when this computer has
    /// neither).
    pub destination: String,
    /// Recent folders that still exist, newest first, at most [`MAX_FOLDERS`].
    pub recent: Vec<String>,
    /// "Open the folder when done", the choice shared with the compact window.
    pub open_folder: bool,
}

/// What the folder typed into "Extract to..." would do, shown under the field as it is
/// typed (owner request 2026-11-10). Nothing is created or written to answer it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "snake_case")]
#[ts(export, export_to = "../../ui/src/ipc/generated/")]
pub enum ExtractToPreview {
    /// The text cannot be used; `reason` says why.
    Invalid { reason: String },
    /// The folder exists, or does not and will be created (with the folders above
    /// it that are missing). `target` is where the files go: the folder itself, or
    /// the new folder named after the archive inside it.
    Ready {
        creates: bool,
        target: String,
        /// With a new folder: the archive's own name, when that is taken in the
        /// folder, so `target` carries a number (`photos (2)`).
        taken: Option<String>,
    },
}

/// [`validate_folder`], and the name, if it exists, is a folder (it need not exist
/// yet). The second value is whether it exists.
pub fn folder_to_extract_into(text: &str) -> Result<(PathBuf, bool)> {
    let path = validate_folder(text)?;
    match std::fs::metadata(&path) {
        Ok(m) if m.is_dir() => Ok((path, true)),
        Ok(_) => Err(MochiError::new(
            ErrorCode::InvalidArgument,
            "that is a file, not a folder; choose a folder",
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((path, false)),
        Err(e) => Err(MochiError::new(
            ErrorCode::IoError,
            format!("that folder cannot be read: {e}"),
        )),
    }
}

/// The preview for `text`; with `new_folder`, `archive_name` is the archive's file name
/// (the new folder is named after it).
pub fn preview(text: &str, new_folder: bool, archive_name: Option<&str>) -> ExtractToPreview {
    let (folder, exists) = match folder_to_extract_into(text) {
        Ok(f) => f,
        Err(e) => return ExtractToPreview::Invalid { reason: e.message },
    };
    let shown = |p: &Path| crate::help::for_shell(p).to_string_lossy().into_owned();
    if !new_folder {
        return ExtractToPreview::Ready {
            creates: !exists,
            target: shown(&folder),
            taken: None,
        };
    }
    let Some(stem) = archive_name.and_then(crate::extract::folder_stem) else {
        return ExtractToPreview::Invalid {
            reason: "this archive's name cannot be used for a folder".to_owned(),
        };
    };
    let name = if exists {
        crate::extract::next_free_name(&folder, &stem)
    } else {
        Some(stem.clone())
    };
    match name {
        Some(name) => ExtractToPreview::Ready {
            creates: !exists,
            taken: (name != stem).then_some(stem),
            target: shown(&folder.join(&name)),
        },
        None => ExtractToPreview::Invalid {
            reason: "too many folders with this name already exist".to_owned(),
        },
    }
}

/// A folder text from the window as a path, or why it is refused.
pub fn validate_folder(text: &str) -> Result<PathBuf> {
    let bad = |why: &str| MochiError::new(ErrorCode::InvalidArgument, why.to_owned());
    let text = text.trim();
    if text.is_empty() {
        return Err(bad("enter the folder to extract into"));
    }
    if text.chars().count() > MAX_FOLDER_CHARS {
        return Err(bad("the folder name is too long"));
    }
    if text.chars().any(char::is_control) {
        return Err(bad("the folder name has a control character"));
    }
    let path = Path::new(text);
    if !path.is_absolute() {
        return Err(bad(
            "enter the full path of the folder, or choose it with Browse",
        ));
    }
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(bad("the folder name cannot contain \"..\""));
    }
    Ok(path.to_path_buf())
}

/// [`validate_folder`], and the folder must exist.
pub fn existing_folder(text: &str) -> Result<PathBuf> {
    let path = validate_folder(text)?;
    if path.is_dir() {
        Ok(path)
    } else {
        Err(MochiError::new(
            ErrorCode::InvalidArgument,
            "that folder does not exist; choose one that does",
        ))
    }
}

#[derive(Default, Serialize, Deserialize)]
struct Stored {
    folders: Vec<String>,
}

#[derive(Default, Debug)]
pub struct FolderHistory {
    file: Mutex<Option<PathBuf>>,
    list: Mutex<Vec<String>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl FolderHistory {
    /// Keep the list in `dir` from now on, reading what is there. Entries
    /// that are not acceptable folder texts are dropped.
    pub fn configure(&self, dir: &Path) {
        let file = dir.join(FILE);
        let loaded: Stored = std::fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let mut list: Vec<String> = Vec::new();
        for f in loaded.folders {
            if validate_folder(&f).is_ok() && !list.contains(&f) {
                list.push(f);
            }
            if list.len() == MAX_FOLDERS {
                break;
            }
        }
        *lock(&self.list) = list;
        *lock(&self.file) = Some(file);
    }

    /// Note that `folder` was extracted into: it moves to the front. A path
    /// that is not valid UTF-8 or not an acceptable folder is not kept.
    pub fn record(&self, folder: &Path) {
        let Some(text) = folder.to_str() else {
            return;
        };
        if validate_folder(text).is_err() {
            return;
        }
        {
            let mut list = lock(&self.list);
            list.retain(|f| f != text);
            list.insert(0, text.to_owned());
            list.truncate(MAX_FOLDERS);
        }
        self.save();
    }

    /// The recent folders that still exist, newest first.
    pub fn existing(&self) -> Vec<String> {
        lock(&self.list)
            .iter()
            .filter(|f| Path::new(f.as_str()).is_dir())
            .cloned()
            .collect()
    }

    /// What the window opens with: the Desktop (`desktop`, if there is one), else the
    /// folder used last; the recent folders are offered beside it.
    pub fn setup(&self, desktop: Option<&Path>, open_folder: bool) -> ExtractWizardSetup {
        let recent = self.existing();
        let destination = desktop
            .and_then(|p| p.to_str())
            .map(str::to_owned)
            .or_else(|| recent.first().cloned())
            .unwrap_or_default();
        ExtractWizardSetup {
            destination,
            recent,
            open_folder,
        }
    }

    /// Best effort: a list that cannot be saved is still right for this run.
    fn save(&self) {
        let Some(file) = lock(&self.file).clone() else {
            return;
        };
        let stored = Stored {
            folders: lock(&self.list).clone(),
        };
        let Ok(json) = serde_json::to_vec(&stored) else {
            return;
        };
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = file.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &file);
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn folder(dir: &tempfile::TempDir, name: &str) -> PathBuf {
        let p = dir.path().join(name);
        std::fs::create_dir(&p).unwrap();
        p
    }

    #[test]
    fn folder_text_is_validated() {
        let dir = tempfile::tempdir().unwrap();
        let ok = dir.path().to_str().unwrap();
        assert!(validate_folder(ok).is_ok());
        assert!(validate_folder(&format!("  {ok}  ")).is_ok());
        for bad in ["", "   ", "relative/dir", "a\nb", "~/x"] {
            assert!(validate_folder(bad).is_err(), "{bad:?}");
        }
        assert!(validate_folder(&format!("{ok}/../x")).is_err());
        assert!(validate_folder(&format!("{ok}/{}", "d".repeat(MAX_FOLDER_CHARS))).is_err());
        assert!(existing_folder(ok).is_ok());
        assert!(existing_folder(&format!("{ok}/missing")).is_err());
    }

    #[test]
    fn newest_first_without_duplicates_and_capped() {
        let dir = tempfile::tempdir().unwrap();
        let h = FolderHistory::default();
        let made: Vec<PathBuf> = (0..MAX_FOLDERS + 3)
            .map(|i| folder(&dir, &format!("f{i}")))
            .collect();
        for p in &made {
            h.record(p);
        }
        h.record(&made[5]);
        let got = h.existing();
        assert_eq!(got.len(), MAX_FOLDERS);
        assert_eq!(got[0], made[5].to_str().unwrap());
        assert_eq!(got.iter().filter(|f| **f == got[0]).count(), 1);
        assert_eq!(got[1], made.last().unwrap().to_str().unwrap());
    }

    #[test]
    fn the_desktop_comes_first_then_the_folder_used_last_and_gone_folders_are_not_offered() {
        let dir = tempfile::tempdir().unwrap();
        let desktop = folder(&dir, "Desktop");
        let a = folder(&dir, "a");
        let b = folder(&dir, "b");
        let h = FolderHistory::default();
        // No history: the Desktop.
        let s = h.setup(Some(&desktop), true);
        assert_eq!(s.destination, desktop.to_str().unwrap());
        assert!(s.recent.is_empty());
        assert!(s.open_folder);
        // History: still the Desktop first (owner request 2026-11-10); the recent
        // folders are offered beside it, newest first.
        h.record(&a);
        h.record(&b);
        let s = h.setup(Some(&desktop), false);
        assert_eq!(s.destination, desktop.to_str().unwrap());
        assert_eq!(s.recent, [b.to_str().unwrap(), a.to_str().unwrap()]);
        assert!(!s.open_folder);
        // No Desktop on this computer: the folder used last.
        assert_eq!(h.setup(None, true).destination, b.to_str().unwrap());
        // The newest is gone: it is not offered, and the next one leads.
        std::fs::remove_dir(&b).unwrap();
        let s = h.setup(None, true);
        assert_eq!(s.destination, a.to_str().unwrap());
        assert_eq!(s.recent, [a.to_str().unwrap()]);
        // Nothing at all.
        std::fs::remove_dir(&a).unwrap();
        assert_eq!(h.setup(None, true).destination, "");
    }

    /// Owner request 2026-11-10: what "Extract to..." will do, shown as the folder is typed.
    #[test]
    fn the_preview_says_whether_the_folder_exists_and_names_the_new_folder() {
        let dir = tempfile::tempdir().unwrap();
        let desk = folder(&dir, "Desk");
        let text = |p: &Path| p.to_str().unwrap().to_owned();
        let ready = |creates: bool, target: &Path, taken: Option<&str>| ExtractToPreview::Ready {
            creates,
            target: crate::help::for_shell(target)
                .to_string_lossy()
                .into_owned(),
            taken: taken.map(str::to_owned),
        };
        // An existing folder, as it is.
        assert_eq!(
            preview(&text(&desk), false, None),
            ready(false, &desk, None)
        );
        // A folder that does not exist yet: it will be created.
        let new = desk.join("new");
        assert_eq!(preview(&text(&new), false, None), ready(true, &new, None));
        // With a new folder named after the archive: its name, numbered when taken.
        assert_eq!(
            preview(&text(&desk), true, Some("photos.tar.gz")),
            ready(false, &desk.join("photos"), None)
        );
        std::fs::create_dir(desk.join("photos")).unwrap();
        assert_eq!(
            preview(&text(&desk), true, Some("photos.tar.gz")),
            ready(false, &desk.join("photos (2)"), Some("photos"))
        );
        // Inside a folder that does not exist yet, nothing can be taken.
        assert_eq!(
            preview(&text(&new), true, Some("photos.zip")),
            ready(true, &new.join("photos"), None)
        );
        // Text that cannot be used, and a file in the way, say why; nothing was created.
        std::fs::write(desk.join("file"), b"x").unwrap();
        for bad in ["", "relative/path", &text(&desk.join("file"))] {
            assert!(
                matches!(preview(bad, false, None), ExtractToPreview::Invalid { .. }),
                "{bad}"
            );
        }
        assert!(!new.exists());
    }

    #[test]
    fn the_list_survives_a_restart_and_a_damaged_file_means_an_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let a = folder(&dir, "a");
        let b = folder(&dir, "b");
        let h = FolderHistory::default();
        h.configure(config.path());
        h.record(&a);
        h.record(&b);
        let again = FolderHistory::default();
        again.configure(config.path());
        assert_eq!(again.existing(), [b.to_str().unwrap(), a.to_str().unwrap()]);

        std::fs::write(config.path().join(FILE), b"{ not json").unwrap();
        let damaged = FolderHistory::default();
        damaged.configure(config.path());
        assert!(damaged.existing().is_empty());

        // Entries a hand-edited file should not be able to smuggle in.
        std::fs::write(
            config.path().join(FILE),
            format!(
                r#"{{"folders":["relative","{}","{}"]}}"#,
                a.to_str().unwrap().replace('\\', "\\\\"),
                a.to_str().unwrap().replace('\\', "\\\\")
            ),
        )
        .unwrap();
        let edited = FolderHistory::default();
        edited.configure(config.path());
        assert_eq!(edited.existing(), [a.to_str().unwrap()]);
    }
}
