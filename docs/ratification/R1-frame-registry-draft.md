# R1 — Frame registry and version mapping (FROZEN, draft 2)

> **Status 2026-10-12: frozen as part of draft 2** (gate G12, [delegated 2026-10-12];
> owner review pending at the desktop checkpoint, plan K11). It was written 2026-10-11
> from the working code at `main` commit `57e3a69` and the golden vectors in
> `fixtures/golden/`, and frozen with R2, R3, and R4 by the review in §7. The file name
> keeps "draft" for links (as R5 and R6 did). A change to any byte or rule below is a
> new draft identifier (`descriptor::DRAFT_ID`, spec Annex B.2.14) with an Annex B
> entry, never an edit. Tables marked *(checked)* are compared with the code by
> `crates/mochi-cli/tests/ratification_drafts.rs`.

Sources: spec §1.2, §8.1, §8.2, §8.4, §8.6, Annex B.1 D1, Annex B.2 D11, D12, D14,
B.2.2, B.2.10. Code: `crates/mochi-format/src/registry.rs` (the only module allowed
to spell a frame magic, `ci/check-invariants.sh`), `version.rs`, `footer.rs`,
`frame.rs`; record schema versions in `crates/mochi-core/src/{descriptor,commit,manifest,keys,image}.rs`.

Where this file and the spec disagreed, §6 records the call, and the spec was
corrected at the freeze (§7). Where they still differ, this file wins for its topic
(AGENTS.md, "Sources of truth").

## 1. Version identifiers

Spec §1.2 and §26 keep these distinct. *(checked)*

| Identifier | Value | Where |
|---|---|---|
| Specification revision | `2.0` | `version::SPEC_REVISION` |
| Wire generation | `2` | `version::WIRE_GENERATION`; descriptor key 2 |
| Footer magic | `MOCHI2` ‖ `00 00` | `registry::FOOTER_MAGIC` |
| Draft identifier | `2` | `descriptor::DRAFT_ID`, the **last draft** (read only by `mochi migrate`); descriptor key 3, which a 1.0 writer writes as **null** (a ratified archive) |
| Format status | `1.0 (ratified format)` | `version::FORMAT_STATUS`; every report's `tool.format_status` (before the 1.0 flip: `experimental / draft-compatible`) |

**D1 (decided):** the wire generation stays 2, independent of the product version.
**D24 (decided, implemented at the freeze; flipped at 1.0, W20):** the draft identifier
2 names the layout frozen here and in R2 to R4. **At 1.0 the layout is ratified and
a 1.0 writer writes `null` in descriptor key 3** (the only byte of the descriptor that
differs, and through the descriptor's stored-object hash in each commit, key 10, every
byte that hashes it). A 1.0 reader accepts `null`. A number is a draft: every command
but `mochi migrate` refuses it as `UNSUPPORTED_FEATURE` (exit 4) with a message naming
the draft; for draft 2 only, the message suggests `mochi migrate`, which reads draft 2
and no other. Draft 1, the pre-freeze batch (R4 `user_version` 0), is refused with a
message naming draft 1 and no hint, as is any other number.
`fixtures/golden/b2/reject-archive-draft-1.mochi` is a draft-1 archive;
`fixtures/golden/r8/legacy/` holds three draft-2 archives.
The product version (`mochi --version`, `tool.version` in reports) is unrelated to
any of the values above.

## 2. Frame registry

Every MOCHI control record is a Zstandard skippable frame (RFC 8878 §3.1.2): a 4-byte
little-endian magic in `0x184D2A50`–`0x184D2A5F`, a 4-byte little-endian
`Frame_Size`, and exactly that many payload bytes. Data is stored in standard
Zstandard data frames. All sixteen skippable magics are registered; a value outside
this table is not a frame (`MALFORMED_FRAME`). *(checked)*

| Magic | Kind (`FrameKind`) | Skippable | Required offset | Use in 1.0 |
|---|---|---|---|---|
| `0xFD2FB528` | `ZstdData` | no | — | Data chunk (one frame per object, O21: `Frame_Content_Size` and checksum present). In the TAR-compatible profile also stream-only chunks (D19) |
| `0x184D2A50` | `MetadataDelta` | yes | — | Catalog image (checkpoint): binary envelope v0 + SQLite image (R2, R4) |
| `0x184D2A51` | `CommitRecord` | yes | — | Commit record, deterministic CBOR (R3) |
| `0x184D2A52` | `PreparedTransactionManifest` | yes | — | Not written. Multi-writer preparation is post-1.0 |
| `0x184D2A53` | `Reserved` | yes | — | Reserved; no Core interpretation |
| `0x184D2A54` | `SignatureExtension` | yes | — | Not written. Signatures are post-1.0 |
| `0x184D2A55` | `SearchIndex` | yes | — | Not written. 1.0 search reads the catalog (C13) |
| `0x184D2A56` | `CommitFooter` | yes | — | Commit footer, fixed 64-byte payload (§3 below) |
| `0x184D2A57` | `ArchiveDescriptor` | yes | 0 | Archive descriptor, deterministic CBOR; exactly one, at offset 0 (D12) |
| `0x184D2A58` | `RecoveryManifest` | yes | — | Recovery manifest, delta or snapshot, deterministic CBOR (R3) |
| `0x184D2A59` | `EncryptedObject` | yes | — | Sealed object v0, Encrypted profile only (R5 §5) |
| `0x184D2A5A` | `Reserved` | yes | — | Reserved |
| `0x184D2A5B` | `Reserved` | yes | — | Reserved |
| `0x184D2A5C` | `KeyEnvelope` | yes | — | Key envelope, deterministic CBOR, Encrypted profile only (R5 §3) |
| `0x184D2A5D` | `CompressionDictionary` | yes | — | Not written. No dictionaries in 1.0 builds yet |
| `0x184D2A5E` | `FooterHistory` | yes | — | Not written. Optional accelerator, never a recovery authority (§22) |
| `0x184D2A5F` | `ParityObject` | yes | — | Parity frame, Redundancy profile only (D21, R6): binary envelope v0 with payload encoding 1, written between a commit frame and its footer |

Rules the code enforces for every kind:

- **A magic match is a candidate, never proof** (§8.5). The structural walk (§8.6,
  `frame::walk_frame`) accepts every registered magic. Interpretation happens only
  when a verified record references the frame with a field that names its kind (D11
  "Record type"); kinds "not written" above are therefore walked but never
  interpreted by a 1.0 reader.
- **Physical length comes from the walk**, never from `Frame_Content_Size`. An RLE
  block occupies one stored byte; block type 3 is invalid; reserved header bits are
  refused.
- **The descriptor is valid only at offset 0** (D12). The walker refuses a
  `0x184D2A57` frame anywhere else on the magic alone (`MisplacedFrame`,
  `MALFORMED_FRAME`).
- **What the walk refuses in a Zstandard data frame** (`frame::walk_frame`): bit 3 of
  the `Frame_Header_Descriptor` (reserved), block type 3, and a `Block_Size` above the
  frame's block maximum. These are `MALFORMED_FRAME`. Missing `Frame_Content_Size` or
  checksum (O21) is not a walk error: it is refused when a chunk is decoded
  (`codec`, `MALFORMED_FRAME`). A nonzero `Dictionary_ID` is read; no 1.0 writer emits
  one, and a chunk that needs a dictionary is `UNSUPPORTED_FEATURE` (R4 §2,
  `chunk_dependencies`).
- **A skippable frame of kind `0x184D2A56` whose `Frame_Size` is not 64** is walked like
  any other frame and is not a footer: footer parsing (§3) requires exactly 64.
- **In the Encrypted profile** data chunks are stored in `0x184D2A59` sealed frames of
  kind 0 (R5 §4, §5), not as bare `0xFD2FB528` frames; the `ZstdData` row describes the
  plaintext a sealed frame holds.
- **Reserved kinds** have three magics and no writer may emit any of them
  (`FrameKind::magic` is `None` for `Reserved`).
- **No bare bytes between frames.** A file is the descriptor frame followed by
  frames only; footers are frames too (§8.4).
- **Between a commit frame and its footer** a writer puts nothing, or, in the
  Redundancy profile, exactly that commit's parity frames (D21; §8.4's amendment
  allows it: the commit frame precedes its footer). Readers that do not check parity
  walk over them like any unreferenced frame.

## 3. Commit footer

The footer is a skippable frame of kind `0x184D2A56` whose `Frame_Size` is exactly 64:
72 bytes in all. Integers are unsigned little-endian. *(checked: sizes only)*

| Payload offset | Size | Field |
|---|---|---|
| 0 | 8 | Magic: `MOCHI2` ‖ `00 00` |
| 8 | 8 | Commit-frame offset, from byte 0 of the archive, at the commit frame's magic |
| 16 | 8 | Commit-frame stored length, header and payload |
| 24 | 8 | Commit sequence |
| 32 | 32 | Footer digest |

Footer digest = BLAKE3-256(`MOCHI2-FOOTER` ‖ `00` ‖ payload bytes 0–31 ‖ the exact
stored commit-frame bytes). The domain string is `digest::FOOTER_DOMAIN`, defined
once (R3 owns the full separator list). The digest covers stored bytes, so footers
validate without keys in the Encrypted profile. A reader that finds 64 plausible
bytes at end of file also validates the preceding 8-byte skippable header.

The footer never carries a record envelope (D11); its fixed layout is its schema.

**Validation order** (`footer::validate_footer`): the preceding 8-byte skippable header
(`FOOTER_INVALID`); the payload magic; the named range is at least 8 bytes, does not
overflow, and ends at or before the footer's own offset (`FOOTER_INVALID`); the range is
within the commit-frame length limit (`LIMIT_EXCEEDED`); a skippable frame of exactly
that stored length starts at the offset (`FOOTER_INVALID`); the digest
(`FOOTER_INVALID`). The caller then requires that frame's kind to be `0x184D2A51` and
the footer's sequence to equal the commit's own key 2 (`publish.rs`). Bytes between the
commit frame and the footer are not examined by the digest; in the Redundancy profile
they are the commit's parity frames (§2, R6), checked by R6's rules.

## 4. Other registered byte strings

Not frame magics, but registered in `registry.rs` so that no other module spells
them. *(checked)*

| Name | Bytes (hex) | Meaning |
|---|---|---|
| `FOOTER_MAGIC` | `4d4f43484932 0000` | Footer payload bytes 0–7 |
| `TAIL_QUARANTINE_MAGIC` | `4d4f434849 5451 00` | Offset 0 of a `.mochiq` tail-quarantine sidecar (D14, B.2.2). Never inside an archive; its first four bytes are not a frame magic |
| `SQLITE_IMAGE_SIGNATURE` | `53514c69746520666f726d6174203300` | Binary-envelope payload encoding 0 must start with these 16 bytes (R2) |
| `ZSTD_IMAGE_SIGNATURE` | `28b52ffd` | Binary-envelope payload encoding 2, a Zstandard-compressed SQLite image (B.2.15), must start with these 4 bytes: the Zstandard frame magic. The SQLite signature is checked on the decoded bytes. Amended by the owner, 2026-10-16 |
| `PARITY_SIGNATURE` | `4d4f434849322d504152495459000000` | Binary-envelope payload encoding 1, a parity shard (D21, R6), must start with these 16 bytes |

## 5. Record schema versions this build reads

Per kind, the schema version carried by the record (CBOR key 0, or the binary
envelope's record-schema field). An unknown version is refused as
`UNSUPPORTED_FEATURE` (D11, exit 4); version 0 of commits and manifests is the pre-batch
draft and is refused with the same code and a message that says *legacy* (§26). *(checked)*

| Kind | Record | Versions read | Written when |
|---|---|---|---|
| `0x184D2A57` | Archive descriptor | 0 | Always 0 |
| `0x184D2A51` | Commit record | 1, 2 | 2 exactly in the Encrypted profile (required feature 1), else 1 |
| `0x184D2A58` | Recovery manifest | 1, 2, 3 | 3 in the Encrypted profile; 2 when retention data is present; else 1 |
| `0x184D2A5C` | Key envelope | 0 | Always 0 |
| `0x184D2A50` | Catalog image (binary envelope v0) | 1 | Record schema = the image's SQLite `user_version`, 1 (R4); 0 was the pre-freeze draft and is refused |
| `0x184D2A59` | Sealed object | 0 | Always 0 (R5, frozen) |
| `0x184D2A5F` | Parity frame (binary envelope v0) | 0 | Always 0 (R6) |

Required-feature identifiers registered: **1** = the Encrypted profile, suite 1 (D20,
R5 frozen). No other identifier is assigned; any other listed feature is refused
(`UNSUPPORTED_FEATURE`, exit 4).

## 6. Decisions on the open items (delegated, 2026-10-11)

The owner delegated these calls ("decide on best practice and the goal"). Each is
recorded where it now lives; nothing in this section changes a byte on the wire.

1. **"Proposed" in §8.2 and §8.4.** Removed from the spec at the freeze (§7, found and
   fixed 2).
2. **§8.4's stale "open decision" on `MOCHI2`.** Replaced in the spec by a pointer to
   Annex B.1 D1 (decided: keep `MOCHI2`).
3. **Two names for `0x184D2A59`.** The §8.2 name stays; the spec's registry row now
   adds "the *sealed object* of Annex B.2.10, D20", as this draft's table does.
4. **Footer after commit (plan O17).** Already decided in the plan; now stated in
   §8.4: the commit frame's last byte precedes the footer's first byte, otherwise the
   footer is invalid. The code already enforces it.
5. **Unreferenced frames of kinds 1.0 never writes: (a) silent.** This draft
   recommended an `info` finding, but `verify` has no forward walk of the whole file:
   it reaches frames only through references. Adding one costs a full extra pass on
   every run, at every level, to report bytes that no committed hash covers (so a
   report about them would claim nothing a commit vouches for). Anything a later
   build writes that matters is reached through a reference, and an unknown
   reference is already refused (`UNSUPPORTED_FEATURE`). The spec now says so (§8.2
   amendment). Adding such a finding later is a new code, which is not a breaking
   change.
6. **§8.2 "Readers MUST validate the descriptor".** Amended to "before interpreting
   any record", with the D12 exceptions named, so the two texts agree.

## 7. Freeze review (2026-10-12)

The review gate G12 asks for, in the form of R5 §12, run once for R1 to R4 (the other
three artifacts carry the same section for their own findings). Plan authority: K11
(a self-review recorded here, marked [delegated 2026-10-12]; the owner reviews it at
the next desktop-phase checkpoint), K12, K13, and W15. The rule it ran under: **if any
byte other than R4 `user_version` and the draft identifier should change, stop and do
not freeze.** None did.

**Checked.**

* **The drift test passes** (`ratification_drafts.rs`, 30 tests) with the tables in
  this file; the identifiers table now says draft 2 and the record-schema table says
  catalog image 1. R3's mechanical check (`r3_cddl.rs`, 7 tests) also passes.
* **The code is the registry.** The 17 magics, the 64-byte footer layout and digest
  input, and the four registered byte strings are compared by the drift test; the walk
  rules of §2 and the footer validation order of §3 were read against `frame.rs` and
  `footer.rs`.
* **Draft 2 is written and draft 1 is refused.** `DRAFT_ID` is 2; the descriptor vectors
  were regenerated (every `b2` descriptor file differs from its old self in exactly one
  byte, key 3's value); a draft-1 archive is refused with exit 4 naming draft 1
  (`exit_codes.rs`).

**Found and fixed at the freeze** (no byte other than the two planned ones changed).

1. **The spec said draft identifier 1** (B.2.2 descriptor table) while R1 §1 said 2.
   B.2.2 now says 2, names draft 1 as refused, and draws constraint key 5.1.
2. **"Proposed" in spec §8.2 and §8.4**, the status line, §1.2's two "assigned by the
   ratification package" rows, and "(proposed)" on the wire generation: removed or
   replaced by the values (checklist item 2).
3. **Three behaviours the code had and the text did not say** (cold read, findings 4 to
   8 below): the footer validation order, what the walk refuses in a data frame, and
   that a 56-size footer-kind frame is simply walked.
4. **Stale text**: "Where this file and the spec disagree … does not pick a side", the
   catalog image's schema version in §5, and the status of §6 item 1.

**Cold read.** A fresh subagent was given only `docs/spec.md` and this file (no code)
and asked where it would have to guess to write a reader. Its findings, and the call on
each:

| # | Finding | Call |
|---|---|---|
| 1 | Draft identifier: spec said 1, R1 says 2 | **Fixed in the spec** (found 1). |
| 2 | Image schema: 0 or 1 | **Fixed**: only 1 is read (§5); 0 is refused. |
| 3 | Code for a legacy version 0 | **Fixed in text** (§5): `UNSUPPORTED_FEATURE`, exit 4, message says *legacy*. |
| 4 | Code for a misplaced descriptor, and for another kind at offset 0 | **Decided, as the code does.** A `0x184D2A57` frame away from offset 0 is `MALFORMED_FRAME` (§2). Whatever sits at offset 0 and is not a decodable descriptor is `DESCRIPTOR_INVALID` (D12; the vector `reject-descriptor-wrong-frame-kind` pins it). |
| 5 | What the footer's pointer must satisfy | **Fixed in text** (§3, validation order). |
| 6 | Bytes between the commit frame and its footer | **Fixed in text** (§3): not examined by the footer digest; Redundancy frames are R6's. |
| 7 | A 0x184D2A56 frame whose size is not 64 | **Fixed in text** (§2). |
| 8 | What "reserved header bits are refused" means, block limits, `Dictionary_ID`, O21 | **Fixed in text** (§2). |
| 9 | Code for a record that names a reserved, unwritten, or wrong-kind frame | **Open item, call:** the reference returns `ENVELOPE_INVALID` for a binary-envelope kind mismatch (R2 §2.1) and `RECORD_INVALID`/`UNSUPPORTED_FEATURE` for the CBOR layer's references (R3 §2.2). W16 records the code each golden case returns, and R9 compares verdicts through R8's `expect`. |
| 10 | Code for a wrong wire generation or footer magic | **Decided, as the code does:** generation ≠ 2 is `UNSUPPORTED_FEATURE`; a payload whose magic is not `MOCHI2 00 00` is not a footer (`FOOTER_INVALID`). |
| 11 | Data frames in the Encrypted profile | **Fixed in text** (§2); the sealed layout is R5's. |

Text-only items fixed: the "Specification revision" and "Product release" rows are
identifiers, not wire values (§1 already says the product version is unrelated); the
required-feature rule (strictly increasing, at most 64 in a binary envelope) is R2 §2,
which the R1 table points to; spec §1.2 now assigns the metadata and manifest versions.
Dependencies the reader was not given (R2 to R6, R7's registry, plan O17 and O21) are
cross-references, not guesses.

**Calls on the open items.** §6's six calls stand and none changed a byte. Item 1 is
done. Nothing else is outstanding for R1.

**What the review did not do.** It did not repeat the cold read after the text fixes
(the fixes are quotations of the code's behaviour; R9's independent reader is the
second check); it did not run a fuzzing campaign (CI's `fuzz-smoke` replays the corpora).
