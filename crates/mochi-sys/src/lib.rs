//! The only `unsafe` MOCHI has outside `mochi-foreign` (AGENTS.md; owner
//! decision 2026-10-15, superseding T21 and checklist Q63).
//!
//! `mochi-core` keeps `#![forbid(unsafe_code)]`, so the two Win32 calls it
//! needs live here, behind safe functions:
//!
//! * [`move_no_replace_write_through`]: `MoveFileExW(src, dst,
//!   MOVEFILE_WRITE_THROUGH)`, **without** `MOVEFILE_REPLACE_EXISTING`, so it
//!   fails if `dst` exists. This publishes a created archive (spec Annex B
//!   D13). Microsoft documents `MOVEFILE_WRITE_THROUGH` as: "The function does
//!   not return until the file is actually moved on the disk." The next
//!   sentence of the same page ("Setting this value guarantees that a move
//!   performed as a copy and delete operation is flushed to disk before the
//!   function returns.") is about the copy-and-delete case; a same-directory
//!   rename is not that case, so this crate claims only the first sentence.
//!   The G6b crash-replay evidence (`docs/g6-windows-crash-replay.md`) shows
//!   that on NTFS that sentence alone does not make the new name durable; the
//!   directory flush in `mochi-core` does, and Windows still reports
//!   `Unconfirmed` by the G6 policy ([owner, 2026-10-15]; spec Annex B.3).
//! * [`volume_filesystem_name`]: `GetVolumeInformationByHandleW` on a handle
//!   to a directory, e.g. `"NTFS"`.
//!
//! Every `unsafe` block carries a `// SAFETY:` comment, and
//! `ci/check-invariants.sh` checks both that and that `unsafe` appears in no
//! other file. The crate is empty on non-Windows targets.
#![cfg(windows)]
#![deny(unsafe_op_in_unsafe_fn)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::ffi::OsStr;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::Path;

use windows_sys::Win32::Storage::FileSystem::{
    GetVolumeInformationByHandleW, MoveFileExW, FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES,
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, MOVEFILE_WRITE_THROUGH,
};

/// `path` as a NUL-terminated UTF-16 string; an interior NUL is refused
/// (Win32 would silently stop at it and act on a shorter name).
fn wide_nul_terminated(path: &Path) -> io::Result<Vec<u16>> {
    let mut wide: Vec<u16> = OsStr::new(path).encode_wide().collect();
    if wide.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path contains an interior NUL",
        ));
    }
    wide.push(0);
    Ok(wide)
}

/// Move `src` to `dst` and return only once the move is on disk
/// (`MOVEFILE_WRITE_THROUGH`), failing if `dst` exists.
///
/// An existing `dst` is `ERROR_ALREADY_EXISTS` / `ERROR_FILE_EXISTS`, which
/// `std` maps to [`io::ErrorKind::AlreadyExists`]; `src` and `dst` are then
/// untouched. `MOVEFILE_REPLACE_EXISTING` is deliberately never passed.
pub fn move_no_replace_write_through(src: &Path, dst: &Path) -> io::Result<()> {
    let (src, dst) = (wide_nul_terminated(src)?, wide_nul_terminated(dst)?);
    // SAFETY: both pointers come from live `Vec<u16>`s that outlive the call
    // and end in exactly one NUL (interior NULs were refused above), as
    // `PCWSTR` requires. The flags are a valid `MOVE_FILE_FLAGS` value.
    let ok = unsafe { MoveFileExW(src.as_ptr(), dst.as_ptr(), MOVEFILE_WRITE_THROUGH) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// The filesystem name (e.g. `"NTFS"`) of the volume that holds the directory
/// `path`.
pub fn volume_filesystem_name(path: &Path) -> io::Result<String> {
    // The handle is opened by `std` (attribute access only, shared with
    // everyone, backup semantics so a directory can be opened) and closed by
    // its `Drop`, so this function has no handle management of its own.
    let dir = std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?;
    // MAX_PATH + 1 UTF-16 units: the documented size of the name buffer.
    let mut name = [0u16; 261];
    // SAFETY: the handle is open for the duration of the call (`dir` is alive
    // until the end of the function). The volume-name, serial-number,
    // component-length and flags outputs are optional and passed null with a
    // zero size. `name` is a writable buffer of exactly the length passed.
    let ok = unsafe {
        GetVolumeInformationByHandleW(
            dir.as_raw_handle(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            name.as_mut_ptr(),
            name.len() as u32,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let len = name.iter().position(|&c| c == 0).unwrap_or(name.len());
    Ok(String::from_utf16_lossy(
        name.get(..len).unwrap_or_default(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_and_refuses_to_replace() {
        let td = tempfile::tempdir().unwrap();
        let (a, b, c) = (
            td.path().join("a"),
            td.path().join("b"),
            td.path().join("c"),
        );
        std::fs::write(&a, b"first").unwrap();
        move_no_replace_write_through(&a, &b).unwrap();
        assert!(!a.exists());
        assert_eq!(std::fs::read(&b).unwrap(), b"first");

        std::fs::write(&c, b"second").unwrap();
        let e = move_no_replace_write_through(&c, &b).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::AlreadyExists, "{e}");
        assert_eq!(std::fs::read(&b).unwrap(), b"first");
        assert_eq!(std::fs::read(&c).unwrap(), b"second");
    }

    #[test]
    fn a_missing_source_is_an_error() {
        let td = tempfile::tempdir().unwrap();
        let e = move_no_replace_write_through(&td.path().join("nope"), &td.path().join("x"))
            .unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::NotFound, "{e}");
    }

    #[test]
    fn interior_nul_is_refused_before_any_call() {
        let td = tempfile::tempdir().unwrap();
        let src = td.path().join("a");
        std::fs::write(&src, b"x").unwrap();
        let bad = std::path::PathBuf::from("a\u{0}b");
        let e = move_no_replace_write_through(&src, &bad).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::InvalidInput, "{e}");
        let e = move_no_replace_write_through(&bad, &td.path().join("y")).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::InvalidInput, "{e}");
        assert!(src.exists());
    }

    /// The runner's temp directory is on NTFS (gate G6 is about NTFS).
    #[test]
    fn temp_directory_is_ntfs() {
        let td = tempfile::tempdir().unwrap();
        assert_eq!(volume_filesystem_name(td.path()).unwrap(), "NTFS");
    }

    #[test]
    fn filesystem_name_of_a_missing_directory_is_an_error() {
        let td = tempfile::tempdir().unwrap();
        assert!(volume_filesystem_name(&td.path().join("nope")).is_err());
    }
}
