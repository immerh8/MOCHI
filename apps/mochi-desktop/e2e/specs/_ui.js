// Shared steps for the specs: the window's panes and menus are closed until a person opens them
// (toolbar Info, the path bar's versions, the toolbar's More menu), so a spec that reads or clicks
// something inside one opens it the way a person would. Not a spec itself (wdio runs *.e2e.js).
import { $ } from "@wdio/globals";

async function expand(testId) {
  const button = await $(`[data-testid="${testId}"]`);
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
}

async function collapse(testId) {
  const button = await $(`[data-testid="${testId}"]`);
  if ((await button.getAttribute("aria-expanded")) === "true") await button.click();
}

/**
 * The Details panel of a finished create, add, remove, or extract (`write`, `extract`; `quick` in
 * the compact window). A side panel over the window's right edge: close it with its own Close
 * button before clicking in the window, since it covers the result's buttons while it is open.
 */
export async function openResultDetails(prefix) {
  await expand(`${prefix}-details-toggle`);
  // The panel renders on the next frame: wait until it shows before a spec reads its text.
  await $(`[data-testid="${prefix}-details"]`).waitForDisplayed({ timeoutMsg: `${prefix} Details did not open` });
}
export async function closeResultDetails(prefix) {
  const button = await $(`[data-testid="${prefix}-details-toggle"]`);
  if ((await button.getAttribute("aria-expanded")) !== "true") return;
  const close = await $(`[data-testid="${prefix}-details-close"]`);
  if (await close.isExisting()) await close.click();
  else await button.click();
  await $(`[data-testid="${prefix}-details"]`).waitForDisplayed({ reverse: true, timeoutMsg: `${prefix} Details did not close` });
}

/** The Info panel (entry details; for a foreign archive, what the app says about the format). */
export const openInfo = () => expand("toolbar-info");
export const closeInfo = () => collapse("toolbar-info");

/** The version list under the archive's name. Close it again before clicking in the list. */
export const openVersions = () => expand("toggle-versions");
export const closeVersions = () => collapse("toggle-versions");

/** The More menu; choosing an item closes it. */
export const openMore = () => expand("toolbar-more");

/** The Help panel (keyboard keys, what an archive is not, the user guide). */
export const openHelp = () => expand("toolbar-help");
export const closeHelp = () => collapse("toolbar-help");

/** Start a new archive: the start screen's button, or More > New archive when an archive is open. */
export async function clickNewArchive() {
  if (await $('[data-testid="start-screen"]').isExisting()) {
    await $('[data-testid="start-create"]').click();
    return;
  }
  await openMore();
  await $('[data-testid="new-archive"]').click();
}
