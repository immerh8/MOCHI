# MOCHI desktop (Tauri v2)

**Phases D0 to D6 and D8 built, and D7 in slices** (plan §7; the in-app updater, T13, and the bundled user guide, audit F8, are part of D7; the owner-held release checklist has not been run): the shell, the job runner, typed IPC, E2E tests,
the archive browser (snapshot timeline, folder tree, virtualized list, details),
create, add, and remove (D2), extract (D3), test, health, and repair (D4), encryption and
search (D5), shell integration (D6), foreign formats (D8), packaging (D7 slice 1), and
accessibility, the message catalogue, and the opt-in crash log (D7 slice 2), and the
simplified main path (D10: a start screen, guided create and extract, technical tools under
"Advanced").
Stack (plan §9 O1, next-work-plan K9): Tauri 2, React 19 + TypeScript (strict) on
Vite, pnpm with a frozen lockfile, Node 24 LTS in CI (Node 22 works locally).
Platforms (O11): Windows 10 22H2 / 11 and Ubuntu 22.04 / 24.04, x86-64. macOS is not
supported in 1.0.

```text
apps/mochi-desktop/
├── src-tauri/          # Rust: thin commands over mochi-core (a workspace member)
│   ├── capabilities/   # least-privilege capability files
│   └── src/
│       ├── browse.rs   # D1: open archives and snapshots, paged listings, details
│       ├── check.rs    # D4: Test archive, health, report export, repair plan/apply
│       ├── commands.rs # Tauri commands: validate, call, return typed results
│       ├── crashlog.rs # D7: the opt-in local crash log (panic hook, settings, rotation)
│       ├── extract.rs  # D3: the chosen folder, the collision plan, the extract job
│       ├── formats.rs  # O31: the five formats of a new archive, their extensions, typed names
│       ├── foreign.rs  # D8: ZIP, 7z, RAR, tar, tar.gz, tar.zst read-only through the isolated helper; name search
│       ├── help.rs     # Help, User guide: opens the bundled guide offline (F8)
│       ├── launch.rs   # D6: the shell's open, extract, and add verbs, parsed in Rust
│       ├── route.rs    # One Open for every format: MOCHI magic wins, then foreign by name or first bytes
│       ├── rekey.rs    # D5: key envelopes and passphrase changes
│       ├── search.rs   # D5: name search
│       ├── update.rs   # T13: the in-app updater, driven from Rust
│       ├── ipc.rs      # IPC types (ts-rs exports them to ui/src/ipc/generated)
│       ├── jobs.rs     # job runner: mochi_core::job → events, cancellation
│       ├── picker.rs   # D1/D2: the native open, choose, and save dialogs, shown from Rust
│       ├── self_test.rs# sample job for the job-runner tests (no UI; no archive I/O)
│       └── write.rs    # D2: staged sources, drop handling, create/add/remove jobs
├── ui/                 # React + TypeScript + Vite
│   ├── src/browser/    # D1: Browser, Tree, VirtualList, Name (text-only names)
│   ├── src/write/      # D2: Writer (create, add, remove), messages (wording rules)
│   ├── src/extract/    # D3: Extractor (plan, collisions, progress, report), messages
│   ├── src/check/      # D4: Checker (test, health, repair wizard), Report, messages
│   ├── src/a11y/       # D7: Live, Panel (focus in/out), ProgressMeter; keyboard + contrast tests
│   ├── src/i18n/       # D7: typed message lookup t(); en/ = the English catalogue, one file per screen
│   ├── src/settings/   # D7: CrashReports (the opt-in crash log screen)
│   ├── src/test/       # test setup; audit.ts (the accessibility audit run after every test)
│   └── src/ipc/        # typed invoke wrappers; generated/ is never edited by hand
└── e2e/                # WebdriverIO + tauri-driver
```

## Building and running

Linux needs webkit2gtk 4.1 and its companions (Ubuntu 22.04 or later):

```bash
sudo apt-get install libwebkit2gtk-4.1-dev libxdo-dev libssl-dev librsvg2-dev libayatana-appindicator3-dev
```

Windows needs only the WebView2 runtime, which Windows 10 22H2 and 11 ship. Release builds link the Visual C++ runtime statically, so users need no VC++ redistributable; debug and test builds link it dynamically, because Tauri's static mode puts a stub `msvcrt.lib` on the search path that a workspace-wide `cargo test` hands to every other crate's doctests (`build.rs` explains).

```bash
# Development: the Vite dev server, then the app, which loads it (devUrl).
pnpm --dir apps/mochi-desktop/ui install --frozen-lockfile
pnpm --dir apps/mochi-desktop/ui dev          # terminal 1
cargo run -p mochi-desktop                    # terminal 2

# UI checks (what the `desktop ui` CI job runs)
cd apps/mochi-desktop/ui && pnpm lint && pnpm typecheck && pnpm test && pnpm build

# Regenerate the IPC types after changing src-tauri/src/ipc.rs
cargo test -p mochi-desktop        # writes ui/src/ipc/generated/*.ts; commit them

# End to end (what the `desktop e2e` CI job runs)
pnpm --dir apps/mochi-desktop/ui build
cargo build -p mochi-desktop --features custom-protocol,e2e   # embeds ui/dist; e2e: see below
cargo install tauri-driver --locked
# The archives the D1 spec opens (target/d1-fixtures; MOCHI_E2E_FIXTURES overrides):
cargo run --release -p mochi-testkit --example d1_browse_fixtures -- target/d1-fixtures
cd apps/mochi-desktop/e2e && pnpm install --frozen-lockfile
xvfb-run -a pnpm test     # Linux (apt: webkit2gtk-driver xvfb); on Windows: pnpm test,
                          # with MOCHI_NATIVE_DRIVER pointing at a matching msedgedriver.exe
```

`cargo build` without `custom-protocol` builds the development app, which loads
`devUrl` and needs no built frontend; that is why the workspace's `cargo test` and
`cargo clippy` need no Node toolchain.

## Security decisions (each is a reason AGENTS.md asks for)

- **Compact window (D6 quick verbs).** The shell's "Extract here", "Extract to a new folder", "Add to archive" (`--add-now`) and "Add to archive..." (`--add`, the form below) run in a small second window labelled `quick` (the same page, `#quick`). `capabilities/quick.json` grants it ten commands and nothing else (the last three are its title bar's Minimize, Close and move, below): `allow-watch-quick` (hear the one running job), `allow-quick-passphrase` (an encrypted archive's passphrase, once, into a zeroizing type in Rust), `allow-quick-cancel`, `allow-quick-show-folder` (Rust remembers the folder; the webview names no path), `allow-quick-close`, and, for the Add form, `allow-quick-choose-location` (Browse...: the save dialog is shown from Rust, which keeps the folder; the webview learns the folder's display text and the file name) and `allow-quick-add-submit` (OK: a plain file name, one of five format words, a level, and for `.mochi` only a passphrase that crosses once into a zeroizing type and a recovery percentage; Rust checks it, refuses a name that exists, and makes the archive in the folder it holds). The main window gains none of them and the compact window reaches none of the main window's archive, staging, extract or update commands. No fs, shell, http or dialog permission is granted to either.
- **One window per archive (`src/windows.rs`).** Like WinRAR, an archive opened while the window already shows one (or runs a job, or has files staged) opens in a **new window**; an empty window (the start screen) is reused, and an archive that is already open is not opened twice: its window is brought forward (same file by device and inode on Linux, by canonical path on Windows). This holds for a double-click or "Open with MOCHI" (the single-instance forward), **Open**, **Recent**, and a `.mochi` or foreign archive dropped on a window. `Placement` (`windows::place`) is the pure decision; `Launches::open_in_window` and the shell's open apply it. Labels are `main` then `win-N`; a new window is the opener's size, cascaded 32 logical pixels down and right (`windows::cascade`), and its title is `<archive name> - MOCHI` (a plain-text title; the name is the user's file name). There is no "open in this window" switch in 1.0: close the archive first. What used to be a singleton for "the open archive" is now **per window**, keyed by the label Tauri reports for the calling webview (the `Win` argument of a command, never a value the page sends): the staged sources, drop listener, extract folder and Test and Repair tool (`windows::WindowState`); which archives, foreign archives, waiting passphrases and password retries (`Archives::open_as`, `Foreign::open_as`) and running jobs (`JobRegistry::start_for`) a window owns. Closing a window (`WindowEvent::Destroyed`) runs `WindowStates::release`: cancels its jobs (a write job holds the archive's writer lock for its length, so the lock goes with it), closes its archives (their readers) and forgets its passphrases; nothing of any other window is touched. Handles are still process-wide counters; a window cannot name another's state, but within one app a page that guessed another window's archive handle could read it (same trust domain, as before). Limits: 4 archives per window, 16 archives and 12 windows in all. The start-up update check is made by `main` only. `capabilities/main.json` grants `win-*` the same commands as `main` and nothing more; no window permission is granted, so a page cannot open windows. The release checklist (W-09b in `docs/release-runbook.md`) covers the multi-window behaviour that WebDriver cannot drive.
- **Capabilities.** `capabilities/main.json` grants the main window only the app's own
  commands: `allow-start-job` and `allow-cancel-job` (D0), and `allow-open-archive`,
  `allow-close-archive`, `allow-open-snapshot`, `allow-list-children`, and
  `allow-entry-details` (D1, each needed by the browser), and `allow-watch-drops`,
  `allow-staged-sources`, `allow-stage-sources`, `allow-unstage-source`,
  `allow-clear-staged`, and `allow-choose-destination` (D2, each needed by the create
  and add panel), and `allow-plan-extract` (D3, needed to show the folder dialog and
  the collision plan; the extract job itself runs through `start_job`, so it needs no
  permission of its own), and `allow-choose-check-subject`, `allow-health-report`,
  `allow-export-report`, and `allow-repair-setup` (D4: choosing the archive to test or
  repair, the health summary, exporting a report, and choosing a repair's copies and new
  file, each of which shows a native dialog from Rust or reads only what Rust kept; the
  test and repair jobs run through `start_job`), and
  `allow-unlock-archive`, `allow-cancel-unlock`, `allow-list-envelopes`, and
  `allow-unlock-check-subject` (D5: the passphrase prompt for an encrypted archive,
  forgetting a waiting archive, listing a head's key envelopes, and the passphrase for
  an archive chosen for testing or repair; the create, rekey, and search jobs run
  through `start_job` and need nothing of their own). **Passphrases (D5).** A passphrase
  crosses IPC once per use, as a `Secret` (zeroizing, `Debug` prints `<redacted>`, no
  `Serialize`); Rust keeps it only as a `mochi-core` key session on the open archive or
  the chosen subject, never in the webview after submit and never on disk. The optional
  OS keychain is not built: see the plan, D5 status. Also `allow-get-crash-settings`,
  `allow-set-crash-settings`, `allow-read-crash-log`, `allow-export-crash-log`, and
  `allow-clear-crash-log` (D7: the two crash-log switches, showing the log text, saving
  a copy through a save dialog that Rust shows, and deleting it; the log is a local file
  that only Rust opens, so these add no `fs`, `http`, or `dialog` permission and the CSP
  is unchanged). Also `allow-window-minimize`, `allow-window-toggle-maximize`,
  `allow-window-close`, `allow-window-start-drag`, and `allow-window-watch` (release 0.9.10,
  the window's own title bar; below). Also `allow-get-speed-settings` and
  `allow-set-speed-settings` (release 0.9.11, *Settings → Speed*; below). Also
  `allow-pause-job` (release 0.9.12: pause and resume a running job at its safe points;
  see Jobs), and for the compact window `allow-quick-pause`. All are the app's own commands, not plugin permissions. The commands are declared in
  `build.rs` (`AppManifest`), so any command not listed there or not granted is
  refused. `core:default` is **not** granted: the app needs no window, event, path,
  menu, tray, or image API, and job events travel over a Channel, which needs no
  permission. No `fs`, `shell`, `http`, `process`, or `dialog` permission.
  `ci/check-invariants.sh` rule 10 refuses them; the E2E test fails if
  `allow-cancel-job` is removed (checked).
- **One title bar (release 0.9.10, `src/frame.rs`, `ui/src/shell/TitleBar.tsx`).** Every
  window is built undecorated (`decorations(false)`) with `shadow(true)`, which keeps
  Windows 11's shadow, one-pixel border and rounded corners; the windowing library keeps
  resize borders on the edges of an undecorated window on Windows and Linux, and the archive
  windows keep their 720×480 minimum. The page draws one bar: the app icon, the title (the
  archive's file name, untrusted text rendered as text and cut short with an ellipsis; the
  native title stays `<name> - MOCHI` for the taskbar and `document.title` matches), the
  toolbar, and minimize, maximize/restore and close (46 pixels wide, the full height of the
  bar, Close red under the pointer; the same on Ubuntu). The buttons are five small commands
  that act on **the calling window** (Tauri hands it to the command; the page names none):
  `window_minimize`, `window_toggle_maximize` (a no-op on a window that may not be
  maximized), `window_close`, `window_start_drag` (a press on the bar's empty part; the
  second press of a double click toggles maximize instead, as Tauri's own drag region
  does), and `window_watch` (the maximized and focused state now and on each change, over a
  Channel, so the button shows restore or maximize and the bar dims when the window is
  inactive). `core:window:default` and `core:window:allow-start-dragging` are **not**
  granted, and no event permission is needed. `window_close` is `Window::close`, the same
  request as the system's close button and Alt+F4 (`CloseRequested`, then `Destroyed`, where
  `WindowStates::release` runs), so closing behaves exactly as before. The compact window
  gets the same bar without maximize (`allow-window-minimize`, `allow-window-close`,
  `allow-window-start-drag` only; it is neither resizable nor maximizable): one look for the
  whole app, and its Close stops its job as the system's close did. Not provided: Windows
  11's snap-layout flyout on hovering Maximize (it needs a native caption button); Windows +
  arrow keys and dragging to a screen edge still snap. The release checklist (W-09c in
  `docs/release-runbook.md`) covers what WebDriver cannot drive: dragging, edge resizing,
  Alt+F4, the shadow and corners, and high contrast.
- **The open dialog runs in Rust (D1).** `open_archive` shows the operating system's
  dialog from Rust (`tauri-plugin-dialog`, MIT OR Apache-2.0, registered for its Rust
  API only) and opens the chosen file itself. The webview never names a path, so no
  script in it can ask the app to read a file the user did not pick, and it needs no
  dialog permission. The plugin brings the `tauri-plugin-fs` crate as a Rust
  dependency; no `fs` permission is granted, so the webview cannot call it. Archives
  are opened read-only (`OsReadStorage`); nothing in D1 writes. With the `e2e`
  feature only, the dialog first takes paths from `MOCHI_E2E_PICK`, because WebDriver
  cannot drive a native dialog; shipped builds never read it.
- **Sources and destinations are chosen in Rust (D2).** `stage_sources` and
  `choose_destination` show the operating system's dialogs from Rust, and files dragged
  onto the window arrive as the window's drag-and-drop event, which Rust receives
  (`on_window_event`) and stages itself. Rust keeps the paths; the webview sees only
  display names (`StagedView`) and starts a job with options, never a path. A script in
  the webview therefore cannot make the app read or write a file the user did not pick
  or drop, and the webview needs no `dialog`, `fs`, or event permission. The drop
  channel is a Tauri `Channel`, which needs no permission. Create never replaces an
  existing file. With the `e2e` feature only, dialogs take paths from
  `MOCHI_E2E_PICK_FILE` (one per line, rewritten by the spec) before `MOCHI_E2E_PICK`,
  and `MOCHI_E2E_PACE_MS` slows the walk of a create or add per entry so a spec can
  cancel it; shipped builds read neither.
- **The extract folder is chosen in Rust (D3).** `plan_extract` shows the operating
  system's folder dialog from Rust, keeps the choice, and returns only its display text
  and what extracting would meet there. The `ExtractArchive` job request carries an archive
  handle, a snapshot, entry keys, and the conflict choice, never a path, so no script in the
  webview can make the app write anywhere the user did not pick, and the webview needs no
  `dialog` or `fs` permission. Every byte reaches the disk through the C6 restore engine
  (`mochi_core::restore`): traversal and absolute paths cannot be expressed, links are never
  followed, reserved Windows names are refused, case collisions are reported, nothing is
  overwritten. With the `e2e` feature only, the dialog takes its path from the pick queue
  and `MOCHI_E2E_PACE_MS` also slows an extraction per entry; shipped builds read neither.
  On Linux the engine refuses a folder other users can modify; on Windows the destination's
  ACL is not checked (`docs/c6-restore-platforms.md`, W2), so the panel says: "Extract into
  a folder only you can modify."
- **Tests, reports, and repairs stay in Rust (D4).** The archive to test or repair, each
  independent copy, the new archive a repair writes, and where a report is exported are
  chosen in native dialogs shown from Rust and kept there (`src/check.rs`); the webview
  refers to them by ID. "Test archive" and the health summary open the file read-only
  (`OsReadStorage`) and call `mochi_core::verify` and `mochi_core::health` as the CLI
  does; a repair plans read-only and writes only a new file that does not exist yet (the
  source is never written, an existing file is never replaced). A report's JSON is
  rendered once, exactly as `mochi verify --json` prints it, and exporting writes those
  bytes to a new file. With the `e2e` feature only, these dialogs take paths from the pick
  queue and `MOCHI_E2E_PACE_MS` slows tests and repairs per progress event.
- **Browsing pages over IPC (D1 exit).** `mochi_core::browse::SnapshotIndex` keeps a
  snapshot's tree in Rust; the webview asks for at most 1,000 entries per call (the
  list asks for 200) and renders only the rows in view, so a folder of 100,000 entries
  never crosses IPC or enters the DOM whole. Paths cross as hex of their stored bytes,
  so names that are not UTF-8 round-trip exactly; names cross as text escaped by
  `mochi_core::text::escape` (the CLI's rule) and are marked "(escaped)" when that
  changed them. Sizes cross as decimal strings, because an archive may claim values
  above 2^53. Encrypted archives are refused with `KEY_UNAVAILABLE` until passphrase
  entry (D5).
- **Dragging entries out to the file manager (`dragout.rs`).** `drag_out` (a MOCHI
  archive) and `drag_out_foreign` (ZIP, 7z, RAR, tar) take only an archive handle, the
  snapshot, and entry keys; each is granted by its own permission (`allow-drag-out`,
  `allow-drag-out-foreign`). Rust makes a fresh folder with a random 128-bit name under
  `<app cache>/drag-out/` (owner-only on Unix), extracts the selection into it through the
  Extract code itself (`extract::run`, `Foreign::run`, so the C6 restore engine writes every
  byte, an Encrypted archive uses the passphrase already given in its session, and a foreign
  archive is read only by the isolated helper), moves each selected entry to the top level of
  the folder's `items` directory under its own name (`a/b/c.txt` is dragged as `c.txt`), and
  starts the operating system's drag of those items with the `drag` crate (Apache-2.0 OR MIT,
  CrabNebula; OLE `DoDragDrop` on Windows, a GTK drag source on Linux). `tauri-plugin-drag`
  is not used and the webview gets no plugin, fs, shell, or dialog permission, so it never
  sees a path. A selection above 8 GiB of declared size is refused (`LIMIT_EXCEEDED`; the UI
  offers Extract); so is one with no keys, too many keys, an unparseable key, or one the
  archive lacks (`INVALID_ARGUMENT`), and so is a selection from which any entry could not
  be extracted (nothing partial is offered). The folder is deleted when the drag ends without
  a drop, when anything fails before it starts, and by a sweep at start-up and at exit for
  folders over an hour old; the sweep removes only directories directly inside `drag-out`
  whose name is 32 lowercase hex digits, and never follows a symbolic link. A dropped-on
  folder is left for the sweep because the file manager may still be copying from it.
  Extraction happens before the drag starts, so the interface should call the command as the
  drag gesture begins. Not covered by headless tests: the native drag itself (the E2E job
  cannot drive an OS drag; the release checklist covers it by hand on Windows and Ubuntu).
- **Extract to... (`extract.rs`, `folders.rs`, `commands.rs`, `ui/src/extract/ExtractToDialog.tsx`).** WinRAR's window: an editable destination folder with Browse..., the folders extracted into lately (newest first, at most 8, only ones that still exist), and "Extract into a new folder named after the archive" (on by default); Enter confirms. `extract_wizard_setup` opens it with the folder used last, else the Desktop (Tauri's `desktop_dir`, resolved in Rust). `browse_extract_folder` shows the folder dialog from Rust. `plan_extract_to` (MOCHI) and `plan_extract_foreign_to` (ZIP, 7z, RAR, tar) take the archive handle, the snapshot, the entry keys, the folder text and the new-folder flag. **This is the one place the webview sends folder text**, so Rust treats it as untrusted (`folders::existing_folder`: an absolute path of at most 1,024 characters, no control characters or `..`, naming a folder that exists); nothing is created from typed text except the new folder named after the archive (`create_unique_dir`: `name`, `name (2)`, ... by `create_dir`, which fails on an existing name, so nothing is ever reused; a `.tar.gz` is named without `.tar`). The restore engine still never overwrites: with nothing in the way the interface starts the ordinary extract job at once, otherwise the plan panel lists the collisions first and "Extract the rest" skips them. If a job into a new folder fails or is cancelled before writing anything, the empty folder is removed again (`discard_extract_folder` removes only an empty one). Every successful extraction (this window, the Extract panel, the compact window's quick verbs) is recorded by Rust in `recent-extract-folders.json` in the app config folder (`Destination::record_success`; for a new folder the folder it was made in is recorded). The list is kept in Rust and not in `localStorage` because the compact window is another webview with its own storage; a missing or damaged file means an empty list.
- **Which actions are on (`ui/src/shell/availability.ts`).** One pure function, `availableActions(archive, selection)`, decides every toolbar button, More item, list-menu item and key (Add, Remove/Delete, Extract, Extract to..., Test, Copy names, Select all, Passphrases) from the archive kind (none, MOCHI latest or older version, foreign read-only, locked), the selection and a running job. A disabled action stays visible, is announced as disabled (`aria-disabled` in the list menu, `disabled` on buttons) and its tooltip says why. Repair is not in it: it chooses its own archive.
- **Rubber-band selection (`ui/src/list/marquee.ts`, `selection.ts`).** Pressing on empty space in a file list, or on a row's non-name columns (Size, Type, the gap right of a short name), and dragging draws a translucent band and selects the rows it touches (Ctrl toggles against the selection the drag began with); pressing on a row's icon or name, or anywhere on a selected row, keeps the drag out to the file manager. The list scrolls while the pointer is held past its top or bottom edge. The rule is `pressIntent`.
- **CSP.** `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'
  data:; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none';
  form-action 'none'; frame-ancestors 'none'`. `connect-src` names Tauri's IPC
  transport: `ipc:` on Linux, `http://ipc.localhost` on Windows. `devCsp` adds only
  `ws://localhost:5173` (Vite's hot reload) and inline styles (Vite injects CSS as
  style elements in development). No remote content, no eval; `freezePrototype` is on.
  `ci/check-invariants.sh` rule 10 refuses eval and any other http(s) origin.
- **WebDriver hook only in test builds.** On Windows, msedgedriver attaches by setting
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` (remote debugging) and
  `WEBVIEW2_USER_DATA_FOLDER`, but Tauri always passes its own WebView2 arguments and data
  directory, which win, so the driver never finds `DevToolsActivePort`. The `e2e` Cargo
  feature (`src/automation.rs`) passes both variables through to the main window. Only
  the E2E job enables it; a shipped build never does, so no environment variable can open
  a debugging port in it. The main window is built in code (`lib.rs`), not in
  `tauri.conf.json`, for this reason; its label stays `main`, the label the capability
  grants.
- **Text only.** Lint errors for `dangerouslySetInnerHTML`, `innerHTML`/`outerHTML`
  assignment, `insertAdjacentHTML`, `javascript:` URLs, and eval
  (`@eslint-react/dom-no-dangerously-set-innerhtml` and friends, plus a core
  `no-restricted-syntax` backstop). `eslint-plugin-react`'s `react/no-danger` supports
  only ESLint up to 9, which is out of support, so the maintained `@eslint-react`
  plugin carries the rule. `ci/check-invariants.sh` rule 7 also greps `ui/src`.

### In-app updates (T13)

`src/update.rs` drives `tauri-plugin-updater` from Rust. The webview is granted three of
the app's own commands (`get_update_settings`, `set_update_settings`, `check_for_update`),
starts the download as the `install_update` job, and gets **no** `updater:*` permission:
the request, the signature check, and the install all happen in Rust, so the CSP is
unchanged. The start-up check is opt-in and off by default; Rust refuses an automatic check
while it is off. Release notes are remote text and are shown as text only. The decision
logic is behind the `Backend` trait and is tested without a network. Endpoint, public key,
the release workflow, and the owner's steps: `docs/packaging.md`.

## Creating ZIP and tar archives, and the Add form (plan O31, owner decision 2026-10-20)

The app may create `.mochi` (the default), ZIP, `.tar`, `.tar.gz` and `.tar.zst`; it never writes RAR, and
7z is not written now. The writer is `crates/mochi-export` (not `mochi-format`, not `mochi-core`, not the
foreign helper: it parses no archive, only reads the user's files). The `ExportArchive { format, level }`
job runs through the one job runner with the one progress sink and cancellation token (`export_scan`, then
`export` in content bytes with a known total) and finishes with `completed` carrying an `ExportReportView`:
what was written (files, folders, bytes, the file's size, what was skipped and why) and nothing else. It
never carries `LOCAL_COMMITTED`, a health dimension, or a statement about the file being checked; the
window says "Wrote 12 files · 3 folders · 3.4 MB to trip.zip". The bytes go to a temporary file
(`.<name>.<random>.part`) in the destination folder and are published with the no-replace rename the
`.mochi` writer uses, so a failed or cancelled job leaves no file under the final name and an existing file
is never replaced (there is no "replace" option). Symlinks, devices, names that are not Unicode, and files
that cannot be read are skipped and listed. There is no ZIP encryption: asking for a password or a recovery
record with a plain format is refused (`UNSUPPORTED_FEATURE`), and the window does not offer them.

* **Create archive** has a Format drop-down (`set_archive_format`): the default name and a chosen
  destination take the format's extension; encryption, the TAR-compatible profile and the recovery record
  are shown for `.mochi` only; the compression level is shown for everything but plain tar.
* **"Add to archive..." (`--add`)** opens a small form in the compact window instead of the main window's
  add panel: archive name (prefilled `<Name>.mochi` next to the items, the `--add-now` rule), Browse...,
  format, compression, the `.mochi` options, OK and Cancel. Launches of one selection (Explorer starts one
  process per item) arriving within 500 ms make one form; a later launch joins the form while it is open;
  one that arrives after OK gets a form of its own (the compact window runs one job at a time, so an
  Extract verb started while a form is open waits until the form is answered or closed). Nothing is written until OK, closing the window cancels,
  and OK runs in the same window with progress, then the result with "Show in folder". Cold start: the first
  process opens only this window (`Verb::is_quick`); the main window is never created for it. The old add
  panel is no longer reachable from the shell. (A bug that hid the New archive dialog while a ZIP, 7z or RAR
  file was open is fixed: the writer sits outside the stage that is hidden then. `DropWatch` takes its
  waiting announcement and installs the listener under one lock, so an announcement made between the two
  cannot be stranded; and the writer ignores the first "what is staged" answer if Rust announced something
  newer.)

## MOCHI Find: search the names inside many archives

"Find in archives" (the title bar's Find button, Ctrl+Shift+F, Explorer's "Find in MOCHI archives" on folders and on a
folder's background, a Linux folder launcher) searches the **file names** inside every `.mochi` under
chosen folders. It reads names only, never file content. Code: `src-tauri/src/find.rs`, `ui/src/find/`.

* **Entry points.** The launch verb `--find [--] FOLDER...` (`launch.rs`; any number of folders, none
  opens the tool as it was left; files in the list are ignored, no folder at all is a problem). The
  window hears only `LaunchEvent::Find { folders }`. In the .deb: a launcher `mochi-find.desktop`
  (`Exec=mochi-desktop --find -- %F`, **no `MimeType`**: MOCHI must never be a registered folder
  handler), a Dolphin service menu, a Nemo action and an optional GNOME Files extension (loaded only
  if `python3-nautilus` is installed; otherwise use the in-app command).
* **Per window.** Each window has its own folders, scan and results (`WindowState::finder`, reached
  through the `Win` extractor); only the cache of names is shared (`WindowStates::find_cache`), so a
  second window does not re-read archives the first one read. A scan stops when its window closes.
  `--find` opens Find in an empty window, else in a new one; it never takes over a window that shows
  an archive. A hit opens through the multi-window routing (`Launches::open_hit_in_window`): in the
  asking window if it is empty, else the window that already has the archive (brought forward), else a
  new window; that window then gets `LaunchEvent::Reveal` and goes to the entry's folder with the entry
  selected.
* **Scan = a job.** `Finder::start` runs `scan` under a `mochi_core::job::JobContext` (progress sink,
  cancellation token); progress and one `finished` stream over a `Channel<FindEvent>`. One thread walks
  the folders (symbolic links and junctions are counted and **not followed**, so nothing can loop; depth,
  folder, archive and name counts are bounded), a bounded pool (2 to 8 workers) opens each archive
  **read-only**: `open_head` (the catalog image is hash-verified first) then `mochi_core::search` over the
  head with an empty query. No file content is read or hashed. Names, kinds and sizes stay in Rust.
* **Cache.** Per archive, in memory, for the session, keyed by (path, size, modified time). A new query
  never rescans; a new scan re-reads only archives whose key changed. There is no on-disk cache.
* **Query.** A substring (case-insensitive: Unicode lower-casing for valid UTF-8, ASCII for other bytes),
  or a glob if it has `*` or `?` (the whole file name); text with `/` is matched against the whole path.
  At most 1,000 hits cross IPC; the rest are counted.
* **Coverage (§23.3 #8).** Every result carries the scan's coverage. `complete` is true only if the scan
  finished, every archive found was searched, no folder was unreadable, no link was left unfollowed and no
  limit was hit. Encrypted archives (Find never has a passphrase), damaged or unreadable ones, files that
  are not MOCHI archives, unsupported formats and archives with too many names are listed with the reason.
  The window says "Search incomplete: N archives could not be searched" and never "No matches" then.
* **No path in, no path out of the webview's control.** Folders are chosen in Rust (native dialog or the
  launch); the window shows them as text, removes one by position, and opens or shows a hit by
  (scan number, archive position). Rust re-checks that the archive file is unchanged before opening it.
  Entry names are escaped `NameText`, rendered as text.
* **`mochi find` is the same search on the command line** (owner decision 2026-10-24, spec Annex B.2.18,
  D28). The walk, the per-archive listing, the classification of failures and the matcher live in
  `mochi_core::find` (the folder tree in `storage::os::OsFindTree`); this module keeps the window's parts:
  scopes, the session cache, the scan's state and events, and the IPC views.

## Jobs

Long operations are `mochi-core` jobs (a progress sink and a cancellation token).
`start_job(request, onEvent)` validates the request, returns a job ID at once, and runs
the work on Tauri's blocking pool; events (`started`, `progress`, then exactly one
`finished`) stream over the Channel. `cancel_job(id)` sets the token; the job stops at
its next safe point and reports `cancelled`. `pause_job(id, paused)` pauses or resumes it:
a paused job waits at those same safe points (`CancellationToken::check`), so it stops
only where it could also have been cancelled, and cancelling or closing the window still
ends it. If the window goes away, the next event
fails to send and the job is cancelled. A job that unwinds still reports `finished`
with outcome `aborted`. Only a `completed` outcome is described as complete, and
nothing on screen gets success styling (spec §23.3: success styling is for a
verification `PASS`).

Write jobs (D2) use the same runner: `CreateArchive`, `AddToArchive`, and
`DeleteFromArchive` finish with `completed` carrying a `CommitReport` (status
`LOCAL_COMMITTED`, never more). Cancelling before the commit is published leaves the
previous head valid, and a cancelled create leaves no file. The wording after a commit
is in `ui/src/write/messages.ts` and is tested against spec §23.3 #5 and #6.

The extract job (D3) is `ExtractArchive { handle, seq, keys, on_conflict }` and finishes
with `completed` carrying an `ExtractReport` (counts, each entry not extracted with its
code and reason, attributes not applied per kind, unconfirmed durability). It opens its
own reader, so browsing continues while it runs. Cancelling discards the file being
written and leaves the files already published, each complete; folders made so far have
not had their recorded times and permissions applied yet (the engine applies them last),
and the result says so. An extraction is not a verification: it states what it extracted
and that nothing else was checked (`ui/src/extract/messages.ts`).

Test and repair jobs (D4) are `TestArchive { subject, level, deep }`, `PlanRepair {
subject, salvage, archive_id }`, and `ApplyRepair { subject, plan, accept_retention_loss }`,
finishing with `completed` carrying a `CheckResult` (the report, the plan, or what the
repair wrote with its re-verification). The plan is the approval: `ApplyRepair` names the
plan the user reviewed, core plans again and refuses any difference, and changing the
archive or the copies drops the plan. Only a §20.4 `PASS` gets success styling
(`ui/src/check/messages.ts`, tested); the overall line names every failing dimension.

## Accessibility (plan D7)

What is built, and how each part is checked:

- **Keyboard.** Every control is a native button, link, input, select, or summary, so it
  is in the tab order in reading order; nothing sets a positive `tabindex`. The page opens
  with a *Sections* list of buttons that move focus to a section's heading (buttons, not
  anchors: the window has no `href` at all, which the browse E2E spec asserts). Long lists (the
  folder contents, a foreign archive's entries) are **one tab stop** with roving focus:
  Up/Down, Page Up/Down, Home, and End move between rows (rows outside the window are
  scrolled in first), Space selects, Enter opens a folder and puts focus in the new
  listing. The folder tree is a plain nested list of buttons (no ARIA `tree`, which would
  need its own key contract); each expander names its folder and sets `aria-expanded`.
- **Focus.** A panel the user opens (new archive, add, remove, extract, passphrase,
  rekey, foreign password) takes focus on its heading and gives it back to the button
  that opened it when it closes (`a11y/Panel.tsx`). The panels are inline, not modal, so
  there is no focus trap and Tab simply continues. After a passphrase attempt the field
  disabled during the attempt gets focus back, with the error tied to it by
  `aria-describedby`. Every focusable thing has a 3 px ring (`:focus-visible`); the
  stylesheet never sets `outline: none` (tested).
- **Names and live regions.** Every control has an accessible name; the progress bar
  has a name and a spoken value. Results go to **polite status regions that exist before
  they have text** (`a11y/Live.tsx`); failures are `role="alert"`; progress ticks are not
  announced (the start and the end are).
- **Colour.** All colours are tokens in `styles.css :root`. `a11y/contrast.test.ts`
  reads the real stylesheet and checks WCAG 2.1 AA: 4.5:1 for each text colour on every
  surface, 3:1 for the focus ring and status borders, no raw colour outside `:root`.
  A status is always its word, plus a glyph (`data-mark`) and a solid or dashed border;
  only PASS is green (§23.3 #2). Forced-colour (Windows high contrast) keeps selection
  and status shapes. Narrow windows stack the panes (reflow).
- **The audit.** Axe-core is MPL-2.0, and O23 asks for MIT/Apache-compatible
  dependencies, so `test/audit.ts` is an in-house structural audit (accessible names via
  `dom-accessibility-api`, MIT; unique ids and resolvable `aria-*` references; heading
  levels; reviewed roles; list, table, and radio-group structure; status words) that
  `test/setup.ts` runs on **the screen every UI test ends on**, and `test/audit.test.tsx`
  proves it can fail. Add `expectAccessible()` mid-flow when a test passes through a
  state worth checking.
- **E2E.** `e2e/specs/a11y.e2e.js` drives the real app by key only (Tab, arrows, Space,
  Enter): section buttons, opening an archive, the roving list, panel focus in and out,
  a keyboard-started test with its result, and a full tab cycle with no trap.

Not checked by a machine, so on the release checklist (`docs/packaging.md`): a pass with
NVDA on Windows and Orca on Ubuntu, Windows high-contrast themes, and 200 % zoom.

## Messages (i18n scaffolding, plan D7)

All user-visible wording is in the typed catalogue `ui/src/i18n/en/*.ts` (one file per
screen, merged in `en.ts`); screens call `t("area.key", { param })`. English, Thai (`th/`)
and Simplified Chinese (`zh-CN/`) ship, chosen in Settings (default: the webview language);
how to translate or add one is `ui/src/i18n/README.md`. A key that does not exist, or a placeholder that is not supplied, fails
`pnpm typecheck`. The rules:

- Wording did not change in the move (the existing screen tests assert it).
- The lookup interprets only the catalogue's own templates. **Archive-supplied strings
  (names, labels, foreign-format messages) are parameters**: inserted once as plain text,
  never scanned for `{placeholders}`, never used as a key or a template (tested).
- `i18n.test.ts` applies the §23.3 banned words ("safe", "secure", "backed up",
  "preserved", "revoked", "repaired", …) to the whole catalogue, and fails on a key that
  nothing uses.
- ESLint refuses English text in JSX and in `aria-label`/`title`/`placeholder`/`alt`
  attributes outside tests, so wording cannot bypass the catalogue.
- Wording in `*/messages.ts` that does not depend on a value is a function (`checkNote()`),
  not a constant, because the language can change while the app runs; the root of each
  window calls `useLocale()` so a change re-renders in place. Numbers go through
  `formatNumber`, never a hard-coded locale.
- Each translation must have exactly the English keys and the same `{placeholders}`
  (`tsc` and `i18n.test.ts`), and the §23.3 banned words are checked per language.

## Speed: compressing on every core (release 0.9.11)

Writes (Create, Add, the Explorer "Add to archive" verbs) pass
`WriterOptions::threads` from `src-tauri/src/speed.rs`: by default `None`,
every processor core up to 8, so `mochi-core` reads, hashes and compresses
file content on worker threads (`docs/benchmarks/c14-threads.md`: 3.2× on one
512 MiB file with 4 cores). *Settings → Speed* (`ui/src/settings/Speed.tsx`)
turns it down to one core, which leaves the computer more responsive during a
long job. The archive is the same bytes either way, so the choice is not
recorded in it. Rust saves the choice in `compression-settings.json` next to the
crash-log settings and reads it at start, before any window can write; a
missing or damaged file means every core.

## Crash reports (plan D7): opt-in, local, never sent

There is no reporting endpoint, so nothing is sent. The app has an **off-by-default
local panic log** (`src-tauri/src/crashlog.rs`, screen: *Settings → Crash reports*):

| Question | Answer |
|---|---|
| Collected? | Only if the user turns it on: time, app version, OS and CPU, the failed thread's name, the source `file:line` of the panic, up to 60 backtrace lines of function names. |
| Never | Passphrases, archive contents, file or folder names. |
| The panic message | Left out unless the user also turns on "Include the panic message", which warns that it can quote a file name. Then it is escaped to one line and cut at 500 characters. |
| Where | `crash.log` (+ one rotated `crash.log.1`, 256 KiB each at most, owner-only on Unix) in the app's local data folder. The webview never sees a path. |
| Sent? | No. No network client, no new permission; the CSP is unchanged. |
| What the user can do | Show the text, save a copy through a save dialog, delete it. Deleting keeps the switches. |
| Not caught | Faults outside a Rust panic: the system web view, out-of-memory, the OS ending the app. |

**Decided [owner, 2026-10-14]: crash reporting stays local-only (option A) for 1.0 and beyond unless
revisited.** MOCHI is an archiver, and other programs can collect the exported log, so the
app has no reporting endpoint and sends nothing. The way to report a crash is: turn the log on, reproduce it, save a copy, read it, and
attach it to an issue.

## Rules that apply from the first commit (AGENTS.md, spec §23.3)

- No format logic in the UI or in Tauri commands. Commands validate input, call `mochi-core`, return typed results.
- Grant the webview no broad filesystem, shell, or HTTP permissions. Users pick paths
  in the native dialog, which Rust shows; Rust does the I/O. Every new permission needs a written reason.
- Archive-supplied strings (names, labels, comments) render as text only: never
  `dangerouslySetInnerHTML`, never into `href`/`src`.
- No success styling for `UNKNOWN` / `OVERDUE` / `UNSUPPORTED` / `DEGRADED`.
  Never say "backed up", "safe", or "preserved" after a commit.
- Passphrases cross IPC once and are never persisted unless the user opts into the OS credential store.
- Foreign archives (D8): opened read-only, parsed in the helper process, extracted only
  through the shared restore engine, and tested with CRC wording, never MOCHI verification wording.
  The same holds when the shell starts the app with one (T20): `launch.rs` sends a ZIP, 7z, RAR,
  tar, tar.gz, or tar.zst path to the in-app open path in Rust, the window shows the foreign browser (an
  encrypted archive asks for its password there, once), and the shell's "Extract here" /
  "Extract to a new folder" stay `.mochi`-only: on a foreign file they extract nothing and open it
  for browsing with a plain note.
  **One Open (`route.rs`):** Open archive, the recent list, a dropped file, and the shell's open verb
  all go through one router. A file that starts with the MOCHI descriptor frame is a MOCHI archive
  whatever its name (a TAR-compatible `.mochi` is also a valid tar.zst stream, so a name cannot decide);
  otherwise a foreign name or first bytes send it to the helper. `open_archive`, `open_recent` and
  `open_dropped_archive` return `foreign` or `foreign_password` beside the MOCHI outcomes; foreign
  archives are recorded in the recent list. A dropped single archive file is announced with
  `foreign: bool` and can be opened or, with `stage_dropped_archive`, staged as an ordinary source to
  add. `foreign_search` looks up entry names (never contents) in an open foreign archive.

## The simplified main path (D10)

Owner test, 2026-10-16: nobody knew where to start, the words were technical, and create and
extract were confusing. The window opens on a drop area with two actions (Create archive, Open
archive) and a short recent list. The technical tools are in the toolbar's More menu (0.9.4: in a
tool window; until 0.9.3 an "Advanced" drawer). Nothing was removed.

### The window (a desktop app, almost no text; 0.9.4)

Owner feedback, 2026-10-20: no scroll bar, Advanced had too much text, it should look like a
desktop app and not a web page, as little text as possible, a music-file icon, easy drag and drop
in and out, and a search bar in place of the result banners; explanations belong in the docs,
not on screen. The window is one fixed frame that never scrolls (only the file list and a
dialog's own body do, with thin scroll bars):

- **Toolbar** (`role="group"`): icons only, each with its name as hidden text and as the
  tooltip: Open (Ctrl+O), New archive, then Add, Extract, Test, Remove; at the right the
  **search field** (Ctrl+F), Info, More and Help. A button is disabled when it does not apply;
  its tooltip says why. **More** holds Open and extract, Other formats, Passphrases, Repair,
  Settings.
- **Tools open in a window over the list** (`shell/ToolSheet.tsx`, `data-testid="tool-sheet"`),
  one at a time, with a close button and Escape. Every tool stays mounted, so a running test or
  an open report is still there when the user comes back. There is no Advanced drawer any more.
- **Dialogs.** Create, Add, Remove, Extract, and the passphrase and password prompts are small
  dialogs over the list (`a11y/Panel.tsx`, a close button and Escape where the dialog can be left).
  Explanations that are not a decision's own words are an "i" whose tooltip holds them
  (`a11y/Hint.tsx`; screen readers read them as a note). What the spec requires the user to see
  where they decide stays as text: removing keeps the content in history, removing a passphrase
  is not revocation, what cannot be extracted and why.
- **Path bar**: back, folders toggle, the archive name with an encrypted badge (its tooltip lists
  what stays visible without the passphrase), the version on screen (`v3`, a button that lists the
  versions; its tooltip is `N versions`), the crumbs, and a small `!` mark for an archive
  condition (retention could not be determined, catalog rebuilt from a manifest) whose tooltip
  holds the words. A foreign archive shows its format as a badge (`ZIP`), "Partial" when the
  listing stopped early, and the ZipCrypto mark.
- **File list**: Name / Size / Type, 26 px rows, file-type icons from a fixed table
  (`browser/fileKind.ts`): folder, image, **music**, video, archive, code, spreadsheet, PDF, text,
  other, link. **Multiple selection** as in a file manager: Ctrl-click toggles, Shift-click selects
  a range (fetched from Rust, since most of it is off screen), Ctrl+A the folder, Backspace goes up,
  Delete asks to remove, Enter or a double click opens a folder. Extract takes the selection, or
  everything when nothing is selected; Remove takes the selection.
- **Search** (`search/`): the toolbar field searches names (never contents) in the archive on
  screen, as you type. MOCHI archives run the search job over the version on screen
  (`{ scope: "commit", seq }`); foreign archives are searched in Rust over the listing the
  helper returned (`foreign_search`). The matches replace the folder (Name / Folder / Size / Type)
  and can be selected, extracted and dragged like entries; a double click opens the folder a match
  is in. The status bar says `N matches` (and `coverage PARTIAL` when the search did not cover
  everything, spec §23.3 #8); its tooltip is the full coverage.
- **Status bar** (always there): the count and the selection on the left; on the right what a job
  is doing (a small progress bar and a cancel button) or did (one line, Show in folder, Details,
  dismiss), and errors. Nothing appears above the list any more.
- **Drag and drop in**: files dropped on an open archive are added at once (one commit, no
  dialog; only on the latest version); with nothing open they start a new archive; one dropped
  archive opens.
- **Drag and drop out**: drag a row (or the selection it belongs to) onto the desktop or a folder.
  Rust extracts the entries through the normal extract path into a folder of its own under the
  app's cache directory and starts the system drag with them (`src-tauri/src/dragout.rs`); the
  webview names no path and has no drag or file-system permission.
- **How the toolbar is wired.** The component that owns an action keeps its state, test ids and
  focus handling and only draws its button into the toolbar (or the status bar) with `ToolSlot`
  (`src/shell/Shell.tsx`, a portal into an empty element the window provides); outside the window
  (a component's own tests) the same buttons are drawn in place. The foreign browser draws its
  archive into the same area (`stage` slot) and its own Extract and Test into the same buttons.
  Since 0.9.10 the toolbar lives in the window's title bar and keeps only Open, Add, Extract
  to..., Test and Find (and the search field and More); the slots in `MENU_SLOTS` (New archive,
  Extract, Remove) are drawn inside the More menu, where `ToolButton` renders as a menu item
  with its key (Ctrl+N, Ctrl+E, Delete), with the same test id, state and action. Info
  (Alt+Enter) and Help (F1) are More items too. Each key presses the very button the menu
  shows, so it is on and off exactly when the button is.
- **Where the wording went.** An archive is not a second copy, the keys and shortcuts: Help.
  What the format's check covers: the Test button's tooltip and the test result's Details.
  The rest is in the user guide (`docs/user`).

- **Plain words, precise terms secondary.** "Version" on the main path is a snapshot (one
  commit); IDs, hashes, checkpoint/delta, and the profile are in "Technical details"
  disclosures. A finished create, add, remove, or extract is **one short line** with
  "Show in folder", a **Details** button, and a dismiss button on the same row
  (`ui/src/result/`; release 0.9.3). Details open in a closed-by-default side panel (Esc or
  Close shuts it) as label/value rows: counts, the status with its precise value
  (`commit 0 · LOCAL_COMMITTED`), the directory-entry dimension (DEGRADED shows as "Not
  confirmed" with a caution marker), what was not stored or extracted, and the one-file note.
  Items not stored or not extracted, and an archive that could not be reopened, are also in the
  line (warning bar). A degraded directory entry is deliberately **not** in the line (the owner
  wants no durability wording upfront, and on Windows every create is degraded by policy): it
  is in the panel, marked by a dot on the Details button, whose accessible name becomes
  "Details, N items need attention", and by visually hidden text in the result's live region
  ("N item needs attention, see Details") so a screen reader announces it. Nothing is
  success-styled. A removal's line still says earlier versions keep the
  content. The compact quick-verb window has the same rows behind an inline Details button.
  The technical record is also written once per result to the console (`console.info`).
- **Create** is a guided panel: choose items, see where it will be saved (default: next to the
  first item, named after it, `name (2).mochi` if taken; Rust computes it, `Staging`,
  `StagedView.default_destination`; `create_archive` never replaces), a closed **Options**
  (size and speed, password, repair data, tar tools), one **Create archive** button.
  **Change…** shows the save dialog, started at the default.
- **Extract** plans into a **new folder next to the archive** (`plan_extract_default`, Rust
  makes it; `discard_extract_folder` removes it again, only while empty, when the plan is
  closed or another folder is picked). **Choose a different folder…** keeps the dialog.
  Collisions are listed and skipped exactly as before: nothing is overwritten.
- **Drop.** Files dropped on the window go to the create panel, or straight into the open
  archive; one dropped archive file is held by Rust (`DropEvent::Archive`) and opened on request
  (`open_dropped_archive`).
- **Recent archives** (`recent.rs`, `recent-archives.json` in the config folder, at most
  six, cleared by "Clear this list"): the window sees file and folder names and opens an
  entry by position (`open_recent`); it never holds a path.
- **Show in folder** (`show_in_folder`): Rust resolves the folder (the last extraction's, or
  the archive's) and asks the OS to show it. E2E builds record it in
  `MOCHI_E2E_FOLDER_LOG`.

The new commands are app commands in `build.rs` and `capabilities/main.json`; none takes or
returns a path and no `fs`, `shell`, `opener`, or `dialog` permission was added.

## Foreign-format helper in the installers

Both installers ship `mochi-foreign-helper` next to the app (T16), so a packaged
build opens ZIP, 7z, RAR, tar, tar.gz, and tar.zst archives. How it is built, staged, licensed, and
smoke-tested: `crates/mochi-foreign/README.md` "Shipping the helper". Dev runs are
unchanged (the helper is built into `target/<profile>`).
