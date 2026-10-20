// Plan D6, owner decision 2026-10-16: the compact window of the shell's quick verbs. It hears
// events from Rust, asks for a passphrase once, and never names a path (spec §23.3 wording:
// a new archive is a local commit, never "backed up" or "safe").
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, expect, test } from "vitest";

import { resetQuickForTests, type QuickEvent } from "../ipc/quick";
import { QuickWindow } from "./QuickWindow";

type Internals = { runCallback: (id: number, data: unknown) => void };
const internals = () =>
  (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;

function backend() {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  let channel: Channel<QuickEvent> | undefined;
  let index = 0;
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
    if (cmd === "watch_quick") channel = (args as { onEvent: Channel<QuickEvent> }).onEvent;
    return null;
  });
  return {
    calls,
    send: (message: QuickEvent) => {
      if (!channel) throw new Error("the window never asked to hear the job");
      const id = channel.id;
      act(() => {
        internals().runCallback(id, { index: index++, message });
      });
    },
  };
}

const name = (text: string) => ({ text, verbatim: true });

beforeEach(() => resetQuickForTests());
afterEach(() => clearMocks());

test("an extraction shows its progress, then a plain result with Show in folder and Close", async () => {
  const b = backend();
  render(<QuickWindow />);
  b.send({ event: "started", action: "extract_here", subject: name("photos.mochi"), items: 1 });
  expect(await screen.findByTestId("quick-title")).toHaveTextContent("Extracting photos.mochi");
  b.send({ event: "progress", phase: "restore", completed: 3, total: 10 });
  expect(await screen.findByTestId("quick-progress-text")).toHaveTextContent("3");
  b.send({
    event: "done",
    action: "extract_here",
    name: name("Pictures"),
    location: name("/home/me/Pictures"),
    files: 3,
    directories: 1,
    bytes: 12,
    skipped: 0,
    note: null,
    status: null,
    durability_note: null,
  });
  const result = await screen.findByTestId("quick-result");
  expect(result).toHaveTextContent(/^Extracted 3 files · 1 folder · 12 bytes into Pictures$/);
  // The rest is behind a small Details disclosure, closed by default.
  const toggle = screen.getByRole("button", { name: "Details" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByTestId("quick-details")).not.toBeVisible();
  await userEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByTestId("quick-details")).toBeVisible();
  expect(screen.getByTestId("quick-details")).toHaveTextContent("/home/me/Pictures");
  expect(screen.getByTestId("quick-details")).toHaveTextContent("Extracting is not a verification");
  expect(result).toHaveAttribute("data-state", "finished");
  await userEvent.click(screen.getByTestId("quick-show-folder"));
  await userEvent.click(screen.getByTestId("quick-close"));
  const cmds = b.calls.map((c) => c.cmd);
  expect(cmds).toEqual(["watch_quick", "quick_show_folder", "quick_close"]);
  // Neither call carries a path.
  expect(b.calls.filter((c) => c.cmd !== "watch_quick").map((c) => c.args)).toEqual([{}, {}]);
});

test("a new archive is reported as a local commit and never as backed up or safe", async () => {
  const b = backend();
  render(<QuickWindow />);
  b.send({ event: "started", action: "add", subject: name("notes.txt"), items: 3 });
  expect(await screen.findByTestId("quick-title")).toHaveTextContent("Adding notes.txt and 2 more to a new archive");
  b.send({
    event: "done",
    action: "add",
    name: name("notes.mochi"),
    location: name("/home/me/notes.mochi"),
    files: 3,
    directories: 0,
    bytes: 1536,
    skipped: 1,
    note: "x: not stored",
    status: "LOCAL_COMMITTED",
    durability_note: null,
  });
  const result = await screen.findByTestId("quick-result");
  expect(result).toHaveTextContent("Archive created: notes.mochi · 3 files · 1.5 KiB · 1 not added");
  expect(result).not.toHaveTextContent("LOCAL_COMMITTED");
  // Something was not stored: the line is a warning and the Details button carries a badge.
  expect(result.querySelector("p")).toHaveClass("warning");
  const toggle = screen.getByRole("button", { name: "Details, 1 note" });
  await userEvent.click(toggle);
  const details = screen.getByTestId("quick-details");
  expect(details).toHaveTextContent("LOCAL_COMMITTED");
  expect(details).toHaveTextContent("First reason: x: not stored");
  const text = (document.body.textContent ?? "");
  for (const word of ["backed up", "safe", "preserved", "verified"]) {
    expect(text.toLowerCase()).not.toContain(word);
  }
});

test("an encrypted archive asks for its passphrase once, empties the field, and asks again if it was wrong", async () => {
  const b = backend();
  render(<QuickWindow />);
  b.send({ event: "started", action: "extract_to_folder", subject: name("secret.mochi"), items: 1 });
  b.send({ event: "need_passphrase", wrong: false });
  const input = await screen.findByTestId("quick-passphrase-input");
  expect(input).toHaveAttribute("type", "password");
  await userEvent.type(input, "hunter2{Enter}");
  const sent = b.calls.filter((c) => c.cmd === "quick_passphrase");
  expect(sent.map((c) => c.args)).toEqual([{ passphrase: "hunter2" }]);
  expect(await screen.findByTestId("quick-progress")).toBeInTheDocument();
  b.send({ event: "need_passphrase", wrong: true });
  expect(await screen.findByTestId("quick-passphrase-note")).toHaveTextContent("did not open secret.mochi");
  expect(screen.getByTestId("quick-passphrase-input")).toHaveValue("");
});

test("a collision explains that nothing was written and where the plan is", async () => {
  const b = backend();
  render(<QuickWindow />);
  b.send({ event: "started", action: "extract_here", subject: name("a.mochi"), items: 1 });
  b.send({ event: "fallback", conflicts: 2, destination: name("/home/me") });
  const result = await screen.findByTestId("quick-result");
  expect(result).toHaveTextContent("Nothing was written: 2 entries");
  expect(result).toHaveTextContent("main window");
  expect(screen.queryByTestId("quick-show-folder")).toBeNull();
});

test("a failure is text with its code, hostile markup inert, and cancel is sent to Rust", async () => {
  const b = backend();
  render(<QuickWindow />);
  b.send({ event: "started", action: "extract_here", subject: name("<img src=x onerror=alert(1)>.mochi"), items: 1 });
  expect(await screen.findByTestId("quick-title")).toHaveTextContent("<img src=x onerror=alert(1)>.mochi");
  expect(document.querySelector("img")).toBeNull();
  await userEvent.click(await screen.findByTestId("quick-cancel"));
  expect(b.calls.map((c) => c.cmd)).toContain("quick_cancel");
  b.send({ event: "failed", code: "IO_ERROR", message: "<b>no space</b>" });
  const result = await screen.findByTestId("quick-result");
  expect(result).toHaveAttribute("data-state", "failed");
  expect(result).toHaveTextContent("Failed (IO_ERROR): <b>no space</b>");
  expect(result.querySelector("b")).toBeNull();
});

test("a window that mounts after the job began still hears all of it", async () => {
  const b = backend();
  const first = render(<QuickWindow />);
  b.send({ event: "started", action: "add", subject: name("x"), items: 1 });
  b.send({ event: "cancelled", action: "add" });
  first.unmount();
  render(<QuickWindow />);
  expect(await screen.findByTestId("quick-result")).toHaveTextContent("Cancelled. No archive was created.");
});

test("a degraded directory entry is a note in the details, not in the line, and gets no success styling", async () => {
  const b = backend();
  const { container } = render(<QuickWindow />);
  b.send({ event: "started", action: "add", subject: name("a.txt"), items: 1 });
  b.send({
    event: "done",
    action: "add",
    name: name("a.mochi"),
    location: name("/home/me/a.mochi"),
    files: 1,
    directories: 0,
    bytes: 10,
    skipped: 0,
    note: null,
    status: "LOCAL_COMMITTED",
    durability_note: "directory flush ran, but Windows does not document it as durable",
  });
  const result = await screen.findByTestId("quick-result");
  expect(result).toHaveTextContent("Archive created: a.mochi · 1 file · 10 bytes");
  expect(result).not.toHaveTextContent(/degraded|durable/i);
  expect(result.querySelector("p")).not.toHaveClass("warning");
  await userEvent.click(screen.getByRole("button", { name: "Details, 1 note" }));
  expect(screen.getByTestId("quick-details")).toHaveTextContent("Not confirmed");
  expect(screen.getByTestId("quick-details")).toHaveTextContent("Windows does not document it as durable");
  expect(container.querySelector(".success, .pass, [data-status='PASS']")).toBeNull();
});
