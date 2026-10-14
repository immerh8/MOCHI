// Plan D7 accessibility, on the real app over real keys: the window can be
// operated with the keyboard alone. Nothing here clicks or focuses by script:
// each step is Tab, Shift+Tab, arrows, Space, or Enter sent through WebDriver,
// and what is asserted is where focus lands. Opening an archive uses the e2e
// build's scripted dialog (wdio.conf.js), as every other spec does.
import { $, expect } from "@wdio/globals";

const active = () =>
  browser.execute(() => {
    const el = document.activeElement;
    return {
      tag: el?.tagName ?? "",
      testid: el?.getAttribute?.("data-testid") ?? "",
      id: el?.id ?? "",
      text: (el?.textContent ?? "").trim().slice(0, 60),
      outlineStyle: el ? getComputedStyle(el).outlineStyle : "",
      outlineWidth: el ? getComputedStyle(el).outlineWidth : "",
    };
  });

/** Press Tab (or Shift+Tab) until focus is on `testid`; fail if it never gets there. */
async function tabTo(testid, { back = false, max = 160 } = {}) {
  for (let i = 0; i < max; i++) {
    await browser.keys(back ? ["Shift", "Tab"] : ["Tab"]);
    if ((await active()).testid === testid) return;
  }
  throw new Error(`Tab never reached ${testid} in ${max} presses`);
}

describe("keyboard-only use", () => {
  it("starts at the top of the page and the first stops are the section links", async () => {
    await $('[data-testid="browse-empty"]').waitForExist();
    await browser.keys(["Tab"]);
    const first = await active();
    expect(first.tag).toBe("A");
    expect(first.text).toBe("Archive");
    // The focus ring is drawn (the stylesheet never turns the outline off).
    expect(first.outlineStyle).not.toBe("none");
    expect(first.outlineWidth).toBe("3px");
  });

  it("a section link moves focus to that section's heading", async () => {
    // Walk the links with Tab until the one for the test and repair section.
    for (let i = 0; i < 12; i++) {
      const here = await active();
      if (here.text === "Test, health, and repair") break;
      await browser.keys(["Tab"]);
    }
    expect((await active()).text).toBe("Test, health, and repair");
    await browser.keys(["Enter"]);
    const now = await active();
    expect(now.id).toBe("check-heading");
    expect(now.tag).toBe("H2");
  });

  it("opens an archive from the keyboard and reaches the list with one Tab stop", async () => {
    await browser.execute(() => window.scrollTo(0, 0));
    await tabTo("open-archive", { back: true }).catch(() => tabTo("open-archive"));
    await browser.keys(["Enter"]);
    await $('[data-testid="archive-meta"]').waitForExist({ timeout: 60_000 });
    await $('[data-testid="entry"]').waitForExist();
    // The list is one tab stop (roving focus), however many rows it has.
    const stops = await browser.execute(
      () => document.querySelectorAll('[data-testid="entry"]:not([tabindex="-1"])').length,
    );
    expect(stops).toBe(1);
    await tabTo("entry");
    const first = await active();
    expect(first.testid).toBe("entry");
  });

  it("arrow keys move between rows, and Space selects without moving focus", async () => {
    const before = (await active()).text;
    await browser.keys(["ArrowDown"]);
    const after = await active();
    expect(after.testid).toBe("entry");
    expect(after.text).not.toBe(before);
    await browser.keys([" "]);
    await $('[data-testid="details"]').waitForExist();
    expect((await active()).text).toBe(after.text);
    await browser.keys(["ArrowUp"]);
    expect((await active()).text).toBe(before);
  });

  it("Enter on a folder opens it and puts focus in the new listing", async () => {
    // Folders are listed first: the first row is one.
    await browser.keys(["Home"]);
    const folder = await browser.execute(
      () => document.activeElement?.getAttribute("data-kind") ?? "",
    );
    expect(folder).toBe("directory");
    await browser.keys(["Enter"]);
    await browser.waitUntil(async () => (await $('[data-testid="crumbs"]').getText()).includes("/"), {
      timeoutMsg: "the folder did not open",
    });
    await browser.waitUntil(async () => (await active()).testid === "entry", {
      timeoutMsg: "focus did not land in the new listing",
    });
  });

  it("an opened panel takes focus, and Close gives it back to the button that opened it", async () => {
    await tabTo("new-archive", { back: true });
    await browser.keys(["Enter"]);
    await $('[data-testid="write-panel"]').waitForExist();
    const inPanel = await active();
    expect(inPanel.tag).toBe("H3");
    expect(inPanel.text).toBe("New archive");
    // Tab leaves the heading for the panel's controls: no trap, no skipped content.
    await browser.keys(["Tab"]);
    expect((await active()).testid).toBe("stage-files");
    await tabTo("write-close");
    await browser.keys(["Enter"]);
    await $('[data-testid="write-panel"]').waitForExist({ reverse: true });
    expect((await active()).testid).toBe("new-archive");
  });

  it("tests the open archive from the keyboard; the result is announced and focus stays put", async () => {
    await tabTo("check-use-open");
    await browser.keys(["Enter"]);
    await $('[data-testid="check-subject"]').waitForExist();
    await tabTo("check-test");
    await browser.keys(["Enter"]);
    await $('[data-testid="report"]').waitForExist({ timeout: 60_000 });
    // A result must not steal focus from the control the user pressed.
    expect((await active()).testid).toBe("check-test");
    // Status words are written out, not just coloured.
    const badges = await browser.execute(() =>
      Array.from(document.querySelectorAll('[data-testid="status-badge"]'), (b) => [
        b.getAttribute("data-status"),
        b.textContent,
      ]),
    );
    expect(badges.length).toBeGreaterThan(0);
    for (const [status, text] of badges) expect(text).toContain(status);
    // The live regions exist and are polite status regions.
    const regions = await browser.execute(() =>
      ["check-status", "report-exported", "write-status", "extract-status"].map((id) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        return [id, el?.getAttribute("role"), el?.getAttribute("aria-live")];
      }),
    );
    for (const [id, role, live] of regions) {
      expect([id, role, live]).toEqual([id, "status", "polite"]);
    }
  });

  it("the whole tab cycle has no trap: Tab reaches the end of the page and wraps", async () => {
    const seen = new Set();
    let wrapped = false;
    for (let i = 0; i < 400; i++) {
      await browser.keys(["Tab"]);
      const a = await active();
      const key = `${a.tag}|${a.testid}|${a.id}|${a.text}`;
      if (a.tag === "BODY" || (seen.has(key) && seen.size > 20)) {
        wrapped = true;
        break;
      }
      seen.add(key);
    }
    expect(wrapped).toBe(true);
    expect(seen.size).toBeGreaterThan(20);
  });
});
