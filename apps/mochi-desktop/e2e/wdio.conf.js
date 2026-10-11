// End-to-end tests of the built desktop app (plan D0 exit) through
// tauri-driver, which forwards WebDriver to the platform's native driver:
// WebKitWebDriver on Linux, msedgedriver (matching WebView2) on Windows.
//
// Build first, with the UI embedded:
//   pnpm --dir ../ui build
//   cargo build -p mochi-desktop --features custom-protocol
// Linux needs a display: run under `xvfb-run`.
import { spawn } from "node:child_process";
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
