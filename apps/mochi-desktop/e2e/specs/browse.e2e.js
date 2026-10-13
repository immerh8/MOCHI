// Plan D1 exit, on the real app over real IPC: browse a snapshot, its
// history, and a 100,000-entry folder without loading it whole into the
// webview; archive names stay text (spec §23.3 #9). The archives come from
// the d1_browse_fixtures example (wdio.conf.js): browse.mochi on the first
// "Open archive" click, large.mochi on the second.
import { $, $$, expect } from "@wdio/globals";

const countElements = (selector) =>
  browser.execute((s) => document.querySelectorAll(s).length, selector);

const entryNames = () =>
  browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="entry"] .name'), (e) => e.textContent),
  );

async function openNext() {
  await $('[data-testid="open-archive"]').click();
  await $('[data-testid="archive-meta"]').waitForExist({ timeout: 60_000 });
}

async function enterFolder(name) {
  await browser.waitUntil(async () => (await entryNames()).includes(name), {
    timeoutMsg: `no entry ${name}`,
  });
  const rows = await $$('[data-testid="entry"]');
  for (const row of rows) {
    if ((await row.$(".name").getText()) === name) {
      await row.click();
      await browser.keys("Enter");
      return;
    }
  }
  throw new Error(`no entry ${name}`);
}

describe("archive browser", () => {
  it("opens an archive and shows its history and hostile names as text", async () => {
    await openNext();
    await expect($('[data-testid="archive-meta"]')).toHaveText(expect.stringContaining("browse.mochi"));
    await expect($('[data-testid="archive-meta"]')).toHaveText(expect.stringContaining("4 commits"));
    await expect($('[data-testid="commit-3"]')).toHaveText(expect.stringContaining("(head)"));

    // Root of the head: the scripted history's hostile name, inert.
    await browser.waitUntil(async () => (await entryNames()).includes("<img src=x onerror=alert(1)>"), {
      timeoutMsg: "the hostile name is not listed as text",
    });
    await enterFolder("hostile");
    await expect($('[data-testid="crumbs"]')).toHaveText("Commit 3 / hostile");
    await browser.waitUntil(async () => (await entryNames()).length === 6);
    const names = await entryNames();
    for (const n of ["<script>alert(1)", '"><svg onload=alert(1)>', "javascript:alert(1)", "&lt;b&gt;entity"]) {
      expect(names).toContain(n);
    }
    // Control and bidi characters arrive escaped, and are marked so.
    expect(names).toContain("esc\\u{1b}[31mred");
    expect(names).toContain("rtl\\u{202e}gpj.exe");
    expect(await countElements('[data-testid="entry"] .escaped')).toBe(2);

    expect(await countElements("img")).toBe(0);
    expect(await countElements("svg")).toBe(0);
    // No script element came from a name. (Counting all scripts does not
    // work: WebView2 under msedgedriver adds one of its own on Windows.)
    expect(
      await browser.execute(
        () =>
          Array.from(document.scripts).filter((s) => `${s.src} ${s.textContent}`.includes("alert(1)"))
            .length,
      ),
    ).toBe(0);
    expect(await countElements("a[href]")).toBe(0);

    // Details of one entry.
    const rows = await $$('[data-testid="entry"]');
    await rows[0].click();
    await expect($('[data-testid="details"]')).toHaveText(expect.stringContaining("rw-r--r-- (0644)"));
  });

  it("switches snapshots from the timeline", async () => {
    await $('[data-testid="commit-0"]').click();
    await expect($('[data-testid="crumbs"]')).toHaveText("Commit 0");
    await browser.waitUntil(async () => (await entryNames()).includes("docs"));
    // `hostile/` arrived in commit 3; commit 0 does not have it.
    expect(await entryNames()).not.toContain("hostile");
    await expect($('[data-testid="commit-0"]')).toHaveAttribute("aria-current", "true");
  });

  it("pages a 100,000-entry folder and keeps only a window of rows in the DOM", async () => {
    await $('[data-testid="close-archive"]').click();
    await expect($('[data-testid="browse-empty"]')).toBeExisting();
    await openNext();
    await expect($('[data-testid="archive-meta"]')).toHaveText(expect.stringContaining("large.mochi"));
    await enterFolder("many");
    await expect($('[data-testid="entry-count"]')).toHaveText(
      expect.stringContaining("100,000 entries in this folder"),
    );
    await browser.waitUntil(async () => (await entryNames()).includes("f000000"));
    expect(await countElements('[data-testid="entries"] [role="listitem"]')).toBeLessThan(150);

    // Jump to the end: the last rows load; the first are gone from the DOM.
    await browser.execute(() => {
      const list = document.querySelector('[data-testid="entries"]');
      list.scrollTop = list.scrollHeight;
      list.dispatchEvent(new Event("scroll"));
    });
    await browser.waitUntil(async () => (await entryNames()).includes("f099999"), {
      timeoutMsg: "the last entry did not load",
    });
    expect(await entryNames()).not.toContain("f000000");
    expect(await countElements('[data-testid="entries"] [role="listitem"]')).toBeLessThan(150);
  });
});
