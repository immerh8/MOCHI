//! The COM side: class factory, `IShellExtInit` and `IContextMenu`. Everything
//! unsafe in this crate is here, each block with a `SAFETY:` comment, and every
//! entry point that Explorer can call is wrapped in `catch_unwind` so that no
//! panic crosses into the shell (a failure answers `E_FAIL`).

use std::ffi::{c_void, CStr, OsString};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use windows::core::{implement, Interface, Ref, Result, BOOL, GUID, HRESULT, PCWSTR, PSTR};
use windows::Win32::Foundation::{
    CLASS_E_CLASSNOTAVAILABLE, CLASS_E_NOAGGREGATION, E_FAIL, E_INVALIDARG, E_NOTIMPL, HMODULE,
    S_FALSE, S_OK, TRUE,
};
use windows::Win32::System::Com::{
    IClassFactory, IClassFactory_Impl, IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL,
};
use windows::Win32::System::LibraryLoader::GetModuleFileNameW;
use windows::Win32::System::Ole::{ReleaseStgMedium, CF_HDROP};
use windows::Win32::System::Registry::HKEY;
use windows::Win32::System::SystemServices::DLL_PROCESS_ATTACH;
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{
    DragQueryFileW, IContextMenu, IContextMenu_Impl, IShellExtInit, IShellExtInit_Impl,
    CMF_DEFAULTONLY, CMINVOKECOMMANDINFO, GCS_HELPTEXTA, GCS_HELPTEXTW, GCS_VALIDATEA,
    GCS_VALIDATEW, GCS_VERBA, GCS_VERBW, HDROP,
};
use windows::Win32::UI::WindowsAndMessaging::{InsertMenuW, HMENU, MF_BYPOSITION, MF_STRING};

use crate::plan::{self, Item};

/// The class id registered by `packaging/nsis/hooks.nsh` (MOCHI_SHELLEXT_CLSID).
const CLSID_MOCHI_MENU: GUID = GUID::from_u128(0x508772cd_d924_4b90_8b87_37fd5d593932);

/// The app next to this DLL.
const APP_EXE: &str = "mochi-desktop.exe";

/// More items than this, or a command line that Windows (32,767 UTF-16 units)
/// could not carry, show no MOCHI entries at all: a launch that cannot start
/// is worse than a missing entry.
const MAX_ITEMS: usize = 2048;
const MAX_COMMAND_UNITS: usize = 30_000;

/// The DLL's own module handle (set once, in `DllMain`).
static MODULE: AtomicIsize = AtomicIsize::new(0);
/// Live menu objects and `LockServer` locks, for `DllCanUnloadNow`.
static LIVE_OBJECTS: AtomicU32 = AtomicU32::new(0);
static SERVER_LOCKS: AtomicU32 = AtomicU32::new(0);

fn guard<T>(f: impl FnOnce() -> Result<T>) -> Result<T> {
    catch_unwind(AssertUnwindSafe(f)).unwrap_or_else(|_| Err(E_FAIL.into()))
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

// ---------------------------------------------------------------- exports

/// # Safety
/// Called by the loader with the DLL's own handle.
#[no_mangle]
pub unsafe extern "system" fn DllMain(hinst: HMODULE, reason: u32, _reserved: *mut c_void) -> BOOL {
    if reason == DLL_PROCESS_ATTACH {
        MODULE.store(hinst.0 as isize, Ordering::Relaxed);
    }
    TRUE
}

/// # Safety
/// `rclsid`, `riid` and `ppv` are the COM caller's pointers, each valid or null.
#[no_mangle]
pub unsafe extern "system" fn DllGetClassObject(
    rclsid: *const GUID,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> HRESULT {
    catch_unwind(AssertUnwindSafe(|| {
        if rclsid.is_null() || riid.is_null() || ppv.is_null() {
            return E_INVALIDARG;
        }
        // SAFETY: `ppv` is non-null and, by the COM contract, writable.
        unsafe { *ppv = std::ptr::null_mut() };
        // SAFETY: `rclsid` is non-null and points to a GUID for this call.
        if unsafe { *rclsid } != CLSID_MOCHI_MENU {
            return CLASS_E_CLASSNOTAVAILABLE;
        }
        let factory: IClassFactory = Factory.into();
        // SAFETY: `riid` and `ppv` were checked above; `query` writes an
        // owned interface pointer into `ppv` on success.
        unsafe { factory.query(riid, ppv) }
    }))
    .unwrap_or(E_FAIL)
}

#[no_mangle]
pub extern "system" fn DllCanUnloadNow() -> HRESULT {
    catch_unwind(|| {
        if LIVE_OBJECTS.load(Ordering::Acquire) == 0 && SERVER_LOCKS.load(Ordering::Acquire) == 0 {
            S_OK
        } else {
            S_FALSE
        }
    })
    .unwrap_or(S_FALSE)
}

// ---------------------------------------------------------------- factory

#[implement(IClassFactory)]
struct Factory;

impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(
        &self,
        outer: Ref<'_, windows::core::IUnknown>,
        riid: *const GUID,
        ppv: *mut *mut c_void,
    ) -> Result<()> {
        guard(|| {
            if riid.is_null() || ppv.is_null() {
                return Err(E_INVALIDARG.into());
            }
            // SAFETY: `ppv` is non-null and writable by the COM contract.
            unsafe { *ppv = std::ptr::null_mut() };
            if outer.is_some() {
                return Err(CLASS_E_NOAGGREGATION.into());
            }
            let unknown: windows::core::IUnknown = MochiMenu::new().into();
            // SAFETY: `riid` and `ppv` were checked; `query` stores an owned
            // interface pointer in `ppv` on success.
            unsafe { unknown.query(riid, ppv).ok() }
        })
    }

    fn LockServer(&self, lock: BOOL) -> Result<()> {
        guard(|| {
            if lock.as_bool() {
                SERVER_LOCKS.fetch_add(1, Ordering::AcqRel);
            } else {
                // Saturating: an unbalanced unlock must not wrap to "locked forever".
                let _ = SERVER_LOCKS
                    .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_sub(1));
            }
            Ok(())
        })
    }
}

// ---------------------------------------------------------------- the menu

#[implement(IShellExtInit, IContextMenu)]
struct MochiMenu {
    items: Mutex<Vec<Item>>,
}

impl MochiMenu {
    fn new() -> Self {
        LIVE_OBJECTS.fetch_add(1, Ordering::AcqRel);
        Self {
            items: Mutex::new(Vec::new()),
        }
    }
}

impl Drop for MochiMenu {
    fn drop(&mut self) {
        let _ =
            LIVE_OBJECTS.fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_sub(1));
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The selected paths from the data object's `CF_HDROP`.
fn read_selection(data: &IDataObject) -> Result<Vec<PathBuf>> {
    let format = FORMATETC {
        cfFormat: CF_HDROP.0,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    // SAFETY: `format` is a fully initialised FORMATETC that lives across the call.
    let mut medium = unsafe { data.GetData(&format)? };
    // SAFETY: the medium was requested as TYMED_HGLOBAL, so `hGlobal` is the
    // active union member; a CF_HDROP global is a valid HDROP.
    let hdrop = HDROP(unsafe { medium.u.hGlobal.0 });
    let paths = (|| {
        // SAFETY: `hdrop` stays valid until ReleaseStgMedium below. Index
        // 0xFFFFFFFF asks for the count.
        let count = unsafe { DragQueryFileW(hdrop, u32::MAX, None) } as usize;
        if count == 0 || count > MAX_ITEMS {
            return Vec::new();
        }
        let mut paths = Vec::with_capacity(count);
        for i in 0..count {
            // SAFETY: `i` < count; a `None` buffer returns the length in units.
            let len = unsafe { DragQueryFileW(hdrop, i as u32, None) } as usize;
            if len == 0 {
                continue;
            }
            let mut buf = vec![0u16; len + 1];
            // SAFETY: `buf` has room for `len` units plus the terminator.
            let got = unsafe { DragQueryFileW(hdrop, i as u32, Some(&mut buf)) } as usize;
            buf.truncate(got.min(len));
            paths.push(PathBuf::from(OsString::from_wide(&buf)));
        }
        paths
    })();
    // SAFETY: `medium` came from GetData above and is released exactly once.
    unsafe { ReleaseStgMedium(&mut medium) };
    Ok(paths)
}

fn command_units(paths: &[PathBuf]) -> usize {
    paths
        .iter()
        .map(|p| p.as_os_str().encode_wide().count() + 3)
        .sum::<usize>()
        + APP_EXE.len()
        + 32
}

impl IShellExtInit_Impl for MochiMenu_Impl {
    fn Initialize(
        &self,
        _folder: *const ITEMIDLIST,
        data: Ref<'_, IDataObject>,
        _prog_id: HKEY,
    ) -> Result<()> {
        guard(|| {
            let Some(data) = data.as_ref() else {
                return Err(E_INVALIDARG.into());
            };
            let paths = read_selection(data)?;
            let too_long = command_units(&paths) > MAX_COMMAND_UNITS;
            let items = if too_long {
                Vec::new()
            } else {
                // Whether a lone item is a folder decides its label; several
                // items are named for their folder, so they need no lookup.
                let single = paths.len() == 1;
                paths
                    .into_iter()
                    .map(|path| {
                        let is_dir = single && std::fs::metadata(&path).is_ok_and(|m| m.is_dir());
                        Item { path, is_dir }
                    })
                    .collect()
            };
            *lock(&self.items) = items;
            Ok(())
        })
    }
}

/// The app that sits next to this DLL.
fn app_path() -> Option<PathBuf> {
    let module = HMODULE(MODULE.load(Ordering::Relaxed) as *mut c_void);
    let mut buf = vec![0u16; 32_768];
    // SAFETY: `buf` is writable for its whole length; the call writes at most that many units.
    let len = unsafe { GetModuleFileNameW(Some(module), &mut buf) } as usize;
    if len == 0 || len >= buf.len() {
        return None;
    }
    let dll = PathBuf::from(OsString::from_wide(&buf[..len]));
    Some(dll.parent()?.join(APP_EXE))
}

/// Starts the app with `verb -- PATH...` in one process. No shell, no string
/// built from the paths.
fn launch(verb: &str, items: &[Item]) -> Result<()> {
    let exe = app_path().ok_or(E_FAIL)?;
    let paths: Vec<PathBuf> = items.iter().map(|i| i.path.clone()).collect();
    Command::new(exe)
        .args(plan::launch_args(verb, &paths))
        .spawn()
        .map(drop)
        .map_err(|_| E_FAIL.into())
}

const CMD_PANEL: u32 = 0;
const CMD_NOW: u32 = 1;
const CMD_COUNT: u32 = 2;

fn verb_for(offset: u32) -> Option<&'static str> {
    match offset {
        CMD_PANEL => Some(plan::VERB_PANEL),
        CMD_NOW => Some(plan::VERB_NOW),
        _ => None,
    }
}

fn canonical(offset: usize) -> Option<&'static str> {
    match offset as u32 {
        CMD_PANEL => Some(plan::CANONICAL_PANEL),
        CMD_NOW => Some(plan::CANONICAL_NOW),
        _ => None,
    }
}

impl IContextMenu_Impl for MochiMenu_Impl {
    fn QueryContextMenu(
        &self,
        menu: HMENU,
        index: u32,
        first_id: u32,
        last_id: u32,
        flags: u32,
    ) -> HRESULT {
        catch_unwind(AssertUnwindSafe(|| {
            let none = HRESULT(0);
            if flags & CMF_DEFAULTONLY != 0 {
                return none;
            }
            let items = lock(&self.items).clone();
            if items.is_empty() || last_id < first_id || last_id - first_id + 1 < CMD_COUNT {
                return none;
            }
            let entries = [
                (CMD_PANEL, plan::PANEL_LABEL.to_owned()),
                (CMD_NOW, plan::add_now_label(&items)),
            ];
            for (n, (offset, label)) in entries.iter().enumerate() {
                let text = wide(label);
                // SAFETY: `menu` is the shell's live menu; `text` is NUL-terminated
                // and outlives the call, which copies it.
                let added = unsafe {
                    InsertMenuW(
                        menu,
                        index + n as u32,
                        MF_BYPOSITION | MF_STRING,
                        (first_id + offset) as usize,
                        PCWSTR(text.as_ptr()),
                    )
                };
                if added.is_err() {
                    return none;
                }
            }
            // MAKE_HRESULT(SEVERITY_SUCCESS, FACILITY_NULL, number of ids used).
            HRESULT(CMD_COUNT as i32)
        }))
        .unwrap_or(E_FAIL)
    }

    fn InvokeCommand(&self, info: *const CMINVOKECOMMANDINFO) -> Result<()> {
        guard(|| {
            if info.is_null() {
                return Err(E_INVALIDARG.into());
            }
            // SAFETY: the shell passes a CMINVOKECOMMANDINFO (or the larger
            // Ex form, which begins with the same fields) valid for this call.
            let info = unsafe { &*info };
            let verb = info.lpVerb.0;
            let offset = if (verb as usize) >> 16 == 0 {
                (verb as usize) as u32
            } else {
                // SAFETY: a non-index lpVerb is a NUL-terminated ANSI string.
                let name = unsafe { CStr::from_ptr(verb.cast()) };
                match name.to_bytes() {
                    b if b == plan::CANONICAL_PANEL.as_bytes() => CMD_PANEL,
                    b if b == plan::CANONICAL_NOW.as_bytes() => CMD_NOW,
                    _ => return Err(E_INVALIDARG.into()),
                }
            };
            let verb = verb_for(offset).ok_or(E_INVALIDARG)?;
            let items = lock(&self.items).clone();
            if items.is_empty() {
                return Err(E_FAIL.into());
            }
            launch(verb, &items)
        })
    }

    fn GetCommandString(
        &self,
        id: usize,
        kind: u32,
        _reserved: *const u32,
        name: PSTR,
        cch: u32,
    ) -> Result<()> {
        guard(|| {
            let Some(verb) = canonical(id) else {
                return Err(E_INVALIDARG.into());
            };
            let help = if id as u32 == CMD_PANEL {
                "Choose options and add to an archive"
            } else {
                "Add to a new archive next to the selection"
            };
            let (text, unicode) = match kind {
                k if k == GCS_VERBA => (verb, false),
                k if k == GCS_VERBW => (verb, true),
                k if k == GCS_HELPTEXTA => (help, false),
                k if k == GCS_HELPTEXTW => (help, true),
                k if k == GCS_VALIDATEA || k == GCS_VALIDATEW => return Ok(()),
                _ => return Err(E_NOTIMPL.into()),
            };
            if name.is_null() || cch == 0 {
                return Err(E_INVALIDARG.into());
            }
            let cch = cch as usize;
            if unicode {
                let units: Vec<u16> = text.encode_utf16().take(cch - 1).collect();
                // SAFETY: the caller's buffer holds `cch` UTF-16 units; at most
                // cch - 1 are copied, then the terminator.
                unsafe {
                    let dst = name.0.cast::<u16>();
                    std::ptr::copy_nonoverlapping(units.as_ptr(), dst, units.len());
                    *dst.add(units.len()) = 0;
                }
            } else {
                let bytes: Vec<u8> = text.bytes().take(cch - 1).collect();
                // SAFETY: the caller's buffer holds `cch` bytes; at most cch - 1
                // are copied, then the terminator.
                unsafe {
                    std::ptr::copy_nonoverlapping(bytes.as_ptr(), name.0, bytes.len());
                    *name.0.add(bytes.len()) = 0;
                }
            }
            Ok(())
        })
    }
}
