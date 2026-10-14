// What the app says about an extraction (spec §23.3). Extracting is not a
// verification: it speaks only of what it extracted, gives nothing success
// styling, and never calls the archive or the copies "safe" or "backed up".
// A cancelled or failed extraction says plainly what may remain in the folder.
import { formatSize } from "../browser/format";
import { t, tc } from "../i18n";
import type { JobOutcome } from "../ipc/jobs";
import type { ExtractReport } from "../ipc/extract";

/** Shown with every extraction: what the engine checked, and what it did not. */
export const CHECK_NOTE = t("extract.checkNote");

/** The rule every collision follows (plan C6): shown with the conflict list. */
export const CONFLICT_NOTE = t("extract.conflictNote");

/** The options the extraction engine does not have (plan D3 "Gap"). */
export const NOT_OFFERED_NOTE = t("extract.notOffered");

/** Restores into a folder others can change are refused or limited (C6). */
export const FOLDER_NOTE = t("extract.folderNote");

export interface Described {
  /** First line: what happened. */
  headline: string;
  /** More lines, in order. */
  notes: string[];
  /** Whether the extraction ran to its end (it may still list exceptions). */
  completed: boolean;
}

/** Codes that end a job before it wrote anything. */
const BEFORE_WRITING = new Set([
  "NAME_COLLISION",
  "NAME_UNSUPPORTED",
  "INVALID_ARGUMENT",
  "UNSUPPORTED_FEATURE",
  "KEY_UNAVAILABLE",
]);

export function describe(outcome: JobOutcome): Described {
  switch (outcome.status) {
    case "completed": {
      const r = outcome.extract;
      if (!r) {
        return { headline: t("common.completed", { summary: outcome.summary }), notes: [], completed: true };
      }
      return { headline: extractedLine(r), notes: reportNotes(r), completed: true };
    }
    case "cancelled":
      return {
        headline: t("extract.cancelled"),
        notes: [t("extract.cancelledNote1"), t("extract.cancelledNote2")],
        completed: false,
      };
    case "failed":
      return {
        headline: t("common.failed", { code: outcome.code, message: outcome.message }),
        notes: [
          t(BEFORE_WRITING.has(outcome.code) ? "extract.nothingWritten" : "extract.mayHaveExtracted"),
        ],
        completed: false,
      };
    case "aborted":
      return {
        headline: t("common.stoppedUnexpectedly", { message: outcome.message }),
        notes: [t("extract.mayHaveExtracted")],
        completed: false,
      };
  }
}

function extractedLine(r: ExtractReport): string {
  const what = t("extract.what2", {
    files: tc(r.files, "count.fileOne", "count.fileMany"),
    size: formatSize(String(r.bytes)),
    folders: tc(r.directories, "count.folderOne", "count.folderMany"),
  });
  const line = t("extract.extractedAll", { what, seq: r.seq, dest: r.destination });
  if (r.not_extracted_total === 0) return line;
  const n = r.not_extracted_total.toLocaleString("en-US");
  return `${line} ${t(r.not_extracted_total === 1 ? "extract.notExtractedOne" : "extract.notExtractedMany", { n })}`;
}

function reportNotes(r: ExtractReport): string[] {
  const notes: string[] = [];
  if (r.attributes_unavailable) {
    notes.push(t("extract.attributesUnavailable", { reason: r.attributes_unavailable.text }));
  }
  if (r.durability_note) {
    notes.push(t("extract.durabilityNote", { note: r.durability_note }));
  }
  if (r.case_insensitive) {
    notes.push(t("extract.caseInsensitive"));
  }
  notes.push(CHECK_NOTE);
  return notes;
}

/** One attribute note as a sentence. */
export function attributeLine(n: ExtractReport["attribute_notes"][number]): string {
  return t("extract.attributeLine", {
    attribute: n.attribute,
    count: tc(n.count, "count.entryOne", "count.entryMany"),
    path: n.first_path.text,
    escaped: n.first_path.verbatim ? "" : t("common.escapedMarker"),
    reason: n.reason.text,
  });
}

/** How a running extraction's progress reads. */
export function progressText(phase: string, completed: number, total: number | null): string {
  if (phase === "restore") {
    return total === null
      ? t("extract.progressRestore", { completed })
      : t("extract.progressRestoreOf", { completed, total });
  }
  return total === null
    ? t("extract.progressPhase", { phase, completed })
    : t("extract.progressPhaseOf", { phase, completed, total });
}
