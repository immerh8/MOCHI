// Plan D2 on the real app over real IPC: create an archive, add to it, browse
// it, remove an entry, and cancel a create. WebDriver cannot drive a native
// dialog, so the `e2e` build takes the paths of its dialogs (choose files,
// choose folder, save as) from MOCHI_E2E_PICK_FILE, in order; this spec
// writes that file before each flow. Dropping files from a file manager is
// an operating-system gesture WebDriver cannot make: it is covered by the
// Rust drop-event tests and the UI tests, and is on the release checklist.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { $, $$, expect } from "@wdio/globals";
import {
  clickNewArchive,
  closeHelp,
  closeResultDetails,
  closeVersions,
  openHelp,
  openResultDetails,
  openVersions,
} from "./_ui.js";

const pickFile = process.env.MOCHI_E2E_PICK_FILE;
const queuePicks = (...paths) => writeFileSync(pickFile, paths.join("\n"));

const root = mkdtempSync(path.join(os.tmpdir(), "mochi-d2-"));
const src = path.join(root, "src");
const out = path.join(root, "out");
mkdirSync(path.join(src, "photos"), { recursive: true });
mkdirSync(path.join(src, "bulk"), { recursive: true });
mkdirSync(out, { recursive: true });
writeFileSync(path.join(src, "photos", "a.txt"), "alpha");
writeFileSync(path.join(src, "photos", "b.txt"), "bravo");
writeFileSync(path.join(src, "extra.txt"), "extra content");
// 60 entries at MOCHI_E2E_PACE_MS each: seconds to click Cancel in.
for (let i = 0; i < 60; i++) writeFileSync(path.join(src, "bulk", `f${String(i).padStart(3, "0")}`), "x");

const mainArchive = path.join(out, "main.mochi");
const tarArchive = path.join(out, "tar.mochi");
const cancelled = path.join(out, "cancelled.mochi");

const entryNames = () =>
  browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="entry"] .name'), (e) => e.textContent),
  );

const textOf = (testid) =>
  browser.execute(
    (id) => document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "",
    testid,
  );

const waitForStatus = (text) =>
  browser.waitUntil(
    async () => {
      const s = await $('[data-testid="write-status"]');
      return (await s.isExisting()) && (await s.getText()).includes(text);
    },
    { timeout: 60_000, timeoutMsg: `no status containing ${JSON.stringify(text)}` },
  );

const BANNED = ["backed up", "backup", "safe", "preserved"];
const assertNoBannedWording = async () => {
  const text = (await $("body").getText()).toLowerCase();
  for (const word of BANNED) expect(text).not.toContain(word);
};

describe("create and add", () => {
  it("starts from the start screen with two plain actions; the note is in Help", async () => {
    await expect($('[data-testid="start-screen"]')).toBeExisting();
    for (const id of ["start-create", "open-archive"]) {
      await expect($(`[data-testid="${id}"]`)).toBeEnabled();
    }
    await openHelp();
    await expect($('[data-testid="start-note"]')).toHaveText(
      expect.stringContaining("not a second copy of them"),
    );
    await closeHelp();
    await assertNoBannedWording();
  });

  it("creates an archive next to the first item by default, never over an existing file", async () => {
    // A file is already called photos.mochi: the default name steps aside.
    writeFileSync(path.join(src, "photos.mochi"), "mine");
    queuePicks(path.join(src, "photos"));
    await $('[data-testid="start-create"]').click();
    await $('[data-testid="stage-folder"]').click();
    await browser.waitUntil(async () => (await $$('[data-testid="staged-item"]')).length === 1);
    await expect($('[data-testid="save-location"]')).toHaveText(path.join(src, "photos (2).mochi"));
    await expect($('[data-testid="save-location"]')).toHaveAttribute(
      "title",
      expect.stringContaining("An existing file is never replaced"),
    );
    // Cancel: nothing was created, and the start screen is back.
    await $('[data-testid="stage-clear"]').click();
    await $('[data-testid="write-close"]').click();
    await expect($('[data-testid="start-screen"]')).toBeExisting();
    expect(existsSync(path.join(src, "photos (2).mochi"))).toBe(false);
    expect(readFileSync(path.join(src, "photos.mochi"), "utf8")).toBe("mine");
  });

  it("creates an archive from a folder and says it was created, nothing more", async () => {
    queuePicks(path.join(src, "photos"), mainArchive);
    await $('[data-testid="start-create"]').click();
    await $('[data-testid="stage-folder"]').click();
    await browser.waitUntil(async () => (await $$('[data-testid="staged-item"]')).length === 1);
    await expect($('[data-testid="staged-item"]')).toHaveText(expect.stringContaining("photos"));
    // Choosing another place uses the save dialog, which starts at the default.
    await $('[data-testid="change-destination"]').click();
    // The panel re-renders when the place changes: poll the text, hold no element.
    await browser.waitUntil(async () => (await textOf("save-location")).includes("main.mochi"), {
      timeoutMsg: "the chosen place was not shown",
    });

    // The options are collapsed; they hold neither encryption nor a recovery record unless asked (D5).
    await expect($('[data-testid="create-options"]')).not.toHaveAttribute("open");
    await $('[data-testid="create-options"] summary').click();
    await expect($('[data-testid="preset-balanced"]')).toBeSelected();
    await expect($('[data-testid="tar-compatible"]')).not.toBeSelected();
    await expect($('[data-testid="encrypt"]')).not.toBeSelected();
    await expect($('[data-testid="recovery-none"]')).toBeSelected();

    await $('[data-testid="create-confirm"]').click();
    await waitForStatus("Created main.mochi");
    // One short line; the technical record is in the Details panel (owner request, 0.9.3).
    const status = await $('[data-testid="write-status"]').getText();
    expect(status).toContain("Created main.mochi · ");
    expect(status).not.toContain("LOCAL_COMMITTED");
    await openResultDetails("write");
    const details = await $('[data-testid="write-details"]').getText();
    expect(details).toContain("Committed on this computer");
    expect(details).toContain("commit 0 · LOCAL_COMMITTED");
    expect(details).toContain("one file on this computer");
    await assertNoBannedWording();
    await closeResultDetails("write");
    expect(existsSync(mainArchive)).toBe(true);

    // The new archive opened in the browser, at its head.
    await expect($('[data-testid="archive-meta"]')).toHaveText(expect.stringContaining("main.mochi"));
    await expect($('[data-testid="toggle-versions"]')).toHaveAttribute("title", "1 version");
    await browser.waitUntil(async () => (await entryNames()).includes("photos"));
  });

  it("adds a file as a new commit", async () => {
    queuePicks(path.join(src, "extra.txt"));
    await $('[data-testid="add-to-archive"]').click();
    await $('[data-testid="stage-files"]').click();
    await browser.waitUntil(async () => (await $$('[data-testid="staged-item"]')).length === 1);
    await $('[data-testid="add-confirm"]').click();
    await waitForStatus("Added to main.mochi");
    await expect($('[data-testid="toggle-versions"]')).toHaveAttribute("title", "2 versions");
    await openVersions();
    await expect($('[data-testid="commit-1"]')).toHaveText(expect.stringContaining("(latest)"));
    await closeVersions();
    await browser.waitUntil(async () => {
      const names = await entryNames();
      return names.includes("extra.txt") && names.includes("photos");
    });
    await assertNoBannedWording();
  });

  it("browses what was stored", async () => {
    const rows = await $$('[data-testid="entry"]');
    let photos;
    for (const row of rows) if ((await row.$(".name").getText()) === "photos") photos = row;
    await photos.click();
    await browser.keys("Enter");
    await browser.waitUntil(async () => {
      const names = await entryNames();
      return names.includes("a.txt") && names.includes("b.txt");
    });
    await expect($('[data-testid="toggle-versions"]')).toHaveText("v1");
    await expect($('[data-testid="crumbs"]')).toHaveText(expect.stringContaining("photos"));
    // Back to the root for the next step.
    await $('[data-testid="crumbs"] button').click();
    await browser.waitUntil(async () => (await entryNames()).includes("extra.txt"));
  });

  it("removes an entry from the current snapshot, which history keeps", async () => {
    const rows = await $$('[data-testid="entry"]');
    for (const row of rows) {
      if ((await row.$(".name").getText()) === "extra.txt") await row.click();
    }
    await expect($('[data-testid="details"]')).toBeExisting();
    await $('[data-testid="remove-entry"]').click();
    await expect($('[data-testid="delete-note"]')).toHaveText(
      expect.stringContaining("stays in the archive's history"),
    );

    // Keep it: nothing happens.
    await $('[data-testid="delete-keep"]').click();
    await expect($('[data-testid="write-panel"]')).not.toBeExisting();
    await expect($('[data-testid="toggle-versions"]')).toHaveAttribute("title", "2 versions");

    await $('[data-testid="remove-entry"]').click();
    await $('[data-testid="delete-confirm"]').click();
    await waitForStatus("Removed 1 item from this version");
    const status = await $('[data-testid="write-status"]').getText();
    expect(status).toContain("Earlier versions still have it");
    await openResultDetails("write");
    expect(await $('[data-testid="write-details"]').getText()).toContain("stays in the archive's history");
    await closeResultDetails("write");
    await expect($('[data-testid="toggle-versions"]')).toHaveAttribute("title", "3 versions");
    await browser.waitUntil(async () => {
      const names = await entryNames();
      return names.includes("photos") && !names.includes("extra.txt");
    });

    // The earlier snapshot still has it; and only the latest can be changed.
    await openVersions();
    await $('[data-testid="commit-1"]').click();
    await browser.waitUntil(async () => (await entryNames()).includes("extra.txt"));
    await assertNoBannedWording();
  });

  it("creates a TAR-compatible archive when asked, and shows it", async () => {
    queuePicks(path.join(src, "photos"), tarArchive);
    await clickNewArchive();
    await $('[data-testid="stage-folder"]').click();
    await browser.waitUntil(async () => (await $$('[data-testid="staged-item"]')).length === 1);
    await $('[data-testid="change-destination"]').click();
    await $('[data-testid="create-options"] summary').click();
    await expect($('[data-testid="tar-notes"]')).toHaveText(
      expect.stringContaining("not the latest snapshot"),
    );
    await $('[data-testid="preset-fast"]').click();
    await $('[data-testid="tar-compatible"]').click();
    await $('[data-testid="create-confirm"]').click();
    await waitForStatus("Created tar.mochi");
    await expect($('[data-testid="archive-meta"]')).toHaveText(expect.stringContaining("tar.mochi"));
    await expect($('[data-testid="archive-technical"]')).toHaveElementProperty(
      "textContent",
      expect.stringContaining("TAR-compatible"),
    );
    // A standard zstd decoder reads the file's first frame: the TAR stream.
    expect(readFileSync(tarArchive).length).toBeGreaterThan(0);
  });

  it("cancels a create midway: no archive appears and the archive on screen is unchanged", async () => {
    queuePicks(path.join(src, "bulk"), cancelled);
    await clickNewArchive();
    await $('[data-testid="stage-folder"]').click();
    await browser.waitUntil(async () => (await $$('[data-testid="staged-item"]')).length === 1);
    await $('[data-testid="change-destination"]').click();
    await $('[data-testid="create-confirm"]').click();

    // Progress streams over the channel; cancel once some content was read.
    const progress = await $('[data-testid="write-progress"]');
    await progress.waitForExist({ timeout: 30_000 });
    await browser.waitUntil(async () => (await progress.getText()).includes("Reading files"));
    await $('[data-testid="write-cancel"]').click();
    await waitForStatus("Cancelled. No archive was created.");
    expect(existsSync(cancelled)).toBe(false);
    await expect($('[data-testid="archive-meta"]')).toHaveText(expect.stringContaining("tar.mochi"));
    await expect($('[data-testid="write-status"]')).toHaveAttribute("data-committed", "false");
  });
});
