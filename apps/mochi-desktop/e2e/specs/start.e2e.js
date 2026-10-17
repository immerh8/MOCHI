// D10 on the real app: the start screen. A fresh window offers three plain
// actions and a quiet note; the technical tools are a closed disclosure;
// Open archive and the recent list work; Extract archive goes straight to a
// plan into a new folder next to the archive. WebDriver cannot drop files from
// a file manager or drive a native dialog: the `e2e` build takes the archive
// from MOCHI_E2E_PICK_FILE, and dropping is covered by the Rust drop tests and
// the UI tests (and the release checklist).
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { $, $$, expect } from "@wdio/globals";

const fixtures = process.env.MOCHI_E2E_FIXTURES;
const pickFile = process.env.MOCHI_E2E_PICK_FILE;
const queuePicks = (...paths) => writeFileSync(pickFile, paths.join("\n"));

const root = mkdtempSync(path.join(os.tmpdir(), "mochi-d10-"));
const archive = path.join(root, "trip.mochi");
copyFileSync(path.join(fixtures, "browse.mochi"), archive);

const BANNED = ["backed up", "backup", "safe", "preserved", "secure"];

describe("the start screen", () => {
  it("offers three plain actions, a quiet note, and keeps the technical tools closed", async () => {
    await $('[data-testid="start-screen"]').waitForExist({ timeout: 60_000 });
    for (const id of ["start-create", "open-archive", "start-extract"]) {
      await expect($(`[data-testid="${id}"]`)).toBeDisplayed();
    }
    await expect($('[data-testid="start-note"]')).toHaveText(expect.stringContaining("not a second copy"));
    await expect($('[data-testid="advanced"]')).not.toHaveAttribute("open");
    // The start screen itself (the closed Advanced area is not part of it; some
    // engines report a closed disclosure's text, and it names the tools plainly).
    const text = (await $('[data-testid="start-screen"]').getText()).toLowerCase();
    for (const word of BANNED) expect(text).not.toContain(word);
    // None of the jargon is on the first screen.
    for (const word of ["snapshot", "commit", "verification", "retention"]) {
      expect(text).not.toContain(word);
    }
  });

  it("opens an archive and then lists it among the recent ones", async () => {
    queuePicks(archive);
    await $('[data-testid="open-archive"]').click();
    await $('[data-testid="archive-meta"]').waitForExist({ timeout: 60_000 });
    await expect($('[data-testid="archive-meta"]')).toHaveText(expect.stringContaining("trip.mochi"));
    await $('[data-testid="close-archive"]').click();
    await $('[data-testid="start-screen"]').waitForExist();
    // The list is kept across app runs (and earlier specs opened archives), newest first.
    await browser.waitUntil(
      async () => (await $$('[data-testid="recent-open"]')).length > 0 && (await $('[data-testid="recent-open"]').getText()) === "trip.mochi",
      { timeoutMsg: "the archive was not listed first among the recent ones" },
    );
  });

  it("opens a recent archive without a dialog", async () => {
    await $('[data-testid="recent-open"]').click();
    await $('[data-testid="archive-meta"]').waitForExist({ timeout: 60_000 });
    await expect($('[data-testid="archive-meta"]')).toHaveText(expect.stringContaining("trip.mochi"));
    await $('[data-testid="close-archive"]').click();
    await $('[data-testid="start-screen"]').waitForExist();
  });

  it("Extract archive: choose an archive, then a plan into a new folder next to it", async () => {
    queuePicks(archive);
    await $('[data-testid="start-extract"]').click();
    const panel = await $('[data-testid="extract-panel"]');
    await panel.waitForExist({ timeout: 60_000 });
    const made = path.join(root, "trip");
    await expect($('[data-testid="extract-destination"]')).toHaveText(made);
    expect(existsSync(made)).toBe(true);
    // Nothing is extracted until the user says so; closing tidies the empty folder.
    await $('[data-testid="extract-close"]').click();
    await browser.waitUntil(() => !existsSync(made), { timeoutMsg: "the empty new folder stayed" });
  });

  it("Clear this list empties the recent archives", async () => {
    await $('[data-testid="close-archive"]').click();
    await $('[data-testid="start-screen"]').waitForExist();
    await $('[data-testid="recent-forget"]').click();
    await browser.waitUntil(async () => !(await $('[data-testid="recent"]').isExisting()), {
      timeoutMsg: "the recent list stayed",
    });
  });
});
