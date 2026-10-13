//! WebDriver support for test builds (feature `e2e`, the E2E job only).
//!
//! On Windows, msedgedriver attaches to a WebView2 app by setting
//! `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` (remote debugging) and
//! `WEBVIEW2_USER_DATA_FOLDER` (where it then looks for `DevToolsActivePort`).
//! Tauri's webview layer always passes its own browser arguments and data
//! directory to WebView2, and those win, so the driver never finds the port
//! (CI: "DevToolsActivePort file doesn't exist"). With `e2e`, the main
//! window passes both through. Shipped builds never enable the feature, so
//! an environment variable can never open a debugging port in them.
//!
//! WebDriver cannot drive a native file dialog, so with `e2e` the open
//! dialog first takes paths from `MOCHI_E2E_PICK` (a platform path list, one
//! path per "Open archive" click, in order; `crate::picker`). Shipped builds
//! never read the variable.

use tauri::{App, WebviewWindowBuilder, Wry};

/// The arguments Tauri's webview layer uses when none are given (wry
/// `webview2::create_environment`), kept when ours are added.
#[cfg(all(windows, feature = "e2e"))]
const DEFAULT_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

#[cfg(all(windows, feature = "e2e"))]
pub fn configure<'a>(
    mut builder: WebviewWindowBuilder<'a, Wry, App>,
) -> WebviewWindowBuilder<'a, Wry, App> {
    if let Some(extra) = std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        let extra = extra.to_string_lossy();
        builder = builder.additional_browser_args(&format!("{DEFAULT_ARGS} {extra}"));
    }
    if let Some(folder) = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER") {
        builder = builder.data_directory(folder.into());
    }
    builder
}

#[cfg(not(all(windows, feature = "e2e")))]
pub fn configure<'a>(
    builder: WebviewWindowBuilder<'a, Wry, App>,
) -> WebviewWindowBuilder<'a, Wry, App> {
    builder
}

/// The next path from `MOCHI_E2E_PICK`, if any remain.
#[cfg(feature = "e2e")]
pub fn next_pick() -> Option<std::path::PathBuf> {
    use std::collections::VecDeque;
    use std::sync::Mutex;
    static QUEUE: Mutex<Option<VecDeque<std::path::PathBuf>>> = Mutex::new(None);
    let mut q = QUEUE.lock().unwrap_or_else(|p| p.into_inner());
    q.get_or_insert_with(|| {
        std::env::var_os("MOCHI_E2E_PICK")
            .map(|v| std::env::split_paths(&v).collect())
            .unwrap_or_default()
    })
    .pop_front()
}
