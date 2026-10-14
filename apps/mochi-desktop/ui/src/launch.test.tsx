// Plan D6: the shell's verbs reach the window as events from Rust. The webview
// hears that an archive was opened (or why a launch failed) and never a path.
import { act, render, screen, waitFor } from "@testing-library/react";
import type { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";

import { Browser } from "./browser/Browser";
import { ForeignBrowser } from "./foreign/ForeignBrowser";
import type { ForeignArchiveSummary } from "./ipc/foreign";
import type { ArchiveSummary } from "./ipc/browse";
import type { LaunchEvent } from "./ipc/launch";

type Internals = { runCallback: (id: number, data: unknown) => void };
const internals = () =>
  (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;

function summary(handle: number, name: string): ArchiveSummary {
  return {
    handle,
    file_name: name,
    archive_id: "ab".repeat(16),
    profile: { tar_compatible: false, encrypted: false, redundancy_percent: null },
    commits: [{ seq: 0, commit_id: "0".repeat(64), time: null, checkpoint: true, retained: true, expired: false, holds: [] }],
    retention_error: null,
  };
}

function foreignSummary(handle: number, name: string): ForeignArchiveSummary {
  return {
    handle,
    file_name: name,
    format: "7z",
    entries: 1,
    complete: true,
    stop_reason: null,
    notes: [],
    checks: "CRC32 per entry",
    opened_with_password: false,
    weak_encryption: false,
    dimensions: { recoverability: "UNSUPPORTED", freshness: "UNSUPPORTED", retention: "UNSUPPORTED" },
  };
}

function backend() {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  let channel: Channel<LaunchEvent> | undefined;
  let index = 0;
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: a });
    switch (cmd) {
      case "watch_launches":
        channel = a.onLaunch as Channel<LaunchEvent>;
        return null;
      case "watch_drops":
        return null;
      case "staged_sources":
        return { items: [], destination: null };
      case "open_snapshot":
        return { seq: a.seq, commit_id: "c".repeat(64), entries: 0, root_dirs: 0, root_files: 0, catalog_source: { source: "image" } };
      case "list_children":
        return { total: 0, offset: 0, entries: [] };
      case "close_archive":
      case "close_foreign_archive":
        return true;
      case "foreign_children":
        return {
          total: 1,
          offset: 0,
          entries: [
            {
              key: "3c",
              name: { text: '<img src=x onerror="alert(1)">', verbatim: true },
              kind: "file",
              size: "5",
              child_dirs: 0,
              child_files: 0,
              encryption: null,
              note: null,
            },
          ],
        };
      case "open_foreign_archive":
        return foreignSummary(12, "retried.7z");
      case "plan_extract":
        return { destination: "/home/me/photos", entries: 4, conflicts: [], conflicts_total: 0, case_insensitive: false };
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  return {
    calls,
    launch: (message: LaunchEvent) => {
      if (!channel) throw new Error("the window never asked to hear launches");
      const id = channel.id;
      act(() => {
        internals().runCallback(id, { index: index++, message });
      });
    },
  };
}

afterEach(() => clearMocks());

test("an archive opened by the shell is shown, and the previous one is closed", async () => {
  const b = backend();
  render(<Browser />);
  await screen.findByTestId("browse-empty");
  b.launch({ event: "opened", archive: summary(7, "first.mochi"), extract: false });
  expect(await screen.findByText("first.mochi")).toBeInTheDocument();
  b.launch({ event: "opened", archive: summary(8, "second.mochi"), extract: false });
  expect(await screen.findByText("second.mochi")).toBeInTheDocument();
  const cmds = b.calls.map((c) => c.cmd);
  expect(cmds).toContain("close_archive");
  expect(b.calls.find((c) => c.cmd === "close_archive")?.args).toEqual({ handle: 7 });
  // Opening by the shell never asks for a dialog or names a path.
  expect(cmds).not.toContain("open_archive");
  expect(JSON.stringify(b.calls.map((c) => c.args))).not.toMatch(/\.mochi"/);
  // And nothing was planned or written: opening is read-only.
  expect(cmds).not.toContain("plan_extract");
  expect(cmds).not.toContain("start_job");
});

test("an extract verb shows the plan for the folder Rust chose, and writes nothing until confirmed", async () => {
  const b = backend();
  render(<Browser />);
  await screen.findByTestId("browse-empty");
  b.launch({ event: "opened", archive: summary(7, "photos.mochi"), extract: true });
  const panel = await screen.findByTestId("extract-panel");
  expect(panel).toHaveTextContent("The whole of commit 0");
  expect(screen.getByTestId("extract-destination")).toHaveTextContent("/home/me/photos");
  const plan = b.calls.find((c) => c.cmd === "plan_extract");
  // The folder was chosen in Rust: no dialog (`pick` false), the whole snapshot.
  expect(plan?.args).toMatchObject({ handle: 7, seq: 0, keys: [], pick: false });
  expect(b.calls.map((c) => c.cmd)).not.toContain("start_job");
  expect(screen.getByTestId("extract-confirm")).toBeEnabled();
});

test("a launch that failed is shown as text, hostile markup inert", async () => {
  const b = backend();
  const { container } = render(<Browser />);
  await screen.findByTestId("browse-empty");
  b.launch({ event: "problem", message: '<img src=x onerror="alert(1)"> could not be opened (CORRUPT)' });
  const alert = await screen.findByTestId("browse-error");
  expect(alert).toHaveTextContent('<img src=x onerror="alert(1)"> could not be opened');
  expect(container.querySelector("img")).toBeNull();
});

test("a foreign archive opened by the shell shows the foreign browser, read-only, with names as text", async () => {
  const b = backend();
  const { container } = render(
    <>
      <Browser />
      <ForeignBrowser />
    </>,
  );
  await screen.findByTestId("browse-empty");
  b.launch({ event: "foreign_opened", archive: foreignSummary(11, "photos.zip") });
  expect(await screen.findByTestId("foreign-meta")).toHaveTextContent("photos.zip");
  expect(screen.getByTestId("foreign-label")).toBeInTheDocument();
  expect(await screen.findByTestId("foreign-entry")).toHaveTextContent('<img src=x onerror="alert(1)">');
  expect(container.querySelector("img")).toBeNull();
  // The MOCHI browser is untouched, and nothing asked for a dialog or a path.
  expect(screen.getByTestId("browse-empty")).toBeInTheDocument();
  const cmds = b.calls.map((c) => c.cmd);
  expect(cmds).not.toContain("open_archive");
  expect(cmds).not.toContain("open_foreign_archive");
  // A second one replaces the first and closes it.
  b.launch({ event: "foreign_opened", archive: foreignSummary(13, "other.zip") });
  await waitFor(() => expect(screen.getByTestId("foreign-meta")).toHaveTextContent("other.zip"));
  expect(b.calls.find((c) => c.cmd === "close_foreign_archive")?.args).toEqual({ handle: 11 });
});

test("a password-protected foreign archive asks in the window and sends the password once", async () => {
  const user = userEvent.setup();
  const b = backend();
  render(
    <>
      <Browser />
      <ForeignBrowser />
    </>,
  );
  await screen.findByTestId("browse-empty");
  b.launch({ event: "foreign_password", wrong: false });
  const input = await screen.findByTestId("foreign-password-input");
  await user.type(input, "SECRET");
  await user.click(screen.getByTestId("foreign-password-submit"));
  await waitFor(() => expect(screen.getByTestId("foreign-meta")).toHaveTextContent("retried.7z"));
  const opens = b.calls.filter((c) => c.cmd === "open_foreign_archive");
  // The retry names no file (Rust remembers it) and carries the password once.
  expect(opens.map((c) => c.args)).toEqual([{ retry: true, password: "SECRET" }]);
  expect(screen.queryByTestId("foreign-password")).toBeNull();
  expect(JSON.stringify(b.calls.filter((c) => c.cmd !== "open_foreign_archive"))).not.toContain("SECRET");
});
