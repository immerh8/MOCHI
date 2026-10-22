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
//! control characters or `..`, and the folder must already exist (nothing
//! here creates a folder from typed text). The restore engine then applies
//! its own checks, and never overwrites. The list is a convenience, so a
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
    /// The folder the field starts with: the one used last, else the Desktop
    /// (empty when this computer has neither).
    pub destination: String,
    /// Recent folders that still exist, newest first, at most [`MAX_FOLDERS`].
    pub recent: Vec<String>,
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

    /// What the window opens with. `fallback` is the Desktop, if there is one.
    pub fn setup(&self, fallback: Option<&Path>) -> ExtractWizardSetup {
        let recent = self.existing();
        let destination = recent
            .first()
            .cloned()
            .or_else(|| fallback.and_then(|p| p.to_str()).map(str::to_owned))
            .unwrap_or_default();
        ExtractWizardSetup {
            destination,
            recent,
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
    fn folders_that_are_gone_are_not_offered_and_the_default_follows_the_list() {
        let dir = tempfile::tempdir().unwrap();
        let desktop = folder(&dir, "Desktop");
        let a = folder(&dir, "a");
        let b = folder(&dir, "b");
        let h = FolderHistory::default();
        // No history: the Desktop.
        let s = h.setup(Some(&desktop));
        assert_eq!(s.destination, desktop.to_str().unwrap());
        assert!(s.recent.is_empty());
        // History: the most recent one.
        h.record(&a);
        h.record(&b);
        let s = h.setup(Some(&desktop));
        assert_eq!(s.destination, b.to_str().unwrap());
        assert_eq!(s.recent, [b.to_str().unwrap(), a.to_str().unwrap()]);
        // The newest is gone: it is not offered, and the next one leads.
        std::fs::remove_dir(&b).unwrap();
        let s = h.setup(Some(&desktop));
        assert_eq!(s.destination, a.to_str().unwrap());
        assert_eq!(s.recent, [a.to_str().unwrap()]);
        // Nothing at all.
        std::fs::remove_dir(&a).unwrap();
        assert_eq!(h.setup(None).destination, "");
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
