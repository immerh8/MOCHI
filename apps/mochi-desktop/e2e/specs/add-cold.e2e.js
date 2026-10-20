// "Add to archive..." from Explorer on a COLD start (owner decision 2026-10-20): the app is not
// running, the shell starts it with `--add -- a b c`, and the first thing on screen is the small
// form, not the main window. wdio.conf.js starts this spec's app with those arguments (its own
// capability), so the form is what the session finds. Nothing is written until OK; the main
// window is never created for this verb.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { $, browser, expect } from "@wdio/globals";

const dir = process.env.MOCHI_E2E_COLD_DIR;

describe("Add to archive... on a cold start", () => {
  it("shows the form for the whole selection in a compact window, and no main window", async () => {
    await $('[data-testid="quick-form"]').waitForExist({ timeout: 60_000 });
    // One window only: this verb never opens the main window.
    expect((await browser.getWindowHandles()).length).toBe(1);
    await expect($('[data-testid="start-screen"]')).not.toExist();
    await expect($('[data-testid="toolbar-more"]')).not.toExist();
    await expect($('[data-testid="quick-title"]')).toHaveText(expect.stringContaining("and 2 more"));
    await expect($('[data-testid="quick-name"]')).toHaveValue("trip.mochi");
    await expect($('[data-testid="quick-folder"]')).toHaveText(expect.stringContaining(dir));
    await expect($('[data-testid="quick-format"]')).toHaveValue("mochi");
    // Nothing was written to make the form.
    expect(readdirSync(dir).sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  it("OK writes the archive in the chosen format and reports what was written", async () => {
    await $('[data-testid="quick-format"]').selectByAttribute("value", "zip");
    await expect($('[data-testid="quick-name"]')).toHaveValue("trip.zip");
    await $('[data-testid="quick-ok"]').click();
    await $('[data-testid="quick-result"]').waitForExist({ timeout: 60_000 });
    await expect($('[data-testid="quick-result"]')).toHaveText(expect.stringContaining("Wrote 3 files"));
    const zip = path.join(dir, "trip.zip");
    expect(existsSync(zip)).toBe(true);
    expect(readFileSync(zip).subarray(0, 2).toString("latin1")).toBe("PK");
    expect(existsSync(path.join(dir, "trip.mochi"))).toBe(false);
    expect(readdirSync(dir).filter((n) => n.endsWith(".part"))).toEqual([]);
    const text = (await $('[data-testid="quick-result"]').getText()).toLowerCase();
    for (const word of ["backed up", "safe", "preserved", "committed"]) expect(text).not.toContain(word);
  });
});
