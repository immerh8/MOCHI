# Ratification artifacts

The spec (§28) requires these before the format is called interoperable. Each is
written *from* working code and golden vectors, then frozen. Where one exists it is
more precise than the spec and wins for its topic (AGENTS.md, "Sources of truth").

| ID | Artifact | Informed by | Status |
|---|---|---|---|
| R1 | Final frame registry and version mapping | C1 | **frozen 2026-10-12 as draft 2** (gate G12, [delegated 2026-10-12]; owner review pending at the desktop checkpoint): `R1-frame-registry-draft.md` (name kept for links), from `mochi-format/src/registry.rs` at `57e3a69`; its 6 open items decided 2026-10-11; freeze review in §7 |
| R2 | Record-envelope layouts | C1–C4 | **frozen 2026-10-12 as draft 2** (gate G12, [delegated 2026-10-12]; owner review pending at the desktop checkpoint): `R2-record-envelopes-draft.md`, from `mochi-format/src/envelope.rs` at `57e3a69`; its 4 open items decided 2026-10-11; the fault-code table and the freeze review are in §2 and §6 |
| R3 | Canonical commit and manifest serialization; domain separators | C2, C4, C5 | **frozen 2026-10-12 as draft 2** (gate G12, [delegated 2026-10-12]; owner review pending at the desktop checkpoint): `R3-canonical-serialization-draft.md`, from `mochi-format/src/{cbor,digest}.rs` and the record codecs of `mochi-core` at `17fe094`; the encoding (D2) with a constructed example for every accepted and refused construct, the schema registry and the rule for which version a writer uses, the commit ID construction, the nine domain separators and the two unseparated scopes, the rules CDDL cannot state, and a vector index that marks its gaps. **Every `docs/schemas/*.cddl` file is complete and standalone and is checked mechanically against the golden bytes** by `crates/mochi-testkit/tests/r3_cddl.rs` (the `cddl` crate, MIT, a dev-dependency of `mochi-testkit` only). 9 open items, whose calls were confirmed at the freeze (§10); the cold-read conventions are §7.3 and the freeze review §11; no byte the code writes changed |
| R4 | Complete SQLite DDL and constraints | C3 | **frozen 2026-10-12 as draft 2** (gate G12, [delegated 2026-10-12]; owner review pending at the desktop checkpoint): `R4-catalog-ddl-draft.md`, from `mochi-core/src/catalog/schema.rs` at `57e3a69` (five §10.1 tables live outside the catalog, §4 there); **`user_version` is 1**; its 5 open items decided 2026-10-11; the path, extent, and namespace rules (§3.1) and the freeze review (§6) were added at the freeze |
| R5 | Cryptographic suite and vectors | C11 | **frozen 2026-10-11** (D20, spec Annex B.2.10; gate G10 met; review in §12): `R5-crypto-draft.md` (name kept for links), vectors in `R5-vectors/` (independent oracles, reproducible), schemas `key-envelope-v0.cddl` (frozen), and the R5 keys of `commit-record-v2.cddl` (11, 12) and `recovery-manifest-v3.cddl` (13, provenance `reason`); the rest of those two schemas freezes with R3 |
| R6 | Erasure-coding suite and vectors | C12 | **frozen 2026-10-12** (D21, spec Annex B.2.11; gate G11 met, self-review K11 in §10): `R6-erasure-coding-draft.md` (name kept for links), from `mochi-format/src/parity.rs` and `mochi-core/src/parity.rs`; vectors in `R6-vectors/` from an independent Python implementation, regenerated and diffed by CI; cost measured in `docs/benchmarks/c12-parity.md`; its 5 open items decided at the freeze (none changed a byte) |
| R7 | Report schema and stable error codes | C7 | **draft 2026-10-11, not frozen** (freezes at Beta): `R7-reports-and-error-codes-draft.md`, from `mochi-core` (`error.rs`, `report.rs` v1, `status.rs`, `exit.rs`, `verify::classify`) and `mochi_cli::exit_code_for` at `57e3a69`; its 6 open items decided 2026-10-11 (delegated) |
| R8 | Golden valid/corrupt/interrupted archives | all C phases | **built 2026-10-13** (W16, gate G13 met [delegated]): `fixtures/golden/r8/`, 76 cases (21 valid, 38 corrupt, 10 interrupted, 3 copy, 3 salvage, 1 legacy) over the six 1.0 profiles, each with an expected `mochi-interop-summary-v1`; **frozen when written**; mechanical coverage (profiles x classes, the spec 24.2 rows about archive bytes, every reachable violation-class code; exemptions named in the test); 9.6 MiB of a 12 MiB budget; the G1 audit adds 48 vectors in `r8/g1/`. See `fixtures/golden/README.md`. The per-phase sets `c1` to `c12` and `b2` remain |
| R9 | Independent reader/writer interop results | R1–R8 | **met 2026-10-13** (W17 verifier `interop/pyverify`, W18 results, gate G14 met [delegated]): the Python verifier produces the reference `mochi-interop-summary-v1` for all 76 R8 cases in CI (job `r9-interop`, run 38364569151); every disagreement (53 cases, 70 field differences) is in `R9-interop-results.md` with class and resolution; no byte changed, draft 2 stands |
| R10 | Segmented-location rules | none | post-1.0 |

**Drafts and drift.** R7 is a draft; R1, R2, R3, R4, and R6 were drafts until they froze, written from the code (plan §6,
next-work-plan W8, ratification-core-plan W13). Each marks the tables it states as *(checked)*;
`crates/mochi-cli/tests/ratification_drafts.rs` parses those tables and compares them
with the code (and R2's D11 obligations and R4's §10.1 table list with the spec), so a
change to the registry, an envelope layout, the DDL, the error-code registry, the
report fields, the parity suite's constants and frame layout, the CBOR codec's accepted
constructs and fault codes, the schema versions, the commit ID construction, or a
domain separator fails CI until the draft is updated with it. R3's schemas are checked
separately: `r3_cddl.rs` validates every valid golden CBOR record against its
`docs/schemas/*.cddl` file, classifies every reject vector, and compares the schemas
with the production decoders over generated mutants. Each draft ends with the
open items it found (places where the spec and the code disagreed or the spec was
silent) and, since 2026-10-11, the delegated decision on each and where it now lives.

**Plan for the rest (2026-10-12, delegated).** `docs/ratification-core-plan.md` makes the
remaining calls and orders the work:
1. R3 is written as a draft (W13).
2. R6 is benchmarked and frozen (W14, G11): done 2026-10-12.
3. R1–R4 froze together at a **format freeze** (W15, gate G12): done 2026-10-12, with the
   draft identifier at 2 (spec D24) and `user_version` 1. Each ends with its freeze review,
   including a cold reading by a reader given only the spec and that artifact.
4. R8 is built on the frozen format (W16, G13): done 2026-10-13.
5. R9 runs against R8 (W17, W18, G14): done 2026-10-13.
6. R7 freezes at Beta (W19, G15).

Freezes are self-reviewed in the form of R5 §12 and reviewed by the owner at the desktop
checkpoint.
