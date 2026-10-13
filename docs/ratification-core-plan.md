# Remaining Core library and ratification work: calls and workstreams (2026-10-12)

This file is the hand-off for everything left on the **Core library track** (plan §5)
and the **Ratification track** (plan §6). It follows the pattern of
`docs/next-work-plan.md` (W1–W9, calls K1–K9) and continues its numbering: calls
**K10–K26**, workstreams **W10–W20**. The desktop track (D1–D8) is out of scope here.

It was written at `main` `6172a99`, after C12 and the R6 draft merged
(immerh8/MOCHI#26).

**Authority.** The owner delegated every call in this file on 2026-10-12. They asked that
each call be made on best practice and the project's goals, that it be self-reviewed,
and that the owner review it at the next desktop-phase checkpoint. Calls are marked
**[delegated 2026-10-12]**. Where a call changes a spec rule, it is already written into
`docs/spec.md` Annex B (D22–D24, gates G12–G15). Where it is a plan matter, it is written
into `docs/implementation-plan.md`. This file does not override the spec or the
ratification artifacts (AGENTS.md "Sources of truth"). If this file and the spec ever
disagree, the spec wins and the disagreement is a bug in this file.

**Sessions.** Every session follows `docs/next-work-plan.md` §2 ("How every workstream
session works"): start from the latest `main`, use an independent oracle, run the
mutation check, add fuzz coverage for parser changes, update the docs in the same PR,
and get CI green on Windows and Ubuntu.

---

## 0. What is left, in one table

| Area | Item | State at `6172a99` | Workstream |
|---|---|---|---|
| Core | C8 ladder step 5: alternate objects from independent copies | `not_attempted` at that commit; **implemented by W11** (`mochi_core::copies`) | **W11** |
| Core | C8 ladder step 7: bounded salvage scan | `not_attempted`; blocked on a D12 call at that commit; **implemented by W12** (`mochi_core::salvage`) | **W12** (call K19, K20) |
| Core | DoD row "missing shared dictionary" | Nothing to exercise; K4 refuses the plan | **W10** (K17) |
| Core | Footer-history accelerator `0x184D2A5E` (§22) | Registered, never written | **W10** (K16: not in 1.0) |
| R1, R2, R4 | Frame registry, envelopes, DDL | Drafts; all open items decided 2026-10-11. **Frozen 2026-10-12 by W15 (G12, draft 2)** | **W15** (format freeze) |
| R3 | Canonical serialization and separators | No artifact at that commit. The encoding, schemas, and separators existed as drafts in code and CDDL. **Written by W13; frozen 2026-10-12 by W15** | **W13**, frozen in **W15** |
| R5 | Crypto | **Frozen** 2026-10-11 | — |
| R6 | Erasure coding | **Frozen** 2026-10-12 (W14, G11 met; the row below was the state when this plan was written: draft with independent vectors, 5 open items, G11 not met) | — |
| R7 | Reports and error codes | Draft; decided items; freezes at Beta | **W19** |
| R8 | Golden valid, corrupt, and interrupted archives | Per-phase sets `c1`–`c12`, `b2`; no whole-set R8. **Built by W16 (2026-10-13, G13): 76 cases, `fixtures/golden/r8/`** | **W16** |
| R9 | Independent reader results | Not started; author not chosen | **W17**, **W18** (call K22) |
| Gate 4 | Draft-to-1.0 boundary (§26) | Descriptor key 3 = draft 1; a reader refuses any other draft | **W20** (K25) |
| G6 | Windows durability evidence | Needs physical Windows hardware | Owner-only (T33). Not planned here |

---

## 1. Calls made now

"Wire" means a stored byte or field changes. Every call below is **[delegated 2026-10-12]**.

### Ordering and freezing

| # | Question | Call | Why | Recorded in |
|---|---|---|---|---|
| K10 | **Order of the remaining ratification work** | (1) Finish the Core work that could touch the format (W10–W12). (2) Write R3 and freeze R6 (W13, W14). (3) Freeze the wire artifacts R1–R4 together (W15). (4) Build R8 on the frozen format (W16). (5) Write R9 against frozen artifacts (W17) and run it over R8 (W18). (6) Freeze R7 at Beta (W19). (7) Make the 1.0 flip (W20). | Golden archives made before the freeze would be regenerated twice (R4 decision 3 already says so for `user_version`). An independent reader written against drafts chases churn. R7 has consumers still unbuilt (desktop D4, W12's new code). | This file; plan §6 |
| K11 | **Who approves a freeze** | **A self-review recorded in the artifact**, in the form of R5 §12. It lists what was checked, what was found and fixed, and a call on every open item, marked [delegated 2026-10-12]. The owner reviews all freezes at the next desktop-phase checkpoint. A change the owner asks for after a freeze is a **new identifier** where one exists (schema version, suite, envelope version). Otherwise it is a draft-identifier bump (K13), never a silent edit. | The owner delegated review. Recording the review in the artifact keeps it auditable, and the bump rule keeps "frozen" meaningful while the owner's review is pending. | This file; each artifact's freeze section |
| K12 | **When R1–R4 freeze** | **At a "format freeze" milestone (gate G12), not at Beta.** R1, R2, R3, and R4 freeze together in one review (W15), after R6 has frozen (W14). Desktop phases do not wait for it and are not waited for. **Reader-side indexes are not wire:** a reader, the desktop app included, may `CREATE INDEX` on the in-memory catalog after `Catalog::open_image`. The stored image and its DDL do not change for that. | The desktop app changes no stored byte. Waiting for Beta (which includes D0–D8) would hold R8 and R9, the longest items, behind the desktop track. D1's 100k-entry browsing is the one plausible desktop pressure on R4, and in-memory indexes answer it without a wire change (catalogs are in-memory SQLite, O25). | Spec B.2.6 G12; plan §6 |
| K13 | **The draft identifier at the freeze** | **Bump `descriptor::DRAFT_ID` from 1 to 2 in the W15 freeze change**, in the same change that sets R4 `user_version` to 1. Draft 2 names the frozen layout. Keep one draft-1 archive as a reject fixture (`UNSUPPORTED_FEATURE`, exit 4, the message naming draft 1). Regenerate every other whole-archive fixture deliberately; the PR explains the diff (only descriptor key 3, `user_version`, and the hashes, IDs, and nonces downstream of them change). Any later wire change before 1.0 bumps the draft again, with an Annex B entry. | Rules changed under unchanged schema numbers during C5–C12 (Q64, parity placement, retention encodings). "Never misread" (release gate 4) can be proved mechanically only if the frozen layout has its own identifier. The fixture churn is a one-time, explained regeneration. | Spec Annex B D24; R1 §1 at the freeze |

### R3, R6, and small Core items

| # | Question | Call | Why | Recorded in |
|---|---|---|---|---|
| K14 | **What R3 contains, and what changes** | **Freeze what exists; renumber nothing.** (a) The separators in `digest.rs` (`MOCHI2-<SCOPE>` plus one zero byte) are frozen exactly as drafted, and so is the unseparated file-content hash (O20). (b) Schema version numbers stay: descriptor 0, commit 1 and 2, manifest 1, 2, and 3, key envelope 0 (already frozen with R5), and the image and parity record versions. Commit and manifest schema 0 stay refused as legacy. (c) **Every CDDL file becomes complete and standalone**: no "restated from", every code-defined key drawn (for example manifest key 12, provenance, which `recovery-manifest-v2.cddl` does not yet draw). (d) **The CDDL is validated mechanically**: a test validates every valid golden CBOR record against its CDDL, and checks that every schema-level reject fails, using the `cddl` crate (MIT) as a **dev-dependency of `mochi-testkit` only**. If the crate cannot express a construct, that rule is listed in R3 with a hand-written check and becomes an R9 check. (e) The **commit ID construction** (canonical encoding of the record without key 9, under `MOCHI2-COMMIT-ID`) and the **schema-selection rules** ("one logical structure, one encoding": which schema a writer must use when) are stated as checked tables. (f) `tail-quarantine-v0` goes in an R3 appendix as a tool file, frozen with R3. The JSON tool formats (plans, reports) belong to R7. | Renumbering or renaming at this point buys nothing and invalidates every vector. A spec-only reader (R9) needs complete CDDL, and a mechanical check is the only way to know the CDDL matches the bytes. | W13; R3 artifact |
| K15 | **R6 open items** | (1) Head footer unprotected: **keep** (no wire change). The head's footer is protected by copies (W11), not by parity, and AGENTS.md's "never republish a head commit from parity" stays. (2) End of file is the weak spot: **keep**, documented; a trailer copy is 1.x. (3) Hash-table overhead: **keep**, quantified by the W14 benchmark. (4) GF(2^8) with 128 + 128 shards: **keep**. (5) No benchmark: **W14 writes one before the freeze** (§27 decomposition). | Items 1–4 trade a wire change for a modest gain, and the copies of W11 cover item 1 better than any in-file mechanism. A freeze without a measured cost would leave §27 unmet for the profile. | W14; R6 §9 |
| K16 | **Footer-history accelerator `0x184D2A5E` and `.mochi.trailer-backup`** | **Not written in 1.0.** The magic stays registered (R1). Readers walk and skip such a frame and never interpret it. Step 2 of the ladder stays the forward and backward walk. The sidecar is not written either. Both are 1.x options. | Neither is a recovery authority (§22), the walk is already measured (G3), and writing either is a new wire obligation that would need its own vectors and R9 coverage. | Spec §22 amendment; W10 |
| K17 | **DoD row "missing shared dictionary" in 1.0** | 1.0 writes no dictionaries (O21), and readers refuse dictionary-dependent chunks. The row is met in 1.0 as follows. `verify` reports every file version whose chunks declare a dependency as `UNSUPPORTED` (`UNSUPPORTED_FEATURE`), listing the affected versions and snapshots, with exit 4 and no partial content result. `repair plan` refuses (K4, already built). W10 adds the `verify` test if it is missing; W16 adds an R8 case. | It meets "identify all affected files" honestly. "Exercise recovery" has nothing to recover from in a format that never writes dictionaries. | Spec §24.2 amendment; plan §8.1; W10 |

### C8 steps 5 and 7

| # | Question | Call | Why | Recorded in |
|---|---|---|---|---|
| K18 | **Ladder step 5: independent copies** | Full design in **spec Annex B.2.12 (D22)** and W11 below. In short: **aligned copies only** (byte copies of the same archive, possibly shorter or longer), given as `repair plan|apply --copy PATH` (repeatable) and opened read-only. **Trust comes from the source, bytes may come from a copy.** A copy donates a frame only inside the range of commits it *agrees* on with the source, and only when the copy's frame verifies against the expected hash and the source's frame does not. Parity (step 6) runs first, then copies, then steps 1–4 on the stacked overlay. Donation by stored hash from non-aligned files (rewrites, other archives) is **1.x**. **No wire change.** The plan format becomes `mochi-repair-plan-v2`. | Byte copies are what users keep ("the copy on the other disk"), and aligned donation needs no index of foreign files. Trust rooted in the source stops a diverged or forged copy from replacing history. Parity first needs no external input and touches the copies only for what remains. | Spec D22 (B.2.12), §22 step 5 amendment |
| K19 | **Ladder step 7: bounded salvage scan** | Full design in **spec Annex B.2.13 (D23)** and W12. In short: it runs only when asked (`repair plan|apply --salvage`). It scans with a resync and a candidate limit. A commit found by the scan is **confirmed** when its own footer validates or a confirmed later commit's parent link names it. **An unconfirmed commit is never recovered**, only listed (it may be an interrupted publication, §5.1). Contradictory identities recover neither side. A candidate whose self-recorded offsets disagree with its position is rejected, which keeps an archive stored *inside* the archive from being salvaged as the archive. Several archive IDs is `ARCHIVE_ID_AMBIGUOUS` (new code, exit 3) unless `--archive-id` picks one. Orphan data objects are counted, never placed in a namespace. **Any plan that uses step 7 is `partial`** (exit 2): without a trusted head, completeness cannot be shown. **No wire change.** | It meets each §22.1 rule with a mechanical test, and keeps §5.1 (an uncommitted commit never becomes a head) under salvage. Explicit invocation follows D12 ("explicit salvage labelled partial"). | Spec D23 (B.2.13), §22 step 7 amendment |
| K20 | **D12's "descriptor labelled as reconstructed"** | **No reconstructed descriptor is ever written.** A repaired archive is a new archive (C8 decision 1) with its own descriptor, which is accurate for it. The reconstruction is recorded in the plan and the repair report only, as every other repair fact is (C8 decision 2). Without the source descriptor, and after parity and copies have failed to restore it, the output profile is **inferred from evidence**. Encrypted: from required feature 1 in the confirmed commits (all must agree). Recovery-record percentage: from intact parity frames (all must agree). TAR compatibility cannot be told from evidence with certainty, so it is **not carried**, and the plan lists it as a lost constraint. | An in-archive "reconstructed" label would need a schema change to manifests frozen with R5, and it would be a claim that anyone can write. The report is where repair facts live already. | Spec D12 amendment, D23 item 8 |

### R8 and R9

| # | Question | Call | Why | Recorded in |
|---|---|---|---|---|
| K21 | **R8's form** | `fixtures/golden/r8/`, built after the format freeze. Contents: `cases.json` (the index), `<case>.mochi` (plus `<case>.copyN.mochi` for copy cases), and `<case>.summary.json` (the expected interop summary, K22). Classes: `valid`, `corrupt`, `interrupted`, `copy`, `salvage`, `legacy`. **Coverage is checked by a test**, not by prose. Every profile and allowed combination (Core, TAR, Encrypted, Redundancy, TAR+Redundancy, Encrypted+Redundancy) has valid, corrupt, and interrupted cases. Every §24.2 row that concerns archive bytes in 1.0 has a case. Every R7 violation-class code reachable from archive bytes has a case, and the exemptions are listed in the test. Files are **frozen when written**: the builder refuses to overwrite a different file, as `c11` and `c12` already do. Regeneration happens only at a draft bump or the 1.0 flip, from recipes in code, with an explained diff. The **G1 evidence audit** (R2 decision 4) is done here. Size budget: **12 MiB** for the whole set. | Archives depend on zstd, SQLite, and random nonces, so byte-reproducible whole archives are not available. Freezing on write plus recipes in code is the established practice here. Mechanical coverage keeps the set honest as codes are added. | W16; `fixtures/golden/README.md` |
| K22 | **R9: who writes it, and how independence is enforced** | **A fresh session started cold** (D7: Python, read-only, from the spec alone). It is created with `create_session` and a **sparse checkout** of `docs/`, `fixtures/golden/`, and `interop/` only, so `crates/` is not on disk. Its prompt (W17) allows exactly: `docs/spec.md`, `docs/ratification/*.md`, `docs/schemas/`, the vectors (`R5-vectors/vectors.json`, `R6-vectors/vectors.json`) **as data**, and the fixtures. It forbids the `gen_vectors.py` scripts, every other `docs/*.md` (they describe the Rust code), and every Rust source. The code lives in `interop/pyverify/`, depends on Python ≥ 3.10 (Ubuntu 22.04) and pinned `blake3==1.0.8`, `zstandard`, `PyNaCl`, and `argon2-cffi`, and has **its own** deterministic-CBOR decoder (a general CBOR library cannot enforce the re-encoding rule). Its README states what was read. Agreement is **exact equality of the interop summary** (`mochi-interop-summary-v1`, defined in W17), never a tolerance. | Independence is what makes §28's interoperability claim mean anything. A sparse checkout enforces it physically, and the prompt covers what the checkout cannot. | Spec B.1 D7 amendment; W17 |
| K23 | **R9's scope** | Read-only verification at every level `verify` has for archive bytes: framing walk, footers, descriptor, commit chain and IDs, envelopes, manifests, **namespace replay from manifests without SQLite**, stored and content hashes, file-content hashes, promised attributes, parity (check, and rebuild within capacity), Encrypted (open with the passphrase; keyless stored integrity), and TAR (stream reassembly checked with Python's `tarfile`). It also checks **catalog images against R4** using Python's `sqlite3` (via a temporary file, since 3.10 has no `deserialize`): schema, `user_version`, `integrity_check`, and namespace equal to the manifest replay at checkpoints. It does **not** repair, salvage, or write. It also runs **truncation at every byte** of the small valid R8 cases on the fly and never accepts a commit outside the original's prefix. | It covers every frozen artifact R1–R6 from the reader side, which is what D7 scopes for 1.0. Repair is a product behaviour, not a format property. | W17 |
| K24 | **R7's freeze** | **At Beta, after desktop D4 merges and after W12** (the last new code). It includes JSON Schema (2020-12) documents for **every machine-readable JSON the CLI writes**: report v1, `mochi-repair-plan-v2`, the GC plan, health evidence, and health policy. Outputs are validated against them in tests using the `jsonschema` crate (MIT, dev-dependency). §20.6's example is replaced by an abridged real report generated from an R8 case (R7 decision 4). | D4 consumes the report and is the last likely source of field changes. Additive codes after the freeze are allowed by R7's own rule, so waiting costs nothing. | W19 |
| K25 | **The draft-to-1.0 boundary (release gate 4, §26)** | **1.0 writes `null` in descriptor key 3** (a ratified archive). Every 1.0 command except `migrate` refuses a draft archive with `UNSUPPORTED_FEATURE` (exit 4), naming the draft. **`mochi migrate SRC --output DST`** (new command, §23 amendment) reads **only the last draft** (the frozen layout, draft 2 unless later bumped) and writes a new 1.0 archive through the rewrite path (`compact::Copier`). It then verifies the result at restoration level and compares file hashes and retained namespaces (§26 steps 1–6, 8). Older drafts are refused with the same message, minus the migrate hint. **R8 is regenerated in the 1.0 format at the flip**, R9 reruns on it, and a few draft-2 archives move to `r8/legacy/` as migrate cases. | Rejection alone meets the gate, but it would strand every Beta user's archives. Migrating only the frozen draft bounds what 1.0 must still understand to one layout already covered by R8 and R9. | Spec Annex B D24; W20 |
| K26 | **New evidence gates** | **G12** format freeze (R1–R4 frozen, draft 2), **G13** golden set (R8 complete with mechanical coverage), **G14** interoperability (R9 agrees with R8 on every case; disagreements resolved and recorded), **G15** report freeze (R7). | Each later step depends on a checkable state of the one before. Naming the gates makes "done" testable. | Spec B.2.6 |

Nothing in Core or ratification scope is still waiting on a decision. The remaining
owner-only items are **G6** (Windows hardware, T33) and the owner's review of these calls
at the desktop checkpoint.

---

## 2. Order

Sizes: S ≈ under a day, M ≈ 1–2 days, L ≈ several days, XL ≈ a week or more of agent time.

| ID | Workstream | Size | Depends on | Parallel |
|---|---|---|---|---|
| W10 | Core residue: K16, K17, stale status lines | S | — | ∥ W13, W14 |
| W11 | C8 step 5: independent copies (D22) | M | W10 | ∥ W13, W14 |
| W12 | C8 step 7: bounded salvage (D23) | L | W11 (both edit `repair.rs`) | ∥ W13, W14 |
| W13 | R3 artifact, complete CDDL, mechanical CDDL check | M | — | ∥ W10–W12, W14 |
| W14 | R6 benchmark and freeze review (G11) | S–M | — | ∥ anything |
| W15 | Format freeze: R1–R4 review, draft 2, `user_version` 1 (G12) | M | W10–W14 | — |
| W16 | R8 golden set (G13) | L | W15 | ∥ W17 |
| W17 | R9 independent verifier (cold session) | XL | W15 | ∥ W16 |
| W18 | R9 interop run and resolution (G14) | M | W16, W17 | — |
| W19 | R7 freeze (G15) | S | W12, desktop D4 | — |
| W20 | 1.0 flip: ratified descriptor, `migrate` | M | W18, W19, every §8.2 gate except this one | — |

W10–W12 share `repair.rs`, `verify.rs`, `cli.rs`, and the plan, so they run one after
another. W13 and W14 touch only docs, `mochi-format` tests, and examples.

---

## 3. Workstreams

### W10 — Core residue (S)

**Goal.** Close the small Core items so the C8 work starts clean.

1. **K16.** Amend nothing in code (the accelerator is already unwritten). Check that
   `verify` and the walkers skip a `0x184D2A5E` frame without interpreting it, and add a
   test that an archive with one injected between commits still verifies and its frame is
   never read as history (forge it with `mochi_testkit::forge`). R1's registry row already
   says "Not written".
2. **K17.** Check what `verify` does today with a chunk whose record declares a dictionary
   dependency (forge it as `c8_undecodable_content_refuses_the_plan` does). It must report
   the affected versions (path, version ID, snapshots) with `UNSUPPORTED_FEATURE`, put
   the content levels at `UNSUPPORTED`, exit 4, and produce no partial content result. Fix
   it if it does not, then test it in `c7_verify.rs`. Update plan §8.1's "Recovery &
   repair" row text.
3. **Stale text.** Plan C14 status line ("Still `NOT_IMPLEMENTED`: `rekey`…") is stale:
   `rekey`, `dump-index`, and `health` are built. Fix it, and grep the plan for any other
   "not built" claim contradicted by `crates/mochi-cli/src/cli.rs`.

**Tests.** The two above, plus one mutation each. **PR:** "W10: footer-history frames
skipped, dictionary dependencies reported (K16, K17)".

### W11 — C8 step 5: independent copies (M)

**Goal.** Implement spec Annex B.2.12 (D22). Read it first: it is normative, and this
section is the implementation guide.

**Surface.**
- `mochi repair plan ARCHIVE [--copy PATH]... [--output PLAN]`
- `mochi repair apply ARCHIVE --plan PLAN --output NEW [--copy PATH]... [--accept-retention-loss]`

`apply` must be given the same copies in the same order; the re-survey refuses any
difference, as it already does for the source. Copies are opened read-only through
`Storage`, like the source.

**Design (in `mochi-core`, new module `copies.rs`, used by `repair.rs`).**

1. **Stacking.** `survey_healed` today builds `parity::HealedSource` over the source and
   surveys it. Add the copy overlay *on top of* the parity-healed view: parity first,
   then copies, then the survey. Give `HealedSource` (or a sibling type) a way to accept
   patches from the copy pass. A patch is a whole frame `(offset, bytes)`, never a partial
   one.
2. **Is it a copy?** Read the copy's frame at offset 0. It is a copy when one of these
   holds:
   - (a) It is byte-identical to the source's descriptor frame.
   - (b) The source's descriptor is damaged, and the copy's descriptor's stored hash
     equals the descriptor hash (commit key 10) that a self-verifying source commit records.

   Otherwise its status is `not_a_copy` and it is not used.
3. **Agreement.** Open the copy as-is: head discovery, then `walk_back_tolerant`. Do not
   run parity on the copy in 1.0; that is documented as a limit. A copy commit *agrees*
   when its footer lies entirely inside the source's length and one of these holds:
   - (i) The source has a self-verifying commit at the same footer offset with the same
     sequence and commit ID.
   - (ii) Its sequence is above the source's last self-verifying commit, it lies inside
     the source's length, and it chains by parent commit ID to an agreed commit. This
     covers the source's damaged tail; the plan labels such commits
     `trust: copy_confirmed`.

   A copy commit at an offset where the source holds a *different* self-verifying commit
   means the copy **diverged**. Agreement stops below that point, and the copy's status
   records `diverged_at` (sequence). Copy commits beyond the source's length are never
   used; the plan notes "copy holds N later commits" as information.
4. **Donation.** Over the agreed range (from 0 to the end of the last agreed footer),
   compare source and copy in 64 KiB blocks. For each frame that overlaps a differing
   block and that the copy's agreed structure assigns an expected hash to, patch the
   source with the copy's frame when **the copy's bytes verify and the source's do not**.
   Frames include the descriptor, commit frames (footer digest), footers (their own
   check against the commit frame), parity frames (their digest), and objects
   (stored-object hash from the copy's verified records: commit references, manifests,
   catalog `object_locations`). Build the expected-hash index with the same code the
   survey uses. Where an expected hash or location cannot be established in the copy,
   that copy cannot donate that frame. Several copies: **the first copy, in argument
   order, that donates a frame wins**, so the plan is deterministic.
5. **Re-verification.** The survey then runs over the stacked overlay exactly as today.
   Every byte it uses is checked against the chain again. Donation only proposes bytes;
   it never vouches for them.
6. **Plan v2** (`PLAN_FORMAT = "mochi-repair-plan-v2"`; `apply` refuses v1 plans with a
   message to re-plan).
   - New `copies: [{path, len, match: identical_descriptor|descriptor_hash|not_a_copy,
     agreed_through: seq|null, diverged_at: seq|null, later_commits: n, frames_donated: n,
     bytes_donated: n, status: used|not_needed|not_available|unreadable, detail}]`.
   - New `donations: [{offset, len, kind, copy: index}]`, sorted by offset. It meets
     §22.2: "identify the source of each reconstructed object".
   - `RecoveredSnapshot` gains `trust: chain|copy_confirmed`.
   - Ladder step 5 status: `used`, `not_needed`, or `not_available` (detail "no --copy
     given" when none was given).
7. **Errors.**
   - An I/O error **on a copy** is recorded as that copy's status `unreadable`, with the
     message; the plan continues. An I/O error on the source stays fatal, as today.
   - A copy path that is the source itself (same canonical path) is `INVALID_ARGUMENT`.
8. **Outcome.** The rules are unchanged. A repair made complete by copies is `complete`
   (exit 0): the result is fully verified, and §22.2 asks for the source to be named, not
   for the outcome to be lowered.

**Tests** (`crates/mochi-testkit/tests/c8_copies.rs`, with a pristine copy as the oracle
as in `c8_repair.rs`):
1. A damaged chunk with an intact copy: `complete`, the snapshots reproduced exactly, one
   donation listed.
2. Head commit frame and footer destroyed, copy intact: the head is recovered,
   `copy_confirmed`.
3. Copy diverged after commit *c* (both appended independently): donations only at or
   below *c*, `diverged_at` reported, nothing above *c* taken from the copy.
4. Copy longer than the source: later commits reported, never used.
5. Copy shorter (an older copy): donates for its commits only.
6. Copy damaged in the same place: no donation, `partial`.
7. Not a copy (another archive): `not_a_copy`, step 5 `not_available`.
8. A copy with one altered chunk (a forged copy): never donated.
9. Redundancy beyond capacity in one group, and the copy covers that group: `complete`
   (parity first, then the copy). The ladder shows step 6 `used` and step 5 `used`.
10. Encrypted source and copy: planning works keyless where it does today; `apply` with
    the passphrase.
11. Copies are untouched: whole-file BLAKE3 before and after both `plan` and `apply`.
12. `apply` refuses: a different copy list, a copy edited between `plan` and `apply`, or a
    v1 plan.
13. A copy I/O error is injected with the testkit's fault storage: the copy is
    `unreadable` and the plan still completes.

CLI test in `crates/mochi-cli/tests/c8_repair_command.rs`. Fuzz: `exercise_archive_open`
also plans with a copy equal to a mutated copy of the input, and checks that every
donation's bytes verify against the chain.

**Mutations** (at least 6): no agreement check, divergence not stopping, donation without
source-side failure, the copy-beyond-length rule removed, first-copy-wins replaced by
last-copy-wins, re-verification bypassed for donated frames.

**Docs.** Plan C8 status bullet. `docs/c14-cli.md` (`--copy`). Spec D22 status set to
"implemented". `fixtures/golden/README.md` if fixtures are added.

**PR:** "C8: ladder step 5, independent copies (D22)".

### W12 — C8 step 7: bounded salvage scan (L)

**Goal.** Implement spec Annex B.2.13 (D23) and the D12 amendment (K20). Read both
first.

**Surface.**
- `mochi repair plan ARCHIVE --salvage [--archive-id HEX] [--copy PATH]...`
- `apply` takes the same `--salvage` and `--archive-id`.

Without `--salvage`, step 7 stays `not_attempted`. When steps 1–6 left something
unrecovered, the detail says "`--salvage` may recover more".

**Design (new module `salvage.rs`, used by `repair.rs`).**

1. **When.** Only with `--salvage`, after steps 6, 5, and 1–4. Salvage is needed when one
   of these holds:
   - no trusted head;
   - a chain break left snapshots that no trusted catalog covers;
   - the descriptor is unrecoverable.

   Otherwise step 7 is `not_needed`.
2. **Scan** (bounded, §22.1).
   - Walk frames forward from 0 over the healed view. Where the walk fails at offset *x*,
     **resync**: try each byte offset after *x* as a candidate frame start. A candidate is
     a skippable magic `0x184D2A50`–`0x184D2A5F`, or the Zstandard magic, with a header
     whose length fits the limits and the file. A candidate that validates (structurally
     for data frames; by digest or schema for control frames) resumes the walk after it.
   - Never resync *inside* a frame that walked validly.
   - Each candidate counts against a new reader limit, **`max-salvage-candidates`**
     (default 1,048,576; in `Limits::named`, so `LIMIT_NOT_DEFAULT` reports a change).
     Reaching the limit stops the scan. Step 7 is then **`incomplete`** (a new
     `StepStatus` variant: "ran, stopped at a limit; never a pass"), with the limit
     named in the detail.
3. **Candidates kept.**
   - Footers whose digest validates over the commit frame they name. The **recorded
     commit offset, length, and sequence must equal the commit frame's actual position
     and sequence**.
   - Commit frames whose commit ID recomputes, whose envelope is valid, and whose parent
     footer offset (if any) points before them.
   - Other control frames and data frames by position only. Data and control frames are
     never interpreted except through a reference from a kept commit.
4. **Identity.**
   - The expected archive ID comes from, in order: the source descriptor if readable;
     else `--archive-id`; else the set of archive IDs among kept commits.
   - If that set has more than one member, the result is **`ARCHIVE_ID_AMBIGUOUS`**: a
     new error code, operational, exit 3, listing the IDs. Commits with another ID are
     counted as foreign and ignored.
   - Two kept commits with the same sequence and different commit IDs are
     **contradictory**: neither is recovered, and both are listed (§22.1 "reject
     contradictory identities").
5. **Confirmation.** A kept commit is **confirmed** when either its own footer is kept,
   or a confirmed commit's parent link names it (commit ID). Resolve this to a fixed
   point from the top down. **Unconfirmed commits are never recovered.** They are
   listed with sequence, ID, and offset, and the reason is "no footer or later commit
   confirms publication (§5.1)". This is the rule that keeps an interrupted
   publication's commit (an eligible tail, D14) from becoming history.
6. **Segments.** Group the confirmed commits into maximal chains linked by parent ID.
   Each segment's top commit is opened like a head (the existing survey path, with
   `open_at_footer` checks where a footer exists). Its snapshots are recovered by the
   existing rules: catalogs, then manifests, verified versions only, nothing invented.
   Snapshots from all segments merge in ascending source sequence. A sequence recovered
   by the trusted chain is never replaced by a salvage one.
7. **Labels.** `RecoveredSnapshot.trust` gains `salvage`. A new
   `salvage: {candidates, kept_commits, confirmed, unconfirmed: [...], contradictory: [...],
   foreign_commits: n, orphan_data_objects: n, orphan_bytes: n, segments: [...],
   profile_inference: {...}, limit_reached: bool}` section is added. Orphans are data
   objects that no recovered commit references. They are counted and never extracted (a
   raw orphan export is 1.x).
8. **Profile inference (K20).** Only when the descriptor is not restored by parity or
   copies:
   - Encrypted iff the confirmed commits list required feature 1. If the commits
     disagree, the plan refuses with `RECORD_INVALID`.
   - The recovery-record percentage comes from intact parity frames of confirmed
     commits. If the frames disagree, the plan refuses.
   - TAR compatibility is **not carried**. `profile_constraints_lost: ["tar_compatible"]`
     is listed.
   - Writer parameters come from any verified catalog image; otherwise this build's
     defaults, which are listed.

   The new archive gets a fresh, ordinary descriptor (D12 amendment).
9. **Retention.** Unchanged rules. With no trusted head, retention is unresolved, and
   `apply` requires `--accept-retention-loss`, which is recorded.
10. **Outcome.** **Any plan where step 7 is `used` or `incomplete` is `partial`** (exit 2).
    If nothing is recoverable, the outcome is `nothing_recoverable` (exit 1). Step 7
    `not_needed` leaves the outcome to the existing rules.
11. **Bounds.**
    - Memory: per candidate, a fixed-size index entry (about 64 bytes, so about 64 MiB at
      the default limit).
    - Time: linear in file size plus the limited validation of each candidate.
    - Checked arithmetic on every offset.
    - Cancellation checked per MiB scanned.

**Tests** (`crates/mochi-testkit/tests/c8_salvage.rs`; the oracle is a pristine copy plus
`read_state`):
1. Every footer has one flipped byte (no head): commits 0..n−1 are confirmed by links
   and recovered; the head is listed as unconfirmed; `partial`.
2. Descriptor destroyed beyond parity and with no copy: recovered with inferred profile;
   TAR listed as lost for a TAR archive; Encrypted needs the passphrase.
3. Middle commit frame destroyed, and the later catalogs damaged: the older segment is
   recovered from its own catalogs.
4. **An archive stored inside itself** (a byte copy of an earlier state, put as a file;
   incompressible, so zstd stores it raw), and the header of the data frame that holds it
   destroyed so the resync scans inside it. Nothing is recovered from the embedded copy
   (offsets disagree), and the outer archive's snapshots are unchanged.
5. Two archives concatenated: with archive A's descriptor intact, B's commits are
   foreign. With the descriptor destroyed, `ARCHIVE_ID_AMBIGUOUS` (exit 3); with
   `--archive-id`, the chosen archive is recovered.
6. An interrupted publication (commit frame written, no footer): never recovered, listed.
7. Forged contradictory commits at one sequence: neither recovered.
8. The candidate limit set low with `--limit`: step 7 is `incomplete`, `partial`, and
   `LIMIT_NOT_DEFAULT` is reported.
9. **Truncation at every byte** of a small three-commit fixture, salvaged: the recovered
   snapshots are always a subset of the original's committed snapshots with identical
   content, never an uncommitted one. This is a property test, and it is the strongest
   evidence for §5.1 under salvage.
10. `--salvage` on a clean archive: step 7 `not_needed`, the outcome is unchanged
    (`complete`).
11. Cancellation mid-scan.

CLI test. **Fuzz:** a new target `salvage_scan` runs the scan over arbitrary bytes with low
limits. It checks the invariants: no recovered commit unconfirmed; no two recovered
snapshots with one sequence; outcome never `complete` with step 7 used; termination
within limits. Extend `exercise_archive_open` too.

**Mutations** (at least 8): confirmation by footer removed; by link removed; the offset
self-consistency check removed; contradictory identities allowed; never-resync-inside
removed; outcome `partial` rule removed; the limit not enforced; foreign IDs accepted.

**Docs.**
- The new code in `error.rs`, `verify::classify`, `exit_code_for`, and R7 §6.
- The plan C8 status bullet, with the "Exit" line met: "a partial salvage is reported as
  partial in both report and exit code".
- `docs/c14-cli.md`.
- Spec D23 status set to "implemented".

**PR:** "C8: ladder step 7, bounded salvage scan (D23)".

### W13 — R3 artifact (M) ∥

**Goal.** Write `docs/ratification/R3-canonical-serialization-draft.md` as R1, R2, R4, and
R7 were written: from the code, with tables marked *(checked)* that the drift test
`crates/mochi-cli/tests/ratification_drafts.rs` compares with the code. Do it **as a
draft**; W15 freezes it.

**Contents.**
1. **The encoding.** D2's restricted deterministic CBOR (Annex B.1 D2), restated with the
   RFC 8949 references. Checked: the allowed major types, simple values, and the length
   rules in `mochi-format/src/cbor.rs`.
2. **Rejections.** Every rejection the codec makes, with its error code
   (`RECORD_INVALID`), and the re-encoding identity rule.
3. **Schema registry** *(checked)*: record kind, frame kind, schema versions accepted,
   CDDL file, the rule for which version a writer uses, the legacy versions refused, and
   the frozen status (key envelope 0 and the R5 keys are frozen already).
4. **Commit ID** *(checked)*: body = the record map without key 9, canonically encoded;
   `BLAKE3(MOCHI2-COMMIT-ID ‖ 00 ‖ body)`; the vectors (`fixtures/golden/c5/vectors.txt`).
5. **Domain separators** *(checked against `digest::ALL_DOMAINS`, `AEAD_DOMAINS`, and the
   unseparated scopes)*: every string as hex and ASCII, its scope, its input type, and
   the prefix-freeness argument. State that the file-content and tail-quarantine scopes
   are deliberately unseparated (O20).
6. **"One logical structure, one encoding"** per schema: for example, manifest schema 2
   with empty retention is refused; schema 3 exactly in Encrypted archives; commit
   schema 2 exactly with feature 1.
7. **Vector index**: for every CDDL rule, the golden files (valid and reject) that
   exercise it. This is the input to W16's G1 audit; mark the gaps rather than filling
   them here.
8. **Appendix A**: `tail-quarantine-v0` (a tool file, not archive format).
9. **Open items** found while writing, each with a proposed call.

**CDDL work (K14 c, d).**
- Make every `docs/schemas/*.cddl` complete and standalone. Draw every key the code
  accepts, and remove "restated from" in favour of the full text. Mark `*-v0` commit and
  manifest files **legacy (refused)** in their header.
- Add `crates/mochi-testkit/tests/r3_cddl.rs`:
  - Every valid golden CBOR record (descriptor, commit, manifest, key envelope, and the
    CBOR inside fixtures) validates against its CDDL.
  - Every reject vector whose defect is schema-level fails validation; non-schema defects
    are listed as exempt with the reason.
- Add `cddl` as a dev-dependency of `mochi-testkit`. Check its licence and maintenance in
  the PR, per AGENTS.md. If a construct is unsupported, list the rule in R3 §7 with a
  hand check and an "R9 must check" note.

**Tests.** The drift test, extended for R3's checked tables, plus `r3_cddl.rs`. Mutation:
edit one separator, one schema rule, and one CDDL key, and see each fail.

**Docs.** The ratification README R3 row, and plan §6.

**PR:** "R3: canonical serialization draft, complete CDDL, mechanical CDDL check".

**Status (2026-10-12).** Done as specified: R3 draft, every `docs/schemas/*.cddl` complete
and standalone, `r3_cddl.rs`, and the drift tests; the results and the 9 open items are
in the plan §6 status bullet and in R3 §9 and §10. Two things differ from the text
above. (1) Codec rejections are not all `RECORD_INVALID`: truncation is `TRUNCATED` and a
limit overrun is `LIMIT_EXCEEDED` (R3 §1.2, open item 1; the call at the W15 freeze is that the code stands, so this text, W13's goal list, and K14's "every rejection … `RECORD_INVALID`" are corrected here). (2) The `cddl` crate needs
`ast-span`, `ast-comments`, `ast-parent`, `json`, and `additional-controls` enabled to
compile its CBOR validator, and `[profile.dev.package.cddl] opt-level = 3` to run in
seconds; both are in the workspace manifests and explained in R3 §8. The crate matches a
bare range over a byte string by its length and `.regexp` as a search, so the schemas
use `uint .le N` and list the timestamp pattern as a hand check (R3 §7.1).

### W14 — R6 benchmark and freeze review (S–M) ∥

1. **Benchmark** `crates/mochi-testkit/examples/c12_parity_bench.rs`, written up in
   `docs/benchmarks/c12-parity.md` with the §27 decomposition (dataset, hardware, cache
   state, compression settings, encryption off/on, verification level).
   - Write overhead (time and bytes) at 1, 5, 10, 50, and 100 % over commits of 100 KiB,
     4 MiB, 64 MiB, and 512 MiB.
   - The cost of `verify --level stored_integrity` with and without a recovery record.
   - Rebuild throughput with *m* damaged shards per group.
   - Hash-table overhead (K15 item 3) as a fraction of parity bytes.
   - Run release builds, cold and warm cache.
2. **Freeze review** written into `R6-erasure-coding-draft.md` as a new section, in the
   form of R5 §12.
   - **Checked:** the vectors reproduce in a clean environment (pin versions); the code
     is the layout; every G11 item, item by item.
   - **Found and fixed.**
   - **Calls:** K15 items 1–5.
   - Rename the status to frozen (keep the file name, as R5 did).
   - Update the spec B.2.11 status, B.2.6 G11 → met, the ratification README, and plan
     §6.
3. If the review finds a byte to change, **stop and do not freeze**. A layout change is
   an Annex B entry and new vectors, and it needs the review to restart.

**Status (2026-10-12): done.** The benchmark is `docs/benchmarks/c12-parity.md`; the review is R6 §10. It found no byte to change (documentation fixes only), the calls on K15 items 1 to 5 were confirmed, and R6, spec B.2.11, G11, the README, and the plan were updated.

**PR:** "R6: parity benchmark and freeze review (G11)".

### W15 — Format freeze: R1, R2, R3, R4 (M)

**Goal.** Gate G12. One review, one PR, in the R5 §12 form, written into each artifact's
last section.

**Freeze checklist (each item recorded as checked, found, or fixed):**
1. Every *(checked)* table passes the drift test, and R3's CDDL check passes.
2. Every open item has a call, and the spec text says what the artifact says. R1 decision
   1: remove "Proposed" from §8.2 and §8.4.
3. **R4 `user_version` → 1** (R4 decision 3). Update the image checks and the golden
   `c3` vector deliberately.
4. **`DRAFT_ID` → 2** (K13).
   - Add `fixtures/golden/b2/reject-archive-draft-1.mochi` (exit 4, the message names
     draft 1).
   - Regenerate every other whole-archive fixture (`c5`, `c10`, `c11`, `c12` archives)
     **deliberately**. The `c12` damaged pair is regenerated from its recipe, and the
     byte-for-byte rebuild assertion must still hold.
   - The PR lists every changed file and why. Frame-level vectors change only where they embed
     a descriptor or its hash (for example `c5` commit records, through key 10); list each
     one, and check that no other vector changed.
5. **Cold read.** For each of R1–R4, a fresh subagent given *only* `docs/spec.md` and
   that artifact (no code) lists every place where it would have to guess to implement a
   reader. Fix each one in the text, or record it as an open item with a call. This is
   the cheapest way to cut W18's disagreements.
6. **Annex B bookkeeping.** Move to B.1 every B.2 decision whose implementation is done
   and whose gates pass. D13 stays in B.2 until G6. Update the B.2 status paragraph.
7. Each artifact gets a "Freeze review (date)" section and is marked **frozen
   [delegated 2026-10-12]; owner review pending at the desktop checkpoint** (K11).
   Update the ratification README, spec §28 (status sentence), B.2.6 G12 → met, and
   plan §6.

**Not in this PR:** any byte change other than items 3 and 4. If the review finds one,
stop; it needs its own Annex B entry first.

**Status (2026-10-12): done.** The review is written into R1 §7, R2 §6, R3 §11, and R4 §6. No byte
other than the two planned ones changed. Results:

- **Item 1.** The drift test and `r3_cddl.rs` pass.
- **Items 3 and 4.** `DRAFT_ID` is 2 and R4 `user_version` is 1. Fixtures: `b2` descriptor
  vectors regenerated (each file differs in exactly one byte, key 3; `reject-descriptor-draft-2`
  became `-draft-1` and `-draft-3`); `c3` catalog (one byte, offset 63); the `c5`, `c10`, `c11`,
  and `c12` whole archives regenerated (same sizes; first difference at offset 49, descriptor
  key 3; the rest follows from hashes, offsets, IDs and, for `c11`, fresh OS-random nonces and
  keys); `c12` damaged pair rebuilt from its recipe with the byte-for-byte assertion unchanged;
  `c5`/`c4`/`c2`/`c1` frame vectors **unchanged** (no descriptor hash inside); the frozen
  draft-1 `c5/reject-archive-bare-image.mochi` and `reject-archive-legacy-v0.mochi` kept, the
  first now refused as draft 1. The draft-1 reject fixture is `b2/reject-archive-draft-1.mochi`
  (the pre-freeze `c5/valid-archive-3-commits.mochi`, byte for byte).
- **Item 5.** Four cold reads. They found no byte to change. They found missing rules that the
  code already had (the path rules, extent and namespace rules, the fault codes of the binary
  envelope, the footer validation order, sort order, value-level codes), and the texts now state
  them; calls on the rest are in each review's table.
- **Items 2, 6, 7.** Spec "Proposed" removed; D17 to D23 moved to B.1; B.2 status paragraph,
  §28 status, G12 met, B.2.14 item 1 implemented; README and this plan updated.

**PR:** "Format freeze: R1–R4 frozen, draft 2 (G12)".

### W16 — R8 golden set (L)

**Goal.** Gate G13, per K21.

**Layout.**
- `fixtures/golden/r8/cases.json`: an array of objects with these keys:
  - `name`, `profile` (`core|tar|enc|red|tar+red|enc+red`),
    `class` (`valid|corrupt|interrupted|copy|salvage|legacy`);
  - `fault` (one sentence), `spec` (sections), `fault_matrix_row` (the §24.2 text or
    null);
  - `passphrase` (test passphrase, or null), `expected_head` (for freshness cases, or
    null), `copies` (file names);
  - `expect`: `{verify_exit, verify_level, repair_outcome, repair_exit}`.
- `fixtures/golden/r8/<name>.mochi`, optional `<name>.copyN.mochi`, and
  `<name>.summary.json` (the interop summary, W17 §"Summary", produced by Rust and
  reviewed).
- Builder: `crates/mochi-testkit/tests/r8_golden.rs`.
  - An `#[ignore]` writer, `write_r8_golden_files`, writes *missing* files and refuses
    to overwrite a different one.
  - A normal test rebuilds nothing, but for every case checks that this build's
    `verify` exit code, repair outcome, and summary equal `cases.json` and the stored
    summary.
  - Use the testkit's fixed ID source and the fixed random stream for nonces, and
    test-controls Argon2id cost (64 KiB, 1 pass, 1 lane) as `c11` does.

**Minimum cases** (about 70; extend as coverage requires).
- **valid**, per profile:
  - A ≥ 5-commit history with put, overwrite, delete, rename, mkdir, symlink, an empty
    file, and a multi-chunk file.
  - A forced checkpoint between deltas, a retention hold and an expiry.
  - **Hostile names**: `<img src=x onerror=alert(1)>`, a newline, U+202E, a non-UTF-8
    byte (POSIX), an unpaired surrogate in WTF-8, `CON`, a trailing dot, a trailing
    space, and the case pair `a`/`A`.
  - Also: compacted and GC outputs (provenance); a rekeyed and a re-encrypted archive
    (enc); 5 % and 100 % recovery records and **one multi-group archive** (about 3 MiB
    of incompressible stored data, the largest file in the set); a TAR archive whose
    stream R9 checks with `tarfile`; and a self-containing archive (a raw copy of its
    own earlier state as a file).
- **corrupt** (one defect each; Core always, other profiles where the fault differs):
  - a flipped chunk byte (head-only and older-only);
  - every catalog image destroyed (manifest recovery);
  - a delta manifest damaged;
  - the latest footer corrupted;
  - the descriptor damaged;
  - a middle commit frame damaged;
  - a false magic inside a payload;
  - an oversized `Frame_Size`;
  - non-canonical CBOR in a re-hashed commit;
  - a dictionary dependency (K17);
  - an older valid archive substituted (with `expected_head`);
  - enc: wrong passphrase (exit 3), an AEAD tag failure on a hash-verified object,
    keyless verification;
  - red: within capacity, beyond capacity, a damaged parity frame, a forged parity
    frame;
  - tar: an altered stream-only chunk, re-hashed (`PROFILE_VIOLATION`).
- **interrupted** (from the §12.2 step order; reuse the `c5_publication` crash models):
  - halted after data objects;
  - after the commit frame;
  - after the parity frames (red);
  - a torn footer;
  - a lost write that leaves zeros under a referenced object.
- **copy**: W11 tests 1, 2, and 3 as fixtures.
- **salvage**: W12 tests 1, 2, and 4 as fixtures.
- **legacy**: the draft-1 reject (W15); at W20, draft-2 migrate cases.

**Coverage test** (in `r8_golden.rs`). It fails if:
- a profile lacks any class among valid, corrupt, and interrupted;
- a §24.2 row listed as "1.0, archive bytes" lacks a case. The list of rows is in the
  test, with the non-byte rows (concurrency, GC overlap, inventory, and so on) named as
  exempt and why;
- an R7 violation-class code reachable from archive bytes appears in no case's summary.
  The list is derived from `ErrorCode`, with exemptions named.

**G1 audit (R2 decision 4).** Using R3 §7's vector index, add any missing valid or reject
vector for a CDDL rule or D11 obligation, in both encodings. Then remove §8.3's
"evidence pending" marker.

**Size.** Assert in the test that the total is ≤ 12 MiB.

**Docs.** `fixtures/golden/README.md` (an R8 section), the ratification README R8 row,
spec B.2.6 G13 → met, and plan §6.

**PR:** "R8: golden valid, corrupt, interrupted archives (G13)".

### W17 — R9 independent verifier (XL; cold session)

**Who.** Not the session that wrote W10–W16. Create a **new session** with
`create_session`:
- `source_url`: this repository;
- `sparse_checkout_paths`: `["docs", "fixtures/golden", "interop"]`;
- `prompt`: the W17 kickoff prompt in §4.

If `create_session` is unavailable, the owner starts the session by hand with the same
prompt. The workhorse session must not edit `interop/` itself.

**Summary format** `mochi-interop-summary-v1` (normative for R9; the Rust side produces
the same JSON in W16). Keys sorted; all bytes as lowercase hex; arrays sorted as stated:

```json
{
  "format": "mochi-interop-summary-v1",
  "case": "<name>",
  "head": {"status": "opened", "code": null},
  "archive_id": "<hex>|null",
  "profile": {"encrypted": false, "tar_compatible": false, "recovery_percent": null},
  "commits": [{"seq": 0, "commit_id": "<hex>", "footer_offset": 123, "checkpoint": true}],
  "snapshots": [{"seq": 0, "entries": [
      {"path": "<hex of path bytes>", "kind": "file|dir|symlink", "size": 0,
       "content_hash": "<hex>|null", "target": "<hex>|null",
       "attributes": {"posix_mode": 420, "uid": 0, "gid": 0, "mtime_ns": 0, "windows": null}}]}],
  "findings": [{"code": "STORED_INTEGRITY_FAILED", "object": "<stored hash hex>|null"}],
  "parity": {"commits": 3, "damaged_shards": 0, "rebuilt": 0, "beyond_capacity": 0}
}
```

The fields mean:
- `head.status`: `opened`, or `refused` with the one R7 code.
- `commits`: the verified chain, ascending.
- `snapshots`: every snapshot the verified chain retains, ascending. Entries are sorted
  by path bytes, and attributes are the promised ones as recorded.
- `findings`: the sorted, unique set of **violation-class** findings: code plus the
  stored-object hash it concerns, or null. Information and operational findings are
  excluded.
- `parity`: null without a recovery record.
- Encrypted cases are summarized **with** the passphrase. Keyless cases have their own
  case names, in which content-level fields are null.

**Work.**
1. Read the spec and R1–R7, and write `interop/pyverify/READING-LOG.md`: every ambiguity
   met, with the reading taken. This is evidence for W18.
2. Implement `interop/pyverify/` (package `mochi_verify`):
   - CLI: `python3 -I -m mochi_verify ARCHIVE [--passphrase-file F] [--expected-head HEX]
     --summary`.
   - Modules: `cbor` (strict D2 decoder with the re-encode check), `frames`, `footer`,
     `descriptor`, `envelope`, `commit`, `manifest` (replay), `catalog` (R4 check via
     `sqlite3`), `objects`, `crypto` (R5), `parity` (R6, written from R6's text, **not**
     from `gen_vectors.py`), `tar`, `summary`.
3. Tests (`pytest`, pinned in `requirements.txt` with hashes):
   - R5 and R6 `vectors.json` reproduce.
   - The per-phase golden vectors (`c1`, `c2`, `c4`, `c5`, `b2`, `c11`, `c12`) give
     their listed verdicts.
   - Truncation at every byte of the small valid R8 cases never yields a commit outside
     the original prefix.
4. CI job `r9-interop` on ubuntu-22.04 (Python 3.10) and ubuntu-24.04 (Python 3.12):
   install the pins, run pytest, and run the summary over every R8 case and diff against
   `<case>.summary.json`. Mismatches fail the job, and the list is printed.
5. `interop/pyverify/README.md`: the provenance statement (what was read, what was not;
   the session ID), how to run, and the dependencies with licences.

**Rules for this session.**
- Never read `crates/`, `apps/`, `docs/ratification/*/gen_vectors.py`, or any `docs/*.md`
  other than `docs/spec.md`.
- When the text is ambiguous, **do not look for the answer in the expected summaries**:
  record it in the reading log, pick the reading the text best supports, and let W18
  surface the mismatch.

**PR:** "R9: independent read-only verifier (Python)".

### W18 — R9 interop run and resolution (M)

**Goal.** Gate G14. Make `r9-interop` green honestly.

For every mismatch, classify it and fix it at the source:
- **(a) Ratification ambiguity**: fix the artifact text. A clarification with no byte
  change is allowed after the freeze. A byte change means a draft bump and an Annex B
  entry (K11).
- **(b) Rust bug**: fix the Rust code. Regenerate only the affected summary, with an
  explained diff.
- **(c) Python bug**: fix it in `interop/` (a later cold session may do it; a warm
  session may only fix it if the reading log shows the text was clear).

Never loosen the comparator, and never add a tolerance list. Record every mismatch in
`docs/ratification/R9-interop-results.md`: case, field, class, resolution, and commit.
The file ends with the final run ID, the versions, and the statement "R9 verifies every
R8 case" (release gate 3) once true. Update the README R9 row, spec B.2.6 G14 → met, and
plan §6 and §8.2 item 3.

**PR:** "R9: interoperability results (G14)".

### W19 — R7 freeze (S; at Beta)

**Trigger:** desktop D4 merged and W12 merged.

**Work.**
- Write JSON Schema (2020-12) documents in `docs/schemas/json/` for:
  - report v1;
  - `mochi-repair-plan-v2`;
  - the GC plan;
  - health evidence and health policy.
- Add `crates/mochi-cli/tests/r7_json_schemas.rs`, validating real outputs (from R8
  cases) against them with the `jsonschema` crate (MIT, dev-dependency).
- Replace §20.6's example with an abridged real report generated from an R8 case, and
  add a test that regenerates and compares it.
- Write the freeze review section in R7 (R5 §12 form). Update B.2.6 G15 → met and the
  README.

**PR:** "R7 freeze: report schema, error codes, JSON Schemas (G15)".

### W20 — 1.0 flip and `migrate` (M; at 1.0)

**Trigger:** every §8.2 gate met except item 4, including G6 and the desktop phases.

**Work.**
- Write `null` in descriptor key 3. A reader accepts `null`, and refuses drafts with
  exit 4, naming the draft and (for the last draft only) suggesting `mochi migrate`.
- `mochi migrate SRC --output DST [--passphrase-file F]`:
  - reads only the last draft;
  - writes the new archive with `compact::Copier`;
  - verifies it at restoration level;
  - compares file hashes and retained namespaces with the source (§26 steps 1–6, 8);
  - never touches the source;
  - produces a JSON report.
- Add the command to the spec §23 table.
- Status strings: `FORMAT_STATUS`, the CLI `about`, the spec header and §28 status, and
  the "Proposed" markers left anywhere.
- Regenerate R8 in the 1.0 format from its recipes. Move three draft-2 archives (one per
  encryption state, one with a recovery record) to `r8/legacy/` as migrate cases. Rerun
  R9.
- Update the plan §8.2 gate 4 evidence.

**PR:** "1.0: ratified descriptor, migrate".

---

## 4. Kickoff prompts

Paste one into a new session on this repository. Each assumes the workstreams in its
"Depends on" column are merged.

**W10**
> Read AGENTS.md and docs/ratification-core-plan.md. Do workstream W10 (calls K16, K17,
> stale status text), following docs/next-work-plan.md §2. One PR: "W10: footer-history
> frames skipped, dictionary dependencies reported (K16, K17)".

**W11**
> Read AGENTS.md, docs/spec.md §22 and Annex B.2.12 (D22), and docs/ratification-core-plan.md
> W11. Implement C8 ladder step 5 (independent copies) to D22, following
> docs/next-work-plan.md §2 (independent oracle, mutation check, fuzz, docs). If D22 and
> the code disagree, stop and describe the conflict in the PR instead of changing the
> design. One PR: "C8: ladder step 5, independent copies (D22)".

**W12**
> Read AGENTS.md, docs/spec.md §5.1, §22, Annex B D12 and B.2.13 (D23), and
> docs/ratification-core-plan.md W12. Implement C8 ladder step 7 (bounded salvage scan)
> to D23 and the D12 amendment, following docs/next-work-plan.md §2. Add the new error
> code in every exhaustive place. One PR: "C8: ladder step 7, bounded salvage scan (D23)".

**W13**
> Read AGENTS.md, docs/ratification/README.md, R1/R2/R4 drafts (as models), and
> docs/ratification-core-plan.md W13. Write docs/ratification/R3-canonical-serialization-draft.md
> from the code with checked tables, make every CDDL file complete, and add the mechanical
> CDDL check. Do not change any byte the code writes. One PR: "R3: canonical
> serialization draft, complete CDDL, mechanical CDDL check".

**W14**
> Read AGENTS.md, docs/ratification/R6-erasure-coding-draft.md, R5 §12 (the review form),
> and docs/ratification-core-plan.md W14 and K15. Write the parity benchmark and the
> freeze review. If the review finds a byte to change, stop and report instead of
> freezing. One PR: "R6: parity benchmark and freeze review (G11)".

**W15**
> Read AGENTS.md, docs/ratification/ (all), and docs/ratification-core-plan.md W15, K11–K13.
> Run the format-freeze review for R1–R4 with the checklist there, including the
> cold-read subagent per artifact, R4 user_version 1, and DRAFT_ID 2 with deliberate
> fixture regeneration. One PR: "Format freeze: R1–R4 frozen, draft 2 (G12)".

**W16**
> Read AGENTS.md, fixtures/golden/README.md, docs/ratification-core-plan.md W16 and K21,
> and the W17 summary format. Build the R8 golden set with its coverage test and the G1
> audit. One PR: "R8: golden valid, corrupt, interrupted archives (G13)".

**W17** (for a **new** session with a sparse checkout of `docs`, `fixtures/golden`, and
`interop` only)
> You are writing an independent, read-only MOCHI verifier in Python (spec Annex B.1 D7),
> from the specification alone. You may read only: docs/spec.md, docs/ratification/*.md,
> docs/schemas/, docs/ratification/R5-vectors/vectors.json and R6-vectors/vectors.json (as
> data), and fixtures/golden/. Do not read any Rust source, any gen_vectors.py, or any
> other docs/*.md, even if you can reach them. Then follow docs/ratification-core-plan.md
> W17 (you may read that section): reading log first, then interop/pyverify/, its tests,
> and the r9-interop CI job. When the text is ambiguous, record it and choose; do not
> consult expected outputs to decide. One PR: "R9: independent read-only verifier
> (Python)".

**W18**
> Read AGENTS.md, interop/pyverify/READING-LOG.md, and docs/ratification-core-plan.md W18.
> Make r9-interop green by classifying and fixing every mismatch at its source, recording
> each in docs/ratification/R9-interop-results.md. Never loosen the comparison. One PR:
> "R9: interoperability results (G14)".

**W19**
> Read AGENTS.md, docs/ratification/R7-reports-and-error-codes-draft.md, and
> docs/ratification-core-plan.md W19 and K24. Freeze R7 with JSON Schemas for every
> machine-readable output. One PR: "R7 freeze: report schema, error codes, JSON Schemas
> (G15)".

**W20**
> Read AGENTS.md, docs/spec.md §26 and Annex B D24, and docs/ratification-core-plan.md
> W20 and K25. Make the 1.0 flip and add `mochi migrate`. One PR: "1.0: ratified
> descriptor, migrate".

---

## 5. Self-review of these calls (2026-10-12)

The owner asked for the calls to be reviewed by their author. They are checked here
against AGENTS.md's invariants and against each other.

- **No call changes a stored byte before the freeze.** K13 (draft 2) and R4's
  `user_version` are the only byte changes, and they happen inside the freeze PR with
  deliberate fixture regeneration. D22 and D23 change only tool behaviour and the plan
  JSON. K20 avoids a manifest-schema change that R5's freeze would forbid.
- **§5.1, a partial commit never becomes the head**, holds under the new steps:
  - Copies: a donated commit must chain to a source-verified commit and be verified
    again by the survey. A `copy_confirmed` commit was *published in the copy*, which is
    the same archive.
  - Salvage: unconfirmed commits are never recovered; the truncation-at-every-byte
    property test is required.
- **"Trust from the source"** (K18) and **"confirmation"** (K19) are the two places where
  history could be invented. Both have mandatory mutations and adversarial tests
  (diverged copy, forged copy, self-containing archive, concatenated archives,
  contradictory commits).
- **Honest outcomes.** Salvage is always `partial`. A copy-completed repair is `complete`
  only because the result is fully verified. Step statuses never read as passes when
  skipped or limited (`not_attempted`, `incomplete`).
- **Scope.** Nothing here adds a post-1.0 feature:
  - by-hash donors, a raw orphan export, a footer-history writer, and a trailer sidecar
    are all deferred to 1.x;
  - `migrate` reads one draft layout only, and §26 requires migration or rejection
    anyway.
- **Risks accepted.**
  - (1) R8 is regenerated twice (at the W15 freeze and at W20). Both regenerations come
    from recipes in code and are explained.
  - (2) An R9 mismatch after the freeze that needs a byte change means draft 3 and a
    third regeneration. The cold-read step in W15 exists to make that unlikely.
  - (3) TAR compatibility is lost under salvage without a descriptor. It is a reported
    loss, and the content is intact.
  - (4) Copies are read without their own parity in 1.0. It is a documented limit:
    repair the copy first.
- **Open for the owner's checkpoint review:** K12 (freeze before Beta), K13 (draft bump
  and fixture churn), K22 (the sparse-checkout cold session as the R9 author), and K25
  (`migrate` as a new 1.0 command).
