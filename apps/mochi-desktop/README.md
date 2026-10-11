# MOCHI desktop (Tauri v2)

**Phase D0 built** (plan §7): the shell, the job runner, typed IPC, and E2E tests.
Stack (plan §9 O1, next-work-plan K9): Tauri 2, React 19 + TypeScript (strict) on
Vite, pnpm with a frozen lockfile, Node 24 LTS in CI (Node 22 works locally).
Platforms (O11): Windows 10 22H2 / 11 and Ubuntu 22.04 / 24.04, x86-64. macOS is not
supported in 1.0.

```text
apps/mochi-desktop/
├── src-tauri/          # Rust: thin commands over mochi-core (a workspace member)
│   ├── capabilities/   # least-privilege capability files
│   └── src/
│       ├── commands.rs # Tauri commands: validate, call, return typed results
│       ├── ipc.rs      # IPC types (ts-rs exports them to ui/src/ipc/generated)
│       ├── jobs.rs     # job runner: mochi_core::job → events, cancellation
│       └── self_test.rs# the D0 sample job (no archive I/O)
├── ui/                 # React + TypeScript + Vite
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
cargo build -p mochi-desktop --features custom-protocol   # embeds ui/dist
cargo install tauri-driver --locked
cd apps/mochi-desktop/e2e && pnpm install --frozen-lockfile
xvfb-run -a pnpm test     # Linux (apt: webkit2gtk-driver xvfb); on Windows: pnpm test,
                          # with MOCHI_NATIVE_DRIVER pointing at a matching msedgedriver.exe
```

`cargo build` without `custom-protocol` builds the development app, which loads
`devUrl` and needs no built frontend; that is why the workspace's `cargo test` and
`cargo clippy` need no Node toolchain.

## Security decisions (each is a reason AGENTS.md asks for)

- **Capabilities.** `capabilities/main.json` grants the main window exactly two
  permissions, `allow-start-job` and `allow-cancel-job`. The app's own commands are
  declared in `build.rs` (`AppManifest`), so any command not listed there or not
  granted is refused. `core:default` is **not** granted: D0 needs no window, event,
  path, menu, tray, or image API, and job events travel over a Channel, which needs no
  permission. No `fs`, `shell`, `http`, `process`, or `dialog` permission and no such
  plugin. The file dialog arrives with D1, the first phase that picks paths.
  `ci/check-invariants.sh` rule 10 refuses broad permissions; the E2E test fails if
  `allow-cancel-job` is removed (checked).
- **CSP.** `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'
  data:; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none';
  form-action 'none'; frame-ancestors 'none'`. `connect-src` names Tauri's IPC
  transport: `ipc:` on Linux, `http://ipc.localhost` on Windows. `devCsp` adds only
  `ws://localhost:5173` (Vite's hot reload) and inline styles (Vite injects CSS as
  style elements in development). No remote content, no eval; `freezePrototype` is on.
  `ci/check-invariants.sh` rule 10 refuses eval and any other http(s) origin.
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

## Rules that apply from the first commit (AGENTS.md, spec §23.3)

- No format logic in the UI or in Tauri commands. Commands validate input, call `mochi-core`, return typed results.
- Grant the webview no broad filesystem, shell, or HTTP permissions. Users pick paths
  through the dialog plugin; Rust does the I/O. Every new permission needs a written reason.
- Archive-supplied strings (names, labels, comments) render as text only: never
  `dangerouslySetInnerHTML`, never into `href`/`src`.
- No success styling for `UNKNOWN` / `OVERDUE` / `UNSUPPORTED` / `DEGRADED`.
  Never say "backed up", "safe", or "preserved" after a commit.
- Passphrases cross IPC once and are never persisted unless the user opts into the OS credential store.
- Foreign archives (D8): opened read-only, parsed in the helper process, extracted only
  through the shared restore engine, and tested with CRC wording, never MOCHI verification wording.
