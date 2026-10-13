// What the app says about tests, health, and repairs (spec §20.4, §22.2,
// §23.3). Status values are the report's own (§20.4), each dimension is shown
// on its own, and only PASS may look like success: UNKNOWN, OVERDUE,
// UNSUPPORTED, and DEGRADED never do (§23.3 #2). A repair is labelled by what
// its report establishes; nothing here calls an archive "repaired", "safe",
// "backed up", or "preserved", or says it was "recovered completely".
import { formatSize } from "../browser/format";
import type { JobOutcome } from "../ipc/jobs";
import type {
  CheckLevel,
  RepairOutcomeView,
  RepairPlanView,
  RepairResultView,
  ReportView,
  StatusView,
} from "../ipc/check";

/** Words the app never uses about an archive or a repair (§23.3 #4, #6). */
export const BANNED = [
  "backed up",
  "backup",
  "safe",
  "preserved",
  "secure",
  "repaired",
  "recovered completely",
  "fully recovered",
];

export const STATUSES: StatusView[] = ["PASS", "FAIL", "DEGRADED", "UNKNOWN", "OVERDUE", "UNSUPPORTED"];

/** Spec §20.4, in words. */
export const STATUS_MEANING: Record<StatusView, string> = {
  PASS: "required checks completed successfully within policy",
  FAIL: "a required check found a violation",
  DEGRADED: "some capability remains, but a required protection is reduced",
  UNKNOWN: "evidence is insufficient or unavailable",
  OVERDUE: "required evidence is older than policy permits",
  UNSUPPORTED: "this build cannot perform the required interpretation or check",
};

/**
 * The CSS classes of a status. Only PASS gets the success class; FAIL gets
 * the failure class; everything else is neutral and marked as needing
 * attention, never success.
 */
export function statusClass(s: StatusView): string {
  switch (s) {
    case "PASS":
      return "status status-pass";
    case "FAIL":
      return "status status-fail";
    case "DEGRADED":
    case "UNKNOWN":
    case "OVERDUE":
    case "UNSUPPORTED":
      return "status status-attention";
  }
}

const DIMENSIONS: Record<string, string> = {
  durability: "Durability",
  integrity: "Integrity",
  recoverability: "Recoverability",
  searchability: "Searchability",
  freshness: "Freshness",
  retention_compliance: "Retention compliance",
  key_availability: "Key availability",
};

/** A dimension's name for display; an unknown one as the report spells it. */
export function dimensionLabel(name: string): string {
  return DIMENSIONS[name] ?? name;
}

export const LEVELS: { level: CheckLevel; label: string; detail: string }[] = [
  {
    level: "restoration",
    label: "Restoration (default)",
    detail: "every data object read, decoded, and every retained file version reassembled in memory",
  },
  {
    level: "content_integrity",
    label: "Content integrity",
    detail: "every data object read and decoded",
  },
  {
    level: "stored_integrity",
    label: "Stored integrity",
    detail: "every data object's stored bytes hashed",
  },
  {
    level: "referential",
    label: "Referential",
    detail: "references and frame boundaries only; integrity stays UNKNOWN",
  },
  {
    level: "structural",
    label: "Structural",
    detail: "control objects only; integrity stays UNKNOWN",
  },
];

/** Shown with every test: what "Test archive" is. */
export const TEST_NOTE =
  "Testing reads the archive and changes nothing in it. The result below is the report the core library produced, shown per dimension.";

/** Explains UNKNOWN freshness the first time it appears (spec §5.7, D8). */
export const FRESHNESS_NOTE =
  "Freshness is UNKNOWN: this app keeps no record yet of the head it saw earlier for this archive, so it cannot tell whether this file is the latest copy or an older one. Internal checks cannot show that. This is expected on first sight; it is not a failure, and it is never shown as a pass.";

/** Shown when an Encrypted archive was checked without its key. */
export const KEYLESS_NOTE =
  "This archive is encrypted and the check needs its passphrase, which this app cannot take yet. It was checked without the key: stored bytes, commit records, and key envelopes only. Names, content, and recoverability were not checked, and a check without the key is never PASS overall. The mochi command-line tool can check it with the passphrase.";

/** Shown with every health summary (plan D4 "Gap"). */
export const HEALTH_NOTE =
  "Health runs no check: it summarises the evidence recorded about this archive and judges it at the archive's current head. This app records only the tests run in this window since it started, and does not save them; evidence recorded by the mochi command-line tool is not read yet.";

/** Shown with every repair plan. */
export const PLAN_NOTE =
  "Planning read the archive and changed nothing. Applying writes a new file you choose; the archive itself is never written.";

/** Shown with the approval. */
export const APPROVAL_NOTE =
  "Applying writes exactly this plan into a new file. The core library surveys the archive again first and refuses to write anything if the archive or the copies changed. The new file is verified before it is published.";

/** The overall line of a report: never hides a failing dimension. */
export function overallLine(r: ReportView): string {
  const failing = r.dimensions.filter((d) => d.status === "FAIL").map((d) => dimensionLabel(d.dimension));
  const base = `Overall ${r.overall_status} (exit code ${r.exit_code}); policy result ${r.policy_result}.`;
  return failing.length === 0 ? base : `${base} Failing: ${failing.join(", ")}.`;
}

/** What was checked, in one line. */
export function headline(r: ReportView): string {
  const what =
    r.kind === "health"
      ? `Health of ${r.file_name}`
      : `Test of ${r.file_name}, level ${r.level}${r.deep ? ", deep (fsck)" : ""}`;
  return `${what}: ${r.overall_status}.`;
}

export function coverageLine(r: ReportView): string | null {
  const c = r.coverage;
  if (c.expected_objects === null || c.checked_objects === null) return null;
  const bytes =
    c.checked_bytes !== null && c.expected_bytes !== null
      ? ` (${formatSize(c.checked_bytes)} of ${formatSize(c.expected_bytes)} stored)`
      : "";
  return `Data objects checked: ${c.checked_objects} of ${c.expected_objects}${bytes}.`;
}

export const OUTCOME_LABEL: Record<RepairOutcomeView, string> = {
  complete: "COMPLETE",
  partial: "PARTIAL",
  nothing_recoverable: "NOTHING RECOVERABLE",
};

/** The plan's verdict, in one line. Partial salvage is labelled as such. */
export function planLine(p: RepairPlanView): string {
  switch (p.outcome) {
    case "complete":
      return "Plan: COMPLETE. Every snapshot in the archive's history and every entry would be written to the new file, with its retention.";
    case "partial":
      return p.salvage_used
        ? `Plan: PARTIAL SALVAGE. Some snapshots rest on the bounded salvage scan, so the result is partial whatever it contains; ${lostSummary(p.lost.length, p.omitted_total)}.`
        : `Plan: PARTIAL. ${capitalize(lostSummary(p.lost.length, p.omitted_total))}.`;
    case "nothing_recoverable":
      return "Plan: NOTHING RECOVERABLE. There is nothing to write; nothing was changed.";
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function lostSummary(lost: number, omitted: string): string {
  const parts = [
    `${lost} snapshot${lost === 1 ? "" : "s"} would not be written`,
    `${omitted} entr${omitted === "1" ? "y" : "ies"} would be left out`,
  ];
  return parts.join(" and ");
}

/** What a written repair is, in one line, from its report only. */
export function resultLine(r: RepairResultView): string {
  const wrote = `Wrote the new archive ${r.file_name} (${formatSize(r.new_len)}, ${r.commits.length} commit${r.commits.length === 1 ? "" : "s"}).`;
  switch (r.outcome) {
    case "complete":
      return `${wrote} Outcome COMPLETE: the plan left nothing out.`;
    case "partial":
      return r.salvage_used
        ? `${wrote} Outcome PARTIAL SALVAGE: ${r.lost.length} snapshot(s) not written, ${r.omitted_total} entr${r.omitted_total === "1" ? "y" : "ies"} left out, and some snapshots rest on the salvage scan.`
        : `${wrote} Outcome PARTIAL: ${r.lost.length} snapshot(s) not written, ${r.omitted_total} entr${r.omitted_total === "1" ? "y" : "ies"} left out.`;
    case "nothing_recoverable":
      return `${wrote} Outcome: nothing recoverable.`;
  }
}

/** The re-verification, in one line (spec §22.2). */
export function reverificationLine(r: RepairResultView): string {
  const v = r.reverification;
  return `Re-verified before it was published (level ${v.level}): overall ${v.overall_status}, policy result ${v.policy_result}, exit code ${v.exit_code}, ${v.findings} finding(s).`;
}

export const SOURCE_KEPT_NOTE =
  "The archive you chose was only read; it is unchanged and kept. The new archive has a new archive ID.";

/** A job that ended without a result, in words. */
export function failedLine(what: string, outcome: JobOutcome): string | null {
  switch (outcome.status) {
    case "completed":
      return null;
    case "cancelled":
      return `${what} cancelled before it finished. Nothing was written.`;
    case "failed":
      return `${what} failed (${outcome.code}): ${outcome.message}`;
    case "aborted":
      return `${what} stopped unexpectedly: ${outcome.message}`;
  }
}

/** How a running test or repair reads. */
export function progressText(phase: string, completed: number, total: number | null): string {
  const n = total === null ? `${completed}` : `${completed} of ${total}`;
  const names: Record<string, string> = {
    "repair-survey": "Surveying commits",
    "repair-check": "Reading file versions",
    "repair-salvage": "Salvage scan",
    "repair-copy": "Writing snapshots",
    "repair-verify": "Re-verifying the new archive",
  };
  const label = names[phase] ?? (phase.startsWith("verify") ? `Checking (${phase})` : phase);
  return `${label}: ${n}`;
}

/**
 * Each item with a stable React key made from `text` (repeats get "#2", "#3",
 * … in order) and its position, for lists whose items need not be unique.
 */
export function keyed<T>(items: readonly T[], text: (item: T) => string): { key: string; item: T; index: number }[] {
  const seen = new Map<string, number>();
  return items.map((item, index) => {
    const base = text(item);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { key: n === 1 ? base : `${base}#${n}`, item, index };
  });
}
