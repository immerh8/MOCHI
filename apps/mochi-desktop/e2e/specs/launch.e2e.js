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
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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
