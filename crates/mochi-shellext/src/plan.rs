//! What the two menu entries say and run. Pure: no Windows types, so the rules
//! are tested on every platform.
//!
//! The label of "Add to <Name>.mochi" must match the archive that
//! `mochi-desktop --add-now` makes (`quick::add_target` in the desktop app):
//! one item gives that item's file name without its extension (a folder keeps
//! its whole name); several items give the name of the folder they are in; a
//! name that cannot be found is `archive`. A name already taken becomes
//! `<name> (2).mochi` in the app; the label cannot know that and names the
//! first choice.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Longest name shown in the label, in characters; longer ones end in an ellipsis.
pub const MAX_LABEL_NAME: usize = 40;

/// Text of the panel entry.
pub const PANEL_LABEL: &str = "Add to archive...";

/// Verbs of the entry, as the app's command line spells them (`launch.rs`).
pub const VERB_PANEL: &str = "--add";
pub const VERB_NOW: &str = "--add-now";

/// Command-string verbs for `IContextMenu::GetCommandString` (not shown to users).
pub const CANONICAL_PANEL: &str = "MochiAdd";
pub const CANONICAL_NOW: &str = "MochiAddNow";

/// One selected item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub path: PathBuf,
    pub is_dir: bool,
}

/// The archive's name, without `.mochi`, exactly as the app chooses it.
pub fn archive_stem(items: &[Item]) -> String {
    let stem = match items {
        [] => None,
        [one] => {
            let name = if one.is_dir {
                one.path.file_name()
            } else {
                one.path.file_stem()
            };
            name.map(|n| n.to_string_lossy().into_owned())
        }
        [first, ..] => first
            .path
            .parent()
            .and_then(Path::file_name)
            .map(|n| n.to_string_lossy().into_owned()),
    };
    stem.filter(|s| !s.is_empty())
        .unwrap_or_else(|| "archive".to_owned())
}

/// Menu text for "Add to <Name>.mochi". `&` is doubled because a menu reads a
/// single one as an accelerator marker.
pub fn add_now_label(items: &[Item]) -> String {
    let stem = archive_stem(items);
    let shown = if stem.chars().count() > MAX_LABEL_NAME {
        let head: String = stem.chars().take(MAX_LABEL_NAME - 1).collect();
        format!("{head}\u{2026}")
    } else {
        stem
    };
    format!("Add to \"{}.mochi\"", shown.replace('&', "&&"))
}

/// The arguments after the program name: `VERB -- PATH...`. `--` ends the
/// options, so a file named like an option stays a path. Never a shell string.
pub fn launch_args(verb: &str, paths: &[PathBuf]) -> Vec<OsString> {
    let mut args = Vec::with_capacity(paths.len() + 2);
    args.push(OsString::from(verb));
    args.push(OsString::from("--"));
    args.extend(paths.iter().map(|p| p.clone().into_os_string()));
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(p: &str) -> Item {
        Item {
            path: PathBuf::from(p),
            is_dir: false,
        }
    }
    fn dir(p: &str) -> Item {
        Item {
            path: PathBuf::from(p),
            is_dir: true,
        }
    }

    #[test]
    fn one_file_drops_its_extension() {
        assert_eq!(
            archive_stem(&[file("/home/a/report.final.txt")]),
            "report.final"
        );
        assert_eq!(
            add_now_label(&[file("/x/notes.txt")]),
            "Add to \"notes.mochi\""
        );
    }

    #[test]
    fn one_folder_keeps_its_whole_name() {
        assert_eq!(archive_stem(&[dir("/x/photos.2026")]), "photos.2026");
    }

    #[test]
    fn several_items_use_the_parent_folder() {
        let items = [
            file("/x/trip/a.jpg"),
            dir("/x/trip/b"),
            file("/x/trip/c.txt"),
        ];
        assert_eq!(archive_stem(&items), "trip");
    }

    #[test]
    fn nameless_cases_fall_back_to_archive() {
        assert_eq!(archive_stem(&[]), "archive");
        assert_eq!(archive_stem(&[file("/a.txt"), file("/b.txt")]), "archive");
        assert_eq!(archive_stem(&[dir("/")]), "archive");
    }

    #[test]
    fn ampersand_is_doubled_and_long_names_are_cut() {
        assert_eq!(
            add_now_label(&[file("/x/Tom & Jerry.avi")]),
            "Add to \"Tom && Jerry.mochi\""
        );
        let long = "n".repeat(100);
        let label = add_now_label(&[dir(&format!("/x/{long}"))]);
        assert_eq!(
            label.chars().count(),
            "Add to \"\".mochi".len() + MAX_LABEL_NAME
        );
        assert!(label.contains('\u{2026}'));
    }

    #[test]
    fn arguments_are_verb_separator_then_each_path() {
        let paths = [PathBuf::from("-rf"), PathBuf::from("/x/a b.txt")];
        let args = launch_args(VERB_NOW, &paths);
        assert_eq!(
            args,
            vec![
                OsString::from("--add-now"),
                OsString::from("--"),
                OsString::from("-rf"),
                OsString::from("/x/a b.txt")
            ]
        );
    }
}
