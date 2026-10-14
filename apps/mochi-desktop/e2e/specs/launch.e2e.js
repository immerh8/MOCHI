// Plan D6 exit, on the real app: a second launch with an archive path routes to
// the running instance instead of starting another one. The app wdio started is
// the running instance; this spec starts the binary again, the way a file
// manager or Explorer's "Open with MOCHI" / "Extract here" verbs do, and checks
// that the second process hands its arguments over and exits, and that the
// FIRST window shows the result. The path travels process to process and into
// Rust only; the window is told "an archive was opened" and never a path.
//
// On Linux the single-instance plugin uses the session D-Bus: CI runs this
// under `dbus-run-session` (a desktop session has one already).
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { $, expect } from "@wdio/globals";

// Set by wdio.conf.js to the binary it launches.
const application = process.env.MOCHI_DESKTOP_BINARY;
const fixture = path.join(process.env.MOCHI_E2E_FIXTURES, "browse.mochi");

/** Start the app again with `args`; resolves with how the second process ended. */
function secondLaunch(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(application, args, { stdio: "ignore", cwd: os.tmpdir() });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the second launch did not hand over and exit within 20 s: ${args.join(" ")}`));
    }, 20_000);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

describe("a second launch", () => {
  let work;
  before(() => {
    work = mkdtempSync(path.join(os.tmpdir(), "mochi-e2e-launch-"));
  });
  after(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("opens the archive in the running window instead of starting a second app", async () => {
    await $('[data-testid="browse-empty"]').waitForExist();
    // No dialog click: the path comes from the second process's command line.
    const ended = await secondLaunch(["--open", "--", fixture]);
    expect(ended.code).toBe(0);
    await $('[data-testid="archive-meta"]').waitForExist({ timeout: 30_000 });
    await expect($('[data-testid="archive-meta"]')).toHaveText(expect.stringContaining("browse.mochi"));
    await expect($('[data-testid="commit-3"]')).toHaveText(expect.stringContaining("(head)"));
  });

  it("takes a bare path, which is what a file manager passes", async () => {
    const other = path.join(work, "again.mochi");
    copyFileSync(fixture, other);
    const ended = await secondLaunch([other]);
    expect(ended.code).toBe(0);
    await browser.waitUntil(
      async () => (await $('[data-testid="archive-meta"]').getText()).includes("again.mochi"),
      { timeoutMsg: "the running window did not switch to the second archive" },
    );
  });

  it("'Extract to folder' shows the plan and writes nothing until confirmed", async () => {
    const archive = path.join(work, "photos.mochi");
    copyFileSync(fixture, archive);
    const ended = await secondLaunch(["--extract-to-folder", "--", archive]);
    expect(ended.code).toBe(0);
    await $('[data-testid="extract-panel"]').waitForExist({ timeout: 30_000 });
    await expect($('[data-testid="extract-destination"]')).toHaveText(
      expect.stringContaining(path.join(work, "photos")),
    );
    await expect($('[data-testid="extract-confirm"]')).toBeEnabled();
    // Opening and planning are read-only: the folder exists, empty.
    expect(readdirSync(path.join(work, "photos"))).toEqual([]);
    await $('[data-testid="extract-close"]').click();
  });

  it("refuses a passphrase option without echoing its value", async () => {
    const ended = await secondLaunch(["--passphrase=hunter2", "--", fixture]);
    expect(ended.code).toBe(0);
    await $('[data-testid="browse-error"]').waitForExist({ timeout: 30_000 });
    const text = await $('[data-testid="browse-error"]').getText();
    expect(text).toContain("passphrase cannot be given on the command line");
    expect(text).not.toContain("hunter2");
  });

  it("says plainly that a ZIP cannot be opened yet", async () => {
    const zip = path.join(work, "photos.zip");
    writeFileSync(zip, "PK");
    const ended = await secondLaunch(["--open", "--", zip]);
    expect(ended.code).toBe(0);
    await browser.waitUntil(
      async () => (await $('[data-testid="browse-error"]').getText()).includes("ZIP archives cannot be opened yet"),
      { timeoutMsg: "no 'not supported yet' message" },
    );
  });
});
