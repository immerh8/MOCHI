# Packaging the desktop app (plan D7, first slice)

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

## Signing and updater: what the owner must supply (NOT done)

Nothing below is in the repository, and no key may be committed.

| Need | Used for | Where it goes |
|---|---|---|
| Windows code-signing certificate (OV or EV, or a cloud signing service) | Authenticode-signing the NSIS setup and app exe; without it SmartScreen warns | CI secrets, e.g. a base64 PFX and its password; then set `bundle.windows.certificateThumbprint` or `signCommand` in an overlay config and replace the marked placeholder comment in the `package` job |
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

## Open question

- **MPL-2.0** is in `about.toml`'s accepted list because Tauri's dependency tree
  contains an MPL-2.0 crate (`dtoa-short`; file-level copyleft; shipped unmodified in binary form).
  O23 says "MIT/Apache-compatible" and does not name it. Options: (a) keep it, as now,
  and ship the MPL text and source links in the license list (done by the generator);
  (b) remove it from `accepted` and fail the build, which blocks Tauri itself.
  Recommended: (a); owner to confirm.

## Not done

- Signing, the updater, and release publication (above).
- Icon artwork: the bundle uses the existing `src-tauri/icons/` set (32, 128, 256 px, `.ico`); a designed icon set is a separate task.
- File associations and the `.zip/.7z/.rar` opt-in (D6).
- The first CI run of `package` is the proof of the Tauri bundle itself; the build
  environment used to write this slice has no webkit2gtk.
