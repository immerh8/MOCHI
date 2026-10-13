# MOCHI desktop (Tauri v2)

**Phases D0 to D2 built** (plan §7): the shell, the job runner, typed IPC, E2E tests,
the archive browser (snapshot timeline, folder tree, virtualized list, details), and
create, add, and remove (D2).
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
│       ├── commands.rs # Tauri commands: validate, call, return typed results
│       ├── ipc.rs      # IPC types (ts-rs exports them to ui/src/ipc/generated)
│       ├── jobs.rs     # job runner: mochi_core::job → events, cancellation
│       ├── picker.rs   # D1/D2: the native open, choose, and save dialogs, shown from Rust
│       ├── self_test.rs# the D0 sample job (no archive I/O)
│       └── write.rs    # D2: staged sources, drop handling, create/add/remove jobs
├── ui/                 # React + TypeScript + Vite
│   ├── src/browser/    # D1: Browser, Tree, VirtualList, Name (text-only names)
│   ├── src/write/      # D2: Writer (create, add, remove), messages (wording rules)
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

- **Capabilities.** `capabilities/main.json` grants the main window only the app's own
  commands: `allow-start-job` and `allow-cancel-job` (D0), and `allow-open-archive`,
  `allow-close-archive`, `allow-open-snapshot`, `allow-list-children`, and
  `allow-entry-details` (D1, each needed by the browser), and `allow-watch-drops`,
  `allow-staged-sources`, `allow-stage-sources`, `allow-unstage-source`,
  `allow-clear-staged`, and `allow-choose-destination` (D2, each needed by the create
  and add panel; all are the app's own commands, not plugin permissions). The commands are declared in
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
