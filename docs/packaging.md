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
  (`mochi-installer-*-unsigned`). Nothing is published; releases come from `release.yml`
  (below).

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

## Signing and the updater

**[owner, 2026-10-14]** Decisions: no Windows Authenticode code signing for 1.0; the updater
key pair is the owner's; the update endpoint is GitHub Releases of `immerh8/MOCHI`.

| Item | State |
|---|---|
| Windows Authenticode certificate | **Not used for 1.0.** The NSIS setup and the app are unsigned. |
| `.deb` / APT repository signing | Not done (a loose `.deb` download needs none). |
| Updater key pair (minisign, key ID `79A2DBFA840725F5`) | **Supplied by the owner.** The public key is `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. The private key and its password are the Actions secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; they are not in the repository and must never be (`ci/check-invariants.sh` looks for key material). |
| Update endpoint | `https://github.com/immerh8/MOCHI/releases/latest/download/latest.json`, fixed in `tauri.conf.json`. |

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
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Without them the workflow stops in `preflight`
   with an error naming the missing secret, and builds nothing.
2. Set the version in `src-tauri/tauri.conf.json` and `[workspace.package]` in
   `Cargo.toml` (they must match) and merge it. Optionally write plain-text release notes
   in `docs/release-notes/v<version>.txt`; the app shows them as text.
3. Push the tag `v<version>` on that commit (or run the workflow by hand from the Actions
   tab; the tag is then created only when you publish the draft).
4. When the run is green, open Releases, review the **draft** (assets: the setup, the
   `.deb`, a `.sig` for each, `latest.json`, `THIRD-PARTY-LICENSES.txt`), edit the text
   if you like, and publish it. Publishing makes `latest.json` visible to installed apps
   (`releases/latest` is the newest *published, non-draft, non-prerelease* release).
5. Do the release checklist below, including updating from the previous release.

Never reuse a version: an app compares versions, and a `latest.json` for a lower or equal
version offers nothing. To withdraw a bad release, delete or unpublish it (`releases/latest`
then points to the previous one) and publish a higher version.

CI rehearses the signed path on every pull request (`package`, "Rehearse the release
path"): it generates a throwaway key on the runner, builds with `MOCHI_UPDATER_ARTIFACTS=1`,
and checks that each `.sig` names the app version. `packaging/test_latest_json.py` tests the
manifest generator.

## Release checklist (not reproducible on CI)

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

## Open question

- **MPL-2.0** is in `about.toml`'s accepted list because Tauri's dependency tree
  contains an MPL-2.0 crate (`dtoa-short`; file-level copyleft; shipped unmodified in binary form).
  O23 says "MIT/Apache-compatible" and does not name it. Options: (a) keep it, as now,
  and ship the MPL text and source links in the license list (done by the generator);
  (b) remove it from `accepted` and fail the build, which blocks Tauri itself.
  Recommended: (a); owner to confirm.

## Not done

- Windows Authenticode signing (decided against for 1.0), `.deb` or APT signing, and
  publishing a release without the owner's review (the workflow makes drafts only).
- An update applied end to end on a real pair of published releases (the release checklist).
- Icon artwork: the bundle uses the existing `src-tauri/icons/` set (32, 128, 256 px, `.ico`); a designed icon set is a separate task.
- Windows 11's top-level context menu and Nautilus extensions (1.x, O10). Foreign formats
  opened from the shell answer "not supported yet" until plan D8 lands.
- The first CI run of `package` is the proof of the Tauri bundle itself; the build
  environment used to write this slice has no webkit2gtk.
