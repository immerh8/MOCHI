import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, expect, test, vi } from "vitest";

import { Browser } from "../browser/Browser";
import type { ArchiveSummary } from "../ipc/browse";
import type { JobEvent, JobOutcome } from "../ipc/jobs";
import type { CommitReport, DropEvent, StagedItem, StagedView } from "../ipc/write";
import { Writer } from "./Writer";
import type { WriterProps } from "./Writer";

type Internals = { runCallback: (id: number, data: unknown) => void };
const internals = () =>
  (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;

const HOSTILE = '<img src=x onerror="alert(1)">';

function summary(handle: number, commits: number, name = "fake.mochi"): ArchiveSummary {
  return {
    handle,
    file_name: name,
    archive_id: "ab".repeat(16),
    profile: { tar_compatible: false, encrypted: false, redundancy_percent: null },
    commits: Array.from({ length: commits }, (_, seq) => ({
      seq,
      commit_id: String(seq).repeat(64),
      time: "2023-11-14T22:13:20Z",
      checkpoint: seq === 0,
      retained: true,
      expired: false,
      holds: [],
    })),
    retention_error: null,
  };
}

function commit(operation: CommitReport["operation"], archive: ArchiveSummary | null): CommitReport {
  return {
    operation,
    status: "LOCAL_COMMITTED",
    seq: archive ? archive.commits.length - 1 : 0,
    commit_id: "c".repeat(64),
    files: 2,
    directories: 1,
    bytes: 2048,
    removed: operation === "delete" ? 1 : 0,
    skipped: [],
    durability_note: null,
    archive,
    reopen_error: null,
  };
}

const completed = (c: CommitReport): JobOutcome => ({ status: "completed", summary: "s", commit: c });

/** A fake backend for the staging and job commands; the test pushes events. */
function backend(opts: { destination?: string | null; defaultDestination?: string | null } = {}) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  let staged: StagedItem[] = [];
  let destination: string | null = null;
  let jobChannel: Channel<JobEvent> | undefined;
  let dropChannel: Channel<DropEvent> | undefined;
  // Tauri delivers a channel's messages in order, numbered from 0 per channel.
  const next = new Map<number, number>();
  const view = (): StagedView => ({
    items: staged,
    destination,
    default_destination: destination === null && staged.length > 0 ? (opts.defaultDestination ?? null) : null,
  });
  const browse = { archive: summary(3, 1) };
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: a });
    switch (cmd) {
      case "watch_drops":
        dropChannel = a.onDrop as Channel<DropEvent>;
        return null;
      case "staged_sources":
        return view();
      case "stage_sources": {
        staged = [
          ...staged,
          a.pick === "folder"
            ? { name: { text: "photos", verbatim: true }, kind: "folder" }
            : { name: { text: "notes.txt", verbatim: true }, kind: "file" },
        ];
        return { staged: view(), problems: [] };
      }
      case "unstage_source":
        staged = staged.filter((_, i) => i !== a.index);
        return view();
      case "stage_dropped_archive":
        staged = [...staged, { name: { text: "photos.zip", verbatim: true }, kind: "file" }];
        return view();
      case "clear_staged":
        staged = [];
        destination = null;
        return view();
      case "choose_destination":
        if (opts.destination === null) return null;
        destination = opts.destination ?? "new.mochi";
        return view();
      case "start_job":
        jobChannel = a.onEvent as Channel<JobEvent>;
        return 5;
      case "cancel_job":
        return true;
      case "open_archive":
        return { status: "opened", archive: browse.archive };
      case "open_snapshot":
        return {
          seq: a.seq,
          commit_id: "c".repeat(64),
          entries: 0,
          root_dirs: 0,
          root_files: 0,
          catalog_source: { source: "image" },
        };
      case "list_children":
        return { total: 0, offset: 0, entries: [] };
      case "close_archive":
        return true;
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  const send = (channel: Channel<unknown> | undefined, message: unknown) => {
    if (!channel) throw new Error("no channel yet");
    const id = channel.id;
    const index = next.get(id) ?? 0;
    next.set(id, index + 1);
    act(() => {
      internals().runCallback(id, { index, message });
    });
  };
  return {
    calls,
    browse,
    job: (m: JobEvent) => send(jobChannel as Channel<unknown> | undefined, m),
    drop: (m: DropEvent) => send(dropChannel as Channel<unknown> | undefined, m),
    cmds: () => calls.map((c) => c.cmd),
    request: () => calls.find((c) => c.cmd === "start_job")?.args.request,
    setStaged: (items: StagedItem[]) => {
      staged = items;
    },
  };
}

afterEach(() => clearMocks());

function renderWriter(props: Partial<WriterProps> = {}) {
  const onCommitted = props.onCommitted ?? (() => undefined);
  return render(
    <Writer archive={null} viewingHead selected={[]} {...props} onCommitted={onCommitted} />,
  );
}

test("create: choose items, options, a location, then a job with those options", async () => {
  const user = userEvent.setup();
  const b = backend();
  renderWriter();
  await user.click(screen.getByTestId("new-archive"));
  expect(screen.getByTestId("create-confirm")).toBeDisabled();

  await user.click(screen.getByTestId("stage-folder"));
  await user.click(screen.getByTestId("stage-files"));
  const items = await screen.findAllByTestId("staged-item");
  expect(items.map((i) => i.textContent)).toEqual([
    expect.stringContaining("Folder"),
    expect.stringContaining("File"),
  ]);
  expect(b.calls.filter((c) => c.cmd === "stage_sources").map((c) => c.args)).toEqual([
    { pick: "folder" },
    { pick: "files" },
  ]);

  // Defaults, then the user's choices.
  expect(screen.getByTestId("preset-balanced")).toBeChecked();
  expect(screen.getByTestId("tar-compatible")).not.toBeChecked();
  await user.click(screen.getByTestId("preset-smaller"));
  await user.click(screen.getByTestId("tar-compatible"));
  await user.click(screen.getByTestId("create-confirm"));

  await screen.findByTestId("write-running");
  expect(b.cmds().slice(-2)).toEqual(["choose_destination", "start_job"]);
  expect(b.request()).toEqual({ kind: "create_archive", preset: "smaller", tar_compatible: true });
});

test("the options are collapsed by default, with the plain defaults, and nothing is encrypted", async () => {
  const user = userEvent.setup();
  backend();
  renderWriter();
  await user.click(screen.getByTestId("new-archive"));
  expect(screen.getByTestId("create-options")).not.toHaveAttribute("open");
  expect(screen.getByTestId("preset-balanced")).toBeChecked();
  expect(screen.getByTestId("encrypt")).not.toBeChecked();
  expect(screen.getByTestId("recovery-none")).toBeChecked();
  expect(screen.getByTestId("create-step-files")).toBeInTheDocument();
  expect(screen.getByTestId("create-step-where")).toBeInTheDocument();
});

test("with a default place there is no dialog: one click creates, and the place is shown", async () => {
  const user = userEvent.setup();
  const b = backend({ defaultDestination: "/home/me/photos.mochi" });
  renderWriter();
  await user.click(screen.getByTestId("new-archive"));
  await user.click(screen.getByTestId("stage-folder"));
  await screen.findByTestId("staged-list");
  expect(screen.getByTestId("save-location")).toHaveTextContent("/home/me/photos.mochi");
  expect(screen.getByTestId("save-location").getAttribute("title")).toContain("An existing file is never replaced");
  await user.click(screen.getByTestId("create-confirm"));
  await screen.findByTestId("write-running");
  expect(b.cmds()).not.toContain("choose_destination");
  expect(b.cmds().at(-1)).toBe("start_job");
});

test("Change… shows the save dialog and the chosen name replaces the default", async () => {
  const user = userEvent.setup();
  const b = backend({ defaultDestination: "/home/me/photos.mochi" });
  renderWriter();
  await user.click(screen.getByTestId("new-archive"));
  await user.click(screen.getByTestId("stage-folder"));
  await screen.findByTestId("staged-list");
  expect(screen.getByTestId("change-destination")).toBeEnabled();
  await user.click(screen.getByTestId("change-destination"));
  await waitFor(() => expect(screen.getByTestId("save-location").getAttribute("title")).toMatch(/^Saved as .*\.mochi/));
  expect(b.cmds()).toContain("choose_destination");
});

test("the TAR option names itself and states its trade-offs", async () => {
  const user = userEvent.setup();
  backend();
  renderWriter();
  await user.click(screen.getByTestId("new-archive"));
  const panel = screen.getByTestId("write-panel");
  expect(panel).toHaveTextContent("Let standard zstd and tar tools read it");
  const notes = screen.getByTestId("tar-notes");
  expect(notes).toHaveTextContent("history of every commit, not the latest snapshot");
  expect(notes).toHaveTextContent("a file you delete later is still extracted");
  expect(notes).toHaveTextContent("stored again");
  expect(notes).toHaveTextContent("fixed when the archive is created");
  expect(panel).not.toHaveTextContent("cannot be turned on yet");
});

test("cancelling the save dialog starts nothing", async () => {
  const user = userEvent.setup();
  const b = backend({ destination: null });
  renderWriter();
  await user.click(screen.getByTestId("new-archive"));
  await user.click(screen.getByTestId("stage-folder"));
  await screen.findByTestId("staged-list");
  await user.click(screen.getByTestId("create-confirm"));
  await act(async () => undefined);
  expect(b.cmds()).toContain("choose_destination");
  expect(b.cmds()).not.toContain("start_job");
  expect(screen.queryByTestId("write-running")).toBeNull();
});

test("a running create shows progress, cancels, and ends saying no archive was created", async () => {
  const user = userEvent.setup();
  const b = backend();
  renderWriter();
  await user.click(screen.getByTestId("new-archive"));
  await user.click(screen.getByTestId("stage-folder"));
  await screen.findByTestId("staged-list");
  await user.click(screen.getByTestId("create-confirm"));
  await screen.findByTestId("write-running");

  b.job({ event: "started", job_id: 5 });
  b.job({ event: "progress", job_id: 5, phase: "import", completed: 4096, total: null });
  expect(screen.getByTestId("write-progress")).toHaveTextContent("Reading files: 4.0 KiB (4,096 bytes) so far");
  expect(screen.getByTestId("write-cancel")).toBeEnabled();
  expect(screen.getByTestId("create-confirm")).toBeDisabled();

  await user.click(screen.getByTestId("write-cancel"));
  expect(b.calls.at(-1)).toEqual({ cmd: "cancel_job", args: { jobId: 5 } });
  expect(screen.getByTestId("write-progress")).toHaveTextContent("(cancelling…)");

  b.job({ event: "finished", job_id: 5, outcome: { status: "cancelled" } });
  const status = screen.getByTestId("write-status");
  expect(status).toHaveTextContent("Cancelled. No archive was created.");
  expect(status).toHaveAttribute("data-committed", "false");
  expect(screen.queryByTestId("write-running")).toBeNull();
  // The panel stays, so the user can try again.
  expect(screen.getByTestId("write-panel")).toBeInTheDocument();
});

/** Create through the panel, then deliver `outcome`. */
async function createThen(b: ReturnType<typeof backend>, outcome: JobOutcome, props: Partial<WriterProps> = {}) {
  const user = userEvent.setup();
  const view = renderWriter(props);
  await user.click(screen.getByTestId("new-archive"));
  await user.click(screen.getByTestId("stage-folder"));
  await screen.findByTestId("staged-list");
  await user.click(screen.getByTestId("create-confirm"));
  await screen.findByTestId("write-running");
  b.job({ event: "started", job_id: 5 });
  b.job({ event: "finished", job_id: 5, outcome });
  return { user, ...view };
}

const BANNED = ["backed up", "backup", "safe", "preserved", "secure"];

test("a completed commit is one short line, never backed up, safe, or preserved, and hands over the archive", async () => {
  const b = backend();
  const adopted: (ArchiveSummary | null)[] = [];
  const created = summary(9, 1, "new.mochi");
  const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const { container } = await createThen(b, completed(commit("create", created)), {
    onCommitted: (a) => adopted.push(a),
  });

  const status = screen.getByTestId("write-status");
  expect(status).toHaveTextContent(/^Created new\.mochi · 2 files · 1 folder · 2\.0 KiB$/);
  expect(status).toHaveAttribute("data-committed", "true");
  // None of the old banner text is on the screen unless the panel is open.
  for (const gone of ["Technical detail", "independent copy", "LOCAL_COMMITTED", "2,048"]) {
    expect(status).not.toHaveTextContent(gone);
  }
  expect(screen.getByTestId("write-details")).not.toBeVisible();
  expect(adopted).toEqual([created]);
  expect(screen.queryByTestId("write-panel")).toBeNull();
  const text = (container.textContent ?? "").toLowerCase();
  for (const banned of BANNED) expect(text).not.toContain(banned);
  // No success styling: nothing is a verification (spec §23.3 #2).
  expect(container.querySelector(".success, .pass, [data-status='PASS']")).toBeNull();
  // The technical record goes to the console, once.
  expect(info).toHaveBeenCalledTimes(1);
  expect(String(info.mock.calls[0]?.[0])).toContain("commit 0 LOCAL_COMMITTED");
  info.mockRestore();
});

test("Details opens a side panel with label/value rows; Escape and Close shut it and give focus back", async () => {
  const b = backend();
  const { user } = await createThen(b, completed(commit("create", summary(9, 1, "new.mochi"))));
  const toggle = screen.getByRole("button", { name: "Details" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  const panel = screen.getByTestId("write-details");
  expect(toggle).toHaveAttribute("aria-controls", panel.id);
  expect(panel).not.toBeVisible();

  await user.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(panel).toBeVisible();
  expect(screen.getByRole("complementary", { name: "Details" })).toBe(panel);
  expect(within(panel).getByRole("heading", { name: "Details" })).toHaveFocus();
  const list = screen.getByTestId("write-details-list");
  const rows = new Map(
    [...list.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]),
  );
  expect(rows.get("Files")).toBe("2");
  expect(rows.get("Folders")).toBe("1");
  expect(rows.get("Size")).toBe("2.0 KiB (2,048 bytes)");
  expect(rows.get("Status")).toBe("Committed on this computercommit 0 · LOCAL_COMMITTED");
  expect(rows.has("Folder entry on disk")).toBe(false);
  expect(panel).toHaveTextContent(
    "This archive is one file on this computer. Keep a separate copy of anything you cannot lose.",
  );
  // A clean commit has no caution badge.
  expect(screen.queryByTestId("write-badge")).toBeNull();

  await user.keyboard("{Escape}");
  expect(panel).not.toBeVisible();
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(toggle).toHaveFocus();

  await user.click(toggle);
  await user.click(screen.getByTestId("write-details-close"));
  expect(panel).not.toBeVisible();
  expect(toggle).toHaveFocus();
});

test("a degraded directory entry shows a caution badge and stays neutral: no success styling, nothing in the line", async () => {
  const b = backend();
  const note = "directory flush ran, but Windows does not document it as durable";
  const { user, container } = await createThen(
    b,
    completed({ ...commit("create", summary(9, 1, "new.mochi")), durability_note: note }),
  );
  const status = screen.getByTestId("write-status");
  expect(screen.getByTestId("write-headline")).toHaveTextContent(/^Created new\.mochi · 2 files · 1 folder · 2\.0 KiB$/);
  expect(screen.getByTestId("write-headline")).not.toHaveTextContent(/degraded|durable|not confirmed/i);
  // A hidden pointer in the live region lets a screen reader announce it.
  const hint = screen.getByTestId("write-attention");
  expect(hint).toHaveClass("sr-only");
  expect(hint).toHaveTextContent("1 item needs attention, see Details");
  expect(status).toContainElement(hint);
  expect(status).not.toHaveTextContent(/degraded|durable|not confirmed/i);
  expect(status).not.toHaveClass("warning");
  const toggle = screen.getByRole("button", { name: "Details, 1 item needs attention" });
  expect(toggle).toHaveAttribute("data-cautions", "1");
  expect(screen.getByTestId("write-badge")).toBeInTheDocument();
  expect(container.querySelector(".success, .pass, [data-status='PASS']")).toBeNull();

  await user.click(toggle);
  const row = screen.getByText("Not confirmed").closest("dd");
  expect(row).toHaveClass("result-caution");
  expect(row).toHaveTextContent("Degraded");
  expect(row).toHaveTextContent(note);
  expect(screen.getByText("Folder entry on disk").tagName).toBe("DT");
});

test("items not stored make the result partial in the line, with reasons listed as text in the details", async () => {
  const b = backend();
  const { user, container } = await createThen(
    b,
    completed({
      ...commit("add", summary(3, 2)),
      skipped: [
        { path: { text: HOSTILE, verbatim: true }, reason: "symbolic links are not stored" },
        { path: { text: "a\\u{a}b", verbatim: false }, reason: "not a file or folder" },
      ],
    }),
  );
  const status = screen.getByTestId("write-status");
  expect(status).toHaveTextContent("Added to fake.mochi · 2 files · 1 folder · 2.0 KiB · 2 items not stored");
  expect(status).toHaveClass("warning");
  await user.click(screen.getByRole("button", { name: "Details, 1 item needs attention" }));
  const items = screen.getAllByTestId("write-not-stored-item");
  expect(items).toHaveLength(2);
  expect(items[0]).toHaveTextContent(`${HOSTILE}: symbolic links are not stored`);
  expect(items[1]).toHaveTextContent("a\\u{a}b (escaped): not a file or folder");
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("[src], a[href]")).toBeNull();
});

test("a removal says in one line that earlier versions keep the content, and the details say it again in full", async () => {
  const user = userEvent.setup();
  const b = backend();
  const archive = summary(3, 2);
  renderWriter({ archive, selected: [{ key: "6162", name: { text: "x", verbatim: true } }] });
  await user.click(screen.getByTestId("remove-entry"));
  await user.click(screen.getByTestId("delete-confirm"));
  await screen.findByTestId("write-running");
  b.job({ event: "finished", job_id: 5, outcome: completed({ ...commit("delete", archive), removed: 3 }) });
  expect(screen.getByTestId("write-status")).toHaveTextContent(
    /^Removed 3 items from this version\. Earlier versions still have them\.$/,
  );
  await user.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByTestId("write-details")).toHaveTextContent("stays in the archive's history");
});

test("a result can be dismissed, which closes its panel and keeps focus on the page", async () => {
  const b = backend();
  const { user } = await createThen(b, completed(commit("create", summary(9, 1, "new.mochi"))));
  await user.click(screen.getByRole("button", { name: "Details" }));
  await user.click(screen.getByRole("button", { name: "Dismiss result" }));
  expect(screen.queryByTestId("write-result")).toBeNull();
  expect(screen.queryByTestId("write-details")).toBeNull();
  expect(screen.getByTestId("write-status")).toBeEmptyDOMElement();
});

test("a cancel or a failure stays plain lines with no Details, and can be dismissed", async () => {
  const b = backend();
  const { user } = await createThen(b, { status: "failed", code: "IO_ERROR", message: "disk" });
  expect(screen.getByTestId("write-status")).toHaveTextContent("Failed (IO_ERROR): disk");
  expect(screen.getByTestId("write-status")).toHaveTextContent("Nothing was committed.");
  expect(screen.queryByRole("button", { name: /Details/ })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Dismiss result" }));
  expect(screen.getByTestId("write-status")).toBeEmptyDOMElement();
});

test("a job that cannot start shows the error and leaves the panel usable", async () => {
  const user = userEvent.setup();
  mockIPC((cmd) => {
    if (cmd === "staged_sources") return { items: [{ name: { text: "x", verbatim: true }, kind: "file" }], destination: null, default_destination: null };
    if (cmd === "watch_drops") return null;
    if (cmd === "recent_archives") return [];
    if (cmd === "choose_destination") return { items: [], destination: "n.mochi", default_destination: null };
    if (cmd === "start_job") throw { code: "INVALID_ARGUMENT", message: "nothing is staged" };
    throw new Error(cmd);
  });
  renderWriter();
  await user.click(screen.getByTestId("new-archive"));
  await user.click(await screen.findByTestId("create-confirm"));
  const err = await screen.findByTestId("write-error");
  expect(err).toHaveTextContent("Could not start (INVALID_ARGUMENT): nothing is staged");
  expect(screen.queryByTestId("write-running")).toBeNull();
});

test("a drop opens the create panel with what was dropped, as text; with an archive open it is added at once", async () => {
  const b = backend();
  const { container, rerender } = renderWriter();
  b.drop({ event: "hover", active: true });
  expect(screen.getByTestId("drop-overlay")).toBeInTheDocument();
  b.drop({
    event: "dropped",
    staged: { items: [{ name: { text: HOSTILE, verbatim: true }, kind: "file" }], destination: null, default_destination: null },
    problems: [{ code: "INVALID_ARGUMENT", message: "x would be stored under the same name as y" }],
  });
  b.drop({ event: "hover", active: false });
  expect(screen.queryByTestId("drop-overlay")).toBeNull();
  expect(screen.getByRole("group", { name: "Create a new archive" })).toBeInTheDocument();
  expect(screen.getByTestId("staged-item")).toHaveTextContent(HOSTILE);
  expect(screen.getByTestId("write-problems")).toHaveTextContent("Not added (INVALID_ARGUMENT)");
  expect(container.querySelector("img")).toBeNull();

  // With an archive open, a drop is added to it at once: one commit, no dialog.
  const open = summary(3, 2);
  rerender(<Writer archive={open} viewingHead selected={[]} onCommitted={() => undefined} />);
  const user = userEvent.setup();
  await user.click(screen.getByTestId("write-close"));
  b.drop({
    event: "dropped",
    staged: { items: [{ name: { text: "more", verbatim: true }, kind: "folder" }], destination: null, default_destination: null },
    problems: [],
  });
  expect(screen.queryByTestId("write-panel")).toBeNull();
  await waitFor(() => expect(b.request()).toEqual({ kind: "add_to_archive", handle: 3 }));
});

test("a drop on an older version adds nothing and says only the latest can be changed", async () => {
  const b = backend();
  render(<Writer archive={summary(3, 2)} viewingHead={false} selected={[]} onCommitted={() => undefined} />);
  b.drop({
    event: "dropped",
    staged: { items: [{ name: { text: "more", verbatim: true }, kind: "folder" }], destination: null, default_destination: null },
    problems: [],
  });
  expect(await screen.findByTestId("write-error")).toHaveTextContent("Only the latest version can be changed");
  expect(b.cmds()).not.toContain("start_job");
});

test("an archive file dropped on an open archive is added to it, not opened", async () => {
  const b = backend();
  const opened: string[] = [];
  render(
    <Writer
      archive={summary(3, 2)}
      viewingHead
      selected={[]}
      onCommitted={() => undefined}
      onArchiveDropped={() => opened.push("opened")}
    />,
  );
  b.drop({ event: "archive", name: "photos.zip", foreign: true });
  await waitFor(() => expect(b.request()).toEqual({ kind: "add_to_archive", handle: 3 }));
  expect(b.cmds()).toContain("stage_dropped_archive");
  expect(opened).toEqual([]);
  // A .mochi file still opens.
  b.drop({ event: "archive", name: "other.mochi", foreign: false });
  expect(opened).toEqual(["opened"]);
});

test("add: starts an add job for the open archive and says the archive's profile was fixed at creation", async () => {
  const user = userEvent.setup();
  const b = backend();
  const archive = { ...summary(3, 2), profile: { tar_compatible: true, encrypted: false, redundancy_percent: null } };
  renderWriter({ archive });
  await user.click(screen.getByTestId("add-to-archive"));
  expect(screen.getByTestId("write-panel")).toHaveTextContent("TAR-compatible, as chosen when it was created");
  expect(screen.getByTestId("add-confirm")).toBeDisabled();
  await user.click(screen.getByTestId("stage-files"));
  await user.click(await screen.findByTestId("add-confirm"));
  await screen.findByTestId("write-running");
  expect(b.request()).toEqual({ kind: "add_to_archive", handle: 3 });
});

test("adding is only offered with an archive open", () => {
  backend();
  renderWriter();
  expect(screen.getByTestId("add-to-archive")).toBeDisabled();
  expect(screen.getByTestId("remove-entry")).toBeDisabled();
});

test("remove: asks first, states that history keeps the content, and Keep starts nothing", async () => {
  const user = userEvent.setup();
  const b = backend();
  const archive = summary(3, 2);
  renderWriter({ archive, selected: [{ key: "6162", name: { text: HOSTILE, verbatim: true } }] });
  await user.click(screen.getByTestId("remove-entry"));
  const panel = screen.getByTestId("write-panel");
  expect(panel).toHaveTextContent(`Remove ${HOSTILE} from the current version?`);
  const note = screen.getByTestId("delete-note");
  expect(note).toHaveTextContent("removes the entry from the current version only");
  expect(note).toHaveTextContent("stays in the archive's history");
  expect(note).toHaveTextContent("retention and garbage collection");
  expect(within(panel).queryByRole("img")).toBeNull();

  await user.click(screen.getByTestId("delete-keep"));
  expect(screen.queryByTestId("write-panel")).toBeNull();
  expect(b.cmds()).not.toContain("start_job");

  await user.click(screen.getByTestId("remove-entry"));
  await user.click(screen.getByTestId("delete-confirm"));
  await screen.findByTestId("write-running");
  expect(b.request()).toEqual({ kind: "delete_from_archive", handle: 3, keys: ["6162"] });
});

test("only the latest version can be changed", () => {
  backend();
  renderWriter({
    archive: summary(3, 2),
    viewingHead: false,
    selected: [{ key: "61", name: { text: "a", verbatim: true } }],
  });
  expect(screen.getByTestId("remove-entry")).toBeDisabled();
  expect(screen.getByTestId("remove-entry")).toHaveAttribute("title", "Only the latest version can be changed");
});

test("the browser shows the archive as it stands after a commit: same handle for add, new handle for create", async () => {
  const user = userEvent.setup();
  const b = backend();
  render(<Browser />);
  await user.click(screen.getByTestId("open-archive"));
  await screen.findByTestId("archive-meta");
  expect(screen.getByTestId("toggle-versions")).toHaveAttribute("title", "1 version");

  // Add to the open archive: now two commits, shown at the head.
  await user.click(screen.getByTestId("add-to-archive"));
  await user.click(screen.getByTestId("stage-files"));
  await user.click(await screen.findByTestId("add-confirm"));
  await screen.findByTestId("write-running");
  b.job({ event: "finished", job_id: 5, outcome: completed(commit("add", summary(3, 2))) });
  await waitFor(() => expect(screen.getByTestId("toggle-versions")).toHaveAttribute("title", "2 versions"));
  const snaps = b.calls.filter((c) => c.cmd === "open_snapshot").map((c) => c.args);
  expect(snaps.at(-1)).toEqual({ handle: 3, seq: 1 });
  expect(b.cmds()).not.toContain("close_archive");

  // Create a new archive: it replaces the one on screen, which is closed.
  await user.click(screen.getByTestId("new-archive"));
  await user.click(screen.getByTestId("stage-folder"));
  await user.click(await screen.findByTestId("create-confirm"));
  await screen.findByTestId("write-running");
  b.job({ event: "finished", job_id: 5, outcome: completed(commit("create", summary(9, 1, "made.mochi"))) });
  await screen.findByText("made.mochi");
  expect(b.calls.filter((c) => c.cmd === "close_archive").map((c) => c.args)).toEqual([{ handle: 3 }]);
  expect(b.calls.filter((c) => c.cmd === "open_snapshot").map((c) => c.args).at(-1)).toEqual({ handle: 9, seq: 0 });
});
