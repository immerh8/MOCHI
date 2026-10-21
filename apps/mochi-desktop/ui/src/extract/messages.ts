// What the app says about an extraction (spec §23.3). Extracting is not a
// verification: it speaks only of what it extracted, gives nothing success
// styling, and never calls the archive or the copies "safe" or "backed up".
// A cancelled or failed extraction says plainly what may remain in the folder.
import { formatSize } from "../browser/format";
import { formatNumber, t, tc } from "../i18n";
import type { JobOutcome } from "../ipc/jobs";
import type { ExtractReport } from "../ipc/extract";
import { countParts, joinParts } from "../result/details";
import type { DetailRow, ResultDetails } from "../result/details";

/** Shown with every extraction: what the engine checked, and what it did not. */
export const checkNote = () => t("extract.checkNote");

/** The rule every collision follows (plan C6): shown with the conflict list. */
export const conflictNote = () => t("extract.conflictNote");

/** The options the extraction engine does not have (plan D3 "Gap"). */
export const notOfferedNote = () => t("extract.notOffered");

/** Restores into a folder others can change are refused or limited (C6). */
export const folderNote = () => t("extract.folderNote");

export interface Described {
  /** First line: what happened. */
  headline: string;
  /** More lines, in order. */
  notes: string[];
  /** Whether the extraction ran to its end (it may still list exceptions). */
  completed: boolean;
  /** The Details panel of a finished extraction; `null` for a cancel or a failure. */
  details: ResultDetails | null;
  /** Some entries were not extracted: the line gets warning styling. */
  warn: boolean;
  /** The technical record, for the console. */
  record: string | null;
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
        return {
          headline: t("common.completed", { summary: outcome.summary }),
          notes: [],
          completed: true,
          details: null,
          warn: false,
          record: null,
        };
      }
      return {
        headline: extractedLine(r),
        notes: [],
        completed: true,
        details: reportDetails(r),
        warn: r.not_extracted_total > 0,
        record: reportRecord(r),
      };
    }
    case "cancelled":
      return {
        headline: t("extract.cancelled"),
        notes: [t("extract.cancelledNote1"), t("extract.cancelledNote2")],
        completed: false,
        details: null,
        warn: false,
        record: null,
      };
    case "failed":
      return {
        headline: t("common.failed", { code: outcome.code, message: outcome.message }),
        notes: [
          t(BEFORE_WRITING.has(outcome.code) ? "extract.nothingWritten" : "extract.mayHaveExtracted"),
        ],
        completed: false,
        details: null,
        warn: false,
        record: null,
      };
    case "aborted":
      return {
        headline: t("common.stoppedUnexpectedly", { message: outcome.message }),
        notes: [t("extract.mayHaveExtracted")],
        completed: false,
        details: null,
        warn: false,
        record: null,
      };
  }
}

/**
 * One short line: what was extracted, and (so an overall line does not hide
 * it) how many entries were not. Where it went is in the details and on the
 * "Show in folder" button.
 */
function extractedLine(r: ExtractReport): string {
  const line = t("extract.line", { parts: joinParts(countParts(r.files, r.directories, r.bytes)) });
  if (r.not_extracted_total === 0) return line;
  const n = tc(r.not_extracted_total, "extract.lineNotExtractedOne", "extract.lineNotExtractedMany");
  return `${line}${t("common.statusSeparator")}${n}`;
}

function reportDetails(r: ExtractReport): ResultDetails {
  const rows: DetailRow[] = [
    { label: t("extract.rowFolder"), value: r.destination, testId: "extract-destination-result" },
    { label: t("extract.rowVersion"), value: String(r.seq) },
    { label: t("extract.rowFiles"), value: formatNumber(r.files) },
    { label: t("extract.rowFolders"), value: formatNumber(r.directories) },
    { label: t("extract.rowSize"), value: formatSize(String(r.bytes)) },
  ];
  if (r.durability_note) {
    rows.push({
      label: t("extract.rowFolderEntries"),
      value: t("extract.notConfirmed"),
      sub: t("extract.degradedMark"),
      note: r.durability_note,
      caution: true,
    });
  }
  if (r.not_extracted.length > 0 || r.not_extracted_total > 0) {
    rows.push({
      label: t("extract.rowNotExtracted"),
      value: tc(r.not_extracted_total, "count.entryOne", "count.entryMany"),
      items: r.not_extracted.map((e) => ({
        name: e.path,
        code: e.code,
        text: `${e.reason.text}${e.reason.verbatim ? "" : t("common.escapedMarker")}`,
      })),
      more: r.not_extracted_total - r.not_extracted.length,
      caution: true,
      testId: "extract-not-extracted",
      itemTestId: "extract-not-extracted-item",
    });
  }
  if (r.attributes_unavailable) {
    rows.push({
      label: t("extract.rowAttributes"),
      value: t("extract.attributesNotApplied"),
      note: t("extract.attributesUnavailable", { reason: r.attributes_unavailable.text }),
      caution: true,
    });
  }
  if (r.attribute_notes.length > 0) {
    rows.push({
      label: t("extract.rowAttributeNotes"),
      value: tc(r.attribute_notes.length, "common.itemOne", "common.itemMany"),
      items: r.attribute_notes.map((n) => ({ text: attributeLine(n) })),
      caution: true,
      testId: "extract-attributes",
      itemTestId: "extract-attribute-note",
    });
  }
  const notes: string[] = [];
  if (r.case_insensitive) notes.push(t("extract.caseInsensitive"));
  notes.push(checkNote());
  return { rows, notes };
}

function reportRecord(r: ExtractReport): string {
  return [
    `extract version ${r.seq}`,
    `files ${r.files}, folders ${r.directories}, bytes ${r.bytes}`,
    `not extracted ${r.not_extracted_total}`,
    r.durability_note ? `directory entries not confirmed durable (${r.durability_note})` : "directory entries confirmed",
    ...(r.attributes_unavailable ? ["attributes unavailable"] : []),
  ].join("; ");
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
