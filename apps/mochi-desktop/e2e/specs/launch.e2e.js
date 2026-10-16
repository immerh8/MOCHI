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
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { $, expect } from "@wdio/globals";

// Set by wdio.conf.js to the binary it launches.
const application = process.env.MOCHI_DESKTOP_BINARY;
const foreignFixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../fixtures/foreign");
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

/** Make the window that shows `testid` the one WebDriver talks to (the shell's quick verbs open a compact second window). */
async function switchToWindowWith(testid, timeout = 60_000) {
  await browser.waitUntil(
    async () => {
      for (const handle of await browser.getWindowHandles()) {
        await browser.switchToWindow(handle);
        if (await $(`[data-testid="${testid}"]`).isExisting()) return true;
      }
      return false;
    },
    { timeout, timeoutMsg: `no window shows ${testid}` },
  );
}

describe("a second launch", () => {
  let work;
  let mainWindow;
  before(async () => {
    work = mkdtempSync(path.join(os.tmpdir(), "mochi-e2e-launch-"));
    mainWindow = await browser.getWindowHandle();
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

  // Owner decision 2026-10-16: the quick verbs work at once in a small second window.
  it("'Extract to a new folder' extracts at once in a compact window and leaves the main window alone", async () => {
    const archive = path.join(work, "photos.mochi");
    copyFileSync(fixture, archive);
    const ended = await secondLaunch(["--extract-to-folder", "--", archive]);
    expect(ended.code).toBe(0);
    await switchToWindowWith("quick-result");
    await expect($('[data-testid="quick-title"]')).toHaveText(expect.stringContaining("photos.mochi"));
    await expect($('[data-testid="quick-result"]')).toHaveText(expect.stringContaining("Extracted"));
    // Written at once, into a new folder named for the archive.
    expect(readdirSync(path.join(work, "photos")).length).toBeGreaterThan(0);
    // Not a verification, and no success claim beyond what happened.
    const text = (await $('[data-testid="quick-result"]').getText()).toLowerCase();
    for (const word of ["backed up", "safe", "preserved"]) expect(text).not.toContain(word);
    // The main window did not open the extract panel.
    await browser.switchToWindow(mainWindow);
    await expect($('[data-testid="extract-panel"]')).not.toExist();
    // A second run never reuses the folder.
    const again = await secondLaunch(["--extract-to-folder", "--", archive]);
    expect(again.code).toBe(0);
    await browser.waitUntil(() => readdirSync(work).includes("photos (2)"), {
      timeoutMsg: "no second, new folder was made",
    });
    await switchToWindowWith("quick-result");
    await browser.waitUntil(
      async () => (await $('[data-testid="quick-result"]').getText()).includes("photos (2)"),
      { timeoutMsg: "the second result was not shown" },
    );
    await $('[data-testid="quick-close"]').click();
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 1, {
      timeoutMsg: "the compact window did not close",
    });
    await browser.switchToWindow(mainWindow);
  });

  it("'Extract here' replaces nothing: a name in the way writes nothing and opens the plan in the main window", async () => {
    const dir = path.join(work, "collide");
    mkdirSync(dir);
    const archive = path.join(dir, "again.mochi");
    copyFileSync(fixture, archive);
    // A file where the archive has the folder "docs".
    writeFileSync(path.join(dir, "docs"), "mine");
    const ended = await secondLaunch(["--extract-here", "--", archive]);
    expect(ended.code).toBe(0);
    await switchToWindowWith("quick-result");
    await expect($('[data-testid="quick-result"]')).toHaveText(expect.stringContaining("Nothing was written"));
    await expect($('[data-testid="quick-show-folder"]')).not.toExist();
    await switchToWindowWith("extract-panel");
    await expect($('[data-testid="extract-destination"]')).toHaveText(expect.stringContaining(dir));
    expect(readdirSync(dir).sort()).toEqual(["again.mochi", "docs"]);
    expect(readFileSync(path.join(dir, "docs"), "utf8")).toBe("mine");
    await $('[data-testid="extract-close"]').click();
    await switchToWindowWith("quick-result");
    await $('[data-testid="quick-close"]').click();
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 1, {
      timeoutMsg: "the compact window did not close",
    });
    await browser.switchToWindow(mainWindow);
  });

  it("'Add to archive' collects one selection's launches into one archive and says it is a local commit", async () => {
    const dir = path.join(work, "trip");
    mkdirSync(dir);
    const files = ["a.txt", "b.txt", "c.txt"].map((n) => {
      const f = path.join(dir, n);
      writeFileSync(f, n);
      return f;
    });
    // One process per item, started together, as Explorer does.
    const ended = await Promise.all(files.map((f) => secondLaunch(["--add-now", "--", f])));
    expect(ended.map((e) => e.code)).toEqual([0, 0, 0]);
    await switchToWindowWith("quick-result");
    await expect($('[data-testid="quick-result"]')).toHaveText(expect.stringContaining("Archive created: trip.mochi"));
    await expect($('[data-testid="quick-result"]')).toHaveText(expect.stringContaining("LOCAL_COMMITTED"));
    const text = (await $('[data-testid="quick-result"]').getText()).toLowerCase();
    for (const word of ["backed up", "safe", "preserved"]) expect(text).not.toContain(word);
    expect(readdirSync(dir).filter((n) => n.endsWith(".mochi"))).toEqual(["trip.mochi"]);
    await $('[data-testid="quick-close"]').click();
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 1);
    await browser.switchToWindow(mainWindow);
    // Again: a new name, the first archive stays.
    const lengthBefore = readFileSync(path.join(dir, "trip.mochi")).length;
    const second = await secondLaunch(["--add-now", "--", files[0]]);
    expect(second.code).toBe(0);
    await browser.waitUntil(() => readdirSync(dir).includes("a.mochi"), { timeoutMsg: "no archive named for the file" });
    expect(readFileSync(path.join(dir, "trip.mochi")).length).toBe(lengthBefore);
    await switchToWindowWith("quick-close");
    await $('[data-testid="quick-close"]').click();
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 1);
    await browser.switchToWindow(mainWindow);
  });

  it("'Add to archive...' still opens the add panel in the main window and writes nothing", async () => {
    const dir = path.join(work, "panel");
    mkdirSync(dir);
    const file = path.join(dir, "note.txt");
    writeFileSync(file, "x");
    const ended = await secondLaunch(["--add", "--", file]);
    expect(ended.code).toBe(0);
    await browser.switchToWindow(mainWindow);
    await browser.waitUntil(async () => (await $('[data-testid="staged-item"]').isExisting()), {
      timeoutMsg: "the add panel did not show the staged file",
    });
    expect(readdirSync(dir)).toEqual(["note.txt"]);
  });

  it("refuses a passphrase option without echoing its value", async () => {
    const ended = await secondLaunch(["--passphrase=hunter2", "--", fixture]);
    expect(ended.code).toBe(0);
    await $('[data-testid="browse-error"]').waitForExist({ timeout: 30_000 });
    const text = await $('[data-testid="browse-error"]').getText();
    expect(text).toContain("passphrase cannot be given on the command line");
    expect(text).not.toContain("hunter2");
  });

  const entryNames = () =>
    browser.execute(() =>
      Array.from(document.querySelectorAll('[data-testid="foreign-entry"] .name'), (e) => e.textContent),
    );

  it("opens a ZIP from the command line in the foreign browser (plan D8)", async () => {
    const zip = path.join(work, "photos.zip");
    copyFileSync(path.join(foreignFixtures, "basic_infozip.zip"), zip);
    const ended = await secondLaunch(["--open", "--", zip]);
    expect(ended.code).toBe(0);
    await $('[data-testid="foreign-meta"]').waitForExist({ timeout: 30_000 });
    await expect($('[data-testid="foreign-meta"]')).toHaveText(expect.stringContaining("photos.zip"));
    await browser.waitUntil(async () => (await entryNames()).includes("a.txt"), {
      timeoutMsg: "the ZIP's entries were not listed",
    });
    expect(await entryNames()).toEqual(["empty", "sub", "a.txt"]);
    // Foreign wording: read-only, no MOCHI health dimension claimed.
    const text = (await $('[data-testid="foreign"]').getText()).toLowerCase();
    for (const word of ["backed up", "safe", "preserved", "verified", "healthy"]) {
      expect(text).not.toContain(word);
    }
  });

  it("shows a hostile name in a ZIP as text and marks it not extractable", async () => {
    const zip = path.join(work, "hostile.zip");
    copyFileSync(path.join(foreignFixtures, "traversal.zip"), zip);
    const ended = await secondLaunch(["--", zip]);
    expect(ended.code).toBe(0);
    await browser.waitUntil(
      async () => (await $('[data-testid="foreign-meta"]').getText()).includes("hostile.zip"),
      { timeoutMsg: "the hostile ZIP was not shown" },
    );
    await browser.waitUntil(async () => (await entryNames()).some((n) => n.includes("evil.txt")), {
      timeoutMsg: "the hostile entry was not listed",
    });
    // Text, never markup.
    expect(await browser.execute(() => document.querySelectorAll('[data-testid="foreign"] img').length)).toBe(0);
  });

  it("opens a 7z with encrypted names by asking for the password in the window", async () => {
    const archive = path.join(work, "secret.7z");
    copyFileSync(path.join(foreignFixtures, "7z", "enc_names.7z"), archive);
    const ended = await secondLaunch(["--open", "--", archive]);
    expect(ended.code).toBe(0);
    await $('[data-testid="foreign-password"]').waitForExist({ timeout: 30_000 });
    await $('[data-testid="foreign-password-input"]').setValue("SECRET");
    await $('[data-testid="foreign-password-submit"]').click();
    await browser.waitUntil(
      async () => (await $('[data-testid="foreign-meta"]').getText()).includes("secret.7z"),
      { timeoutMsg: "the 7z did not open after the password" },
    );
  });

  it("an extract verb on a ZIP opens it for browsing and extracts nothing", async () => {
    const zip = path.join(work, "verb.zip");
    copyFileSync(path.join(foreignFixtures, "basic_infozip.zip"), zip);
    const ended = await secondLaunch(["--extract-to-folder", "--", zip]);
    expect(ended.code).toBe(0);
    await browser.waitUntil(
      async () => (await $('[data-testid="foreign-meta"]').getText()).includes("verb.zip"),
      { timeoutMsg: "the ZIP was not opened for browsing" },
    );
    await browser.waitUntil(
      async () => (await $('[data-testid="browse-error"]').getText()).includes("extracting from the shell is for .mochi"),
      { timeoutMsg: "no plain note that shell extraction is for .mochi" },
    );
    expect(readdirSync(work)).not.toContain("verb");
  });

  it("still refuses what D8 does not support, with the typed message", async () => {
    // The last part of a split ZIP: an archive MOCHI cannot read on its own.
    const zip = path.join(work, "split.zip");
    copyFileSync(path.join(foreignFixtures, "split_last.zip"), zip);
    const ended = await secondLaunch(["--open", "--", zip]);
    expect(ended.code).toBe(0);
    await browser.waitUntil(
      async () => (await $('[data-testid="browse-error"]').getText()).includes("could not be opened (UNSUPPORTED"),
      { timeoutMsg: "no typed refusal for the split ZIP" },
    );
    expect(await $('[data-testid="browse-error"]').getText()).not.toContain("cannot be opened yet");
  });
});
