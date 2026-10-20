// What the app says about a create, add, or delete (spec §23.3). After a
// commit it may say the commit completed; it must not say the data is backed
// up, safe, or preserved (#6). A deletion is removal from the current
// snapshot, with a clear statement that the content stays in history (#5).
// Nothing here is a verification, so none of it gets success styling.
import { t, tc } from "../i18n";
import type { CommitReport } from "../ipc/write";
import type { JobOutcome } from "../ipc/jobs";
import { formatSize } from "../browser/format";
import { countParts, joinParts } from "../result/details";
import type { DetailRow, ResultView } from "../result/details";

export type Operation = "create" | "add" | "delete";

/** Shown with every commit: the honest limit of a local commit (spec §5.3). */
export const LOCAL_COMMIT_NOTE = t("write.localCommitNote");

/** The deletion statement (spec §23.3 #5, §16.3). */
export const DELETE_NOTE = t("write.deleteNote");

/** The trade-offs of the TAR-compatible option (plan O4, spec D4, D19). */
export const TAR_NOTES = [t("write.tar1"), t("write.tar2"), t("write.tar3"), t("write.tar4")];

/** What a finished job shows: plain lines (a cancel or a failure), or a compact commit result. */
export type WriteResult = { kind: "text"; lines: string[] } | ({ kind: "commit" } & ResultView);

/** The result of a job. A commit is one short line plus details; the rest are plain lines. */
export function outcomeResult(operation: Operation, outcome: JobOutcome): WriteResult {
  switch (outcome.status) {
    case "completed":
      return outcome.commit
        ? { kind: "commit", ...commitView(outcome.commit) }
        : { kind: "text", lines: [t("common.completed", { summary: outcome.summary })] };
    case "cancelled":
      return { kind: "text", lines: [t(operation === "create" ? "write.cancelledCreate" : "write.cancelledOther")] };
    case "failed": {
      // A commit that could not be confirmed may or may not have been
      // published (spec §12.4): do not claim either.
      const unsure = outcome.code === "COMMIT_UNCONFIRMED" || outcome.code === "WRITER_POISONED";
      return {
        kind: "text",
        lines: [
          t("common.failed", { code: outcome.code, message: outcome.message }),
          t(unsure ? "write.unsureCommit" : "write.nothingCommitted"),
        ],
      };
    }
    case "aborted":
      return {
        kind: "text",
        lines: [t("common.stoppedUnexpectedly", { message: outcome.message }), t("write.openAgain")],
      };
  }
}

/**
 * A commit as one short line and a details panel. The line states what was
 * done; anything that is not fully good (items not stored, an archive that
 * could not be opened again) is in the line as well, so an overall line never
 * hides it. The directory-entry note is a degraded dimension: it is in the
 * details with a caution marker and counts toward the badge on the Details
 * button.
 */
export function commitView(c: CommitReport): ResultView {
  const file = c.archive?.file_name ?? "";
  const isDelete = c.operation === "delete";
  const warn = c.skipped.length > 0 || c.reopen_error !== null;

  const head = isDelete
    ? t("write.committedDelete", {
        items: tc(c.removed, "common.itemOne", "common.itemMany"),
        them: c.removed === 1 ? "it" : "them",
      })
    : t("write.committedAdd", {
        verb: t(c.operation === "create" ? "write.verbCreated" : "write.verbAdded"),
        file,
        parts: joinParts(countParts(c.files, c.directories, c.bytes)),
      });
  const tail: string[] = [];
  if (c.skipped.length > 0) tail.push(tc(c.skipped.length, "write.lineNotStoredOne", "write.lineNotStoredMany"));
  if (c.reopen_error) tail.push(t("write.lineNotReopened"));
  const line = tail.length === 0 ? head : `${head}${t("common.statusSeparator")}${joinParts(tail)}`;

  const rows: DetailRow[] = [];
  if (isDelete) {
    rows.push({ label: t("write.rowRemoved"), value: tc(c.removed, "common.itemOne", "common.itemMany") });
  } else {
    rows.push(
      { label: t("write.rowFiles"), value: c.files.toLocaleString("en-US") },
      { label: t("write.rowFolders"), value: c.directories.toLocaleString("en-US") },
      { label: t("write.rowSize"), value: formatSize(String(c.bytes)) },
    );
  }
  rows.push({
    label: t("write.rowStatus"),
    value: t("write.statusCommitted"),
    sub: t("write.statusTechnical", { seq: c.seq, status: c.status }),
  });
  if (c.durability_note) {
    rows.push({
      label: t("write.rowFolderEntry"),
      value: t("write.folderEntryNotConfirmed"),
      sub: t("write.degradedMark"),
      note: c.durability_note,
      caution: true,
      testId: "write-durability",
    });
  }
  if (c.skipped.length > 0) {
    rows.push({
      label: t("write.rowNotStored"),
      value: tc(c.skipped.length, "common.itemOne", "common.itemMany"),
      items: c.skipped.map((s) => ({ name: s.path, text: s.reason })),
      caution: true,
      testId: "write-not-stored",
      itemTestId: "write-not-stored-item",
    });
  }
  if (c.reopen_error) {
    rows.push({
      label: t("write.rowReopen"),
      value: t("write.reopenFailed"),
      note: t("write.reopenDetail", { code: c.reopen_error.code, message: c.reopen_error.message }),
      caution: true,
    });
  }
  const notes = isDelete ? [DELETE_NOTE, LOCAL_COMMIT_NOTE] : [LOCAL_COMMIT_NOTE];

  const record = [
    `${c.operation} commit ${c.seq} ${c.status}`,
    `files ${c.files}, folders ${c.directories}, bytes ${c.bytes}, removed ${c.removed}`,
    `not stored ${c.skipped.length}`,
    c.durability_note ? `directory entry not confirmed durable (${c.durability_note})` : "directory entry confirmed",
    ...(c.reopen_error ? [`reopen failed ${c.reopen_error.code}`] : []),
  ].join("; ");

  return { line, warn, details: { rows, notes }, record };
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
