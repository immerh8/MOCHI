// What the app says about passphrases, encryption, the recovery record, and
// search coverage (spec §23.3; AGENTS.md "Encrypted profile" and "Redundancy
// profile"). Nothing here may say an archive is "safe", "secure", "backed
// up", or "preserved", or that a passphrase was "revoked": removing one is
// not revocation, and a recovery record is a repair aid, not a second copy.
import type { RekeyReport, SearchCoverageView } from "../ipc/crypt";

/** Shown whenever a passphrase is being chosen. */
export const LOST_PASSPHRASE =
  "If you lose every passphrase for this archive, its contents are lost. There is no recovery: nothing in the file, in MOCHI, or in a repair can supply a passphrase. Keep the passphrase somewhere independent of the archive and of its copies.";

/** Shown whenever encryption is chosen: deduplication is always on. */
export const DEDUP_LEAK =
  "Identical content is stored once, also in an encrypted archive. Anyone who can compare the file before and after a change can learn whether the added content was already in it.";

export const HIDDEN_WITH_KEY =
  "Sealed: file names, attributes, file sizes, folder structure, and content.";

/** What stays visible to anyone holding the file (docs/c11-encrypted.md). */
export const VISIBLE_WITHOUT_KEY = [
  "The archive ID, the number of commits, and their parent links.",
  "The number, kind, and sizes of stored objects, and whether a commit added data.",
  "The key envelopes: their IDs and how costly it is to guess each passphrase.",
  "Compressed sizes (content is compressed, then encrypted).",
];

export const NOT_SIGNED =
  "The commit history is not signed. Someone who can rewrite the whole file can roll it back or withhold commits.";

export const NO_GENERIC_TOOLS =
  "Standard zstd and tar tools cannot unpack an encrypted archive, so it cannot also be TAR-compatible.";

/** The wrong-passphrase answer: an operational error, not a finding. */
export const WRONG_PASSPHRASE = "The passphrase did not open this archive.";
export const WRONG_PASSPHRASE_NOTE =
  "This says nothing about the condition of the archive. Check the passphrase and try again.";

export const REMOVE_NOT_REVOCATION =
  "Removing a passphrase is not revocation. Anyone who knew it and kept a copy of the file can still open that copy, and the removed key envelope stays in this file's history. Only re-encrypting to a new file gives a new data key, and that does not recall copies already made.";

export const REENCRYPT_NOTE =
  "Re-encrypting writes a new file under a new data key and the new passphrase. The original file is not changed and still opens with its old passphrases; retire it yourself if you want it gone. Copies already made are not recalled.";

export const REKEY_NEEDS_UNLOCK =
  "Open the archive with its passphrase first: changing passphrases needs the key.";

/** Recovery-record choices (percent of each commit's bytes). */
export const RECOVERY_CHOICES = [5, 10, 20, 50] as const;

export const RECOVERY_NOTES = [
  "A recovery record is extra data that can rebuild bounded damage to this same file. It is not a second copy, and an archive that has one is not protected against losing the file.",
  "Within each group of stored data it can rebuild damaged blocks up to about the chosen percentage. Damage beyond that is reported and left as it is; nothing more is promised.",
  "It does not cover the newest commit's footer or the recovery data itself.",
  "The file grows by about the percentage you choose, and by more for small commits.",
  "It is fixed when the archive is created. Keep an independent copy as well.",
];

export function recoveryLabel(percent: number): string {
  return `${percent}% extra data`;
}

/** The result of a rekey job as lines; the first is the headline. */
export function rekeyLines(r: RekeyReport): string[] {
  const lines: string[] = [];
  switch (r.action) {
    case "added":
      lines.push(
        `Committed commit ${r.seq ?? "?"} (${r.status ?? "LOCAL_COMMITTED"}): a passphrase was added to ${r.file_name}. The data key and the data are unchanged.`,
      );
      break;
    case "removed":
      lines.push(
        `Committed commit ${r.seq ?? "?"} (${r.status ?? "LOCAL_COMMITTED"}): a passphrase was removed from ${r.file_name}'s current key set. The data key and the data are unchanged.`,
        REMOVE_NOT_REVOCATION,
      );
      break;
    case "reencrypted":
      lines.push(
        `Wrote ${r.file_name}: ${r.snapshots} snapshot${r.snapshots === 1 ? "" : "s"} under a new data key and the new passphrase.`,
        REENCRYPT_NOTE,
      );
      break;
  }
  if (r.durability_note) {
    lines.push(
      `Degraded: the directory entry is not confirmed durable (${r.durability_note}).`,
    );
  }
  if (r.reopen_error) {
    lines.push(
      `The archive could not be opened again with the key held (${r.reopen_error.code}): ${r.reopen_error.message} Open it again with a passphrase that is still in its key set.`,
    );
  }
  return lines;
}

function rangeText(ranges: { from: number; to: number }[]): string {
  if (ranges.length === 0) return "none";
  return ranges.map((r) => (r.from === r.to ? `${r.from}` : `${r.from}–${r.to}`)).join(", ");
}

/**
 * Search coverage as lines (spec §19.3, §23.3 #8): what was searched, what
 * was not, and what "no matches" can and cannot mean.
 */
export function coverageLines(c: SearchCoverageView): string[] {
  const lines = [
    `Searched ${c.searched_count} of ${c.requested_count} requested snapshot${c.requested_count === 1 ? "" : "s"} (commits ${rangeText(c.searched)}); ${c.entries_examined.toLocaleString("en-US")} entries examined.`,
  ];
  if (c.complete) {
    lines.push("Coverage is complete for the snapshots requested: no matches means no matching names there.");
  } else {
    lines.push(
      "Coverage is PARTIAL. Some requested snapshots were not searched, so finding nothing is not proof that nothing matches.",
    );
  }
  for (const u of c.unavailable) {
    lines.push(`Not searched: commit ${u.seq} (${u.code}): ${u.message.text}`);
  }
  if (c.opened_separately.length > 0) {
    lines.push(
      `Commits ${rangeText(c.opened_separately)} were opened one by one because the head's catalog was rebuilt from a snapshot manifest.`,
    );
  }
  if (c.catalog_from_manifest) {
    lines.push("The catalog image at the head was damaged; a snapshot manifest stood in for it.");
  }
  if (c.content_not_searched) {
    lines.push("File contents were not searched, only names. Full-text search is not built.");
  }
  return lines;
}
