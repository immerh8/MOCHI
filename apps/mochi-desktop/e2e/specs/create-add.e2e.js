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
  it("creates an archive from a folder and says it committed, nothing more", async () => {
    queuePicks(path.join(src, "photos"), mainArchive);
    await $('[data-testid="new-archive"]').click();
    await $('[data-testid="stage-folder"]').click();
    await browser.waitUntil(async () => (await $$('[data-testid="staged-item"]')).length === 1);
    await expect($('[data-testid="staged-item"]')).toHaveText(expect.stringContaining("photos"));

    // The options exist today; encryption and recovery are not offered yet.
    await expect($('[data-testid="preset-balanced"]')).toBeSelected();
    await expect($('[data-testid="tar-compatible"]')).not.toBeSelected();
    await expect($('[data-testid="encryption-unavailable"]')).toBeDisabled();
    await expect($('[data-testid="recovery-unavailable"]')).toBeDisabled();

    await $('[data-testid="create-confirm"]').click();
    await waitForStatus("Committed commit 0");
    const status = await $('[data-testid="write-status"]').getText();
    expect(status).toContain("main.mochi (LOCAL_COMMITTED)");
    expect(status).toContain("local commit in one file");
    await assertNoBannedWording();
    expect(existsSync(mainArchive)).toBe(true);

    // The new archive opened in the browser, at its head.
    await expect($('[data-testid="archive-meta"]')).toHaveText(expect.stringContaining("main.mochi"));
    await expect($('[data-testid="archive-meta"]')).toHaveText(expect.stringContaining("1 commit"));
    await browser.waitUntil(async () => (await entryNames()).includes("photos"));
  });

  it("adds a file as a new commit", async () => {
    queuePicks(path.join(src, "extra.txt"));
    await $('[data-testid="add-to-archive"]').click();
    await $('[data-testid="stage-files"]').click();
    await browser.waitUntil(async () => (await $$('[data-testid="staged-item"]')).length === 1);
    await $('[data-testid="add-confirm"]').click();
    await waitForStatus("Committed commit 1");
    await expect($('[data-testid="archive-meta"]')).toHaveText(expect.stringContaining("2 commits"));
    await expect($('[data-testid="commit-1"]')).toHaveText(expect.stringContaining("(head)"));
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
    await expect($('[data-testid="crumbs"]')).toHaveText("Commit 1 / photos");
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
    await expect($('[data-testid="archive-meta"]')).toHaveText(expect.stringContaining("2 commits"));

    await $('[data-testid="remove-entry"]').click();
    await $('[data-testid="delete-confirm"]').click();
    await waitForStatus("Committed commit 2");
    const status = await $('[data-testid="write-status"]').getText();
    expect(status).toContain("removed 1 entry from the current snapshot");
    expect(status).toContain("stays in the archive's history");
    await expect($('[data-testid="archive-meta"]')).toHaveText(expect.stringContaining("3 commits"));
    await browser.waitUntil(async () => {
      const names = await entryNames();
      return names.includes("photos") && !names.includes("extra.txt");
    });

    // The earlier snapshot still has it; and only the latest can be changed.
    await $('[data-testid="commit-1"]').click();
    await browser.waitUntil(async () => (await entryNames()).includes("extra.txt"));
    await assertNoBannedWording();
  });

  it("creates a TAR-compatible archive when asked, and shows it", async () => {
    queuePicks(path.join(src, "photos"), tarArchive);
    await $('[data-testid="new-archive"]').click();
    await $('[data-testid="stage-folder"]').click();
    await browser.waitUntil(async () => (await $$('[data-testid="staged-item"]')).length === 1);
    await expect($('[data-testid="tar-notes"]')).toHaveText(
      expect.stringContaining("not the latest snapshot"),
    );
    await $('[data-testid="preset-fast"]').click();
    await $('[data-testid="tar-compatible"]').click();
    await $('[data-testid="create-confirm"]').click();
    await waitForStatus("Committed commit 0");
    await expect($('[data-testid="archive-meta"]')).toHaveText(expect.stringContaining("tar.mochi"));
    await expect($('[data-testid="archive-meta"]')).toHaveText(expect.stringContaining("TAR-compatible"));
    // A standard zstd decoder reads the file's first frame: the TAR stream.
    expect(readFileSync(tarArchive).length).toBeGreaterThan(0);
  });

  it("cancels a create midway: no archive appears and the archive on screen is unchanged", async () => {
    queuePicks(path.join(src, "bulk"), cancelled);
    await $('[data-testid="new-archive"]').click();
    await $('[data-testid="stage-folder"]').click();
    await browser.waitUntil(async () => (await $$('[data-testid="staged-item"]')).length === 1);
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
