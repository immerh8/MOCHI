# Ratification artifacts

The spec (§28) requires these before the format is called interoperable. Each is
written *from* working code and golden vectors, then frozen. Where one exists it is
more precise than the spec and wins for its topic (AGENTS.md, "Sources of truth").

| ID | Artifact | Informed by | Status |
|---|---|---|---|
| R1 | Final frame registry and version mapping | C1 | **draft 2026-10-11, not frozen** (freezes at Beta): `R1-frame-registry-draft.md`, from `mochi-format/src/registry.rs` at `57e3a69`; its 6 open items decided 2026-10-11 (delegated) |
| R2 | Record-envelope layouts | C1–C4 | **draft 2026-10-11, not frozen** (freezes at Beta, with R3): `R2-record-envelopes-draft.md`, from `mochi-format/src/envelope.rs` at `57e3a69`; its 4 open items decided 2026-10-11 (delegated) |
| R3 | Canonical commit and manifest serialization; domain separators | C2, C4, C5 | in progress: encoding decided (spec D2, deterministic CBOR; codec in `mochi-format/src/cbor.rs`); manifest schema drafted (`docs/schemas/recovery-manifest-v0.cddl`, vectors in `fixtures/golden/c4`); commit body schema arrives in C5; separator strings still draft (O20) |
| R4 | Complete SQLite DDL and constraints | C3 | **draft 2026-10-11, not frozen** (freezes at Beta): `R4-catalog-ddl-draft.md`, from `mochi-core/src/catalog/schema.rs` at `57e3a69` (five §10.1 tables live outside the catalog, §4 there); its 5 open items decided 2026-10-11 (delegated) |
| R5 | Cryptographic suite and vectors | C11 | **frozen 2026-10-11** (D20, spec Annex B.2.10; gate G10 met; review in §12): `R5-crypto-draft.md` (name kept for links), vectors in `R5-vectors/` (independent oracles, reproducible), schemas `key-envelope-v0.cddl` (frozen), and the R5 keys of `commit-record-v2.cddl` (11, 12) and `recovery-manifest-v3.cddl` (13, provenance `reason`); the rest of those two schemas freezes with R3 |
| R6 | Erasure-coding suite and vectors | C12 | **draft 2026-10-12, not frozen** (D21, spec Annex B.2.11; freezes after the gate G11 review): `R6-erasure-coding-draft.md`, from `mochi-format/src/parity.rs` and `mochi-core/src/parity.rs`; vectors in `R6-vectors/` from an independent Python implementation, regenerated and diffed by CI; 5 open items |
| R7 | Report schema and stable error codes | C7 | **draft 2026-10-11, not frozen** (freezes at Beta): `R7-reports-and-error-codes-draft.md`, from `mochi-core` (`error.rs`, `report.rs` v1, `status.rs`, `exit.rs`, `verify::classify`) and `mochi_cli::exit_code_for` at `57e3a69`; its 6 open items decided 2026-10-11 (delegated) |
| R8 | Golden valid/corrupt/interrupted archives | all C phases | not started; see `fixtures/golden/` |
| R9 | Independent reader/writer interop results | R1–R8 | not started |
| R10 | Segmented-location rules | none | post-1.0 |

**Drafts and drift.** R1, R2, R4, R6, and R7 are drafts written from the code (plan §6,
next-work-plan W8). Each marks the tables it states as *(checked)*;
`crates/mochi-cli/tests/ratification_drafts.rs` parses those tables and compares them
with the code (and R2's D11 obligations and R4's §10.1 table list with the spec), so a
change to the registry, an envelope layout, the DDL, the error-code registry, the
report fields, or the parity suite's constants and frame layout fails CI until the
draft is updated with it. Each draft ends with the
open items it found (places where the spec and the code disagreed or the spec was
silent) and, since 2026-10-11, the delegated decision on each and where it now lives.
