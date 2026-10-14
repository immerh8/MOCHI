# Packaging the desktop app (plan D7, first slice; D6 shell integration)

Unsigned installers for the two supported platforms (decision O11): a **Windows NSIS**
setup (per-user, WebView2 bootstrapper) and an **Ubuntu `.deb`** built on 22.04. No MSI,
AppImage, or macOS target. Signing and the updater are **not done**; see below.

## Build

```bash
# Once: cargo install cargo-about --version 0.9.2 --locked --features cli
#       cargo install tauri-cli  --version 2.12.2 --locked
packaging/build-installer.sh deb     # Ubuntu 22.04 (needs the webkit2gtk 4.1 dev packages)
packaging/build-installer.sh nsis    # Windows (Git Bash or CI's bash)
```

Output: `target/release/bundle/{deb,nsis}/` and `target/packaging/THIRD-PARTY-LICENSES.txt`.
The base configuration is `apps/mochi-desktop/src-tauri/tauri.conf.json` (`bundle`:
targets `nsis` and `deb`, `installMode: currentUser`, `webviewInstallMode:
downloadBootstrapper`, the `.deb` gets `libwebkit2gtk-4.1-0` and `libgtk-3-0` from Tauri's own default `Depends`, which `smoke-deb.sh` asserts, so the config lists none). The build
script merges an overlay that adds the generated license list, so `cargo build` and
`cargo test` never depend on a generated file.

## Third-party license list (O23)

`packaging/licenses.py` runs `cargo about` over the desktop crate (Windows and Linux
x86-64 targets, no dev or build dependencies) and `pnpm licenses list --prod` over the
UI, and writes one text file: MOCHI's own `LICENSE-MIT` / `LICENSE-APACHE`,
`THIRD-PARTY-NOTICES.md`, then every dependency grouped by license text. It is
installed at `<install dir>\licenses\` (Windows) and
`/usr/share/doc/mochi/THIRD-PARTY-LICENSES.txt` (`.deb`).

**Policy:** the `accepted` list in `packaging/about.toml`. A crate or npm package whose
license expression has no accepted alternative (an `OR` needs one, an `AND` needs all)
fails the build, as does an npm package without a license file. Adding a license is a
policy decision (O23) and needs a reason in the commit.

The list is generated from metadata and package files. Code that metadata does not
describe (UnRAR once `mochi-foreign` lands) is covered by `THIRD-PARTY-NOTICES.md`, which
is prepended.

## CI (`package`, `package-ubuntu-24` in `.github/workflows/ci.yml`)

- `package (ubuntu-22.04)`: builds the `.deb`; `packaging/smoke-deb.sh --install`
  checks name, `amd64`, `Depends` has `libwebkit2gtk-4.1-0` (and not the 4.0 series),
  exactly one executable in `/usr/bin`, the `.desktop` entry, the license list; then
  installs with `apt`, checks `ldd` for unresolved libraries, and removes it.
- `package (windows-latest)`: builds the NSIS setup; `packaging/smoke-nsis.ps1` runs a
  silent per-user install (`/S`), checks the app exe, `uninstall.exe`, the license list,
  and the `HKCU` uninstall entry, then silently uninstalls.
- `package smoke (ubuntu-24.04)`: installs the 22.04-built `.deb` on 24.04.
- Both installers and the license list are uploaded as workflow artifacts
  (`mochi-installer-*-unsigned`). Nothing is published.

## Shell integration (plan D6, decision O10)

Defined in `tauri.conf.json` (`bundle.fileAssociations`, the NSIS `installerHooks`, the
`.deb` `desktopTemplate` and `files`), `packaging/nsis/hooks.nsh`, and
`packaging/linux/`. The app side (command line, single instance) is
`src-tauri/src/launch.rs`.

**The command line** (`mochi-desktop [VERB] [--] PATH...`): no verb or `--open` opens
`PATH` read-only (what a file manager passes); `--extract-here` and
`--extract-to-folder` open it and show the extract plan for the whole snapshot into the
archive's folder, or into a folder named for the archive; `--add` stages paths and shows
the add panel. Rust parses and validates every argument (unknown option, empty, NUL,
over-long, Windows `\\.\` device paths, wrong path counts) and a launch that does not parse
changes nothing and is reported in the window. There is no passphrase option and none
may ever be added: one is refused by name without echoing its value. **Nothing is
written until the user presses the button in the panel.** The one side effect before
that is "Extract to folder" creating the empty target folder so the plan can check it
(delegated decision 1 in plan D6).

**Single instance.** `tauri-plugin-single-instance` (official, MIT/Apache) is the first
plugin registered. A second process forwards its arguments to the running one, which
parses them with its own working directory, opens or stages in Rust, and brings the
window forward; the second process exits. Permissions: **none added**. The plugin has no
webview commands, so `capabilities/main.json` gains nothing for it; it needs the OS
facility that makes one process the owner (a named mutex and a window message on Windows;
the session D-Bus on Linux, where a session without a bus simply runs without single
instance). The one new app permission is `allow-watch-launches`, the command by which the
window listens for "an archive was opened" or "this launch failed". It carries no path.

**Windows (NSIS, per-user, `HKCU` only):**

| What | Where | Removed by uninstall |
|---|---|---|
| `.mochi` association (ProgID `MOCHI.Archive`) | Tauri's `fileAssociations`; the hooks also remove the `.mochi` key and `MOCHI.Archive_backup` value that Tauri's own removal leaves | yes |
| Classic Explorer verbs "Open with MOCHI", "Extract here", "Extract to folder" | `Software\Classes\SystemFileAssociations\.mochi\shell\Mochi*` | yes |
| "Add to MOCHI archive" (every file and folder) | `Software\Classes\*\shell\MochiAdd`, `...\Directory\shell\MochiAdd` | yes |
| Opt-in "Open with" for ZIP, 7z, RAR, TAR, TGZ, GZ | ProgID `MOCHI.Foreign`; the value `MOCHI.Foreign` under each `.ext\OpenWithProgids` | yes |

Each verb runs `"<app>" --verb -- "%1"`. The opt-in is a question at the end of a
normal install, **default No**, never asked by a silent (`/S`) or passive install, and
`/ASSOCIATE_FOREIGN` on the setup's command line says yes (CI uses it). It adds MOCHI to
"Open with"; it never writes a type's default value and never touches the user's
choice, because Windows lets only the user make an app the default. Verbs sit under
"Show more options" on Windows 11; the top-level Windows 11 menu (`IExplorerCommand`,
package identity) and Nautilus extensions are 1.x (O10), not built.

**Ubuntu (`.deb`):** the `.desktop` file (from `packaging/linux/mochi.desktop`, a
replacement for Tauri's template so that `Exec` can end in `%f`) lists
`application/x-mochi` first, then the foreign formats as "Open with" offers; the
package ships `/usr/share/mime/packages/mochi.xml` (`*.mochi`, matched by name only; no
magic bytes are repeated outside `mochi-format`) and no `mimeapps.list`, so the system's
own defaults (file-roller for ZIP and tar on a stock desktop) stay in charge. The
package's dpkg triggers run `update-mime-database` and `update-desktop-database`.

Checked in CI: `smoke-nsis.ps1` (every key after install, the opt-in off by default and
on with the switch, every key gone after uninstall, twice), `smoke-deb.sh` (`Exec`,
`MimeType`, the mime XML, no default lists, `globs2` after install and after removal),
the Rust tests of the argument parser and the routing, a UI test per launch event, and
the `launch.e2e.js` spec (a second process routes to the running window).

## Signing and updater: what the owner must supply (NOT done)

Nothing below is in the repository, and no key may be committed.

| Need | Used for | Where it goes |
|---|---|---|
| Windows code-signing identity: a cloud signing service (such as Azure Trusted Signing or SignPath), or an OV certificate whose private key stays in the CA's cloud key store (EV certificates are hardware-backed as well) | Authenticode-signing the NSIS setup and app exe; without it SmartScreen warns | Since the CA/B Forum baseline requirements of 2023, a code-signing private key must live in a hardware module or a cloud HSM, so it cannot be exported as a PFX into CI secrets. The credentials of the chosen service (a service principal or API token, not a key file) go in CI secrets; then set `signCommand` (or `certificateThumbprint`, for a certificate the runner can reach) in an overlay config and replace the marked placeholder comment in the `package` job. **The owner has not chosen between these options.** |
| Tauri updater key pair (`cargo tauri signer generate`) | Signing update artifacts | Private key and password as CI secrets `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)`; the **public** key goes in `plugins.updater.pubkey` in the config |
| Update endpoint / hosting (a URL serving the update manifest) | The updater's `endpoints` | Owner decision; none exists yet |
| `.deb` signing (optional) | A signed APT repository or `dpkg-sig`; a loose `.deb` download needs none | Owner decision on whether to publish an APT repository |

The updater also needs `tauri-plugin-updater` and a `core:updater` permission, which
is a webview-permission change that AGENTS.md says needs its own justification; it was
deliberately not added in this slice.

## Release checklist (not reproducible on CI)

GitHub's Windows runners are Windows Server (plan O11). Before a release, on a clean
Windows 10 22H2 and a Windows 11 *client* machine **without** WebView2 (or with it
uninstalled): run the setup, confirm the bootstrapper installs WebView2 (this needs
network), the app starts, the Start-menu entry exists, and uninstall leaves nothing in
`%LOCALAPPDATA%\MOCHI`. On Ubuntu 22.04 and 24.04 desktops: install by double-click and
by `apt install ./mochi_*.deb`, start from the launcher, remove.

**Shell integration (D6).** Windows Server runners have no Explorer shell to show a
context menu, and no second user setting defaults, so on the same clean Windows 10 22H2
and Windows 11 client machines check by hand:

- Right-click a `.mochi` file: "Open with MOCHI", "Extract here", "Extract to folder"
  are listed (Windows 11: under "Show more options"); each starts MOCHI (or goes to the
  running window), shows the archive or the extract plan, and writes nothing until the
  Extract button is pressed.
- Right-click a file, several files, and a folder: "Add to MOCHI archive" opens the add
  panel with them staged (several files make several launches that collect in one set).
- Double-click a `.mochi` file with MOCHI already running: no second window or process.
- Install interactively: the foreign-format question defaults to No; with No, a `.zip`'s
  "Open with" list does not offer MOCHI; with Yes it does, and ZIP still opens in the
  program it did before.
- Uninstall, then search the registry: no `Mochi*`, `MOCHI.Archive`, or `MOCHI.Foreign`
  key remains, and `.mochi` files show no program.
- A path with spaces, non-ASCII letters, and a `&` opens correctly from each verb.

On Ubuntu 22.04 and 24.04 desktops (GNOME Files): after install, double-clicking a
`.mochi` file opens MOCHI and its icon type reads "MOCHI archive"; "Open with" on a
`.zip`, `.7z`, `.rar`, and `.tar.gz` lists MOCHI but the default stays Archive Manager;
with MOCHI running, opening a second `.mochi` goes to the same window; `apt remove`
leaves no "MOCHI archive" type.

**Accessibility (D7).** Machines can check names, structure, tab order, and contrast
(CI: `pnpm test`, the keyboard E2E spec); they cannot hear a screen reader or see a
high-contrast theme. Before a release, on Windows 10 22H2 and 11 with **NVDA**, and on
Ubuntu 22.04 and 24.04 with **Orca**: (1) open an archive, move through the list with
the arrow keys, and hear each row's name and kind; (2) create an archive with a
passphrase and hear the panel's heading when it opens and the result when it ends;
(3) run a test and hear the overall status word and each dimension's status as words;
(4) trigger a wrong passphrase and hear the alert, with focus back in the field. Also:
Windows *Contrast black* and *Contrast white* themes (selection and status shapes stay
visible), 200 % display scaling and a 1280x720 window (no horizontal scrolling of the
page), and the crash-report switches read correctly (the message option's warning is
read with it). Record the result in the release notes.

## Decided: MPL-2.0

- **MPL-2.0 stays accepted** in `about.toml` [owner, 2026-10-14]. Tauri's dependency tree
  contains an MPL-2.0 crate (`dtoa-short`; file-level copyleft; shipped unmodified in
  binary form). O23 says "MIT/Apache-compatible" and does not name it; the owner chose
  to keep it (rather than remove it from `accepted`, which would fail the build and
  block Tauri itself). The MPL text and source links ship in the license list, which
  the generator writes. The crate must stay unmodified; a patched copy would need its
  modified files published under the MPL.

## Not done

- Signing, the updater, and release publication (above).
- Icon artwork: the bundle uses the existing `src-tauri/icons/` set (32, 128, 256 px, `.ico`); a designed icon set is a separate task.
- Windows 11's top-level context menu and Nautilus extensions (1.x, O10). Foreign formats
  opened from the shell answer "not supported yet" until plan D8 lands.
- The first CI run of `package` is the proof of the Tauri bundle itself; the build
  environment used to write this slice has no webkit2gtk.
