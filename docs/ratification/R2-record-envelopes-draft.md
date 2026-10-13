# R2 — Record-envelope layouts (FROZEN, draft 2)

> **Status 2026-10-12: frozen as part of draft 2** (gate G12, [delegated 2026-10-12];
> owner review pending at the desktop checkpoint, plan K11), with R1, R3, and R4, by the
> review in §6. Written 2026-10-11 from the working code at `main` commit `57e3a69` and
> the golden vectors in `fixtures/golden/` (`b2/`, `c11/`). The file name keeps "draft"
> for links. A change to a layout or rule below is a new draft identifier with an Annex B
> entry (spec B.2.14), never an edit. Tables marked *(checked)* are compared with the
> code by `crates/mochi-cli/tests/ratification_drafts.rs`. Names in code font
> (`decode_binary_record`, `Candidate::bind`, …) are the reference implementation's; the
> rules stand without them.

Sources: spec §8.3 and its D11 amendment, Annex B.2 D10 item 11, D11, D12, B.2.2,
B.2.10 (D20). Code: `crates/mochi-format/src/envelope.rs` (binary envelope v0 and the
shared obligation checks), `crates/mochi-core/src/image.rs` (the catalog-image
rules), and the CBOR record decoders in `crates/mochi-core/src/{descriptor,commit,manifest,keys}.rs`.
Schemas: `docs/schemas/*.cddl`.

## 1. Two encodings, one set of obligations (D11)

Spec §8.3 lists the fields every control record's envelope carries. D11 realizes them
in two encodings:

- **Deterministic-CBOR records** (descriptor, commit record, recovery manifest, key
  envelope): the envelope is a set of required keys in the record body (§3).
- **Opaque payloads** (catalog images in 1.0; dictionaries and parity when they
  exist): a fixed **binary envelope v0** precedes the payload in the same skippable
  frame (§2).

Both encodings call the same checks in `mochi-format` (`check_required_features`,
`RecordIdentity::check`), so they cannot drift apart. The obligations: *(checked:
first column)*

| §8.3 field | Obligation | Binary v0 | CBOR records |
|---|---|---|---|
| Record type | The frame kind equals the kind the referencing field names | `decode_binary_record`: `EnvelopeRules::kind` | Each referencing key names one kind (R3) |
| Schema version | Unknown: refuse (`UNSUPPORTED_FEATURE`) | Envelope version = 0, and record schema version in `EnvelopeRules::schema_versions` | Key 0 |
| Required features | Count within the reader limit, strictly increasing, every entry known; else refuse | Offset 80, 8·n bytes | Descriptor key 4, commit key 7, manifest key 9, key envelope key 4 |
| Archive identity | Equals the referencing commit's archive ID | Offset 24 | Key 1 |
| Payload encoding | CBOR: implied by the kind. Binary: a registered value, and the payload starts with its signature | Offset 8 | Implied |
| Payload length | CBOR: the whole payload is consumed. Binary: header field = frame payload − header | Offset 16 | Implied by the frame |
| Integrity scope | The stored-object hash held by the referencing record, checked **before** the envelope is decoded. A record found by scanning is a candidate until bound | Not in the header | Not in the record |
| Identity | Archive ID, commit sequence, and transaction ID of the commit the record belongs to | Offsets 24, 56, 64 | Commit keys 1–3; manifest keys 1, 2, 10; key envelope keys 1–3; descriptor key 1 only (§3) |

**No record contains the ID of the commit that references it.** The commit ID covers
the referenced objects' hashes, so that would be circular (D11).

## 2. Binary envelope v0

At the start of the skippable payload. Integers unsigned little-endian; every byte is
defined. *(checked: offsets and sizes are compared with an encoded record)*

| Offset | Size | Field | Rule |
|---|---|---|---|
| 0 | 4 | Header length | = 80 + 8·n |
| 4 | 2 | Envelope version | = 0 |
| 6 | 2 | Record schema version | Catalog image: = the image's SQLite `user_version` |
| 8 | 4 | Payload encoding | Registered values only (table below) |
| 12 | 4 | n = required-feature count | ≤ 64 (a wire rule, independent of reader limits) |
| 16 | 8 | Payload length | = frame payload length − header length |
| 24 | 32 | Archive ID | |
| 56 | 8 | Commit sequence | |
| 64 | 16 | Transaction ID | |
| 80 | 8·n | Required features | u64 each, strictly increasing |

The largest header is 80 + 8·64 = 592 bytes, so the payload budget of an enveloped
record is *S* − 592, where *S* is the skippable-payload limit (B.2.3). With default
limits that is 268,434,864 bytes, independent of how many features a record lists.

**Payload encodings.** *(checked)*

| Code | Encoding | Signature |
|---|---|---|
| 0 | SQLite 3 database image | `SQLite format 3` ‖ `00` (16 bytes) |
| 1 | Parity shard (Redundancy profile, D21; layout in R6) | `MOCHI2-PARITY` ‖ `00 00 00` (16 bytes) |

Any other value is refused (`ENVELOPE_INVALID`). Each enveloped kind carries exactly
one encoding (below); a registered encoding in the other kind's frame is refused too
(`EncodingKindMismatch`, added with encoding 1 on 2026-10-12).

**Frame kinds that carry a binary envelope.** *(checked)*

| Kind | Record |
|---|---|
| `0x184D2A50` | Catalog image (encoding 0) |
| `0x184D2A5F` | Parity frame (encoding 1; D21, R6) |

**Decode order** (`decode_binary_record`; each failure has its own fault): kind; the
80 fixed bytes present; envelope version; feature count ≤ 64 (before the header
length is computed from it); header length; payload length; payload budget; payload
encoding, and that it is the kind's own; required features; record schema version;
payload signature (and, for SQLite, `user_version` = record schema version).
A parity frame's own digest is checked **before** this decoder runs, because no
referencing record holds its hash (§4). The result is a *candidate*: nothing
may interpret its payload until `Candidate::bind` has checked its identity against
the referencing commit. Encoding refuses everything decoding refuses, plus anything
over the writer's limits (`CAPACITY_EXCEEDED`).

**Fault codes**, in decode order (`FormatError` mapped by `MochiError::from`; the
registry is R7's). Where a record has two faults the first in this order is the one
reported; no golden case has two, and the order among simultaneous faults is not wire
format.

| Step | Fault | Code |
|---|---|---|
| kind | frame kind is not the one the referencing field names, or has no envelope | `ENVELOPE_INVALID` |
| fixed header | fewer than 80 bytes, or fewer than the header length declares | `ENVELOPE_INVALID` |
| envelope version | ≠ 0 | `UNSUPPORTED_FEATURE` |
| feature count | n > 64 (the wire rule) | `ENVELOPE_INVALID` |
| header length | ≠ 80 + 8·n | `ENVELOPE_INVALID` |
| payload length | header field ≠ frame payload − header | `ENVELOPE_INVALID` |
| payload budget | payload > *S* − 592 | `LIMIT_EXCEEDED` (a writer: `CAPACITY_EXCEEDED`) |
| payload encoding | not registered; or not the kind's own | `ENVELOPE_INVALID` |
| required features | n above the reader limit (default 64) | `LIMIT_EXCEEDED` |
| | not strictly increasing | `ENVELOPE_INVALID` |
| | an entry the build does not know | `UNSUPPORTED_FEATURE` |
| record schema version | not in the kind's list | `UNSUPPORTED_FEATURE` |
| signature, `user_version` | payload lacks the encoding's signature; or SQLite `user_version` ≠ the record schema version | `ENVELOPE_INVALID` |
| identity (`bind`) | archive ID, commit sequence, or transaction ID differs from the referencing commit's | `ENVELOPE_INVALID` |

`user_version` is the big-endian signed 32-bit integer at bytes 60 to 63 of the SQLite
header; it is compared as an integer, so a value outside 0 to 65535 never matches.
A catalog image's features must also equal `[1]` exactly in an Encrypted archive and be
empty otherwise (`RECORD_INVALID`). The same identity mismatches in a CBOR record
(a manifest whose archive ID, sequence, or transaction ID differs from its commit's)
are `ENVELOPE_INVALID` too (`c5/reject-archive-manifest-*`). Known features: `{1}`
(the Encrypted profile, R5), on every kind that lists features.

## 3. CBOR-native envelope keys

The schemas are R3's; this table restates only which keys carry the envelope.
Restated from the CDDL files named; where they differ, the CDDL wins and this table
is wrong. The envelope keys of a commit are 0, 1, 3, and 7; its sequence (key 2) is
identity, listed in the same column because §1 checks it the same way. There is no
"optional features" field in envelope v0.

| Record | Schema file | Schema version (key 0) | Archive ID | Sequence | Transaction ID | Required features |
|---|---|---|---|---|---|---|
| Archive descriptor | `archive-descriptor-v0.cddl` | 0 | 1 | — | — | 4 |
| Commit record | `commit-record-v1.cddl`, `-v2.cddl` | 1, 2 | 1 | 2 | 3 | 7 |
| Recovery manifest | `recovery-manifest-v1.cddl` … `-v3.cddl` | 1, 2, 3 | 1 | 2 | 10 | 9 |
| Key envelope | `key-envelope-v0.cddl` | 0 | 1 | 2 | 3 | 4 |

- **Descriptor identity.** The descriptor belongs to no commit: it is written once at
  offset 0 and every commit references it by hash (commit key 10, D12). Its identity
  obligation is the archive ID alone.
- **Key-envelope identity (D20).** An envelope belongs to the commit that wrote it;
  later commits reference it without rewriting it. A reader checks the archive ID
  against the referencing commit and that the envelope's sequence is not after the
  referencing commit's (R5 §3).
- **Snapshot manifests** carry the sequence and transaction ID of their checkpoint
  commit (B.2.2 "Manifest v1").
- Every CBOR record must re-encode to identical bytes under the one codec in
  `mochi-format::cbor` (D2); a record that does not is `RECORD_INVALID`.

## 4. Records without an envelope, and one without a referencing hash

- **Parity frames** (`0x184D2A5F`, Redundancy profile, D21) carry a binary envelope
  (encoding 1, record schema version 0, the identity and required features of the
  commit whose footer follows them), but **no record references them**: the commit
  record is written before them and the footer covers only the commit frame. Their
  integrity scope is therefore their own frame digest (BLAKE3 over
  `MOCHI2-PARITY-FRAME\0` and every frame byte before it), checked before the
  envelope is decoded; their identity is bound to the commit whose footer follows
  them, and a mismatch is a profile violation. They are a repair aid, never an
  integrity anchor (R6 §5).


- **Commit footer** (`0x184D2A56`): a fixed 64-byte payload (R1 §3). Its digest binds
  the commit frame; it never carries an envelope.
- **Data frames** (`0xFD2FB528`): Zstandard data, not a record. A chunk's identity
  and hashes are in the catalog and the manifests.
- **Sealed objects** (`0x184D2A59`, Encrypted profile): a 48-byte header (R5 §5,
  frozen), not an envelope. The plaintext inside is exactly the record a Core
  archive would store (a catalog image with its binary envelope, a manifest with its
  CBOR keys, or a data frame), and the envelope obligations apply to that plaintext
  after opening. The seal's associated data binds the archive ID and the object or
  commit identity, so a sealed frame opens only in its own place.

**Names.** This file calls `0x184D2A50` the *catalog image* (the spec's registry says
"metadata delta or checkpoint") and `0x184D2A5F` the *parity frame* (the registry's
"parity object"); R1 §2 has both names.

## 5. Decisions on the open items (delegated, 2026-10-11)

1. **The feature-count cap is permanent for envelope version 0.** n ≤ 64 is a wire
   rule of v0, independent of reader limits; a record needing more features needs
   envelope version 1. Stated in spec B.2.2 under the binary envelope table.
2. **Oversized records are rejected, not split, in 1.0.** That is D10 item 11's branch
   of §8.3, and R2 freezes it: a writer refuses (`CAPACITY_EXCEEDED`) and publishes no
   head. A split representation would be a new envelope version with its own Annex B
   entry.
3. **Dictionaries and parity register a payload encoding before writing.** C12 (R6)
   and any dictionary work must add their payload encoding to B.2.2's registry, with
   signature and vectors, before a writer emits one. Recorded as a precondition in
   plan W9 (`docs/next-work-plan.md`). **Done for parity (2026-10-12):** encoding 1,
   signature `MOCHI2-PARITY\0\0\0`, registered in B.2.2 with D21; vectors in
   `R6-vectors/` and the golden reject `b2/reject-envelope-payload-encoding-kind.bin`.
4. **The B.2.6 evidence audit belongs to R8.** "Valid and reject vectors for every
   CDDL rule and every D11 obligation, in both encodings" is checked when the golden
   set R8 is assembled, not in this draft. §8.3's "evidence pending" marker stays until
   that audit passes.

## 6. Freeze review (2026-10-12)

Run together with R1's (R1 §7 has the method, authority, and the stop rule). This section
records what concerns the envelopes.

**Checked.**

* **The drift test passes** with the tables above: the D11 obligations against spec §8.3,
  the binary offsets against an encoded record, the payload encodings, and the kinds that
  carry an envelope. The new fault-code table was written from `envelope.rs` and
  `error.rs`, and its rows are pinned by the `b2/reject-envelope-*` vectors (15 rejects, one
  fault each, unchanged by the freeze) and `c5/reject-archive-manifest-*`.
* **No R2 byte changed.** The envelope vectors use their own rules (schema 0 in a test
  `EnvelopeRules`), so they are byte-identical to the pre-freeze set; the catalog image's
  record schema version moved from 0 to 1 with R4 and is the only envelope value that
  moved (the golden archives that embed an image were regenerated, R4 §6).

**Found and fixed at the freeze** (text only).

1. **The fault codes were nowhere in the text** (cold read 1): the table above.
2. **The order of the feature checks and the two meanings of 64** (cold read 2): §2 table
   — 64 as a wire rule is `ENVELOPE_INVALID`, 64 as a reader limit is `LIMIT_EXCEEDED`.
3. **Where `user_version` sits and what a mismatch is** (cold read 4).
4. **What an image's features must equal** (cold read 2), and that the same identity
   mismatches in a CBOR record share the code (cold read 5).
5. **Stale status** ("not frozen", "freezes at Beta"), and the two registry names.

**Cold read.** A fresh subagent was given only `docs/spec.md`, this file, and the
`docs/schemas/*.cddl` texts it defers to (they are R3's, but R2 is not implementable
without their keys). Findings and calls:

| # | Finding | Call |
|---|---|---|
| 1 | Error code per binary decode step | **Fixed** (table in §2). |
| 2 | Feature checks: 64 as wire or limit; order; known set; image equality | **Fixed** (§2). For a CBOR record's *exact-list* rules (`7: [1]`, `9: [1]`), R3 §6 owns the schema and `UNSUPPORTED_FEATURE` for an unknown entry is raised first, by the same shared check. |
| 3 | CBOR-side decode order is not stated | **Decided.** Three steps are ordered: the stored-object hash (before parsing), then canonical decode (R3 §1), then key 0 (R3 §3, an unknown version is refused before any other key is read). R3 §2.2 and §6 list every later rule with its vector. Precedence among simultaneous faults is not pinned (§2), and each golden reject has one defect. |
| 4 | Accepted catalog schema versions; where `user_version` lives | **Fixed** (R4 §1: only 1; §2 above). |
| 5 | Identity comparison rules and codes | **Fixed** (§2). The descriptor's archive ID is compared with every commit's key 1 (a disagreement is `DESCRIPTOR_INVALID`, D12). |
| 6 | Sealed objects: which kind and budget the plaintext is checked against | **Decided as §4 says:** the opened plaintext is exactly what a Core archive stores, so it is decoded as a `0x184D2A50` record with the *S* − 592 budget; the sealed frame's own kind field must match what the referencing record names (R5 §4). |
| 7 | A parity frame with a valid digest and a bad envelope | **Open item, call:** R6 §5 owns the parity decode order and codes (frozen); R2 adds nothing. W16's `expect` records the code of each parity reject. |
| 8 | Draft identifier and declared limits (key 6) | **Fixed in the spec / unchanged:** draft 2 (R1 §1). Key 6 is decoded and not acted on (spec D16, out of 1.0). |

Text-only items: stale spec statements in B.2 ("None of it is done", "evidence
pending") were corrected at the freeze (spec Annex B status paragraph); §8.3's
"evidence pending" marker **stays** until the G1 audit passes in W16 (decision 4 above).
`ENVELOPE_INVALID` for a CBOR identity mismatch while the descriptor uses
`DESCRIPTOR_INVALID` is the D12 split, not an inconsistency.

**Calls on the open items.** Decisions 1 to 4 (§5) stand; none changed a byte.

**What the review did not do.** It did not repeat the cold read after the fixes; it did
not run a fuzz campaign.
