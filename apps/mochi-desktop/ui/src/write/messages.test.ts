import { expect, test } from "vitest";

import type { CommitReport } from "../ipc/write";
import type { JobOutcome } from "../ipc/jobs";
import { DELETE_NOTE, LOCAL_COMMIT_NOTE, outcomeLines, TAR_NOTES } from "./messages";
import type { Operation } from "./messages";

const ARCHIVE = {
  handle: 1,
  file_name: "a.mochi",
  archive_id: "ab".repeat(16),
  profile: { tar_compatible: false, encrypted: false, redundancy_percent: null },
  commits: [],
  retention_error: null,
};

function report(operation: CommitReport["operation"], extra: Partial<CommitReport> = {}): CommitReport {
  return {
    operation,
    status: "LOCAL_COMMITTED",
    seq: 4,
    commit_id: "c".repeat(64),
    files: 3,
    directories: 1,
    bytes: 1536,
    removed: 0,
    skipped: [],
    durability_note: null,
    archive: ARCHIVE,
    reopen_error: null,
    ...extra,
  };
}

const ALL: [Operation, JobOutcome][] = [
  ["create", { status: "completed", summary: "s", commit: report("create") }],
  ["add", { status: "completed", summary: "s", commit: report("add") }],
  ["delete", { status: "completed", summary: "s", commit: report("delete", { removed: 2 }) }],
  [
    "add",
    {
      status: "completed",
      summary: "s",
      commit: report("add", {
        skipped: [{ path: { text: "docs/link", verbatim: true }, reason: "symbolic links are not stored" }],
        durability_note: "directory sync unsupported",
        reopen_error: { code: "LIMIT_EXCEEDED", message: "too many archives" },
      }),
    },
  ],
  ["create", { status: "cancelled" }],
  ["add", { status: "cancelled" }],
  ["add", { status: "failed", code: "IO_ERROR", message: "disk" }],
  ["add", { status: "failed", code: "COMMIT_UNCONFIRMED", message: "sync" }],
  ["add", { status: "aborted", message: "boom" }],
];

function at(i: number): JobOutcome {
  const entry = ALL[i];
  if (!entry) throw new Error(`no case ${i}`);
  return entry[1];
}

test("no message claims the data is backed up, safe, or preserved (spec §23.3 #6)", () => {
  const banned = [/backed up/i, /backup/i, /\bsafe/i, /preserv/i, /secure/i, /protected/i];
  const text = [
    ...ALL.flatMap(([op, o]) => outcomeLines(op, o)),
    DELETE_NOTE,
    LOCAL_COMMIT_NOTE,
    ...TAR_NOTES,
  ].join("\n");
  for (const b of banned) expect(text).not.toMatch(b);
});

test("a commit says it completed locally and names its status", () => {
  const lines = outcomeLines("add", at(1));
  expect(lines[0]).toBe("Added to a.mochi: 3 files, 1 folder, 1.5 KiB (1,536 bytes).");
  expect(lines).toContain(LOCAL_COMMIT_NOTE);
  // The precise term and the status are kept, as the last line.
  expect(lines.at(-1)).toBe("Technical detail: commit 4 (LOCAL_COMMITTED).");
});

test("a deletion is removal from the current version and says the content stays in history", () => {
  const lines = outcomeLines("delete", at(2));
  expect(lines[0]).toContain("Removed 2 entries from the current version of a.mochi");
  expect(lines[0]).toContain("Earlier versions still have them");
  const note = lines.join(" ");
  expect(note).toContain("stays in the archive's history");
  expect(note).toContain("retention and garbage collection");
  expect(note).toContain("does not make the archive smaller");
});

test("skips, degraded durability, and a failed reopen are all stated", () => {
  const text = outcomeLines("add", at(3)).join("\n");
  expect(text).toContain("Not stored: docs/link: symbolic links are not stored");
  expect(text).toContain("Degraded: the new file's directory entry is not confirmed durable");
  expect(text).toContain("could not be opened again for browsing (LIMIT_EXCEEDED)");
});

test("cancelled and failed jobs say what did not happen; an unconfirmed commit claims neither", () => {
  expect(outcomeLines("create", { status: "cancelled" })).toEqual(["Cancelled. No archive was created."]);
  expect(outcomeLines("add", { status: "cancelled" })[0]).toContain("Nothing was committed");
  expect(outcomeLines("add", { status: "failed", code: "IO_ERROR", message: "disk" })).toEqual([
    "Failed (IO_ERROR): disk",
    "Nothing was committed.",
  ]);
  for (const code of ["COMMIT_UNCONFIRMED", "WRITER_POISONED"]) {
    const text = outcomeLines("add", { status: "failed", code, message: "m" }).join(" ");
    expect(text).toContain("may or may not have been published");
    expect(text).not.toContain("Nothing was committed");
  }
});
