import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import { App, outcomeText, SELF_TEST } from "./App";
import type { JobEvent, JobOutcome } from "./ipc/jobs";

/** Tauri's IPC internals as `mockIPC` installs them (untyped upstream). */
type Internals = { runCallback: (id: number, data: unknown) => void };
const internals = () =>
  (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;

/** A fake backend: records calls and lets the test push channel events. */
function fakeBackend(startResult: () => unknown = () => 7) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  let channel: Channel<JobEvent> | undefined;
  let index = 0;
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    // The Writer's start-up calls (D2) are tested in write/Writer.test.tsx.
    if (cmd === "staged_sources") return { items: [], destination: null };
    if (cmd === "watch_drops" || cmd === "watch_launches") return null;
    // The update settings (T13) are tested in update/Updates.test.tsx.
    if (cmd === "get_update_settings") {
      return {
        check_on_start: false,
        current_version: "0.1.0",
        install_mode: "manual",
        download_page: "https://github.com/immerh8/MOCHI/releases/latest",
        needs_admin_prompt: false,
      };
    }
    calls.push({ cmd, args: a });
    if (cmd === "start_job") {
      channel = a.onEvent as Channel<JobEvent>;
      return startResult();
    }
    if (cmd === "cancel_job") return true;
    throw new Error(`unexpected command ${cmd}`);
  });
  const emit = (message: JobEvent) => {
    if (!channel) throw new Error("no channel yet");
    const id = channel.id;
    act(() => {
      internals().runCallback(id, { index: index++, message });
    });
  };
  return { calls, emit };
}

afterEach(() => clearMocks());

test("start, see progress, cancel, and end in a clean cancelled state", async () => {
  const user = userEvent.setup();
  const backend = fakeBackend();
  render(<App />);
  expect(screen.getByTestId("status")).toHaveTextContent("Not started.");
  expect(screen.getByTestId("cancel")).toBeDisabled();

  await user.click(screen.getByTestId("start"));
  expect(backend.calls[0]?.cmd).toBe("start_job");
  expect(backend.calls[0]?.args.request).toEqual(SELF_TEST);
  expect(screen.getByTestId("start")).toBeDisabled();

  backend.emit({ event: "started", job_id: 7 });
  backend.emit({ event: "progress", job_id: 7, phase: "self_test", completed: 3, total: 50 });
  expect(screen.getByTestId("progress-text")).toHaveTextContent("Step 3 of 50");
  expect(screen.getByTestId("progress")).toHaveAttribute("value", "3");
  expect(screen.getByTestId("status")).toHaveTextContent("Running.");

  await user.click(screen.getByTestId("cancel"));
  expect(backend.calls[1]).toEqual({ cmd: "cancel_job", args: { jobId: 7 } });
  expect(screen.getByTestId("cancel")).toBeDisabled();
  expect(screen.getByTestId("progress-text")).toHaveTextContent("cancelling");

  backend.emit({ event: "finished", job_id: 7, outcome: { status: "cancelled" } });
  expect(screen.getByTestId("status")).toHaveAttribute("data-state", "finished");
  expect(screen.getByTestId("status")).toHaveTextContent(
    "Cancelled. The self-test stopped before finishing.",
  );
  expect(screen.queryByTestId("progress")).not.toBeInTheDocument();
  expect(screen.getByTestId("start")).toBeEnabled();
  expect(screen.getByTestId("cancel")).toBeDisabled();
});

test("a completed job says completed and nothing more", async () => {
  const user = userEvent.setup();
  const backend = fakeBackend();
  render(<App />);
  await user.click(screen.getByTestId("start"));
  backend.emit({ event: "started", job_id: 7 });
  backend.emit({
    event: "finished",
    job_id: 7,
    outcome: { status: "completed", summary: "self-test finished 50 steps" },
  });
  expect(screen.getByTestId("status")).toHaveTextContent(
    "Completed: self-test finished 50 steps.",
  );
});

test("a refused start shows the error code and leaves the screen usable", async () => {
  const user = userEvent.setup();
  fakeBackend(() => {
    throw { code: "INVALID_ARGUMENT", message: "self-test takes 1 to 1000 steps" };
  });
  render(<App />);
  await user.click(screen.getByTestId("start"));
  expect(await screen.findByText(/Could not start \(INVALID_ARGUMENT\)/)).toBeInTheDocument();
  expect(screen.getByTestId("start")).toBeEnabled();
});

test("strings from the backend render as text, never as HTML", async () => {
  const user = userEvent.setup();
  const backend = fakeBackend();
  const { container } = render(<App />);
  await user.click(screen.getByTestId("start"));
  const hostile = '<img src=x onerror="alert(1)">';
  backend.emit({
    event: "finished",
    job_id: 7,
    outcome: { status: "failed", code: "IO_ERROR", message: hostile },
  });
  expect(screen.getByTestId("status")).toHaveTextContent(hostile);
  expect(container.querySelector("img")).toBeNull();
});

test("outcome wording follows spec §23.3", () => {
  const outcomes: JobOutcome[] = [
    { status: "completed", summary: "s" },
    { status: "cancelled" },
    { status: "failed", code: "IO_ERROR", message: "m" },
    { status: "aborted", message: "m" },
  ];
  for (const o of outcomes) {
    const text = outcomeText(o).toLowerCase();
    for (const banned of ["backed up", "safe", "preserved", "pass", "verified"]) {
      expect(text).not.toContain(banned);
    }
  }
  expect(outcomeText({ status: "cancelled" })).toMatch(/before finishing/);
});
