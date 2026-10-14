import { expect, test } from "vitest";

import type { StatusView } from "../ipc/check";
import { planView, report, resultView } from "./fixtures";
import * as m from "./messages";

const ALL: StatusView[] = ["PASS", "FAIL", "DEGRADED", "UNKNOWN", "OVERDUE", "UNSUPPORTED"];

test("only PASS gets the success class; FAIL the failure class; the rest neither", () => {
  expect(m.STATUSES).toEqual(ALL);
  for (const s of ALL) {
    const c = m.statusClass(s);
    expect(c.split(" ").includes("status-pass")).toBe(s === "PASS");
    expect(c.split(" ").includes("status-fail")).toBe(s === "FAIL");
    if (s !== "PASS" && s !== "FAIL") expect(c).toBe("status status-attention");
  }
});

test("the overall line never hides a failing dimension", () => {
  const r = report({
    dimensions: [
      { dimension: "integrity", status: "FAIL", required: true },
      { dimension: "freshness", status: "UNKNOWN", required: false },
    ],
    overall_status: "FAIL",
    policy_result: "FAIL",
    exit_code: 1,
  });
  expect(m.overallLine(r)).toBe("Overall FAIL (exit code 1); policy result FAIL. Failing: Integrity.");
  expect(m.overallLine(report())).not.toContain("Failing");
  expect(m.headline(report({ deep: true }))).toBe("Test of a.mochi, level restoration, deep (fsck): UNKNOWN.");
  expect(m.headline(report({ kind: "health" }))).toBe("Health of a.mochi: UNKNOWN.");
});

test("plans and results are labelled by their outcome; partial salvage says so", () => {
  expect(m.planLine(planView())).toBe(
    "Plan: PARTIAL. 0 snapshots would not be written and 1 entry would be left out.",
  );
  expect(m.planLine(planView({ salvage_used: true }))).toMatch(/^Plan: PARTIAL SALVAGE\./);
  expect(m.planLine(planView({ outcome: "complete", omitted: [], omitted_total: "0" }))).toMatch(/^Plan: COMPLETE\./);
  expect(m.planLine(planView({ outcome: "nothing_recoverable" }))).toMatch(/nothing was changed/);
  expect(m.resultLine(resultView())).toMatch(/Outcome PARTIAL: 0 snapshot\(s\) not written, 1 entry left out\.$/);
  expect(m.resultLine(resultView({ salvage_used: true }))).toMatch(/PARTIAL SALVAGE/);
  expect(m.resultLine(resultView({ outcome: "complete", omitted: [], omitted_total: "0" }))).toMatch(
    /Outcome COMPLETE: the plan left nothing out\.$/,
  );
  expect(m.reverificationLine(resultView())).toBe(
    "Re-verified before it was published (level restoration): overall UNKNOWN, policy result PASS, exit code 0, 0 finding(s).",
  );
});

test("no message uses a banned word", () => {
  const texts: string[] = [
    m.TEST_NOTE,
    m.FRESHNESS_NOTE,
    m.KEYLESS_NOTE,
    m.HEALTH_NOTE,
    m.PLAN_NOTE,
    m.APPROVAL_NOTE,
    m.SOURCE_KEPT_NOTE,
    ...Object.values(m.STATUS_MEANING),
    ...Object.values(m.OUTCOME_LABEL),
    ...m.LEVELS.flatMap((l) => [l.label, l.detail]),
    m.overallLine(report()),
    m.headline(report()),
    m.coverageLine(report()) ?? "",
  ];
  for (const outcome of ["complete", "partial", "nothing_recoverable"] as const) {
    for (const salvage_used of [false, true]) {
      texts.push(m.planLine(planView({ outcome, salvage_used })));
      texts.push(m.resultLine(resultView({ outcome, salvage_used })));
    }
  }
  texts.push(m.reverificationLine(resultView()));
  for (const kind of ["The test", "Planning", "Writing the new archive"]) {
    texts.push(m.failedLine(kind, { status: "cancelled" }) ?? "");
    texts.push(m.failedLine(kind, { status: "failed", code: "IO_ERROR", message: "x" }) ?? "");
  }
  for (const t of texts) {
    for (const word of m.BANNED) expect(t.toLowerCase()).not.toContain(word);
  }
});

test("freshness UNKNOWN is explained as not a failure and never a pass", () => {
  expect(m.FRESHNESS_NOTE).toMatch(/UNKNOWN/);
  expect(m.FRESHNESS_NOTE).toMatch(/not a failure/);
  expect(m.FRESHNESS_NOTE).toMatch(/never shown as a pass/);
  expect(m.KEYLESS_NOTE).toMatch(/without its passphrase/);
  expect(m.KEYLESS_NOTE).toMatch(/never PASS overall/);
});

test("keys are unique and stable for repeated items", () => {
  expect(m.keyed(["a", "b", "a"], (x) => x).map((k) => k.key)).toEqual(["a", "b", "a#2"]);
  expect(m.keyed(["a", "b"], (x) => x).map((k) => k.index)).toEqual([0, 1]);
  expect(m.dimensionLabel("key_availability")).toBe("Key availability");
  expect(m.dimensionLabel("new_thing")).toBe("new_thing");
  expect(m.progressText("repair-check", 3, 10)).toBe("Reading file versions: 3 of 10");
  expect(m.coverageLine(report({ coverage: { ...report().coverage, checked_objects: null } }))).toBeNull();
});
