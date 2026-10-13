// Plan D3 on the real app over real IPC: extract all, extract the selected
// entry, a collision (listed before anything is written, skipped, never
// overwritten), hostile names (text only), and cancel. WebDriver cannot drive
// a native dialog, so the `e2e` build takes the archive and the folders from
// MOCHI_E2E_PICK_FILE, in order; this spec writes that file before each
// click. The archives are the D1 fixtures (wdio.conf.js): browse.mochi (the
// scripted history, hostile names) and large.mochi (100,000 entries, so an
// extraction paced at MOCHI_E2E_PACE_MS per entry can be cancelled).
//
// Hostile names differ by platform on purpose: Windows cannot hold `<`, `>`,
// `"`, `:` or control characters in a name, so there the same entries are
// reported NAME_UNSUPPORTED instead of being extracted. Either way the name is
// shown as text and the app never writes outside the chosen folder.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { $, $$, expect } from "@wdio/globals";

// Set by wdio.conf.js (the d1_browse_fixtures directory).
const fixtures = process.env.MOCHI_E2E_FIXTURES;
const pickFile = process.env.MOCHI_E2E_PICK_FILE;
const queuePicks = (...paths) => writeFileSync(pickFile, paths.join("\n"));

const windows = process.platform === "win32";
const HOSTILE_ROOT = "<img src=x onerror=alert(1)>";

const root = mkdtempSync(path.join(os.tmpdir(), "mochi-d3-"));
const dir = (name) => {
  const d = path.join(root, name);
  mkdirSync(d, { recursive: true });
  return d;
};
const allDir = dir("all");
const selectedDir = dir("selected");
const crowdedDir = dir("crowded");
const emptyDir = dir("empty");
const cancelDir = dir("cancel");

const entryNames = () =>
  browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="entry"] .name'), (e) => e.textContent),
  );

const countElements = (selector) =>
  browser.execute((s) => document.querySelectorAll(s).length, selector);

const waitForState = (state) =>
  browser.waitUntil(
    async () => {
      const s = await $('[data-testid="extract-status"]');
      return (await s.isExisting()) && (await s.getAttribute("data-state")) === state;
    },
    { timeout: 120_000, timeoutMsg: `the extraction did not reach ${state}` },
  );

const BANNED = ["backed up", "backup", "safe", "preserved", "secure"];
const assertNoBannedWording = async () => {
  const text = (await $("body").getText()).toLowerCase();
  for (const word of BANNED) expect(text).not.toContain(word);
};

async function selectEntry(name) {
  await browser.waitUntil(async () => (await entryNames()).includes(name), {
    timeoutMsg: `no entry ${name}`,
  });
  for (const row of await $$('[data-testid="entry"]')) {
    if ((await row.$(".name").getText()) === name) {
      await row.click();
      await $('[data-testid="details"]').waitForExist();
      return;
    }
  }
  throw new Error(`no entry ${name}`);
}

// The panel opens below the fold of the 640 px test window: scroll to a
// control before clicking it (the app also scrolls the panel into view).
async function press(testId) {
  const el = await $(`[data-testid="${testId}"]`);
  await el.scrollIntoView({ block: "center" });
  await el.click();
}

const listed = async (testId) =>
  browser.execute(
    (id) => Array.from(document.querySelectorAll(`[data-testid="${id}"]`), (e) => e.textContent),
    testId,
  );

// The fixture records mode 0644 for the folder `hostile` (no search bit), and
// the engine restores recorded modes. A non-root user cannot open anything
// inside it until it is opened up, so check the mode, then chmod.
function openUp(folder) {
  if (windows) return;
  expect(statSync(folder).mode & 0o777).toBe(0o644);
  chmodSync(folder, 0o755);
}

const size = (...p) => statSync(path.join(...p)).size;

describe("extract", () => {
  before(async () => {
    queuePicks(path.join(fixtures, "browse.mochi"));
    await $('[data-testid="open-archive"]').click();
    await $('[data-testid="archive-meta"]').waitForExist({ timeout: 60_000 });
    await expect($('[data-testid="archive-meta"]')).toHaveText(expect.stringContaining("browse.mochi"));
  });

  it("extracts all of the snapshot on screen into the folder chosen in the native dialog", async () => {
    queuePicks(allDir);
    await press("extract-all");
    await $('[data-testid="extract-panel"]').waitForExist({ timeout: 60_000 });
    await expect($('[data-testid="extract-destination"]')).toHaveText(allDir);
    await expect($('[data-testid="extract-scope"]')).toHaveText(
      expect.stringContaining("The whole of commit 3"),
    );
    await expect($('[data-testid="extract-panel"]')).toHaveText(
      expect.stringContaining("Extract into a folder only you can modify."),
    );
    // Nothing is written until the user confirms.
    expect(readdirSync(allDir)).toEqual([]);
    if (!windows) await expect($('[data-testid="extract-no-conflicts"]')).toBeExisting();

    await press("extract-confirm");
    await waitForState("completed");
    const status = await $('[data-testid="extract-status"]').getText();
    expect(status).toContain("to " + allDir);
    expect(status).toContain("Extracting is not a verification of the archive");
    await assertNoBannedWording();

    // The head of the scripted history, byte for byte in size.
    expect(size(allDir, "docs", "a.txt")).toBe(130);
    expect(size(allDir, "docs", "empty")).toBe(0);
    expect(size(allDir, "big")).toBe(1000);
    expect(existsSync(path.join(allDir, "docs", "c.bin"))).toBe(false); // deleted at commit 2
    openUp(path.join(allDir, "hostile"));
    expect(readFileSync(path.join(allDir, "hostile", "&lt;b&gt;entity"), "utf8")).toBe("&lt;b&gt;entity");
    expect(readdirSync(allDir).some((n) => n.includes(".mochi-restore."))).toBe(false);

    if (windows) {
      // Names Windows cannot hold are reported, not renamed or dropped silently.
      const items = await listed("extract-not-extracted-item");
      expect(items.some((t) => t.includes(HOSTILE_ROOT) && t.includes("NAME_UNSUPPORTED"))).toBe(true);
      await expect($('[data-testid="extract-status"]')).toHaveAttribute("data-complete", "false");
      expect(existsSync(path.join(allDir, HOSTILE_ROOT))).toBe(false);
    } else {
      await expect($('[data-testid="extract-status"]')).toHaveAttribute("data-complete", "true");
      expect(readFileSync(path.join(allDir, HOSTILE_ROOT), "utf8")).toBe("hostile name, plain content");
    }
    // Archive text is text: nothing was injected into the page.
    expect(await countElements("img")).toBe(0);
    expect(await countElements("svg")).toBe(0);
  });

  it("extracts the selected entry with the folders above it, and only that", async () => {
    await selectEntry("docs");
    queuePicks(selectedDir);
    await press("extract-selected");
    await $('[data-testid="extract-panel"]').waitForExist({ timeout: 60_000 });
    await expect($('[data-testid="extract-scope"]')).toHaveText(expect.stringContaining("docs from commit 3"));
    await press("extract-confirm");
    await waitForState("completed");
    expect(readdirSync(selectedDir)).toEqual(["docs"]);
    expect(size(selectedDir, "docs", "a.txt")).toBe(130);
    expect(readdirSync(path.join(selectedDir, "docs")).sort()).toEqual(["a.txt", "empty"]);
    await expect($('[data-testid="extract-status"]')).toHaveAttribute("data-complete", "true");
  });

  it("lists collisions before writing, skips them on request, and overwrites nothing", async () => {
    mkdirSync(path.join(crowdedDir, "docs"), { recursive: true });
    writeFileSync(path.join(crowdedDir, "docs", "keep.txt"), "keep");
    writeFileSync(path.join(crowdedDir, "big"), "mine");
    if (!windows) writeFileSync(path.join(crowdedDir, HOSTILE_ROOT), "mine too");
    const before = readdirSync(crowdedDir).sort();

    // Commit 3 again from the top: the snapshot on screen is unchanged.
    queuePicks(crowdedDir);
    await press("extract-all");
    await $('[data-testid="extract-conflicts"]').waitForExist({ timeout: 60_000 });
    const conflicts = await listed("extract-conflict");
    const has = (name, code) => conflicts.some((t) => t.includes(name) && t.includes(code));
    expect(has("big", "NAME_COLLISION")).toBe(true);
    expect(has("docs", "NAME_COLLISION")).toBe(true);
    expect(has(HOSTILE_ROOT, windows ? "NAME_UNSUPPORTED" : "NAME_COLLISION")).toBe(true);
    await expect($('[data-testid="extract-conflict-note"]')).toHaveText(
      expect.stringContaining("Nothing is overwritten and no name is changed"),
    );
    await expect($('[data-testid="extract-not-offered"]')).toHaveText(
      expect.stringContaining("keeping both under a new name, is not available yet"),
    );
    // Listing the conflicts wrote nothing.
    expect(readdirSync(crowdedDir).sort()).toEqual(before);
    expect(await countElements("img")).toBe(0);

    // A different folder has no conflict; going back to the first has them again.
    queuePicks(emptyDir);
    await press("extract-change-folder");
    await $('[data-testid="extract-no-conflicts"]').waitForExist({ timeout: 60_000 });
    await expect($('[data-testid="extract-destination"]')).toHaveText(emptyDir);
    queuePicks(crowdedDir);
    await press("extract-change-folder");
    await $('[data-testid="extract-conflicts"]').waitForExist({ timeout: 60_000 });

    await expect($('[data-testid="extract-confirm"]')).toHaveText("Extract the rest, skipping these");
    await press("extract-confirm");
    await waitForState("completed");

    // Existing bytes are untouched; the skipped folder's subtree is absent.
    expect(readFileSync(path.join(crowdedDir, "big"), "utf8")).toBe("mine");
    expect(readFileSync(path.join(crowdedDir, "docs", "keep.txt"), "utf8")).toBe("keep");
    expect(existsSync(path.join(crowdedDir, "docs", "a.txt"))).toBe(false);
    if (!windows) {
      expect(readFileSync(path.join(crowdedDir, HOSTILE_ROOT), "utf8")).toBe("mine too");
    }
    // The rest was extracted.
    openUp(path.join(crowdedDir, "hostile"));
    expect(size(crowdedDir, "hostile", "&lt;b&gt;entity")).toBe("&lt;b&gt;entity".length);

    const status = await $('[data-testid="extract-status"]');
    await expect(status).toHaveAttribute("data-complete", "false");
    const items = await listed("extract-not-extracted-item");
    expect(items.some((t) => t.startsWith("big") && t.includes("NAME_COLLISION"))).toBe(true);
    expect(items.some((t) => t.startsWith("docs/a.txt") || t.includes("docs/a.txt"))).toBe(true);
    expect(items.some((t) => t.includes(HOSTILE_ROOT))).toBe(true);
    await assertNoBannedWording();
    expect(await countElements("img")).toBe(0);
    expect(await countElements("svg")).toBe(0);
  });

  it("cancels an extraction midway: files already extracted stay, none is partial, none is temporary", async () => {
    queuePicks(path.join(fixtures, "large.mochi"));
    await $('[data-testid="open-archive"]').click();
    await browser.waitUntil(
      async () => (await $('[data-testid="archive-meta"]').getText()).includes("large.mochi"),
      { timeout: 60_000 },
    );
    queuePicks(cancelDir);
    await press("extract-all");
    await $('[data-testid="extract-panel"]').waitForExist({ timeout: 120_000 });
    await press("extract-confirm");

    // 100,000 entries at MOCHI_E2E_PACE_MS each: ample time to cancel.
    const progress = await $('[data-testid="extract-progress"]');
    await progress.waitForExist({ timeout: 60_000 });
    await browser.waitUntil(
      async () => {
        const m = /Extracting: (\d+) of/.exec(await progress.getText());
        return m !== null && Number(m[1]) >= 3;
      },
      { timeout: 60_000, timeoutMsg: "the extraction never reported progress" },
    );
    await press("extract-cancel");
    await waitForState("cancelled");
    const status = await $('[data-testid="extract-status"]').getText();
    expect(status).toContain("Cancelled");
    expect(status).toContain("each one complete");
    await expect($('[data-testid="extract-status"]')).toHaveAttribute("data-complete", "false");

    // The last entry in path order was never reached.
    expect(existsSync(path.join(cancelDir, "readme.txt"))).toBe(false);
    const many = path.join(cancelDir, "many");
    const names = readdirSync(many);
    expect(names.length).toBeGreaterThan(0);
    expect(names.length).toBeLessThan(100_000);
    expect(names.some((n) => n.includes(".mochi-restore."))).toBe(false);
    // Every file that is there is a whole (empty) file under its own name.
    for (const n of names.slice(0, 50)) expect(statSync(path.join(many, n)).size).toBe(0);
    await expect($('[data-testid="extract-all"]')).toBeEnabled();
    await assertNoBannedWording();
  });
});
