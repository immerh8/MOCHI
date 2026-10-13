// What the app says about a create, add, or delete (spec §23.3). After a
// commit it may say the commit completed; it must not say the data is backed
// up, safe, or preserved (#6). A deletion is removal from the current
// snapshot, with a clear statement that the content stays in history (#5).
// Nothing here is a verification, so none of it gets success styling.
import type { CommitReport } from "../ipc/write";
import type { JobOutcome } from "../ipc/jobs";
import { formatSize } from "../browser/format";

export type Operation = "create" | "add" | "delete";

/** Shown with every commit: the honest limit of a local commit (spec §5.3). */
export const LOCAL_COMMIT_NOTE =
  "This is a local commit in one file. Keep an independent copy of anything you cannot lose.";

/** The deletion statement (spec §23.3 #5, §16.3). */
export const DELETE_NOTE =
  "This removes the entry from the current snapshot only. Its content stays in the archive's history: earlier snapshots still show it, and it is not erased until retention and garbage collection allow it. Deleting does not make the archive smaller.";

/** The trade-offs of the TAR-compatible option (plan O4, spec D4, D19). */
export const TAR_NOTES = [
  "Standard zstd and tar tools can unpack the archive.",
  "They unpack the history of every commit, not the latest snapshot: a file you delete later is still extracted, and a renamed file appears under both names.",
  "Identical files are stored again instead of once, so the archive is larger.",
  "The choice is fixed when the archive is created.",
];

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** The result of a job as text lines; the first is the headline. */
export function outcomeLines(operation: Operation, outcome: JobOutcome): string[] {
  switch (outcome.status) {
    case "completed":
      return outcome.commit ? commitLines(outcome.commit) : [`Completed: ${outcome.summary}.`];
    case "cancelled":
      return [
        operation === "create"
          ? "Cancelled. No archive was created."
          : "Cancelled. Nothing was committed; the archive is as it was.",
      ];
    case "failed": {
      // A commit that could not be confirmed may or may not have been
      // published (spec §12.4): do not claim either.
      const unsure = outcome.code === "COMMIT_UNCONFIRMED" || outcome.code === "WRITER_POISONED";
      return [
        `Failed (${outcome.code}): ${outcome.message}`,
        unsure
          ? "The commit may or may not have been published. Open the archive again to see what it holds."
          : "Nothing was committed.",
      ];
    }
    case "aborted":
      return [
        `Stopped unexpectedly: ${outcome.message}`,
        "Open the archive again to see what it holds.",
      ];
  }
}

function commitLines(c: CommitReport): string[] {
  const where = c.archive ? ` to ${c.archive.file_name}` : "";
  const status = `(${c.status})`;
  const lines: string[] = [];
  if (c.operation === "delete") {
    lines.push(
      `Committed commit ${c.seq}${where} ${status}: removed ${plural(c.removed, "entry", "entries")} from the current snapshot.`,
      DELETE_NOTE,
    );
  } else {
    lines.push(
      `Committed commit ${c.seq}${where} ${status}: ${plural(c.files, "file", "files")}, ${plural(c.directories, "folder", "folders")}, ${formatSize(String(c.bytes))}.`,
    );
  }
  for (const s of c.skipped) {
    lines.push(`Not stored: ${s.path.text}${s.path.verbatim ? "" : " (escaped)"}: ${s.reason}`);
  }
  if (c.durability_note) {
    lines.push(
      `Degraded: the new file's directory entry is not confirmed durable (${c.durability_note}).`,
    );
  }
  if (c.reopen_error) {
    lines.push(
      `The commit was made, but the archive could not be opened again for browsing (${c.reopen_error.code}): ${c.reopen_error.message}`,
    );
  }
  lines.push(LOCAL_COMMIT_NOTE);
  return lines;
}

/** How a running job's progress reads. */
export function progressText(phase: string, completed: number, total: number | null): string {
  if (phase === "import") return `Reading files: ${formatSize(String(completed))} so far`;
  if (phase === "delete") return `Preparing removal: ${completed} of ${total ?? "?"}`;
  return total === null ? `${phase}: ${completed}` : `${phase}: ${completed} of ${total}`;
}
