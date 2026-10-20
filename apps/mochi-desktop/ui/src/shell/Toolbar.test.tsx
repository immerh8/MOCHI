// The window's toolbar and status line (WinRAR-like, minimal): which buttons are on or off, that
// each one reaches the action that already existed, and the counts in the status line. The
// actions themselves are tested with their components (write/, extract/, check/, foreign/).
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, expect, test } from "vitest";

import { App } from "../App";
import type { ArchiveSummary, EntryRow } from "../ipc/browse";
import type { ForeignArchiveSummary, ForeignRow } from "../ipc/foreign";

const hex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");

const row = (name: string, kind: "file" | "directory" = "file"): EntryRow => ({
  key: hex(name),
  name: { text: name, verbatim: true },
  kind,
  size: "10",
  child_dirs: 0,
  child_files: 0,
});

const ROOT = [row("docs", "directory"), row("a.txt"), row("b.txt")];

const SUMMARY: ArchiveSummary = {
  handle: 3,
  file_name: "tools.mochi",
  archive_id: "ab".repeat(16),
  profile: { tar_compatible: false, encrypted: false, redundancy_percent: null },
  commits: [0, 1].map((seq) => ({
    seq,
    commit_id: String(seq).repeat(64),
    time: null,
    checkpoint: true,
    retained: true,
    expired: false,
    holds: [],
  })),
  retention_error: null,
};

const FOREIGN: ForeignArchiveSummary = {
  handle: 9,
  file_name: "photos.zip",
  format: "ZIP",
  entries: 2,
  complete: true,
  stop_reason: null,
  notes: [],
  checks: "CRC32 per entry",
  opened_with_password: false,
  weak_encryption: false,
  dimensions: { recoverability: "UNSUPPORTED", freshness: "UNSUPPORTED", retention: "UNSUPPORTED" },
};

const FOREIGN_ROWS: ForeignRow[] = ["x.txt", "y.txt"].map((n) => ({
  ...row(n),
  encryption: null,
  note: null,
}));

function backend(opts: { rows?: EntryRow[] } = {}) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const rows = opts.rows ?? ROOT;
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "staged_sources":
        return { items: [], destination: null, default_destination: null };
      case "watch_drops":
      case "watch_launches":
        return null;
      case "recent_archives":
        return [];
      case "get_crash_settings":
        return { enabled: false, include_details: false, entries: 0, bytes: 0 };
      case "get_update_settings":
        return {
          check_on_start: false,
          current_version: "0.1.0",
          install_mode: "manual",
          download_page: "https://github.com/immerh8/MOCHI/releases/latest",
          needs_admin_prompt: false,
        };
    }
    calls.push({ cmd, args: a });
    switch (cmd) {
      case "open_archive":
        return { status: "opened", archive: SUMMARY };
      case "open_snapshot":
        return { seq: a.seq, commit_id: "c".repeat(64), entries: 437, root_dirs: 1, root_files: 2, catalog_source: { source: "image" } };
      case "list_children": {
        const pool = a.dir ? [] : a.directoriesOnly ? rows.filter((r) => r.kind === "directory") : rows;
        const offset = a.offset as number;
        return { total: pool.length, offset, entries: pool.slice(offset, offset + (a.limit as number)) };
      }
      case "entry_details":
        return {
          key: a.key,
          path: { text: "a.txt", verbatim: true },
          kind: "file",
          size: "10",
          content_hash: "d".repeat(64),
          file_version_id: "e".repeat(64),
          attributes: { state: "recorded", posix: null, windows: null, mtime: null },
        };
      case "plan_extract_default":
        return { destination: "/home/me/tools", entries: 3, conflicts: [], conflicts_total: 0, case_insensitive: false };
      case "choose_check_subject":
        return { id: 5, file_name: "tools.mochi", encrypted: false, unlocked: false };
      case "start_job":
        return 1;
      case "open_foreign_archive":
        return FOREIGN;
      case "foreign_children":
        return { total: FOREIGN_ROWS.length, offset: a.offset, entries: FOREIGN_ROWS };
      case "plan_extract_foreign":
        return { plan: { destination: "/home/me/zip", entries: 2, conflicts: [], conflicts_total: 0, case_insensitive: false }, skipped_kinds: 0 };
      case "close_archive":
      case "close_foreign_archive":
        return true;
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  return { calls, cmds: () => calls.map((c) => c.cmd) };
}

afterEach(() => clearMocks());

const ARCHIVE_TOOLS = ["add-to-archive", "extract-all", "toolbar-test", "remove-entry", "search-query", "toolbar-info"];

async function openIt() {
  const user = userEvent.setup();
  const b = backend();
  render(<App />);
  await user.click(await screen.findByTestId("open-archive"));
  await screen.findByText(/^3 items/);
  return { user, b };
}

test("with nothing open, the archive's buttons are off and More and Help are on", async () => {
  backend();
  render(<App />);
  await screen.findByTestId("start-screen");
  const bar = screen.getByRole("group", { name: "Actions" });
  for (const id of ARCHIVE_TOOLS) expect(within(bar).getByTestId(id), id).toBeDisabled();
  expect(within(bar).getByTestId("toolbar-more")).toBeEnabled();
  expect(within(bar).getByTestId("toolbar-help")).toBeEnabled();
  // Icons only: one or two words each are the accessible name (hidden text); the
  // reason a button is off is its tooltip.
  const names = ["Open", "New archive", "Add", "Extract", "Test", "Remove", "Info", "More", "Help"];
  const buttons = within(bar).getAllByRole("button");
  expect(buttons.map((b) => b.textContent)).toEqual(names);
  for (const b of buttons) expect(b.querySelector(".sr-only")?.textContent, b.textContent ?? "").toBe(b.textContent);
  expect(screen.getByTestId("extract-all")).toHaveAttribute("title", "Open an archive first");
  expect(within(bar).getByRole("searchbox", { name: /Search names/ })).toBeDisabled();
});

test("with an archive open the buttons are on; Remove waits for a selection and says why", async () => {
  const { user } = await openIt();
  for (const id of ARCHIVE_TOOLS.filter((id) => id !== "remove-entry")) expect(screen.getByTestId(id), id).toBeEnabled();
  expect(screen.getByTestId("remove-entry")).toBeDisabled();
  expect(screen.getByTestId("remove-entry")).toHaveAttribute("title", "Select an entry first");
  const entry = (await screen.findAllByTestId("entry"))[1] as HTMLElement;
  await user.click(entry);
  await screen.findByTestId("details");
  expect(screen.getByTestId("remove-entry")).toBeEnabled();
});

test("Add and Remove open the panels that were already there", async () => {
  const { user } = await openIt();
  await user.click(screen.getByTestId("add-to-archive"));
  expect(await screen.findByRole("group", { name: "Add to archive" })).toBeInTheDocument();
  await user.click(screen.getByTestId("write-close"));
  await user.click((await screen.findAllByTestId("entry"))[1] as HTMLElement);
  await screen.findByTestId("details");
  await user.click(screen.getByTestId("remove-entry"));
  // Where the decision is made, the note says what removing does and does not do.
  expect(await screen.findByTestId("delete-note")).toHaveTextContent("stays in the archive's history");
});

test("Extract plans the whole version into a new folder; nothing is written", async () => {
  const { user, b } = await openIt();
  await user.click(screen.getByTestId("extract-all"));
  await screen.findByTestId("extract-panel");
  expect(b.calls.find((c) => c.cmd === "plan_extract_default")?.args).toEqual({ handle: 3, seq: 1, keys: [] });
  expect(b.cmds()).not.toContain("start_job");
});

test("Test opens its tool window and runs the test on the open archive", async () => {
  const { user, b } = await openIt();
  const sheet = screen.getByTestId("tool-sheet");
  expect(sheet).not.toBeVisible();
  await user.click(screen.getByTestId("toolbar-test"));
  expect(sheet).toBeVisible();
  expect(document.activeElement).toBe(document.getElementById("check-heading"));
  await waitFor(() => expect(b.cmds()).toContain("start_job"));
  expect(b.calls.find((c) => c.cmd === "choose_check_subject")?.args).toEqual({ from: { from: "open_archive", handle: 3 } });
  expect(b.calls.find((c) => c.cmd === "start_job")?.args.request).toEqual({
    kind: "test_archive",
    subject: 5,
    level: "restoration",
    deep: false,
  });
});

test("Ctrl+F puts the cursor in the search field", async () => {
  const { user } = await openIt();
  await user.keyboard("{Control>}f{/Control}");
  expect(document.activeElement).toBe(screen.getByTestId("search-query"));
});

test("Info shows and hides the details pane, which is closed to start with", async () => {
  const { user } = await openIt();
  const info = screen.getByTestId("toolbar-info");
  const panel = screen.getByTestId("info-panel");
  expect(info).toHaveAttribute("aria-expanded", "false");
  expect(panel).not.toBeVisible();
  await user.click(info);
  expect(info).toHaveAttribute("aria-expanded", "true");
  expect(panel).toBeVisible();
  // The archive's technical facts are in it, as a closed disclosure.
  expect(within(panel).getByTestId("archive-technical")).toHaveTextContent("archive ID");
  await user.click(info);
  expect(panel).not.toBeVisible();
});

test("More lists the rarer things, takes its choice, closes on Escape, and Escape gives focus back", async () => {
  const user = userEvent.setup();
  const b = backend();
  render(<App />);
  await screen.findByTestId("start-screen");
  const more = screen.getByTestId("toolbar-more");
  const menu = document.getElementById("more-menu") as HTMLElement;
  expect(more).toHaveAttribute("aria-controls", "more-menu");
  expect(more).toHaveAttribute("aria-expanded", "false");
  expect(menu).not.toBeVisible();
  await user.click(more);
  expect(more).toHaveAttribute("aria-expanded", "true");
  expect(menu).toBeVisible();
  expect(within(menu).getAllByRole("button").map((x) => x.textContent)).toEqual([
    "Open and extract…",
    "Other formats…",
    "Passphrases",
    "Repair",
    "Settings",
    "Self-test",
  ]);
  await user.keyboard("{Escape}");
  expect(menu).not.toBeVisible();
  expect(document.activeElement).toBe(more);

  // A choice closes it, and does what it says.
  await user.click(more);
  await user.click(within(menu).getByText("Settings"));
  expect(menu).not.toBeVisible();
  expect(screen.getByTestId("tool-sheet")).toBeVisible();
  expect(document.activeElement).toBe(document.getElementById("settings-heading"));
  // Escape closes the tool window and gives focus back to More.
  await user.keyboard("{Escape}");
  expect(screen.getByTestId("tool-sheet")).not.toBeVisible();
  expect(document.activeElement).toBe(more);
  await user.click(more);
  await user.click(within(menu).getByText("Other formats…"));
  await waitFor(() => expect(b.cmds()).toContain("open_foreign_archive"));
});

test("More closes when the pointer goes down outside it", async () => {
  const user = userEvent.setup();
  backend();
  render(<App />);
  await screen.findByTestId("start-screen");
  await user.click(screen.getByTestId("toolbar-more"));
  expect(screen.getByTestId("toolbar-more")).toHaveAttribute("aria-expanded", "true");
  await user.click(screen.getByTestId("start-screen"));
  expect(screen.getByTestId("toolbar-more")).toHaveAttribute("aria-expanded", "false");
});

test("New archive opens the create dialog, and closing it gives focus back to the button", async () => {
  const { user } = await openIt();
  await user.click(screen.getByTestId("new-archive"));
  const panel = await screen.findByRole("group", { name: "Create a new archive" });
  expect(panel.contains(document.activeElement)).toBe(true);
  await user.click(within(panel).getByTestId("write-close"));
  await waitFor(() => expect(screen.queryByTestId("write-panel")).toBeNull());
  expect(document.activeElement).toBe(screen.getByTestId("new-archive"));
});

test("Help opens the panel with the keyboard keys and the honest limit, and ? again closes it", async () => {
  const user = userEvent.setup();
  backend();
  render(<App />);
  await screen.findByTestId("start-screen");
  const help = screen.getByTestId("toolbar-help");
  expect(screen.getByTestId("tool-sheet")).not.toBeVisible();
  await user.click(help);
  expect(help).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByTestId("tool-sheet")).toBeVisible();
  await waitFor(() => expect(document.activeElement).toBe(document.getElementById("help-heading")));
  expect(screen.getByTestId("help-keys")).toHaveTextContent("Page Up, Page Down, Home and End jump");
  expect(screen.getByTestId("start-note")).toHaveTextContent("not a second copy of them");
  await user.click(screen.getByTestId("tool-sheet-close"));
  expect(screen.getByTestId("tool-sheet")).not.toBeVisible();
});

test("the status line counts items, then the selection; the whole version is its tooltip", async () => {
  const { user } = await openIt();
  const status = screen.getByTestId("entry-count");
  expect(status).toHaveTextContent(/^3 items$/);
  expect(status).toHaveAttribute("title", "437 entries in this version");
  await user.click((await screen.findAllByTestId("entry"))[0] as HTMLElement);
  await waitFor(() => expect(status).toHaveTextContent("3 items · 1 selected"));
  // Ctrl and Shift add to the selection, as in a file manager.
  const rows = await screen.findAllByTestId("entry");
  await user.keyboard("{Control>}");
  await user.click(rows[2] as HTMLElement);
  await user.keyboard("{/Control}");
  await waitFor(() => expect(status).toHaveTextContent("3 items · 2 selected"));
  await user.keyboard("{Shift>}");
  await user.click(rows[0] as HTMLElement);
  await user.keyboard("{/Shift}");
  await waitFor(() => expect(status).toHaveTextContent("3 items · 3 selected"));
});

test("a folder with one entry says '1 item'", async () => {
  const user = userEvent.setup();
  backend({ rows: [row("only.txt")] });
  render(<App />);
  await user.click(await screen.findByTestId("open-archive"));
  await waitFor(() => expect(screen.getByTestId("entry-count")).toHaveTextContent(/^1 item$/));
});

test("the path bar names the archive and lists its versions on request, at the version on screen", async () => {
  const { user, b } = await openIt();
  const meta = screen.getByTestId("archive-meta");
  expect(meta).toHaveTextContent(/^tools\.mochi$/);
  const toggle = screen.getByTestId("toggle-versions");
  expect(toggle).toHaveTextContent(/^v1$/);
  expect(toggle).toHaveAttribute("title", "2 versions");
  expect(screen.getByTestId("timeline")).not.toBeVisible();
  await user.click(toggle);
  expect(screen.getByTestId("timeline")).toBeVisible();
  await user.click(screen.getByTestId("commit-0"));
  expect(screen.getByTestId("timeline")).not.toBeVisible();
  await waitFor(() => expect(toggle).toHaveTextContent(/^v0$/));
  expect(b.calls.filter((c) => c.cmd === "open_snapshot").at(-1)?.args).toEqual({ handle: 3, seq: 0 });
});

test("the versions button closes the list it opened", async () => {
  const { user } = await openIt();
  const toggle = screen.getByTestId("toggle-versions");
  await user.click(toggle);
  expect(screen.getByTestId("timeline")).toBeVisible();
  // Its own pointer-down is not a press outside the list: closing must not reopen it.
  await user.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByTestId("timeline")).not.toBeVisible();
});

test("a foreign archive fills the window: its own Extract and Test, the rest off, and MOCHI's archive steps aside", async () => {
  const user = userEvent.setup();
  const b = backend();
  render(<App />);
  await screen.findByTestId("start-screen");
  await user.click(screen.getByTestId("toolbar-more"));
  await user.click(screen.getByTestId("menu-foreign"));
  await screen.findByTestId("foreign-meta");
  expect(screen.queryByTestId("start-screen")).toBeNull();
  expect(screen.getByTestId("foreign-meta")).toHaveTextContent("photos.zip");
  expect(screen.getByTestId("foreign-meta")).toHaveTextContent("ZIP");
  // Add and Remove do not apply to a read-only archive in another format; search does.
  for (const id of ["add-to-archive", "remove-entry"]) expect(screen.getByTestId(id), id).toBeDisabled();
  expect(screen.getByTestId("search-query")).toBeEnabled();
  expect(screen.getByTestId("add-to-archive")).toHaveAttribute("title", "Archives in other formats are read-only");
  await waitFor(() => expect(screen.getByTestId("foreign-count")).toHaveTextContent(/^2 items$/));
  // No explanations on screen; the check's limits are the Test tooltip.
  expect(screen.queryByText(/not a MOCHI archive/)).toBeNull();
  expect(screen.getByTestId("foreign-test")).toHaveAttribute("title", expect.stringContaining("does not verify the archive the way MOCHI verifies its own"));
  await user.click(screen.getByTestId("foreign-extract-all"));
  await screen.findByTestId("foreign-plan");
  expect(b.cmds()).toContain("plan_extract_foreign");
  await user.click(screen.getByTestId("foreign-plan-close"));
  await user.click(screen.getByTestId("foreign-test"));
  await waitFor(() => expect(b.calls.find((c) => c.cmd === "start_job")?.args.request).toEqual({ kind: "test_foreign", handle: 9 }));
});

test("showing a MOCHI archive closes the foreign one on screen", async () => {
  const user = userEvent.setup();
  const b = backend();
  render(<App />);
  await screen.findByTestId("start-screen");
  await user.click(screen.getByTestId("toolbar-more"));
  await user.click(screen.getByTestId("menu-foreign"));
  await screen.findByTestId("foreign-meta");
  await user.click(screen.getByTestId("toolbar-more"));
  await user.click(screen.getByTestId("start-extract"));
  await screen.findByTestId("archive-meta");
  await waitFor(() => expect(screen.queryByTestId("foreign-meta")).toBeNull());
  expect(b.cmds()).toContain("close_foreign_archive");
  expect(screen.getByTestId("extract-all")).toBeEnabled();
});
