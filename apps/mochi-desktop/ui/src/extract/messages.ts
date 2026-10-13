// What the app says about an extraction (spec §23.3). Extracting is not a
// verification: it speaks only of what it extracted, gives nothing success
// styling, and never calls the archive or the copies "safe" or "backed up".
// A cancelled or failed extraction says plainly what may remain in the folder.
import { formatSize } from "../browser/format";
import type { JobOutcome } from "../ipc/jobs";
import type { ExtractReport } from "../ipc/extract";

/** Shown with every extraction: what the engine checked, and what it did not. */
export const CHECK_NOTE =
  "Each extracted file was checked against the hashes recorded in the archive before it was kept. Extracting is not a verification of the archive: nothing else in it was checked.";

/** The rule every collision follows (plan C6): shown with the conflict list. */
export const CONFLICT_NOTE =
  "Nothing is overwritten and no name is changed. If a folder is skipped, everything inside it is skipped too.";

/** The options the extraction engine does not have (plan D3 "Gap"). */
export const NOT_OFFERED_NOTE =
  "Replacing existing items, or keeping both under a new name, is not available yet. To keep both, extract into a different or new folder.";

/** Restores into a folder others can change are refused or limited (C6). */
export const FOLDER_NOTE = "Extract into a folder only you can modify.";

export interface Described {
  /** First line: what happened. */
  headline: string;
  /** More lines, in order. */
  notes: string[];
  /** Whether the extraction ran to its end (it may still list exceptions). */
  completed: boolean;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
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
      if (!r) return { headline: `Completed: ${outcome.summary}.`, notes: [], completed: true };
      return { headline: extractedLine(r), notes: reportNotes(r), completed: true };
    }
    case "cancelled":
      return {
        headline: "Cancelled. The extraction stopped before it finished.",
        notes: [
          "Files extracted before you cancelled stay in the folder, each one complete. The file being written was discarded.",
          "Folders already made may not have their recorded times and permissions yet: those are applied at the end.",
        ],
        completed: false,
      };
    case "failed":
      return {
        headline: `Failed (${outcome.code}): ${outcome.message}`,
        notes: [
          BEFORE_WRITING.has(outcome.code)
            ? "Nothing was written."
            : "Some files may already have been extracted into the folder.",
        ],
        completed: false,
      };
    case "aborted":
      return {
        headline: `Stopped unexpectedly: ${outcome.message}`,
        notes: ["Some files may already have been extracted into the folder."],
        completed: false,
      };
  }
}

function extractedLine(r: ExtractReport): string {
  const what = `${plural(r.files, "file", "files")} (${formatSize(String(r.bytes))}) and ${plural(r.directories, "folder", "folders")}`;
  return r.not_extracted_total === 0
    ? `Extracted ${what} from commit ${r.seq} to ${r.destination}.`
    : `Extracted ${what} from commit ${r.seq} to ${r.destination}. ${plural(r.not_extracted_total, "entry was", "entries were")} not extracted.`;
}

function reportNotes(r: ExtractReport): string[] {
  const notes: string[] = [];
  if (r.attributes_unavailable) {
    notes.push(
      `No times, permissions, or other attributes were applied: they could not be read from the archive (${r.attributes_unavailable.text}).`,
    );
  }
  if (r.durability_note) {
    notes.push(
      `Degraded: the folder's entries are not confirmed durable on disk (${r.durability_note}).`,
    );
  }
  if (r.case_insensitive) {
    notes.push("This folder treats names that differ only in case as the same name.");
  }
  notes.push(CHECK_NOTE);
  return notes;
}

/** One attribute note as a sentence. */
export function attributeLine(n: ExtractReport["attribute_notes"][number]): string {
  return `Not applied: ${n.attribute}, on ${plural(n.count, "entry", "entries")}. First: ${n.first_path.text}${n.first_path.verbatim ? "" : " (escaped)"}. ${n.reason.text}`;
}

/** How a running extraction's progress reads. */
export function progressText(phase: string, completed: number, total: number | null): string {
  if (phase === "restore") {
    return total === null
      ? `Extracting: ${completed} entries`
      : `Extracting: ${completed} of ${total} entries`;
  }
  return total === null ? `${phase}: ${completed}` : `${phase}: ${completed} of ${total}`;
}
