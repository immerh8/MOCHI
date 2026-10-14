// What the app says about a foreign archive (plan D8 rule 6, spec §23.3).
// Nothing here uses MOCHI's verification vocabulary or health dimensions: a
// foreign "test" names the checks that ran, recoverability, freshness and
// retention are UNSUPPORTED, and an extraction is never a verification.
import { formatSize } from "../browser/format";
import type { ExtractReport } from "../ipc/extract";
import type { ForeignArchiveSummary, ForeignTestReport } from "../ipc/foreign";
import type { JobOutcome } from "../ipc/jobs";

/** Shown next to every opened foreign archive. */
export const FOREIGN_NOTE =
  "This is not a MOCHI archive. It is open read-only, and MOCHI's own checks do not apply to it.";

/** The only thing "Read and check" claims. */
export const TEST_NOTE =
  "Reads every entry and runs the checks this format has. It does not verify the archive the way MOCHI verifies its own, and a result here says nothing about recoverability, freshness, or retention.";

/** The rule every extraction follows (plan D8 rule 4). */
export const EXTRACT_NOTE =
  "Nothing is overwritten and no name is changed. Links, devices, absolute paths, and names containing .. are never created. Each file is kept only if the format's own check, where it has one, passed.";

export const WEAK_NOTE =
  "Some entries use ZipCrypto, a weak form of encryption that known-plaintext attacks break.";

/** The three health dimensions MOCHI archives have and foreign ones do not. */
export function dimensionsLine(d: ForeignArchiveSummary["dimensions"]): string {
  return `Recoverability: ${d.recoverability} · Freshness: ${d.freshness} · Retention: ${d.retention}`;
}

/** Password errors the open flow handles by asking. */
export function needsPassword(code: string): "ask" | "wrong" | null {
  if (code === "PASSWORD_REQUIRED") return "ask";
  if (code === "WRONG_PASSWORD") return "wrong";
  return null;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** One line for the test result, in the format's own words. */
export function testHeadline(r: ForeignTestReport): string {
  const p = r.problems_total;
  return `Read ${plural(r.entries, "entry", "entries")} of the ${r.format} archive: ${plural(p, "problem", "problems")}.${r.complete ? "" : " The run stopped early, so this covers only part of the archive."}`;
}

/** How a finished job reads (extract or test). */
export function describeOutcome(outcome: JobOutcome): { headline: string; notes: string[] } {
  switch (outcome.status) {
    case "completed": {
      if (outcome.foreign_test) return { headline: testHeadline(outcome.foreign_test), notes: [TEST_NOTE] };
      const r = outcome.extract;
      if (!r) return { headline: `Completed: ${outcome.summary}.`, notes: [] };
      return { headline: extractedLine(r), notes: [outcome.summary] };
    }
    case "cancelled":
      return {
        headline: "Cancelled. The operation stopped before it finished.",
        notes: [
          "Files extracted before you cancelled stay in the folder, each one complete. The file being written was discarded.",
        ],
      };
    case "failed":
      return {
        headline: `Failed (${outcome.code}): ${outcome.message}`,
        notes: ["Nothing was written unless the message says otherwise."],
      };
    case "aborted":
      return { headline: `Stopped unexpectedly: ${outcome.message}`, notes: [] };
  }
}

function extractedLine(r: ExtractReport): string {
  const what = `${plural(r.files, "file", "files")} (${formatSize(String(r.bytes))}) and ${plural(r.directories, "folder", "folders")}`;
  return r.not_extracted_total === 0
    ? `Extracted ${what} to ${r.destination}.`
    : `Extracted ${what} to ${r.destination}. ${plural(r.not_extracted_total, "entry was", "entries were")} not extracted.`;
}

export function progressText(phase: string, completed: number, total: number | null): string {
  const what = phase === "foreign_test" ? "Reading" : "Extracting";
  return total === null ? `${what}: ${completed} entries` : `${what}: ${completed} of ${total} entries`;
}
