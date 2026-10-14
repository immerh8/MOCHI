import { expect, test } from "vitest";

import type { SearchCoverageView } from "../ipc/crypt";
import * as m from "./messages";

const BANNED = ["safe", "backed up", "backup", "preserved", "secure", "revoked"];

function everyText(): string[] {
  const complete: SearchCoverageView = {
    complete: true,
    requested: [{ from: 0, to: 2 }],
    searched: [{ from: 0, to: 2 }],
    requested_count: 3,
    searched_count: 3,
    unavailable: [],
    opened_separately: [],
    entries_examined: 12,
    indexed_seq: 2,
    catalog_from_manifest: false,
    content_not_searched: true,
  };
  const partial: SearchCoverageView = {
    ...complete,
    complete: false,
    searched: [{ from: 0, to: 0 }, { from: 2, to: 2 }],
    searched_count: 2,
    unavailable: [{ seq: 1, code: "CATALOG_INVALID", message: { text: "bad", verbatim: true } }],
    opened_separately: [{ from: 2, to: 2 }],
    catalog_from_manifest: true,
  };
  const report = (action: "added" | "removed" | "reencrypted") => ({
    action,
    seq: 3,
    status: "LOCAL_COMMITTED",
    file_name: "v.mochi",
    snapshots: 2,
    new_archive_id: null,
    durability_note: "dir not synced",
    archive: null,
    reopen_error: { code: "KEY_UNAVAILABLE", message: m.WRONG_PASSPHRASE },
  });
  return [
    m.LOST_PASSPHRASE,
    m.DEDUP_LEAK,
    m.HIDDEN_WITH_KEY,
    ...m.VISIBLE_WITHOUT_KEY,
    m.NOT_SIGNED,
    m.NO_GENERIC_TOOLS,
    m.WRONG_PASSPHRASE,
    m.WRONG_PASSPHRASE_NOTE,
    m.REMOVE_NOT_REVOCATION,
    m.REENCRYPT_NOTE,
    m.REKEY_NEEDS_UNLOCK,
    ...m.RECOVERY_NOTES,
    ...m.RECOVERY_CHOICES.map(m.recoveryLabel),
    ...m.rekeyLines(report("added")),
    ...m.rekeyLines(report("removed")),
    ...m.rekeyLines(report("reencrypted")),
    ...m.coverageLines(complete),
    ...m.coverageLines(partial),
  ];
}

test("no message calls anything safe, secure, backed up, preserved, or revoked", () => {
  for (const text of everyText()) {
    for (const word of BANNED) {
      expect(text.toLowerCase(), `"${word}" in: ${text}`).not.toContain(word);
    }
  }
});

test("a lost passphrase means lost data, with no recovery", () => {
  expect(m.LOST_PASSPHRASE).toMatch(/contents are lost/);
  expect(m.LOST_PASSPHRASE).toMatch(/no recovery/);
});

test("the deduplication equality leak is disclosed", () => {
  expect(m.DEDUP_LEAK).toMatch(/stored once/);
  expect(m.DEDUP_LEAK).toMatch(/already in it/);
});

test("what stays visible without the key is listed, and the history is said to be unsigned", () => {
  const visible = m.VISIBLE_WITHOUT_KEY.join(" ");
  for (const part of ["archive ID", "number of commits", "sizes of stored objects", "key envelopes", "Compressed sizes"]) {
    expect(visible).toContain(part);
  }
  expect(m.HIDDEN_WITH_KEY).toMatch(/file names/);
  expect(m.NOT_SIGNED).toMatch(/not signed/);
});

test("a wrong passphrase is not described as damage", () => {
  expect(m.WRONG_PASSPHRASE).toBe("The passphrase did not open this archive.");
  const text = `${m.WRONG_PASSPHRASE} ${m.WRONG_PASSPHRASE_NOTE}`.toLowerCase();
  for (const word of ["damage", "corrupt", "tamper", "invalid"]) expect(text).not.toContain(word);
});

test("removing a passphrase is said not to be revocation, and every removal result repeats it", () => {
  expect(m.REMOVE_NOT_REVOCATION).toMatch(/not revocation/);
  expect(m.REMOVE_NOT_REVOCATION).toMatch(/kept a copy of the file can still open that copy/);
  const lines = m.rekeyLines({
    action: "removed",
    seq: 4,
    status: "LOCAL_COMMITTED",
    file_name: "v.mochi",
    snapshots: 0,
    new_archive_id: null,
    durability_note: null,
    archive: null,
    reopen_error: null,
  });
  expect(lines).toContain(m.REMOVE_NOT_REVOCATION);
  expect(lines[0]).toMatch(/LOCAL_COMMITTED/);
});

test("the recovery record is a repair aid with a stated capacity, never a second copy", () => {
  const all = m.RECOVERY_NOTES.join(" ");
  expect(all).toMatch(/not a second copy/);
  expect(all).toMatch(/up to about the chosen percentage/);
  expect(all).toMatch(/Damage beyond that is reported and left as it is/);
  expect(all).toMatch(/newest commit's footer/);
  expect(all).toMatch(/independent copy/);
  expect(m.RECOVERY_CHOICES.every((p) => p >= 1 && p <= 100)).toBe(true);
});

test("partial search coverage says so, lists what was skipped, and never reads as complete", () => {
  const base: SearchCoverageView = {
    complete: false,
    requested: [{ from: 0, to: 3 }],
    searched: [{ from: 0, to: 0 }, { from: 2, to: 3 }],
    requested_count: 4,
    searched_count: 3,
    unavailable: [{ seq: 1, code: "CATALOG_INVALID", message: { text: "x", verbatim: true } }],
    opened_separately: [],
    entries_examined: 9,
    indexed_seq: 3,
    catalog_from_manifest: false,
    content_not_searched: true,
  };
  const text = m.coverageLines(base).join("\n");
  expect(text).toMatch(/PARTIAL/);
  expect(text).toMatch(/not proof/);
  expect(text).toMatch(/Not searched: commit 1 \(CATALOG_INVALID\)/);
  expect(text).toMatch(/commits 0, 2–3/);
  expect(text).toMatch(/File contents were not searched/);
  expect(text).not.toMatch(/Coverage is complete/);
  const full = m.coverageLines({ ...base, complete: true, unavailable: [], searched: base.requested, searched_count: 4 });
  expect(full.join("\n")).toMatch(/Coverage is complete/);
  expect(full.join("\n")).toMatch(/File contents were not searched/);
});
