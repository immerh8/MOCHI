# R1 — Frame registry and version mapping (DRAFT, not frozen)

> **Status 2026-10-11: draft.** Written from the working code at `main` commit
> `57e3a69` and the golden vectors in `fixtures/golden/`, as plan §6 requires. It is
> **not frozen**: it freezes at Beta, with R2 and R3. Until then a change to the code
> or the spec may change this file, but only together with the code: the test
> `crates/mochi-cli/tests/ratification_drafts.rs` parses the tables marked
> *(checked)* below and fails if they differ from the code.

Sources: spec §1.2, §8.1, §8.2, §8.4, §8.6, Annex B.1 D1, Annex B.2 D11, D12, D14,
B.2.2, B.2.10. Code: `crates/mochi-format/src/registry.rs` (the only module allowed
to spell a frame magic, `ci/check-invariants.sh`), `version.rs`, `footer.rs`,
`frame.rs`; record schema versions in `crates/mochi-core/src/{descriptor,commit,manifest,keys,image}.rs`.

Where this file and the spec disagree, that is listed in §6 as an open item. This
file does not pick a side.

## 1. Version identifiers

Spec §1.2 and §26 keep these distinct. *(checked)*

| Identifier | Value | Where |
|---|---|---|
| Specification revision | `2.0` | `version::SPEC_REVISION` |
| Wire generation | `2` | `version::WIRE_GENERATION`; descriptor key 2 |
| Footer magic | `MOCHI2` ‖ `00 00` | `registry::FOOTER_MAGIC` |
| Draft identifier | `1` | `descriptor::DRAFT_ID`; descriptor key 3 (null only in a ratified archive) |
| Format status | `experimental / draft-compatible` | `version::FORMAT_STATUS`; every report's `tool.format_status` |

**D1 (decided):** the wire generation stays 2, independent of the product version.
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
| `0x184D2A5F` | `ParityObject` | yes | — | Not written until the Redundancy profile (C12, R6) |

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
- **Reserved kinds** have three magics and no writer may emit any of them
  (`FrameKind::magic` is `None` for `Reserved`).
- **No bare bytes between frames.** A file is the descriptor frame followed by
  frames only; footers are frames too (§8.4).

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

## 4. Other registered byte strings

Not frame magics, but registered in `registry.rs` so that no other module spells
them. *(checked)*

| Name | Bytes (hex) | Meaning |
|---|---|---|
| `FOOTER_MAGIC` | `4d4f43484932 0000` | Footer payload bytes 0–7 |
| `TAIL_QUARANTINE_MAGIC` | `4d4f434849 5451 00` | Offset 0 of a `.mochiq` tail-quarantine sidecar (D14, B.2.2). Never inside an archive; its first four bytes are not a frame magic |
| `SQLITE_IMAGE_SIGNATURE` | `53514c69746520666f726d6174203300` | Binary-envelope payload encoding 0 must start with these 16 bytes (R2) |

## 5. Record schema versions this build reads

Per kind, the schema version carried by the record (CBOR key 0, or the binary
envelope's record-schema field). An unknown version is refused as
`UNSUPPORTED_FEATURE` (D11); version 0 of commits and manifests is the pre-batch
draft and is refused and named legacy (§26). *(checked)*

| Kind | Record | Versions read | Written when |
|---|---|---|---|
| `0x184D2A57` | Archive descriptor | 0 | Always 0 |
| `0x184D2A51` | Commit record | 1, 2 | 2 exactly in the Encrypted profile (required feature 1), else 1 |
| `0x184D2A58` | Recovery manifest | 1, 2, 3 | 3 in the Encrypted profile; 2 when retention data is present; else 1 |
| `0x184D2A5C` | Key envelope | 0 | Always 0 |
| `0x184D2A50` | Catalog image (binary envelope v0) | 0 | Record schema = the image's SQLite `user_version`, 0 (R4) |
| `0x184D2A59` | Sealed object | 0 | Always 0 (R5, frozen) |

Required-feature identifiers registered: **1** = the Encrypted profile, suite 1 (D20,
R5 frozen). No other identifier is assigned; any other listed feature is refused
(`UNSUPPORTED_FEATURE`, exit 4).

## 6. Open items (spec and code disagree, or the spec is silent)

Recorded, not resolved. Each needs a spec edit, an Annex B entry, or an owner call
before R1 freezes.

1. **§8.2 and §8.4 still say "proposed".** The code uses these values as the wire
   format, and the golden vectors depend on them. Freezing R1 is what removes the
   word; until then the spec text and this draft agree that nothing is ratified.
2. **§8.4's closing "Open decision" on `MOCHI2` is stale.** Annex B.1 D1 decided it
   ("Keep `MOCHI2`"). The §8.4 paragraph should point to D1 as decided.
3. **§8.2 names `0x184D2A59` "Encrypted object envelope"**; D20 and the code call
   the frame a *sealed object*. Same frame, two names. Proposal: keep the §8.2 name
   in the registry table and say "sealed object (D20)" in the use column, as here.
4. **Footer before commit (plan O17).** The code requires the commit frame to lie
   entirely before the footer that names it. The spec says physical order may vary
   but does not say a footer may not precede its commit. Proposal: state the rule
   in §8.4.
5. **Unreferenced frames of kinds not written in 1.0.** A 1.0 reader walks them and
   ignores them unless a record references them. The spec does not say whether
   `verify` should report an unreferenced `0x184D2A52`, `…54`, `…55`, `…5D`,
   `…5E`, or `…5F` frame in the committed prefix (today it does not). Options: (a)
   silent, as now; (b) an `info` finding; (c) `UNSUPPORTED` for the dimension that
   kind would serve. Recommendation: (b), since (c) would make every archive written
   by a later build look unsupported to a 1.0 reader even when nothing references
   the frame.
6. **§8.2's closing sentence** says readers MUST validate the descriptor and record
   envelopes; D12 permits head discovery, footer and commit validation, the walk,
   and stored-integrity checks with a missing or damaged descriptor. The two are
   consistent only if "validate" is read as "before interpretation". Proposal:
   say so in §8.2.
