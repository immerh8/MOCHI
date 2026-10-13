import { expect, test } from "vitest";

import type { ExtractReport } from "../ipc/extract";
import type { JobOutcome } from "../ipc/jobs";
import { attributeLine, CHECK_NOTE, describe, progressText } from "./messages";

const text = (s: string, verbatim = true) => ({ text: s, verbatim });

function report(extra: Partial<ExtractReport> = {}): ExtractReport {
  return {
    destination: "/home/me/out",
    seq: 3,
    files: 4,
    directories: 2,
    bytes: 2048,
    not_extracted: [],
    not_extracted_total: 0,
    attribute_notes: [],
    attributes_unavailable: null,
    durability_note: null,
    case_insensitive: false,
    ...extra,
  };
}

const done = (r: ExtractReport): JobOutcome => ({ status: "completed", summary: "s", extract: r });

const BANNED = ["backed up", "backup", "safe", "preserved", "secure", "verified", "pass"];

function everything(outcome: JobOutcome): string {
  const d = describe(outcome);
  return [d.headline, ...d.notes].join("\n").toLowerCase();
}

test("a completed extraction states what it extracted and that it is not a verification", () => {
  const d = describe(done(report()));
  expect(d.headline).toBe(
    "Extracted 4 files (2.0 KiB (2,048 bytes)) and 2 folders from commit 3 to /home/me/out.",
  );
  expect(d.completed).toBe(true);
  expect(d.notes).toContain(CHECK_NOTE);
  expect(CHECK_NOTE).toContain("not a verification of the archive");
});

test("exceptions change the headline: the extraction is not described as complete", () => {
  const d = describe(done(report({ not_extracted_total: 1, files: 1, directories: 0, bytes: 1 })));
  expect(d.headline).toBe(
    "Extracted 1 file (1 byte) and 0 folders from commit 3 to /home/me/out. 1 entry was not extracted.",
  );
  const many = describe(done(report({ not_extracted_total: 12 })));
  expect(many.headline).toContain("12 entries were not extracted.");
});

test("unavailable attributes, unconfirmed durability, and case folding are all said", () => {
  const d = describe(
    done(
      report({
        attributes_unavailable: text("snapshot manifest damaged"),
        durability_note: "no directory sync",
        case_insensitive: true,
      }),
    ),
  );
  const all = d.notes.join("\n");
  expect(all).toContain("No times, permissions, or other attributes were applied");
  expect(all).toContain("snapshot manifest damaged");
  expect(all).toContain("Degraded: the folder's entries are not confirmed durable");
  expect(all).toContain("differ only in case");
});

test("an attribute note names the kind, the count, the first entry and the reason", () => {
  const line = attributeLine({
    attribute: "owner and group",
    count: 3,
    first_path: text("a\\u{a}b", false),
    reason: text("needs privilege"),
  });
  expect(line).toBe(
    "Not applied: owner and group, on 3 entries. First: a\\u{a}b (escaped). needs privilege",
  );
  expect(
    attributeLine({ attribute: "permissions", count: 1, first_path: text("x"), reason: text("r") }),
  ).toContain("on 1 entry.");
});

test("a cancelled extraction says what stays and that attributes may be missing", () => {
  const d = describe({ status: "cancelled" });
  expect(d.completed).toBe(false);
  expect(d.headline).toContain("Cancelled");
  expect(d.notes.join(" ")).toContain("stay in the folder, each one complete");
  expect(d.notes.join(" ")).toContain("file being written was discarded");
  expect(d.notes.join(" ")).toContain("recorded times and permissions");
});

test("a failure before writing says nothing was written; any other says files may remain", () => {
  for (const code of ["NAME_COLLISION", "NAME_UNSUPPORTED", "UNSUPPORTED_FEATURE", "INVALID_ARGUMENT"]) {
    const d = describe({ status: "failed", code, message: "m" });
    expect(d.headline).toBe(`Failed (${code}): m`);
    expect(d.notes).toEqual(["Nothing was written."]);
  }
  const d = describe({ status: "failed", code: "IO_ERROR", message: "disk full" });
  expect(d.notes[0]).toContain("Some files may already have been extracted");
  const a = describe({ status: "aborted", message: "boom" });
  expect(a.headline).toBe("Stopped unexpectedly: boom");
  expect(a.notes[0]).toContain("may already have been extracted");
});

test("no outcome is described as backed up, safe, preserved, or verified", () => {
  const outcomes: JobOutcome[] = [
    done(report()),
    done(report({ not_extracted_total: 2, attributes_unavailable: text("x") })),
    { status: "cancelled" },
    { status: "failed", code: "IO_ERROR", message: "m" },
    { status: "aborted", message: "m" },
  ];
  for (const o of outcomes) {
    const s = everything(o);
    for (const word of BANNED.filter((w) => w !== "verified")) expect(s).not.toContain(word);
    // "verification" appears only in the sentence that denies it.
    const without = s.replace(CHECK_NOTE.toLowerCase(), "");
    expect(without).not.toContain("verified");
    expect(without).not.toContain("verification");
  }
});

test("progress reads as entries", () => {
  expect(progressText("restore", 3, 8)).toBe("Extracting: 3 of 8 entries");
  expect(progressText("restore", 3, null)).toBe("Extracting: 3 entries");
});
