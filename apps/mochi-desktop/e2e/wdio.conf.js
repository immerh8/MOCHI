// End-to-end tests of the built desktop app (plan D0 exit) through
// tauri-driver, which forwards WebDriver to the platform's native driver:
// WebKitWebDriver on Linux, msedgedriver (matching WebView2) on Windows.
//
// Build first, with the UI embedded:
//   pnpm --dir ../ui build
//   cargo build -p mochi-desktop --features custom-protocol,e2e
// Linux needs a display: run under `xvfb-run`.
//
// The D1 browse spec opens archives written by
//   cargo run --release -p mochi-testkit --example d1_browse_fixtures -- DIR
// (DIR is MOCHI_E2E_FIXTURES, default target/d1-fixtures). WebDriver cannot
// drive a native file dialog, so the `e2e` build takes the paths of its
// "Open archive" clicks from MOCHI_E2E_PICK, in order, once per app launch.
// The D2 spec (create-add.e2e.js) builds its own source trees and takes the
// paths of its dialogs from MOCHI_E2E_PICK_FILE.
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const exe = process.platform === "win32" ? "mochi-desktop.exe" : "mochi-desktop";
const application =
  process.env.MOCHI_DESKTOP_BINARY ?? path.resolve(here, "../../../target/debug", exe);

const driverArgs = [];
if (process.env.MOCHI_NATIVE_DRIVER) {
  driverArgs.push("--native-driver", process.env.MOCHI_NATIVE_DRIVER);
}

const fixtures =
  process.env.MOCHI_E2E_FIXTURES ?? path.resolve(here, "../../../target/d1-fixtures");
const picks = ["browse.mochi", "large.mochi"].map((f) => path.join(fixtures, f));
for (const f of picks) {
  if (!existsSync(f)) {
    console.error(
      `missing E2E fixture ${f}: run cargo run --release -p mochi-testkit --example d1_browse_fixtures -- ${fixtures}`,
    );
    process.exit(1);
  }
}
// The D3 spec opens the same archives through MOCHI_E2E_PICK_FILE.
process.env.MOCHI_E2E_FIXTURES = fixtures;
// Inherited by tauri-driver, the native driver, and the app it starts.
process.env.MOCHI_E2E_PICK = picks.join(path.delimiter);
// The D2 spec rewrites this file before its clicks (one path per line; its
// lines are used before MOCHI_E2E_PICK), and the walk of a create or add is
// slowed per entry so that its cancel case is deterministic.
process.env.MOCHI_E2E_PICK_FILE = path.join(os.tmpdir(), "mochi-e2e-picks.txt");
process.env.MOCHI_E2E_PACE_MS = "100";

let tauriDriver;

export const config = {
  runner: "local",
  hostname: "127.0.0.1",
  port: 4444,
  specs: ["./specs/**/*.e2e.js"],
  maxInstances: 1,
  capabilities: [
    {
      maxInstances: 1,
      "tauri:options": { application },
    },
  ],
  logLevel: "warn",
  reporters: ["spec"],
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 60_000 },
  waitforTimeout: 15_000,

  onPrepare: () => {
    // No pick left over from an earlier run.
    writeFileSync(process.env.MOCHI_E2E_PICK_FILE, "");
    // On PATH after `cargo install tauri-driver` (~/.cargo/bin).
    const bin = process.env.TAURI_DRIVER ?? "tauri-driver";
    tauriDriver = spawn(bin, driverArgs, { stdio: [null, process.stdout, process.stderr] });
    tauriDriver.on("error", (e) => {
      console.error(`tauri-driver failed to start (${bin}): ${e.message}`);
      process.exit(1);
    });
    // Give the driver a moment to listen before the first session.
    return new Promise((resolve) => setTimeout(resolve, 1500));
  },
  onComplete: () => {
    tauriDriver?.kill();
  },
};
