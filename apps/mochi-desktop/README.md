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
│       ├── foreign.rs  # D8: ZIP, 7z, RAR, tar read-only through the isolated helper
│       ├── help.rs     # Help, User guide: opens the bundled guide offline (F8)
│       ├── launch.rs   # D6: the shell's open, extract, and add verbs, parsed in Rust
│       ├── rekey.rs    # D5: key envelopes and passphrase changes
│       ├── search.rs   # D5: name search
│       ├── update.rs   # T13: the in-app updater, driven from Rust
│       ├── ipc.rs      # IPC types (ts-rs exports them to ui/src/ipc/generated)
│       ├── jobs.rs     # job runner: mochi_core::job → events, cancellation
│       ├── picker.rs   # D1/D2: the native open, choose, and save dialogs, shown from Rust
│       ├── self_test.rs# the D0 sample job (no archive I/O)
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

- **Compact window (D6 quick verbs).** The shell's "Extract here", "Extract to a new folder" and "Add to archive" run in a small second window labelled `quick` (the same page, `#quick`). `capabilities/quick.json` grants it five commands and nothing else: `allow-watch-quick` (hear the one running job), `allow-quick-passphrase` (an encrypted archive's passphrase, once, into a zeroizing type in Rust), `allow-quick-cancel`, `allow-quick-show-folder` (Rust remembers the folder; the webview names no path) and `allow-quick-close`. The main window gains none of them and the compact window reaches none of the main window's archive, staging, extract or update commands. No fs, shell, http or dialog permission is granted to either.
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
  is unchanged). All are the app's own commands, not plugin permissions. The commands are declared in
  `build.rs` (`AppManifest`), so any command not listed there or not granted is
  refused. `core:default` is **not** granted: the app needs no window, event, path,
  menu, tray, or image API, and job events travel over a Channel, which needs no
  permission. No `fs`, `shell`, `http`, `process`, or `dialog` permission.
  `ci/check-invariants.sh` rule 10 refuses them; the E2E test fails if
  `allow-cancel-job` is removed (checked).
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

## Jobs

Long operations are `mochi-core` jobs (a progress sink and a cancellation token).
`start_job(request, onEvent)` validates the request, returns a job ID at once, and runs
the work on Tauri's blocking pool; events (`started`, `progress`, then exactly one
`finished`) stream over the Channel. `cancel_job(id)` sets the token; the job stops at
its next safe point and reports `cancelled`. If the window goes away, the next event
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
screen, merged in `en.ts`); screens call `t("area.key", { param })`. One locale, English,
ships; adding another is a catalogue plus a language switch, which is deliberately not
built. A key that does not exist, or a placeholder that is not supplied, fails
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
- Constants exported from `*/messages.ts` are evaluated once at import (fine for one
  locale); a second locale turns them into functions.

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
  tar, or tar.gz path to the in-app open path in Rust, the window shows the foreign browser (an
  encrypted archive asks for its password there, once), and the shell's "Extract here" /
  "Extract to a new folder" stay `.mochi`-only: on a foreign file they extract nothing and open it
  for browsing with a plain note.

## The simplified main path (D10)

Owner test, 2026-10-16: nobody knew where to start, the words were technical, and create and
extract were confusing. The window now opens on **What would you like to do?** with two
actions (Create archive, Open archive) and a short recent list. Everything else is under
**Advanced** (a closed `<details>`, `data-testid="advanced"`, a drawer at the bottom of the
window): search, passphrases, test and repair, other formats, the job self-test, settings.
Nothing was removed.

### The window (WinRAR-like, minimal)

Owner feedback, 2026-10-19: "too many texts; design it like WinRAR, but more minimalistic". The
window is one fixed frame (it never scrolls; the minimum size is set where the window is built,
`build_main` in `src-tauri/src/lib.rs`):

- **Toolbar** (`role="group"`, one row of icon-over-label buttons): Add, Extract, Test, Remove,
  Find, Info, then More and Help at the right. A button is disabled when it does not apply (no
  archive open, nothing selected, a foreign archive is read-only); its tooltip holds the longer
  explanation or the reason it is off. **More** is a disclosure (not a role=menu) with New archive,
  Open and extract, Passphrases, Repair, Other formats, Settings, Self-test. **Help** opens the
  Help panel: what an archive is not (a second copy), the keys of the file list, and the User guide.
- **Path bar** (an archive is open): back, folders toggle, the archive name and `N versions` (a
  button that lists them, with each version's time, retention and holds, when there is more than
  one), the crumbs (`Version 2 / folder / folder`), and Open another archive.
- **File list** fills the window: Name / Size / Type, compact rows, file-type icons. The folder
  tree (path bar) and the **Info** panel (toolbar) are optional panes; narrow windows lay them over
  the list. Info holds the selected entry's details, and the archive's technical details and
  encrypted-archive note; for a foreign archive, the notes that it is not a MOCHI archive.
- **Status line**: `437 items · 1 selected` (tooltip: entries in this version) and the
  Extract-selected action.
- **How the toolbar is wired.** The component that owns an action keeps its state, test ids and
  focus handling and only draws its button into the toolbar with `ToolSlot` (`src/shell/Shell.tsx`,
  a portal into an empty element the window provides); outside the window (a component's own
  tests) the same buttons are drawn in place. The foreign browser draws its archive into the same
  area (`stage` slot) and its own Extract and Test into the same buttons, so a ZIP/7z/RAR/tar looks
  like a MOCHI archive and keeps its own labelling.
- **Where the wording went.** An archive is not a second copy: Help (`start-note`). What deleting
  does and what removing a passphrase does not: in the Remove and Remove-passphrase dialogs, where
  the decision is made. A foreign archive is not a MOCHI archive and what its check covers: the
  Info panel and the Test button's tooltip, plus the "(foreign format)" in the path bar, and the
  partial-listing and ZipCrypto warnings stay in view. Keyboard help: Help (also the list's
  accessible description).

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
- **Drop.** Files dropped on the window go to the create panel (or add, with an archive open);
  one dropped `.mochi` file is held by Rust (`DropEvent::Archive`) and opened on request
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
build opens ZIP, 7z, RAR, and tar archives. How it is built, staged, licensed, and
smoke-tested: `crates/mochi-foreign/README.md` "Shipping the helper". Dev runs are
unchanged (the helper is built into `target/<profile>`).
