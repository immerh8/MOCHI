# Packaging the desktop app (plan D7, first slice; D6 shell integration)

Installers for the two supported platforms (decision O11): a **Windows NSIS**
setup (per-user, WebView2 bootstrapper) and an **Ubuntu `.deb`** built on 22.04. No MSI,
AppImage, or macOS target. The installers are **not code-signed** (below); updates are
authenticated by the updater's own signature.

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
UI, and writes one text file: MOCHI's own `LICENSE`,
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
  (`mochi-installer-*-unsigned`). Nothing is published; releases come from `release.yml`
  (below).
- `installer-smoke` (`.github/workflows/installer-smoke.yml`, **manual**, never on pull
  requests): the part of the release checklist that needs no human eyes. It installs the
  CI-built setup in real Windows 11 and Windows 10 22H2 *client* VMs and the `.deb` on
  Ubuntu 22.04 and 24.04; see "Release checklist" below and `docs/release-runbook.md`.

## Shell integration (plan D6, decision O10)

Defined in `tauri.conf.json` (`bundle.fileAssociations`, the NSIS `installerHooks`, the
`.deb` `desktopTemplate` and `files`), `packaging/nsis/hooks.nsh`, and
`packaging/linux/`. The app side (command line, single instance) is
`src-tauri/src/launch.rs`.

**The command line** (`mochi-desktop [VERB] [--] PATH...`): no verb or `--open` opens
`PATH` read-only (what a file manager passes); `--add` opens the compact "Add to archive"
form (name, format, level, `.mochi` options; owner decision 2026-10-20). The **quick verbs** work at once in a small compact window and do not open the main
window (owner decision 2026-10-16; spec Annex B.3 item 9): `--extract-here` and
`--extract-to-folder` extract the whole snapshot into the archive's folder, or into a new
folder named for it (`<name>`, `<name> (2)`, ...); `--add-now` makes `<name>.mochi` next
to the item (or `<folder>.mochi` for several, collected within 500 ms) with the Core
profile and the Balanced preset. They never overwrite: if a name in the way exists,
nothing is written and the extract plan opens in the main window instead. Rust parses and validates every argument (unknown option, empty, NUL,
over-long, Windows `\\.\` device paths, wrong path counts) and a launch that does not parse
changes nothing and is reported in the window. There is no passphrase option and none
may ever be added: one is refused by name without echoing its value (an encrypted archive
asks for its passphrase in the compact window). **The panel verbs write nothing until the
user presses the button in the panel**; the quick verbs write at once, under the limits
above. When a collision sends an extract to the plan, the empty target folder of "Extract
to a new folder" stays, because the plan checks an existing folder.

**Single instance.** `tauri-plugin-single-instance` (official, MIT/Apache) is the first
plugin registered. A second process forwards its arguments to the running one, which
parses them with its own working directory, opens or stages in Rust, and brings the
window forward; the second process exits. Permissions: **none added**. The plugin has no
webview commands, so `capabilities/main.json` gains nothing for it; it needs the OS
facility that makes one process the owner (a named mutex and a window message on Windows;
the session D-Bus on Linux, where a session without a bus simply runs without single
instance). The one new app permission is `allow-watch-launches`, the command by which the
window listens for "an archive was opened" or "this launch failed". It carries no path.
The quick verbs (owner decision 2026-10-16) add a second capability, `capabilities/quick.json`,
for the compact window only: `allow-watch-quick`, `allow-quick-passphrase` (once, into a
zeroizing type; never a command line), `allow-quick-cancel`, `allow-quick-show-folder` (Rust
remembers the folder; no path crosses) and `allow-quick-close`. Nothing is added to
`capabilities/main.json`.

**Windows (NSIS, per-user, `HKCU` only):**

| What | Where | Removed by uninstall |
|---|---|---|
| `.mochi` association (ProgID `MOCHI.Archive`) | Tauri's `fileAssociations`; the hooks also remove the `.mochi` key and `MOCHI.Archive_backup` value that Tauri's own removal leaves | yes |
| Explorer menu on every file and folder (flat, two adjacent top-level entries, each with the MOCHI icon: the DLL draws the exe's small icon into a 32-bit bitmap; the static `.mochi` verbs carry an `Icon` value naming the exe): "Add to archive..." and Add to "<Name>.mochi" (a label that changes with the selection) | The shell extension `crates/mochi-shellext` (classic `IContextMenu`, in-process COM DLL), installed as `mochi-shellext-<version>.dll` next to the app; `Software\Classes\CLSID\{508772cd-d924-4b90-8b87-37fd5d593932}\InprocServer32` (default = the DLL, `ThreadingModel` = `Apartment`) and `Software\Classes\*\shellex\ContextMenuHandlers\MOCHI`, `...\Directory\shellex\ContextMenuHandlers\MOCHI` | yes |
| Flat static verbs on `.mochi` files: Open with MOCHI, Extract here, Extract to a new folder | `Software\Classes\SystemFileAssociations\.mochi\shell\MochiOpen`, `MochiExtractHere`, `MochiExtractToFolder` | yes |
| The cascade "MOCHI" submenu (`MochiMenu`, 0.9.x) and the flat verbs of 0.1.0 (`MochiAdd`) | removed by install (an update) and uninstall | n/a |
| Opt-in "Open with" for ZIP, 7z, RAR, TAR, TGZ, GZ | ProgID `MOCHI.Foreign`; the value `MOCHI.Foreign` under each `.ext\OpenWithProgids` | yes |

**The two Add entries (owner decision 2026-10-20, amending the cascade of 2026-10-16).**
No "MOCHI" submenu: "Add to archive..." runs `mochi-desktop --add -- PATH...` (the compact
"Add to archive" form) and Add to "<Name>.mochi" runs
`--add-now -- PATH...`. The DLL starts the app once, with every selected path, through
`std::process::Command` (never a shell string; `--` ends the options). `<Name>` follows the
rule `--add-now` names the archive by (`quick::add_target`): one item gives its name
without the extension (a folder keeps its whole name), several give their parent folder's
name, and `archive` if there is none; `&` is shown as `&&`, names over 40 characters end in
an ellipsis, and a name already taken becomes `<Name> (2).mochi` in the app (the label shows
the first choice). The rule lives in `mochi_shellext::plan` with its tests (they run on
Linux). The DLL parses no archive and writes nothing; it has no menu icon (a menu bitmap
needs GDI code for little gain). Selections whose command line could not fit in Windows'
32,767 characters show no MOCHI entries. The Windows 11 top-level menu (`IExplorerCommand`
in a signed sparse package) stays 1.x because there is no code-signing certificate: on
Windows 11 both entries sit under "Show more options" (Shift+F10).

**A loaded DLL cannot be replaced.** Explorer keeps a shell extension loaded, so the
installer never overwrites it: the file name carries the app version, the registration
points at it, an older DLL is deleted if it can be, and a locked one is renamed aside (a
loaded DLL can be renamed) and the renamed file is scheduled for deletion at the next
restart (`packaging/nsis/hooks.nsh`; the scheduled name is never reused, so a restart
cannot delete a newer DLL). A same-version reinstall moves the old file aside the same way.
An Explorer that is already running keeps the old DLL until it restarts or the user signs
out; the old DLL starts the same app with the same arguments. Nothing needs elevation:
everything is under `HKCU`. (Group policy "enforce shell-extension security" would need
the CLSID on the approved list; MOCHI does not write there.) The release build puts the DLL
in the installer through the overlay in `packaging/build-installer.sh`, as the helper is
bundled, and `packaging/licenses.py` lists the DLL's `windows` crates.

The three `.mochi` verbs run `"<app>" --verb -- "%1"`; Explorer starts one process per selected item. The opt-in is a question at the end of a
normal install, **default No**, never asked by a silent (`/S`) or passive install, and
`/ASSOCIATE_FOREIGN` on the setup's command line says yes (CI uses it). It adds MOCHI to
"Open with"; it never writes a type's default value and never touches the user's
choice, because Windows lets only the user make an app the default. Verbs sit under
"Show more options" on Windows 11; Nautilus extensions are 1.x (O10), not built.

A foreign archive that arrives from the shell (the opt-in "Open with", a double-click
once MOCHI is the user's default, or a second launch) is opened for **browsing** in the
foreign archive section, read-only and in foreign wording, by the same path as the in-app
"Open archive" button there (plan D8); an encrypted one asks for its password in the
window. "Extract here" and "Extract to a new folder" exist only for `.mochi`: if one reaches
a foreign file, MOCHI extracts nothing, says so plainly, and opens the archive for
browsing, where the Extract button shows the plan first. There are no foreign verbs.

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

## The user guide (audit F8)

**[owner, 2026-10-15]** Both installers bundle `docs/user/` as static, offline HTML: `packaging/guide.py` converts the Markdown (standard library only; every source character is escaped; no script, no remote content, links only between the bundled pages) and `build-installer.sh` adds the result as the resource `guide/`. It lands at `<install dir>\guide\index.html` (NSIS) and `/usr/lib/MOCHI/guide/index.html` (`.deb`), where **Help, User guide** looks (`src-tauri/src/help.rs`, `GUIDE_RESOURCE`).

- **Scope.** The guide is written for the `mochi` command line. The button says "User guide (command line)", and every page opens with a banner saying so, naming the desktop screens that match each command and saying the desktop app has no head history, evidence log, or restore-test.
- **Offline, least privilege.** The webview calls `open_user_guide` with no argument; Rust resolves the bundled file, checks it exists, and opens it with the operating system's handler for `.html` (the `open` crate, MIT). The webview gets no filesystem, shell, or opener permission; the one new permission is `allow-open-user-guide`, for that command. The CSP is unchanged.
- **Checked in CI.** `smoke-nsis.ps1` (silent install on `windows-latest`) and `smoke-deb.sh` (the `package` jobs and `package smoke (ubuntu-24.04)`) assert every guide page at the path above, the banner, no script or remote reference, and its removal on uninstall. Rust tests (`help.rs`) and a vitest test show the Help action calls the open command with the bundled path (the OS open is mocked); the E2E spec `help.e2e.js` (both OSes, `e2e` build records the path instead of starting a browser) reads the file the action opened. What CI does not do: start a real browser on the installed app. That is on the release checklist below.

## Signing and the updater

**[owner, 2026-10-14]** Decisions: no Windows Authenticode code signing for 1.0; the updater
key pair is the owner's; the update endpoint is GitHub Releases of `immerh8/MOCHI`.

| Item | State |
|---|---|
| Windows Authenticode certificate | **Not used for 1.0.** The NSIS setup and the app are unsigned. |
| `.deb` / APT repository signing | Not done (a loose `.deb` download needs none). |
| Updater key pair (minisign, key ID `79A2DBFA840725F5`) | **Supplied by the owner.** The public key is `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. The private key and its **password** are the Actions secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; they are not in the repository and must never be (`ci/check-invariants.sh` looks for key material). |
| Update endpoint | `https://github.com/immerh8/MOCHI/releases/latest/download/latest.json`, fixed in `tauri.conf.json`. |

If Authenticode is ever revisited: since the CA/B Forum baseline requirements of 2023 a
code-signing private key must live in a hardware module or a cloud HSM, so it cannot be
exported as a PFX into CI secrets; the choice would be a cloud signing service (such as
Azure Trusted Signing or SignPath) or an OV/EV certificate in the CA's key store, with the
service's credentials (not a key file) as CI secrets. Not needed for 1.0.

**Running an unsigned installer (Windows).** SmartScreen shows "Windows protected your PC"
with the publisher "unknown". Choose **More info**, then **Run anyway**. That is the
expected result of an unsigned installer; it says nothing about the file either way. This
project does not call an unsigned installer verified, trusted, safe, or secure. What
authenticates an *update* is the updater's signature: the app checks it against the
public key built into it before installing anything, and refuses an update that fails.
(A first install from a download is not covered by that check; compare the file with the
release page if that matters to you.)

## Updates in the app (plan D7, T13)

Settings has **Check for updates**. It makes one request, from Rust, to the endpoint above
and shows the newer version and its release notes as plain text; nothing is downloaded or
installed until you press **Download and install**. A check **at start-up** is a separate
checkbox, **off by default** (stored in `update-settings.json` in the app's config folder),
and Rust refuses an automatic check while it is off. A failure (offline, an unusable
answer, a signature that does not match) is shown as a failure, never as success; a
signature that does not match is refused and nothing is installed. The check carries no
file names or archive contents; GitHub sees the request as it sees any download.

| Install | What happens |
|---|---|
| Windows (NSIS setup) | The app downloads the setup, checks its signature, and starts it in passive mode (a progress bar, no questions); MOCHI closes when the installer starts. |
| Ubuntu (`.deb`) | The app downloads the `.deb`, checks its signature, and runs `dpkg -i` through `pkexec` (or a graphical password prompt, or `sudo` in a terminal): **Ubuntu asks for your password.** `dpkg -i` does not fetch new dependencies. Close and reopen MOCHI afterwards. |
| A binary not installed from a MOCHI package | Cannot update itself: it says a new version exists and shows `https://github.com/immerh8/MOCHI/releases/latest`. |

The Tauri v2 updater can install a `.deb` (checked in `tauri-plugin-updater` 2.13.3,
`install_deb`); that is why Ubuntu updates in place. Which path runs depends on the bundle
marker `tauri build` writes into the binary, not on anything the server says.

**Least privilege.** The webview is granted only `allow-get-update-settings`,
`allow-set-update-settings`, `allow-check-for-update` (the app's own commands; the
capability description gives the reason) and starts the download as the `install_update`
job through `start_job`. It gets no `updater:*`, `core:*`, `http`, `fs`, or `shell`
permission and supplies no URL; the CSP is unchanged because the request is made in Rust.
`requireSignedVersion` is on: the signature must name the version the manifest announces.

## Releasing (owner steps)

`.github/workflows/release.yml` builds both installers with updater artifacts, smoke-checks
them (including the `.deb` on 24.04), makes `latest.json`, and creates a **draft** release.
It never publishes and never pushes a tag.

1. **Once:** in the repository settings add the Actions secrets
   `TAURI_SIGNING_PRIVATE_KEY` (the contents of the private key file) and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. **The key must have a password:** GitHub Actions
   secrets cannot be empty, and the workflow requires both. A key made without a password
   must be regenerated (`cargo tauri signer generate -w mochi-updater.key`, entering a
   password when asked), and then the public key in `tauri.conf.json` replaced and a new
   release made, because apps already installed trust only the old public key. Without the secrets the workflow stops in `preflight`
   with an error naming the missing secret, and builds nothing.
2. Set the version in `src-tauri/tauri.conf.json` and `[workspace.package]` in
   `Cargo.toml` (they must match), run `cargo update --workspace` so `Cargo.lock` carries
   the same version (the installer is built with `--locked`), and merge it. Optionally write plain-text release notes
   in `docs/release-notes/v<version>.txt`; the app shows them as text.
3. Push the tag `v<version>` on that commit (or run the workflow by hand from the Actions
   tab; the tag is then created only when you publish the draft).
4. When the run is green, open Releases, review the **draft** (assets: the setup, the
   `.deb`, a `.sig` for each, `latest.json`, `THIRD-PARTY-LICENSES.txt`), edit the text
   if you like, and publish it. Publishing makes `latest.json` visible to installed apps
   (`releases/latest` is the newest *published, non-draft, non-prerelease* release).
5. Do the release checklist below, including updating from the previous release.
   `docs/release-runbook.md` is the step-by-step version, with the owner's notebook steps and a
   throwaway **0.9.0 / 0.9.1 test release pair** for the updater check, so that no real
   version number is spent on it.

Never reuse a version: an app compares versions, and a `latest.json` for a lower or equal
version offers nothing. To withdraw a bad release, delete or unpublish it (`releases/latest`
then points to the previous one) and publish a higher version.

CI rehearses the signed path on every pull request (`package`, "Rehearse the release
path"): it generates a throwaway key on the runner, builds with `MOCHI_UPDATER_ARTIFACTS=1`,
and checks that each `.sig` names the app version. `packaging/test_latest_json.py` tests the
manifest generator.

## Release checklist (not reproducible on CI)

**Run it from `docs/release-runbook.md`**: every item below is there as numbered steps
with what a pass and a fail look like and a results table, and the results go into the
release notes and the audit F10 row. The `installer-smoke` workflow (manual) already does
what needs no eyes in Windows 11 and Windows 10 22H2 client VMs (silent install, Start
menu, association and verbs, launch, uninstall leaving nothing) and on Ubuntu 22.04 and
24.04; the runbook's section 1 says which items that covers. The text below is the
definition of the checklist.

**Updater (T13).** With the previous release installed on a Windows 10 22H2 and a Windows
11 client machine and on Ubuntu 22.04 and 24.04 desktops: Settings → Check for updates shows
the new version and notes as text and installs nothing by itself; confirm, and the app
updates (Windows: the installer's progress bar, MOCHI closes, the new version starts;
Ubuntu: the password prompt appears, reopen MOCHI; the Updates section shows the new version).
With the start-up checkbox off, a Network monitor (or a firewall log) shows no request at
start; with it on, one. With the network off, the check says it could not reach the server.
A `latest.json` whose `.sig` was edited is refused and nothing is installed.

GitHub's Windows runners are Windows Server (plan O11). Before a release, on a clean
Windows 10 22H2 and a Windows 11 *client* machine **without** WebView2 (or with it
uninstalled): run the setup, confirm the bootstrapper installs WebView2 (this needs
network), the app starts, the Start-menu entry exists, and uninstall leaves nothing in
`%LOCALAPPDATA%\MOCHI`. On Ubuntu 22.04 and 24.04 desktops: install by double-click and
by `apt install ./mochi_*.deb`, start from the launcher, remove.

**Shell integration (D6).** Windows Server runners have no Explorer shell to show a
context menu, and no second user setting defaults, so on the same clean Windows 10 22H2
and Windows 11 client machines check by hand:

- Windows 11 client, **Show more options** (Shift+F10; the short menu has no MOCHI entry,
  expected): right-click one file `Note é & more.txt`: exactly two MOCHI entries, flat, no
  "MOCHI" submenu: "Add to archive..." and `Add to "Note é && more.mochi"` shown as
  `Note é & more.mochi`. Right-click a folder `Folder & ü`: the label names the folder. Select
  three files in `trip`: the label names `trip`. "Add to archive..." opens the small "Add to archive"
  form (name, format, level) with the selection, and the main window stays closed; the other makes **one** archive next to it in the small window (a
  second time: `... (2).mochi`, the first untouched). **Fail:** a cascade, a third entry, three
  windows or archives for three files, or a label that differs from the archive's name.
- Right-click a `.mochi` file: the two Add entries plus the flat "Open with MOCHI",
  "Extract here" and "Extract to a new folder" (see `docs/release-runbook.md` W-06).
- Update with Explorer running (install 0.9.x over 0.9.y, then over the same version
  again): the installer finishes without a "file in use" prompt, the menu still works at
  once, and after signing out and in only the new `mochi-shellext-<version>.dll` remains in
  `%LOCALAPPDATA%\MOCHI`. Uninstall: both entries vanish (Explorer may need a restart) and
  no `mochi-shellext-*` file remains after a restart.
- Double-click a `.mochi` file with MOCHI already running: no second window or process.
- Install interactively: the foreign-format question defaults to No; with No, a `.zip`'s
  "Open with" list does not offer MOCHI; with Yes it does, and ZIP still opens in the
  program it did before.
- With the opt-in on, right-click a `.zip`, `.7z`, `.rar`, `.tar`, and `.tar.gz` and choose
  "Open with" → MOCHI: each shows its entries in the foreign archive section (read-only,
  "foreign format" label, no MOCHI health wording); an encrypted 7z or RAR asks for its
  password in the window; a ZIP named like a hostile archive lists its names as text. Do
  the same from a second launch while MOCHI is running (no second window).
- Help → User guide: the bundled guide opens in the default browser, with no network, and its banner says it is written for the command line.
- Uninstall, then search the registry: no `Mochi*`, `MOCHI.Archive`, or `MOCHI.Foreign`
  key remains, and `.mochi` files show no program.
- A path with spaces, non-ASCII letters, and a `&` opens correctly from each verb.

On Ubuntu 22.04 and 24.04 desktops (GNOME Files): after install, double-clicking a
`.mochi` file opens MOCHI and its icon type reads "MOCHI archive"; "Open with" on a
`.zip`, `.7z`, `.rar`, and `.tar.gz` lists MOCHI but the default stays Archive Manager;
with MOCHI running, opening a second `.mochi` goes to the same window; `apt remove`
leaves no "MOCHI archive" type; Help → User guide opens the installed guide in the default browser.

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

- Windows Authenticode signing (decided against for 1.0), `.deb` or APT signing, and
  publishing a release without the owner's review (the workflow makes drafts only).
- An update applied end to end on a real pair of published releases (the release checklist;
  `docs/release-runbook.md` section 7 sets up a test pair, 0.9.0 and 0.9.1, for it).
- Icon artwork: the bundle uses the existing `src-tauri/icons/` set (32, 128, 256 px, `.ico`); a designed icon set is a separate task.
- Windows 11's top-level context menu and Nautilus extensions (1.x, O10). Foreign
  formats opened from the shell are browsed (D8, T20; fixes `docs/audit-gate1.md` F1);
  there are no foreign shell verbs (extract, add) and none is planned for 1.0.
- The Tauri bundle itself is proved by CI (`package` on both platforms and
  `package smoke (ubuntu-24.04)`, green in main run 38551536791).
