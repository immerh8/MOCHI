import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import type { ArchiveSummary, EntryRow } from "../ipc/browse";
import { ForeignBrowser } from "../foreign/ForeignBrowser";
import { Browser } from "./Browser";

// Folder navigation regression: A/{fileA, fileB, B/C}. The keys are the real
// shape (the full stored path, hex), so a folder's key differs from its name.
const hex = (s: string) =>
  Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");

function row(path: string, kind: "file" | "directory", dirs = 0, files = 0): EntryRow {
  return {
    key: hex(path),
    name: { text: path.split("/").at(-1) ?? path, verbatim: true },
    kind,
    size: "10",
    child_dirs: dirs,
    child_files: files,
  };
}

const TREE: Record<string, EntryRow[]> = {
  "": [row("A", "directory", 1, 2), row("top.txt", "file")],
  A: [row("A/B", "directory", 1, 0), row("A/fileA", "file"), row("A/fileB", "file")],
  "A/B": [row("A/B/C", "directory", 0, 1)],
  "A/B/C": [row("A/B/C/deep.txt", "file")],
};
const KEYS = new Map(Object.keys(TREE).map((p) => [hex(p), p]));

const SUMMARY: ArchiveSummary = {
  handle: 3,
  file_name: "nested.mochi",
  archive_id: "ab".repeat(16),
  profile: { tar_compatible: false, encrypted: false, redundancy_percent: null },
  commits: [{ seq: 0, commit_id: "0".repeat(64), time: null, checkpoint: true, retained: null, expired: null, holds: [] }],
  retention_error: null,
};

function fake() {
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    if (cmd === "staged_sources") return { items: [], destination: null, default_destination: null, format: "mochi" };
    if (cmd === "watch_drops" || cmd === "watch_launches") return null;
    if (cmd === "recent_archives") return [];
    switch (cmd) {
      case "open_archive":
        return { status: "opened", archive: SUMMARY };
      case "close_archive":
        return true;
      case "open_snapshot":
        return { seq: a.seq, commit_id: "c".repeat(64), entries: 7, root_dirs: 1, root_files: 1, catalog_source: { source: "image" } };
      case "list_children": {
        const dir = a.dir === null ? "" : KEYS.get(a.dir as string);
        if (dir === undefined) throw { code: "INVALID_ARGUMENT", message: "no such directory" };
        const all = TREE[dir] ?? [];
        const pool = a.directoriesOnly ? all.filter((r) => r.kind === "directory") : all;
        const off = a.offset as number;
        return { total: pool.length, offset: off, entries: pool.slice(off, off + (a.limit as number)) };
      }
      case "entry_details":
        throw { code: "INVALID_ARGUMENT", message: "n/a" };
    }
    throw new Error(`unexpected command ${cmd}`);
  });
}

afterEach(() => clearMocks());

const names = () => screen.getAllByTestId("entry").map((e) => e.querySelector(".name")?.textContent);

async function into(user: ReturnType<typeof userEvent.setup>, name: string, expected: string[]) {
  const target = (await screen.findAllByTestId("entry")).find((e) => e.querySelector(".name")?.textContent === name);
  await user.dblClick(target as HTMLElement);
  await waitFor(() => expect(names()).toEqual(expected));
}

async function openDeep() {
  const user = userEvent.setup();
  fake();
  render(<Browser />);
  await user.click(screen.getByTestId("open-archive"));
  await screen.findByText(/^2 items/);
  await into(user, "A", ["B", "fileA", "fileB"]);
  await into(user, "B", ["C"]);
  await into(user, "C", ["deep.txt"]);
  return user;
}

test("Backspace climbs C -> B -> A -> root, each landing on the parent", async () => {
  const user = await openDeep();
  const up = async (expected: string[]) => {
    (screen.getAllByTestId("entry")[0] as HTMLElement).focus();
    await user.keyboard("{Backspace}");
    await waitFor(() => expect(names()).toEqual(expected));
  };
  await up(["C"]);
  await up(["B", "fileA", "fileB"]);
  await up(["A", "top.txt"]);
});

test("the path bar goes to each ancestor", async () => {
  const user = await openDeep();
  const crumbs = () => within(screen.getByTestId("crumbs"));
  await user.click(crumbs().getByRole("button", { name: "B" }));
  await waitFor(() => expect(names()).toEqual(["C"]));
  await user.click(crumbs().getByRole("button", { name: "A" }));
  await waitFor(() => expect(names()).toEqual(["B", "fileA", "fileB"]));
  await user.click(crumbs().getByTitle("Archive root"));
  await waitFor(() => expect(names()).toEqual(["A", "top.txt"]));
});

const selectedNames = () =>
  screen
    .getAllByTestId("entry")
    .filter((e) => e.getAttribute("aria-pressed") === "true")
    .map((e) => e.querySelector(".name")?.textContent);

test("going up selects the folder you came out of, as a file manager does", async () => {
  const user = await openDeep();
  (screen.getAllByTestId("entry")[0] as HTMLElement).focus();
  await user.keyboard("{Backspace}");
  await waitFor(() => expect(names()).toEqual(["C"]));
  await waitFor(() => expect(selectedNames()).toEqual(["C"]));
  await user.keyboard("{Backspace}");
  await waitFor(() => expect(names()).toEqual(["B", "fileA", "fileB"]));
  await waitFor(() => expect(selectedNames()).toEqual(["B"]));
  // The path bar does the same.
  await user.click(screen.getByTitle("Archive root"));
  await waitFor(() => expect(selectedNames()).toEqual(["A"]));
});

test("Alt+Left and Alt+Right walk the folder history, Alt+Up goes to the parent", async () => {
  const user = await openDeep();
  (screen.getAllByTestId("entry")[0] as HTMLElement).focus();
  await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
  await waitFor(() => expect(names()).toEqual(["C"]));
  await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");
  await waitFor(() => expect(names()).toEqual(["deep.txt"]));
  await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");
  await waitFor(() => expect(names()).toEqual(["C"]));
  await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");
  await waitFor(() => expect(names()).toEqual(["B", "fileA", "fileB"]));
  await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
  await waitFor(() => expect(names()).toEqual(["C"]));
});

test("the folder tree goes to each ancestor", async () => {
  const user = await openDeep();
  await user.click(screen.getByTestId("toggle-folders"));
  const tree = within(screen.getByTestId("tree"));
  await user.click(await tree.findByRole("button", { name: "Expand A" }));
  await user.click(await tree.findByRole("button", { name: "Expand B" }));
  await user.click(await tree.findByRole("button", { name: "C" }));
  await waitFor(() => expect(names()).toEqual(["deep.txt"]));
  await user.click(tree.getByRole("button", { name: "B" }));
  await waitFor(() => expect(names()).toEqual(["C"]));
  await user.click(tree.getByRole("button", { name: "A" }));
  await waitFor(() => expect(names()).toEqual(["B", "fileA", "fileB"]));
  await user.click(tree.getByRole("button", { name: "Archive root" }));
  await waitFor(() => expect(names()).toEqual(["A", "top.txt"]));
});

test("a foreign archive climbs the same way, including folders that exist only as prefixes", async () => {
  const user = userEvent.setup();
  // Only A/B/C/deep.txt is in the archive: A, B and C are implied by the path.
  const foreignRow = (path: string, kind: "file" | "directory") => ({
    ...row(path, kind, kind === "directory" ? 1 : 0, 0),
    size: kind === "file" ? "5" : null,
    encryption: null,
    note: null,
  });
  const FTREE: Record<string, ReturnType<typeof foreignRow>[]> = {
    "": [foreignRow("A", "directory")],
    A: [foreignRow("A/B", "directory"), foreignRow("A/fileA", "file")],
    "A/B": [foreignRow("A/B/C", "directory")],
    "A/B/C": [foreignRow("A/B/C/deep.txt", "file")],
  };
  const fkeys = new Map(Object.keys(FTREE).map((p) => [hex(p), p]));
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    if (cmd === "staged_sources") return { items: [], destination: null, default_destination: null, format: "mochi" };
    if (cmd === "watch_drops" || cmd === "watch_launches") return null;
    if (cmd === "recent_archives") return [];
    switch (cmd) {
      case "open_foreign_archive":
        return {
          handle: 5,
          file_name: "deep.zip",
          format: "ZIP",
          entries: 3,
          complete: true,
          stop_reason: null,
          notes: [],
          checks: "CRC32 per entry",
          opened_with_password: false,
          weak_encryption: false,
          dimensions: { recoverability: "UNSUPPORTED", freshness: "UNSUPPORTED", retention: "UNSUPPORTED" },
        };
      case "foreign_children": {
        const dir = a.dir === null ? "" : fkeys.get(a.dir as string);
        if (dir === undefined) throw { code: "INVALID_ARGUMENT", message: "no such folder" };
        const all = FTREE[dir] ?? [];
        return { total: all.length, offset: 0, entries: all };
      }
      case "close_foreign_archive":
        return true;
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  render(<Browser foreign={<ForeignBrowser />} />);
  await user.click(screen.getByTestId("toolbar-more"));
  await user.click(screen.getByTestId("menu-foreign"));
  const fnames = () => screen.getAllByTestId("foreign-entry").map((e) => e.querySelector(".name")?.textContent);
  const down = async (name: string, expected: string[]) => {
    const target = (await screen.findAllByTestId("foreign-entry")).find(
      (e) => e.querySelector(".name")?.textContent === name,
    );
    await user.dblClick(target as HTMLElement);
    await waitFor(() => expect(fnames()).toEqual(expected));
  };
  await waitFor(() => expect(fnames()).toEqual(["A"]));
  await down("A", ["B", "fileA"]);
  await down("B", ["C"]);
  await down("C", ["deep.txt"]);
  const selected = () =>
    screen
      .getAllByTestId("foreign-entry")
      .filter((e) => e.getAttribute("aria-pressed") === "true")
      .map((e) => e.querySelector(".name")?.textContent);
  (screen.getAllByTestId("foreign-entry")[0] as HTMLElement).focus();
  await user.keyboard("{Backspace}");
  await waitFor(() => expect(fnames()).toEqual(["C"]));
  await waitFor(() => expect(selected()).toEqual(["C"]));
  await user.keyboard("{Backspace}");
  await waitFor(() => expect(fnames()).toEqual(["B", "fileA"]));
  await waitFor(() => expect(selected()).toEqual(["B"]));
  await user.click(screen.getByTitle("Archive root"));
  await waitFor(() => expect(fnames()).toEqual(["A"]));
});
