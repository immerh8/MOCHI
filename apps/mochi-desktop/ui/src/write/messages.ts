// What the app says about a create, add, or delete (spec §23.3). After a
// commit it may say the commit completed; it must not say the data is backed
// up, safe, or preserved (#6). A deletion is removal from the current
// snapshot, with a clear statement that the content stays in history (#5).
// Nothing here is a verification, so none of it gets success styling.
import { t, tc } from "../i18n";
import type { CommitReport } from "../ipc/write";
import type { JobOutcome } from "../ipc/jobs";
import { formatSize } from "../browser/format";

export type Operation = "create" | "add" | "delete";

/** Shown with every commit: the honest limit of a local commit (spec §5.3). */
export const LOCAL_COMMIT_NOTE = t("write.localCommitNote");

/** The deletion statement (spec §23.3 #5, §16.3). */
export const DELETE_NOTE = t("write.deleteNote");

/** The trade-offs of the TAR-compatible option (plan O4, spec D4, D19). */
export const TAR_NOTES = [t("write.tar1"), t("write.tar2"), t("write.tar3"), t("write.tar4")];

/** The result of a job as text lines; the first is the headline. */
export function outcomeLines(operation: Operation, outcome: JobOutcome): string[] {
  switch (outcome.status) {
    case "completed":
      return outcome.commit
        ? commitLines(outcome.commit)
        : [t("common.completed", { summary: outcome.summary })];
    case "cancelled":
      return [t(operation === "create" ? "write.cancelledCreate" : "write.cancelledOther")];
    case "failed": {
      // A commit that could not be confirmed may or may not have been
      // published (spec §12.4): do not claim either.
      const unsure = outcome.code === "COMMIT_UNCONFIRMED" || outcome.code === "WRITER_POISONED";
      return [
        t("common.failed", { code: outcome.code, message: outcome.message }),
        t(unsure ? "write.unsureCommit" : "write.nothingCommitted"),
      ];
    }
    case "aborted":
      return [t("common.stoppedUnexpectedly", { message: outcome.message }), t("write.openAgain")];
  }
}

function commitLines(c: CommitReport): string[] {
  const where = c.archive ? t("write.committedWhere", { file: c.archive.file_name }) : "";
  const status = c.status;
  const lines: string[] = [];
  if (c.operation === "delete") {
    lines.push(
      t("write.committedDelete", {
        seq: c.seq,
        where,
        status,
        entries: tc(c.removed, "count.entryOne", "count.entryMany"),
      }),
      DELETE_NOTE,
    );
  } else {
    lines.push(
      t("write.committedAdd", {
        seq: c.seq,
        where,
        status,
        files: tc(c.files, "count.fileOne", "count.fileMany"),
        folders: tc(c.directories, "count.folderOne", "count.folderMany"),
        size: formatSize(String(c.bytes)),
      }),
    );
  }
  for (const s of c.skipped) {
    lines.push(
      t("write.notStored", {
        path: s.path.text,
        escaped: s.path.verbatim ? "" : t("common.escapedMarker"),
        reason: s.reason,
      }),
    );
  }
  if (c.durability_note) {
    lines.push(t("write.degraded", { note: c.durability_note }));
  }
  if (c.reopen_error) {
    lines.push(
      t("write.reopenError", { code: c.reopen_error.code, message: c.reopen_error.message }),
    );
  }
  lines.push(LOCAL_COMMIT_NOTE);
  return lines;
}

/** How a running job's progress reads. */
export function progressText(phase: string, completed: number, total: number | null): string {
  if (phase === "import") return t("write.progressImport", { size: formatSize(String(completed)) });
  if (phase === "delete") {
    return t("write.progressDelete", { completed, total: total ?? t("write.progressTotalUnknown") });
  }
  return total === null
    ? t("write.progressPhase", { phase, completed })
    : t("write.progressPhaseOf", { phase, completed, total });
}
