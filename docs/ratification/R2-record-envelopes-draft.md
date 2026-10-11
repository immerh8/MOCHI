# R2 — Record-envelope layouts (DRAFT, not frozen)

> **Status 2026-10-11: draft.** Written from the working code at `main` commit
> `57e3a69` and the golden vectors in `fixtures/golden/` (`b2/`, `c11/`), as plan §6
> requires. It is **not frozen**: it freezes at Beta, together with R3 (the CBOR
> schemas whose envelope keys are restated here). Tables marked *(checked)* are
> compared with the code by `crates/mochi-cli/tests/ratification_drafts.rs`.

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

Any other value is refused (`ENVELOPE_INVALID`).

**Frame kinds that carry a binary envelope.** *(checked)*

| Kind | Record |
|---|---|
| `0x184D2A50` | Catalog image |

**Decode order** (`decode_binary_record`; each failure has its own fault): kind; the
80 fixed bytes present; envelope version; feature count ≤ 64 (before the header
length is computed from it); header length; payload length; payload budget; payload
encoding; required features; record schema version; payload signature (and, for
SQLite, `user_version` = record schema version). The result is a *candidate*: nothing
may interpret its payload until `Candidate::bind` has checked its identity against
the referencing commit. Encoding refuses everything decoding refuses, plus anything
over the writer's limits (`CAPACITY_EXCEEDED`).

## 3. CBOR-native envelope keys

The schemas are R3's; this table restates only which keys carry the envelope.
Restated from the CDDL files named; where they differ, the CDDL wins and this table
is wrong.

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

## 4. Records without an envelope

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
   plan W9 (`docs/next-work-plan.md`).
4. **The B.2.6 evidence audit belongs to R8.** "Valid and reject vectors for every
   CDDL rule and every D11 obligation, in both encodings" is checked when the golden
   set R8 is assembled, not in this draft. §8.3's "evidence pending" marker stays until
   that audit passes.
