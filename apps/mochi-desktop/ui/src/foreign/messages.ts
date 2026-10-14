// What the app says about a foreign archive (plan D8 rule 6, spec §23.3).
// Nothing here uses MOCHI's verification vocabulary or health dimensions: a
// foreign "test" names the checks that ran, recoverability, freshness and
// retention are UNSUPPORTED, and an extraction is never a verification.
import { formatSize } from "../browser/format";
import { t, tc } from "../i18n";
import type { ExtractReport } from "../ipc/extract";
import type { ForeignArchiveSummary, ForeignTestReport } from "../ipc/foreign";
import type { JobOutcome } from "../ipc/jobs";

/** Shown next to every opened foreign archive. */
export const FOREIGN_NOTE = t("foreign.note");

/** The only thing "Read and check" claims. */
export const TEST_NOTE = t("foreign.testNote");

/** The rule every extraction follows (plan D8 rule 4). */
export const EXTRACT_NOTE = t("foreign.extractNote");

export const WEAK_NOTE = t("foreign.weakNote");

/** The three health dimensions MOCHI archives have and foreign ones do not. */
export function dimensionsLine(d: ForeignArchiveSummary["dimensions"]): string {
  return t("foreign.dimensions", {
    recoverability: d.recoverability,
    freshness: d.freshness,
    retention: d.retention,
  });
}

/** Password errors the open flow handles by asking. */
export function needsPassword(code: string): "ask" | "wrong" | null {
  if (code === "PASSWORD_REQUIRED") return "ask";
  if (code === "WRONG_PASSWORD") return "wrong";
  return null;
}

/** One line for the test result, in the format's own words. */
export function testHeadline(r: ForeignTestReport): string {
  return t("foreign.testHeadline", {
    entries: tc(r.entries, "count.entryOne", "count.entryMany"),
    format: r.format,
    problems: tc(r.problems_total, "count.problemOne", "count.problemMany"),
    early: r.complete ? "" : t("foreign.testEarly"),
  });
}

/** How a finished job reads (extract or test). */
export function describeOutcome(outcome: JobOutcome): { headline: string; notes: string[] } {
  switch (outcome.status) {
    case "completed": {
      if (outcome.foreign_test) return { headline: testHeadline(outcome.foreign_test), notes: [TEST_NOTE] };
      const r = outcome.extract;
      if (!r) return { headline: t("common.completed", { summary: outcome.summary }), notes: [] };
      return { headline: extractedLine(r), notes: [outcome.summary] };
    }
    case "cancelled":
      return { headline: t("foreign.cancelled"), notes: [t("foreign.cancelledNote")] };
    case "failed":
      return {
        headline: t("common.failed", { code: outcome.code, message: outcome.message }),
        notes: [t("foreign.failedNote")],
      };
    case "aborted":
      return { headline: t("common.stoppedUnexpectedly", { message: outcome.message }), notes: [] };
  }
}

function extractedLine(r: ExtractReport): string {
  const what = t("foreign.what", {
    files: tc(r.files, "count.fileOne", "count.fileMany"),
    size: formatSize(String(r.bytes)),
    folders: tc(r.directories, "count.folderOne", "count.folderMany"),
  });
  const line = t("foreign.extracted", { what, dest: r.destination });
  if (r.not_extracted_total === 0) return line;
  const n = r.not_extracted_total.toLocaleString("en-US");
  return `${line} ${t(r.not_extracted_total === 1 ? "foreign.notExtractedOne" : "foreign.notExtractedMany", { n })}`;
}

export function progressText(phase: string, completed: number, total: number | null): string {
  const reading = phase === "foreign_test";
  if (total === null) {
    return t(reading ? "foreign.progressReadingNoTotal" : "foreign.progressExtractingNoTotal", { completed });
  }
  return t(reading ? "foreign.progressReading" : "foreign.progressExtracting", { completed, total });
}
