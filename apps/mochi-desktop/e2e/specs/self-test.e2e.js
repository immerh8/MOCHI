// Plan D0 exit: "a sample job streams progress and cancels cleanly",
// on the real app over real IPC.
import { $, expect } from "@wdio/globals";

describe("job runner self-test", () => {
  it("streams progress, cancels, and ends in a clean cancelled state", async () => {
    const start = await $('[data-testid="start"]');
    const cancel = await $('[data-testid="cancel"]');
    const status = await $('[data-testid="status"]');

    await expect(status).toHaveText("Not started.");
    await start.click();

    // Progress arrives over the Channel: wait for a step past the first.
    const text = await $('[data-testid="progress-text"]');
    await text.waitForExist();
    await browser.waitUntil(
      async () => {
        const m = /Step (\d+) of 50/.exec(await text.getText());
        return m !== null && Number(m[1]) >= 3;
      },
      { timeoutMsg: "no progress past step 3" },
    );
    await expect(start).toBeDisabled();

    await cancel.click();
    await browser.waitUntil(
      async () => (await status.getAttribute("data-state")) === "finished",
      { timeoutMsg: "the job did not finish after cancel" },
    );
    await expect(status).toHaveText("Cancelled. The self-test stopped before finishing.");
    await expect($('[data-testid="progress"]')).not.toBeExisting();
    await expect(start).toBeEnabled();
    await expect(cancel).toBeDisabled();
  });

  it("can run again to completion after a cancel", async () => {
    const start = await $('[data-testid="start"]');
    const status = await $('[data-testid="status"]');
    await start.click();
    await browser.waitUntil(
      async () => (await status.getAttribute("data-state")) === "finished",
      { timeout: 30_000, timeoutMsg: "the job did not complete" },
    );
    await expect(status).toHaveText("Completed: self-test finished 50 steps.");
  });
});
