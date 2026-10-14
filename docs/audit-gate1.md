# Gate-1 audit of MOCHI 1.0 (T14, 2026-10-14)

This audit checks the state of `main` before the owner's 1.0 decision. It covers every
Definition-of-Done row (plan §8.1), every 1.0 release gate (plan §8.2), every Annex B.2.6
evidence gate (spec G1–G15), the phase exits that the plan treats as gates (D0–D8), and
the release-blocking fault matrix (spec §24.2).

* **Audited commit:** `main` at `8cac973` (merge of #55). It includes every PR from
  #39 to #55.
* **Method:** I read the documents the task lists and checked each claim against the
  code and tests at that commit. I ran the AGENTS.md "Commands" locally (§1) and read
  CI history through the GitHub API (§2). Nothing was graded on prose alone. A row is
  **met** only when an automated test in CI proves it on the platforms it names.
* **Grades** (in the spirit of spec §20.4: a check that was skipped, unsupported,
  incomplete, or unverified is never met):
  * **met**: with evidence (files, tests, CI runs, PRs).
  * **met, evidence pending**: the work exists, and the named piece of evidence is
    missing.
  * **not met**: what is missing is named.
  * **owner-held**: only the owner can close it.
* **Scope of this PR:** this file, plus the doc-drift fixes listed in §8.1. No
  production code, wire-format, ratification-artifact, or fixture change.

## Summary

* **Not yet 1.0-ready.** The 1.0 flip (W20) is owner-held by design, and its trigger
  ("every §8.2 gate met except item 4, including G6", ratification-core-plan W20) does
  not hold. Gates 1, 5, and 6 are not met, G6 is not started, and gate 6's text
  contradicts an owner decision.
* **Blockers for 1.0** (§9):
  * **F16:** a real bug that makes `main` CI red. A 358-byte 7z hangs the 7z
    listing (found by the `foreign_sevenz` fuzz smoke on `main`; reproduced here).
  * **F1:** a real bug. A ZIP/7z/RAR/tar opened from the shell gets "cannot be opened
    yet", although D8 shipped and the installer offers that association.
  * **F2:** spec D6 makes symbolic links an entry type, but the frozen draft-2 format
    refuses kind 2 and the writer skips links. No decision defers this.
  * **F3:** release gate 6 ("signed installers") contradicts the owner's no-Authenticode
    decision. The gate text was never amended.
  * **F4:** the §8.1 Search row's "interrupted indexing visible" has nothing to test.
    1.0 builds no index, and no amendment says how the row is met.
  * **F5:** the desktop app keeps no freshness anchor and no evidence log (spec D8). The
    owner's options were written up in D4 and never decided.
* **What is solid:**
  * Every check the task asked for passes locally (§1).
  * The last completed `main` CI run (38551536791, head `db611b3`, after #52) has all
    40 jobs green on `ubuntu-22.04`, `ubuntu-24.04`, and `windows-latest`. That covers
    the E2E suite on Windows and Ubuntu, both power-loss jobs, both casefold jobs,
    tar interop on three OSes, r9 interop, 21 fuzz smoke targets, and packaging on both
    OSes.
  * Gates G1–G5 and G7–G15 are met. G12–G15 still await the owner's review.

## 1. Commands run in this audit (local, Linux x86-64, rustc 1.91.1, Node 22.22, pnpm 10.28, Python 3.13)

The container had no webkit2gtk at first. It was installed with apt
(`libwebkit2gtk-4.1-dev` and companions, as in `apps/mochi-desktop/README.md`), so the
whole workspace, the desktop crate included, built and was tested here.

| Command (AGENTS.md "Commands") | Result |
|---|---|
| `cargo fmt --all --check` | pass |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | pass (no warning) |
| `cargo test --workspace --locked` | pass: 99 test binaries and doctests, 1,368 passed, 0 failed, 13 ignored. The ignored ones are the 12 fixture writers ("run by hand") and `c6_casefold_destination`, which needs an ext4 casefold mount (CI job `casefold`) |
| `cargo test -p mochi-testkit --test r3_cddl` | pass: 7 passed, 1 ignored (`print_vector_index`, prints R3 §7 data) |
| `cargo test -p mochi-testkit --test r8_golden` | pass: 10 passed, 1 ignored (`write_r8_golden_files`) |
| `bash ci/check-invariants.sh` | `invariants: ok` |
| `python3 docs/ratification/R6-vectors/gen_vectors.py \| diff - docs/ratification/R6-vectors/vectors.json` (venv, `blake3==1.0.8`) | identical |
| `interop/pyverify`: `pytest`, then `tools/compare_r8.py fixtures/golden/r8` (hash-pinned requirements) | 315 passed; "76 cases compared, 0 differ" |
| `apps/mochi-desktop/ui`: `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build` | all pass; vitest 18 files, 159 tests |

Not run here, with where CI proves each instead:

| Not run | Why | Proven by |
|---|---|---|
| Desktop E2E (`tauri-driver`, WebdriverIO) | no `webkit2gtk-driver`, Xvfb, or session bus set up here | CI `desktop e2e (ubuntu-22.04)` and `desktop e2e (windows-latest)`, green in run 38551536791 |
| Anything on Windows | Linux container | CI `windows-latest` (fmt, clippy, all tests, invariants), `tar interop (windows-latest)`, `package (windows-latest)`, `desktop e2e (windows-latest)` |
| `cargo +nightly test --doc -p mochi-format` (pinned `compile_fail` codes) | no nightly toolchain | CI `compile_fail doctests (codes enforced)` |
| Fuzz targets (`cargo +nightly fuzz`) | no nightly toolchain or cargo-fuzz | CI `fuzz smoke (*)`, 21 targets: every seed once, then 60 s each |
| `ci/tar-interop.sh` with real zstd/GNU tar/bsdtar | not run, to keep the run short | CI `tar interop` × 3. The 22.04 log of run 38551536791 prints zstd 1.5.7, GNU tar 1.34, bsdtar 3.6.0, which match `docs/c10-tar-compat.md` |
| Power loss (`ci/g7-powercut.sh`, dm-flakey) and ext4 casefold | need root and kernel modules | CI `power loss (*)`, `restore to ext4 casefold (*)` |
| Installers (`packaging/build-installer.sh`) | not run here | CI `package (ubuntu-22.04)`, `package (windows-latest)`, `package smoke (ubuntu-24.04)` |
| §27 benchmarks (`c5_append_bench`, `c12_parity_bench`, `t32_*`) | long; not part of a gate re-check | results recorded in `docs/benchmarks/` (dates and hardware there) |

## 2. CI evidence used

* **Run 38551536791** (push to `main`, head `db611b3`, merge of #52, 2026-10-14): 40 of
  40 jobs `success`. Jobs:
  * `ubuntu-22.04`, `ubuntu-24.04`, `windows-latest`;
  * `desktop ui`, `desktop e2e (ubuntu-22.04)`, `desktop e2e (windows-latest)`;
  * `power loss (ubuntu-22.04|24.04, dm-flakey)`;
  * `restore to ext4 casefold (ubuntu-22.04|24.04)`;
  * `tar interop (ubuntu-22.04|24.04|windows-latest)`;
  * `r9 interop (ubuntu-22.04, Python 3.10)` and `(ubuntu-24.04, Python 3.12)`;
  * `compile_fail doctests (codes enforced)`;
  * `package (ubuntu-22.04|windows-latest)`, `package smoke (ubuntu-24.04)`;
  * 21 `fuzz smoke (*)` jobs.

  This run includes #39–#53.
* **Run 38558591812** (`eae258b`, #54) **failed**. 29 of 30 jobs passed; `fuzz smoke
  (foreign_sevenz)` hit a libFuzzer timeout in its 60-second fuzzing phase. #54 does not
  touch `mochi-foreign`: this is a latent hang in the 7z listing path that the fuzzer
  happened to find, and it is reproduced below (F16).
* **Run 38561036215** (`8cac973`, #55) was still running when this was written. The CI
  run on this PR's head is the evidence for `main` at the audited commit (F6).
* Older evidence the gates cite (runs 37260826727 … 37735586637) ran on
  `Sepiolina/MOCHI` and early `immerh8/MOCHI` PRs, before the format freeze. Every test
  those gates name still exists and still passes in the run above. That run is the
  current evidence. The older runs are the history.

## 3. Plan §8.1 Definition of Done, per area

The plan says an area is done when every criterion is met by an automated, repeatable
test in CI, on Windows and Ubuntu (release gate 1). Unless a row says otherwise:
* tests under `crates/` run in the `ubuntu-22.04`, `ubuntu-24.04`, and `windows-latest`
  jobs;
* desktop E2E runs in both `desktop e2e` jobs;
* vitest runs only in `desktop ui` (Ubuntu 22.04).

| Area | Verdict | Evidence | Gap |
|---|---|---|---|
| Framing | **met** | `mochi-format/tests/framing.rs`: `standard_zstd_skips_every_mochi_skippable_frame`, `reserved_block_type_is_rejected`, `reserved_header_bit_is_rejected`, `oversized_skippable_size_is_rejected_before_any_allocation`, `false_magic_inside_a_data_payload_is_never_a_frame_or_footer`, `walker_matches_libzstd_on_real_frames`, `footer_fields_round_trip`; `c1_golden.rs` (every registry frame type); fuzz `frame_walker`, `footer` | — |
| Digests | **met** | `mochi-format/src/digest.rs` tests: `chunk_content_hash_is_exact_decoded_bytes`, `stored_object_hash_is_exact_stored_bytes_and_streams`, `dictionary_hash_is_exact_dictionary_bytes`, `file_content_hash_is_b3sum_compatible`, `same_bytes_differ_across_every_scope`, `separators_are_prefix_free_nul_terminated_and_distinct`, `commit_id_is_the_separated_canonical_body`, `footer_digest_is_blake3_of_the_spec_concatenation`; `c2_objects.rs` property `encode_store_load_decode_round_trips_and_every_digest_matches`; 5 `compile_fail` doctests in `repr.rs`, codes checked by the nightly job | — |
| Catalog & namespace | **met** | `c3_catalog.rs`: property `replay_matches_the_reference_model_everywhere`, `valid_extent_lists_are_accepted_and_each_defect_class_is_rejected`, `published_image_needs_no_wal_or_journal_file`; `t11_t12_replay.rs` `every_commit_opens_to_its_model_state_under_every_policy` | — |
| Recovery manifests | **met** | `c4_recovery.rs` `destroyed_catalog_is_rebuilt_from_manifests_at_every_commit`; `c5_publication.rs` `a_destroyed_catalog_is_recovered_through_the_footer_verified_head`; `t16_baseline_recovery.rs` `t16_recovers_with_everything_before_b_destroyed`; R8 cases | — |
| Publication | **met** | `c5_publication.rs`: `termination_at_each_publication_stage_never_mixes_commits`, `torn_writes_at_every_append_never_mix_commits`, `truncation_at_every_byte_accepts_no_invalid_commit`, `a_failed_sync_is_never_acknowledged`, `a_lying_sync_degrades_only_to_never_mixed`, `directory_durability_is_reported_never_assumed`, `sync_order_follows_spec_12_2`; `t22_creation.rs`; CI `power loss` × 2 | Windows directory durability stays `Unconfirmed` until G6 (owner-held, §6) |
| Read & extract | **met** | traversal: `catalog/mod.rs` `relationship_and_mochi_rule_violations_are_refused` (cannot be encoded); collisions: `c6_restore.rs` `c6_case_insensitive_collisions_never_overwrite_or_merge`, `c6_preflight_*`, `c6_unsupported_names_are_reported_not_renamed`; `c6_restore_races.rs`; `c6_restore_windows.rs`; CI `casefold` × 2; benchmarks `docs/benchmarks/c6-read.md` | Benchmarks are published but run by hand on one VM (host cache not controlled); CI does not re-run them. The row asks only that they be published |
| Verification | **met** | `c7_verify.rs`: `c7_verification_is_read_only` (storage trace and file hash), `c7_healthy_archive_at_every_level`, `c7_a_damaged_data_object_fails`; exit codes and precedence: R7 §5, `docs/c14-cli.md`, `t26_t27_reports.rs` `g9_mixed_outcome_matrix`, `exit_codes.rs`; desktop `check.e2e.js` hashes the archive before and after | — |
| Freshness | **met** | `c7_verify.rs` `c7_an_older_archive_is_never_fresh`, `c7_freshness_against_a_user_supplied_head`; `r7_json_schemas.rs` targeted mutation "freshness `PASS` without an anchor" rejected | Desktop has no anchor (F5); it shows `UNKNOWN`, never `PASS`, so the row still holds |
| Recovery & repair | **met** | ladder: `c8_repair.rs` (corrupted latest footer, partial labelled), `c8_copies.rs` (D22), `c8_salvage.rs` (D23, truncation at every byte), `c12_redundancy.rs` (step 6); re-verification before publication: `c8_repair.rs`; missing dictionary (K17): `c7_a_dictionary_dependency_is_unsupported_with_the_affected_versions`, `c8_undecodable_content_refuses_the_plan`; CLI `c8_repair_command.rs` | — |
| Compaction & GC | **met** | `c9_compact.rs` `c9_interrupted_compaction_leaves_the_source_and_no_archive`, `c9_gc_never_overlaps_publication`, `c9_compact_reproduces_every_snapshot_in_a_new_archive`; `c9_gc_plan.rs` `c9_a_legal_hold_protects_an_expired_snapshot`, `c9_gc_refuses_when_retention_is_unresolved`; auditable: provenance asserted in `c9_compact.rs`, plan equality in `gc apply` (`docs/c14-cli.md` rule 7) | In 1.0 GC deletes nothing in place (D18 writes a new archive). "Deletion batches auditable" is met as provenance, not as a deletion log |
| TAR profile | **met** | CI `tar interop` on `ubuntu-22.04`, `ubuntu-24.04`, `windows-latest`; `c10_*` tests; fuzz `tar_stream` | The "pinned" matrix is not pinned. CI installs what the runner image has and prints versions, and nothing fails if they drift from `docs/c10-tar-compat.md` (F12) |
| Encryption | **met** | `c11_encrypted.rs` `a_wrong_or_missing_passphrase_is_key_unavailable_and_returns_nothing`, `verify_without_a_passphrase_checks_stored_integrity_and_says_what_it_did_not_check`, `deduplication_leaks_that_two_files_are_equal_to_someone_without_the_key`; `c11_rekey.rs` property `nonces_are_never_reused` (writes, retries, crash and reopen, rewraps, re-encryption); `seal.rs` unit; G10 | — |
| Redundancy | **met** | `c12_redundancy.rs` `c12_up_to_m_damaged_shards_per_group_rebuild_bit_identically`, `c12_damage_beyond_parity_capacity_is_an_explicit_unrecoverable_result`; `c12_golden.rs`; `r6_vectors.rs`; CI R6 regeneration; G11 | — |
| Search | **not met** | "rebuild matches expected coverage": `c13_search.rs` `c13_discovery_rebuilds_from_manifests_when_an_image_is_damaged`, `c13_zero_hits_under_partial_coverage_are_reported_partial` | **"Interrupted indexing visible" has no test and cannot have one.** 1.0 builds no index (plan C13 "Open": waits for an index). No amendment states how the row is met in 1.0 (compare K17 for dictionaries) (F4) |
| Concurrency (Core) | **met** | `c5_publication.rs` `a_second_writer_is_refused_and_an_unlocked_write_is_detected`; `q54_writer_lock.rs` (4, Windows included); `t22_creation.rs` two concurrent creators | — |
| Desktop app | **met, evidence pending** | §3.1 below maps every §23.3 requirement to its tests. `check.e2e.js` compares the report shown, and the exported JSON, with `mochi verify --json` over the same file, on both OSes | #8 (zero results under partial coverage shown as incomplete) is tested in vitest and Rust (`d5_tests.rs`), not in E2E. The vitest job runs only on Ubuntu, so the UI half has no Windows run. E2E covers only complete coverage |
| Foreign archives (D8) | **met, evidence pending** | `d8_foreign_restore.rs` (traversal, absolute, links, reserved names, ADS, case and duplicate names, nothing overwritten, planted symlink on a real directory); `mochi-foreign/tests` `limits.rs`, `supervision.rs` (crash, panic, memory, hang, flood; parent unaffected), `zip_fixtures.rs`, `sevenz_fixtures.rs`, `rar_fixtures.rs` (`rar4_data_encryption_fails_closed`), `corpus_interop.rs`; E2E `foreign.e2e.js` (hostile 7z writes nothing outside; no MOCHI vocabulary) on both OSes; fuzz `foreign_*` | The hostile corpus has **no RAR case**: no traversal, bomb, ratio, or BLAKE2sp RAR fixture, because nothing here can write RAR (plan D8 slice 2 "Not done"; 8 mutation survivors). **Multi-volume RAR** is promised by D8 rule 8 but tested only with a missing volume, never with a complete set. The "WinRAR" part of the D8 exit corpus is RARLAB `rar` archives of unknown version from 2015–2019 (F7). A 358-byte 7z hangs the listing until the helper's wall-time kill (F16); the app is unaffected, as the row requires, but the fuzz job is red |

**Rows outside 1.0** (deleted primary archive, original machine unavailable, key service
unavailable, corrupted inventory, stale writer resumes): **met where a 1.0 entry point
exists.**
* `c7_verify.rs` `c7_unsupported_levels_exit_4` covers the inventory, search, and
  disaster-recovery levels: each returns `UNSUPPORTED`, exit 4.
* `exit_codes.rs` `post_1_0_commands_exit_4_not_3` covers `inventory`, `split`, `join`,
  and `mount`.
* "Stale writer resumes" and "key service unavailable" have no 1.0 command or level that
  could return anything, so there is nothing to test (F14, nit).

### 3.1 Spec §23.3 requirements, mapped to tests (desktop row)

| # | Requirement | Tests | Windows + Ubuntu |
|---|---|---|---|
| 1 | One implementation | By construction: `ci/check-invariants.sh` rule 4 (dependency direction) and rule 10 (no fs/shell/http/dialog permission). The webview cannot reach bytes. The app's report equals core's: `check.rs` tests and `check.e2e.js` | yes (invariants run on both) |
| 2 | Honest status | `check.e2e.js` "shows FAIL for a corrupted archive without hiding it in the overall status"; vitest `check/messages.test.ts` (only `PASS` styled as success); `a11y` audit | yes (E2E) |
| 3 | Test is read-only | `check.e2e.js` "tests a good archive read-only…" (sha256 before and after); `check.rs` | yes |
| 4 | Repair is a reviewed plan | `check.e2e.js` "repairs the damaged archive into a new file through a reviewed plan, and re-verifies"; vitest `Checker.test.tsx` (partial labelled) | yes (E2E); "partial labelled" in vitest only |
| 5 | Deletion is namespace deletion | `create-add.e2e.js` "removes an entry from the current snapshot, which history keeps" | yes |
| 6 | Local commit is not preservation | `create-add.e2e.js` "creates an archive … says it committed, nothing more"; `i18n.test.ts` banned words over the whole catalogue | yes |
| 7 | Safe extraction | `extract.e2e.js` "lists collisions before writing, skips them on request, and overwrites nothing" (hostile name `NAME_UNSUPPORTED` on Windows); `foreign.e2e.js` hostile 7z | yes |
| 8 | Search coverage visible | `d5.e2e.js` (complete coverage only); vitest `Crypt.test.tsx` and Rust `d5_tests.rs` (partial) | **partial**: see the Desktop row |
| 9 | Archive strings untrusted | `browse.e2e.js` hostile names; invariants rule 7; lint | yes |
| 10 | Secrets | `d5_tests.rs` (redaction, events carry no passphrase); vitest `Crypt.test.tsx` (not in DOM or state); `launch.e2e.js` refuses a passphrase option without echoing it | yes (Rust and E2E) |
| 11 | Cancellation | `self-test.e2e.js`, `create-add.e2e.js` (cancel create), `extract.e2e.js` (cancel), `check.e2e.js` (cancel plan and test) | yes |
| 12 | Evidence export | `check.e2e.js` "exports the exact report JSON core produced" | yes |

## 4. Plan §8.2 release gates

| # | Gate | Verdict | Evidence / gap |
|---|---|---|---|
| 1 | Every §8.1 row passes in CI on Windows and Ubuntu | **not met** | The Search row is not met (F4). The Desktop and Foreign rows have evidence pending (F7, F13). `main` CI is red on the `foreign_sevenz` fuzz smoke (F16). Every other row is met (§3) |
| 2 | R1–R9 published; format frozen for Core, TAR, Encrypted, Redundancy | **met** (owner review pending) | `docs/ratification/README.md`: R1–R4 frozen as draft 2 (#34, G12); R5 (G10); R6 (G11); R7 (#49, G15); R8 (#36, G13); R9 (#35, #37, G14). R10 is post-1.0 (O5). The owner's review of the delegated freezes (K11) is still pending (§6) |
| 3 | R9 interop over R8 | **met** | CI `r9 interop` × 2 in run 38551536791; locally 76/76 equal (§1); `docs/ratification/R9-interop-results.md` |
| 4 | Draft-to-1.0 boundary enforced | **owner-held** (W20) | Draft 1 is already refused: `exit_codes.rs` `a_draft_1_archive_is_refused_exit_4_naming_the_draft` (fixture `b2/reject-archive-draft-1.mochi`). Writing `null`, `mochi migrate`, and R8's regeneration are W20, the owner's flip |
| 5 | User documentation (not a backup; Encrypted limits; dedup leak; what Test proves) | **not met** | `docs/user/` (#39) covers all four topics for the CLI. The gate's own status (2026-10-13) says the desktop "Test archive" text and installer-bundled help are not covered. The in-app text covers much of it: after a commit, "a local commit in one file. Keep an independent copy…" (`ui/src/i18n/en/write.ts`); the dedup leak and lost-passphrase warnings (`crypt.ts`); and on the Test screen, what each level checks, what a keyless test does not check, and that freshness is unknown (`check.ts`). Still missing: the installers ship no user documentation (`packaging/` copies nothing from `docs/user/`), and the app links to none. The gate's own status line names that gap. Nothing records a decision that in-app text replaces the guide (F8) |
| 6 | Signed installers and signed updates for Windows and Ubuntu | **owner-held; not met as written** | Updates: signed (minisign, `requireSignedVersion`), rehearsed in CI with a throwaway key (`package` "Rehearse the release path"). `release.yml` has never run (the Actions API lists no run of it), so no draft release with the owner's key exists yet. Installers: **unsigned by owner decision** (no Authenticode, no `.deb`/APT signing, `docs/packaging.md`). The gate text was not amended to match (F3) |
| 7 | Annex B decisions that block 1.0 are recorded | **met** (owner review pending) | D1–D24 all have recorded text. D10–D12, D14, D15, and D24 stay in B.2 until the owner reviews them; D13 waits for G6; D16 is 1.x. Exception: D6's symbolic links are decided but contradicted by the frozen format (F2) |
| 8 | License permits distributing UnRAR | **met** | MIT OR Apache-2.0 (O23); UnRAR notice in `THIRD-PARTY-NOTICES.md`; `packaging/licenses.py` fails without the RARLAB paragraph (#51); MPL-2.0 `dtoa-short` accepted by the owner (2026-10-14) |

## 5. Spec Annex B.2.6 evidence gates G1–G15

| Gate | Verdict | Evidence (current tests run in 38551536791; original gate runs in `docs/b2-implementation-checklist.md`) |
|---|---|---|
| G1 Conformance | **met** | Passed 2026-10-05 (run 37287483468). Re-audited at the freeze: R8 `r8/g1/` (48 vectors in both encodings), `r8_golden.rs` `the_g1_audit_vectors_match_their_files_and_verdicts`; `b2_golden.rs`; fuzz `commit_decode`, `manifest_decode`, `descriptor_decode`, `envelope` |
| G2 Replay and recovery | **met** | `t11_t12_replay.rs`, `t12_oracle.rs`, `t15_adoption.rs`, `t16_baseline_recovery.rs`, `t17_damage_scope.rs`, `c9_retention.rs` `c9_a_hold_added_after_the_last_checkpoint_survives`, `c9_gc_plan.rs` `c9_gc_refuses_when_retention_is_unresolved` |
| G3 Scaling | **met** | `docs/benchmarks/t32-scaling.md` (run 37298828576). Measured on draft 1; the freeze changed only descriptor key 3 and `user_version` (K13), so the costs carry over |
| G4 Limits | **met** (opt-in item moved to 1.x, D16) | `mochi-format/tests/limits.rs`, T5 property, `b2_image_budget.rs`, `docs/benchmarks/t32-capacity-memory.md`; `exit_codes.rs` `exceed_default_limits_is_refused_by_name` |
| G5 Capacity | **met** | `docs/benchmarks/t32-capacity-memory.md`; B.2.4 replaced by measurements |
| G6 Windows durability | **owner-held; not started** | T33 needs physical Windows 10 22H2 and 11 hardware. Until then Windows reports `Unconfirmed` and truncation needs `--accept-unconfirmed-durability` (`t24_quarantine.rs`) |
| G7 Creation | **met** | `t22_creation.rs`, `t19_storage_dir.rs`; CI `power loss (ubuntu-22.04|24.04, dm-flakey)`. The `link` fallback is exercised by injected errno, not on a filesystem that rejects the flag (recorded caveat, Q52) |
| G8 Truncation | **met** | `t23_eligibility.rs`, `t24_quarantine.rs`, `c14_commands.rs` `c14_append_truncates_an_eligible_tail_only_on_request` (both waivers recorded); Windows refusal without the override |
| G9 Reports | **met** | `t26_t27_reports.rs` `g9_mixed_outcome_matrix`, timestamp property (T28); the CLI takes its exit code from `Report::conclude` (`c14-cli.md` rule 9, `r7_json_schemas.rs` checks `exit_code` equals the process exit) |
| G10 Encrypted (R5) | **met** | `R5-crypto-draft.md` §12; `c11_*` tests; fuzz `key_envelope`, `sealed_object` |
| G11 Redundancy (R6) | **met** | `R6-erasure-coding-draft.md` §10; CI R6 regeneration (also identical locally); `c12_*`; fuzz `parity_frame` |
| G12 Format freeze | **met** (owner review pending, K11) | #34; `ratification_drafts.rs`; `r3_cddl.rs` (passes locally and in CI); `DRAFT_ID = 2` (`mochi-core/src/descriptor.rs`); `b2/reject-archive-draft-1.mochi` |
| G13 Golden set (R8) | **met** (owner review pending) | #36; `r8_golden.rs` (passes locally and in CI; 76 cases, coverage checked by test, 12 MiB budget) |
| G14 Interop (R9) | **met** (owner review pending) | #35, #37; CI `r9 interop` × 2; local 76/76 |
| G15 Report freeze (R7) | **met** (owner review pending) | #49 (#54 added the in-band tags per O2); `r7_json_schemas.rs`; 8 schemas frozen, the 11 command-output schemas freeze at W20 |

## 6. Other gates and phase exits

| Gate | Verdict | Evidence / gap |
|---|---|---|
| D0 exit (sample job streams and cancels, E2E both OSes) | **met** | `self-test.e2e.js`, run 38551536791 |
| D1 exit (100k entries without loading the namespace) | **met** | `browse.e2e.js` "pages a 100,000-entry folder…" |
| D2 (create/add, wording) | **met** | #41; `create-add.e2e.js`; `write.rs` tests |
| D3 (extract) | **met** (skip-only accepted by the owner for 1.0) | #44; `extract.e2e.js` |
| D4 (test, health, repair) | **met, evidence pending** | #47; `check.e2e.js`. Restore-test, the evidence log, and the head history are not in the app (F5) |
| D5 (encryption, recovery record, search) | **met** | #50; `d5.e2e.js`, `d5_tests.rs`; owner confirmed decisions 3, 5, 6, 8 |
| D6 (OS integration) | **not met** | #46; `launch.e2e.js`. Foreign files opened from the shell are refused although D8 shipped (F1). Client-only behaviour is on the release checklist, which has not been run (owner-held) |
| D7 (distribution and quality) | **owner-held** | #42, #51, #52, #55; CI `package` × 2, `package smoke`. Open: the release checklist (updater between two real releases, WebView2 bootstrap, NVDA/Orca, high contrast) and the first draft release with the owner's key |
| D8 exit (DoD row; pinned corpus from 7-Zip, WinRAR, Info-ZIP, GNU tar; fuzz) | **met, evidence pending** | #43, #48, #53; see the Foreign row (F7) |
| Spec §28 "preservation readiness" | out of 1.0 scope | Preservation profile is not in 1.0 (§7.7). The product must keep saying "experimental / draft-compatible" until W20 (`FORMAT_STATUS`, `mochi-format/src/version.rs`): it does |

### 6.1 Spec §24.2 release-blocking fault matrix

| Row | Verdict | Evidence |
|---|---|---|
| Termination at each publication stage | met | `c5_publication.rs`; `t22_creation.rs` |
| Truncation at every byte | met | `c5_publication.rs`; `c8_salvage.rs` `salvage_9`; R9 on the fly |
| Torn, reordered, or lost writes | met | `c5_publication.rs` (nine crash models) |
| Corrupted latest footer | met | `c5_publication.rs` `a_corrupted_latest_footer_is_never_truncated`; `c8_repair.rs` |
| False magic inside payload | met | `framing.rs` `false_magic_inside_a_data_payload_is_never_a_frame_or_footer` |
| Oversized or malicious frame metadata | met | `framing.rs`, `limits.rs`, fuzz |
| Destroyed SQLite catalogs | met | `c4_recovery.rs`, `c5_publication.rs`, `t16_*` |
| Missing shared dictionary (K17 amendment) | met | `c7_verify.rs`, `c8_repair.rs` |
| Corrupted content object | met | `c7_verify.rs`, `c8_repair.rs`, `c12_*` |
| Damage beyond parity capacity | met | `c12_redundancy.rs` |
| Older valid archive substituted | met | `c7_verify.rs` |
| Index deleted | met | `c13_search.rs` (damaged image as the index) |
| Interrupted indexing | **not met** (no index in 1.0) | F4 |
| Concurrent conflicting commits | met | `c5_publication.rs`, `q54_writer_lock.rs` |
| GC overlaps publication | met | `c9_compact.rs` `c9_gc_never_overlaps_publication` |
| Compaction interrupted | met | `c9_compact.rs` |
| Retention expires under legal hold | met | `c9_gc_plan.rs` |
| Path traversal or naming collision | met | §3 Read & extract; `d8_foreign_restore.rs` |
| Deleted primary archive, original machine unavailable, key service unavailable, stale writer resumes, corrupted inventory | outside 1.0 (Preservation, concurrent preparation) | §3 "Rows outside 1.0" |

## 7. Owner-held items

1. **G6** (T33): Windows durability on physical Windows 10 22H2 and 11 hardware.
2. **W20**: the 1.0 flip (descriptor key 3 `null`, `mochi migrate`, R8 regenerated in
   the 1.0 format, R9 rerun). It also freezes the 11 command-output schemas (R7 O2).
   Its trigger requires every other §8.2 gate to be met first.
3. **The owner's review at the desktop checkpoint** (K11) of everything delegated:
   * the R1–R4 freeze (G12), R7 (G15), R8 (G13), and R9 (G14);
   * Annex B D10–D12, D14, D15, and D24 (still in B.2);
   * the delegated calls K10–K26.
4. **Release gate 6** text, or the decision behind it (F3).
5. **The release checklist** in `docs/packaging.md` on client hardware: updater between
   two published releases, WebView2 bootstrap, shell integration, NVDA/Orca, contrast
   themes. Also the first `release.yml` draft release with the owner's secrets.
6. **Decisions this audit found open** (each written as options in §9): F2 (symbolic
   links), F4 (interrupted indexing), F5 (desktop evidence and head history).

## 8. Documents that disagree with the code or with each other

### 8.1 Fixed in this PR (each plainly contradicted merged code or a later merged record)

| File | Was | Now |
|---|---|---|
| `docs/spec.md` §28 status | "R7 (G15) is pending" | R7 met 2026-10-14 (G15); W20 not done, so the experimental description still applies |
| `docs/c14-cli.md` "Errors in `--json` mode" | said every error is a JSON line | adds that argument-parsing errors are clap's text on standard error, exit 3 (R7 §9 item 8) |
| `docs/c14-cli.md` rule 13, the evidence line | listed `level` and `scope` as always present | `level` is a string or null; `scope` and `finding_codes` are omitted when absent (R7 §9 items 3, 4) |
| `docs/c14-cli.md` concession K10 | "when the Encrypted profile (C11) exists" | C11 exists; `health` still reports key availability `UNKNOWN` |
| `docs/report-schema-v1.md` | "(draft)", "final schema … is R7"; recoverability "(1.0 has no parity)" | frozen with R7 (G15); recoverability `DEGRADED` when parity rebuilt all the damage (R7 §9 item 10) |
| `docs/implementation-plan.md` D2, D3, D4, D5, R8 status headings | "CI evidence pending until merged" | merged as #41, #44, #47, #50, #36; main run 38551536791 green on all 40 jobs |
| `docs/implementation-plan.md` D7 slice 1 "Not done" | "the updater … file associations (D6)" | done by T13 (#55) and D6 (#46) |
| `docs/implementation-plan.md` D8 slice 2 "Not done" | "the helper is not in the installers"; no Windows CI evidence | the helper ships (T16, #51); Windows CI ran the `mochi-foreign` tests (MSVC UnRAR, Job Object) green |
| `docs/packaging.md` "Not done" | the first `package` run is "the proof … no webkit2gtk" | `package` × 2 and `package smoke` are green; the shell "not supported yet" note now points to F1 |

### 8.2 Left for their owners (not plainly fixable here, or not docs)

* **`AGENTS.md` "Commands"** says desktop "D0 and D1 built". D0–D8 are built (nit;
  AGENTS.md is the agents' contract, so I did not edit it).
* **`apps/mochi-desktop/README.md`**:
  * the header names D0–D6, D8, and two slices of D7, but not the updater (T13);
  * the module tree omits `foreign.rs`, `launch.rs`, `rekey.rs`, `search.rs`, and
    `update.rs` (nit).
* **`apps/mochi-desktop/src-tauri/src/launch.rs` module doc**: "until the foreign-format
  helper (plan D8) exists". This is code, so I left it; F1 fixes it.
* **`docs/spec.md` §10.4.1** is still headed "(Proposed, open)", although B.1 D6 decided
  it (nit). D6 itself disagrees with the frozen format on symbolic links (F2).
* **Plan C7 decision (3)** still says "no parity in 1.0". It is a dated decision that
  C12 superseded (nit; history).
* **Plan §8.2 gate 5 status** (2026-10-13) is still accurate, but it should name what is
  missing (F8).
* **Plan §8.2 gate 6** vs D7 and `docs/packaging.md` (F3).
* **`docs/ratification-core-plan.md` §0** and **`docs/next-work-plan.md`** are dated
  hand-offs. They say so and defer to the spec, so they are not drift.

## 9. Findings

Severity: **blocker** = must be closed before the 1.0 flip; **should-fix** = fix or
explicitly accept before 1.0; **nit** = wording or tidiness.

1. **F1 — blocker (real bug).** Shell "Open with MOCHI" on a ZIP, 7z, RAR, or tar file
   refuses to open it, although D8 shipped and the installer offers this association.
   * **Where:** `launch.rs` `Launcher::open` returns
     "`<path>: <kind> archives cannot be opened yet. MOCHI opens .mochi archives.`" for
     any path whose extension `foreign_kind` recognizes. `ForeignBrowser` and
     `open_foreign_archive` already open these files from the in-app dialog.
   * **Who hits it:** the NSIS opt-in (`packaging/nsis/hooks.nsh`, `/ASSOCIATE_FOREIGN`)
     and the `.deb` `MimeType` both route foreign files to this path.
   * **Reproduction:** E2E `launch.e2e.js` "says plainly that a ZIP cannot be opened
     yet" and unit test `a_foreign_archive_is_refused_plainly_and_never_opened` pin the
     refusal and pass on `main`. Manually: install with "Open with" for ZIP, then
     right-click any `.zip` → MOCHI shows the refusal.
   * **Next step:** route `foreign_kind` paths from the launcher to the D8 open (a
     password prompt in the window for encrypted names). Update both tests and the
     release checklist item. Alternatively, stop offering the association until then.
2. **F2 — blocker (spec gap; a decision, not a guess).** Symbolic links: spec B.1 **D6**
   (and plan O6) decide that a symbolic link is an entry type: "target stored as bytes;
   restored as a link". The frozen draft-2 format reserves manifest kind 2 and refuses
   it (`UNSUPPORTED_FEATURE`, R3 `c4/reject-manifest-symlink-kind.bin`). The writer skips
   links (`docs/c14-cli.md` rule 5 and concession K7). Nothing records a deferral. Options:
   * **(a)** amend D6 to "symbolic links are 1.x". No wire change: kind 2 stays reserved,
     and skipping stays reported (exit 2).
   * **(b)** implement kind 2 before 1.0. This is a wire change: draft 3, Annex B entry,
     R3 and R8 regenerated, R9 rerun.

   (a) is cheaper and honest. (b) matches what WinRAR users expect. The owner decides.
3. **F3 — blocker (owner-held).** Release gate 6 requires "signed installers … for
   Windows and Ubuntu". The owner decided no Authenticode and no `.deb` signing for
   1.0 (`docs/packaging.md`, plan D7). The gate was never amended, so as written it can
   never pass. **Next step:** the owner amends gate 6, for example to "signed updates
   (minisign, `requireSignedVersion`); installers unsigned by decision [owner,
   2026-10-14]". Then the evidence is the first draft release from `release.yml` with
   the owner's key, plus the release-checklist update run.
4. **F4 — blocker (spec gap).** §8.1 Search and §24.2 "Interrupted indexing": 1.0 builds
   no search index (full-text is optional, §19.2), so there is nothing to interrupt.
   Plan C13 leaves it "waiting for an index". Options:
   * **(a)** an amendment like K17: in 1.0 the row is met by searchability `UNSUPPORTED`
     in `verify` and refusal of content search (both tested: `c7_unsupported_levels_exit_4`,
     `c13_search_command.rs` `c14_search_refuses_content_search_and_bad_arguments`), and
     the row returns when an index exists;
   * **(b)** build an index before 1.0.

   (a) is recommended.
5. **F5 — should-fix (owner decision).** The desktop app keeps no local head history and
   no evidence log (spec B.1 D8: "the client keeps the last-seen head per archive ID
   locally"):
   * freshness in the app is always `UNKNOWN`;
   * health judges only this window's tests;
   * restore-test is missing.

   Plan D4 wrote options A (move `HeadStore` into core), B (a shared `mochi-state`
   crate), and C (rejected). No decision is recorded. **Next step:** the owner picks A or
   B, or accepts the gap for 1.0 in D8's text.
6. **F6 — should-fix.** `main` is not green at the audited head. The run for #54
   (38558591812) failed on F16. The run for #55 (38561036215) was still running when
   this was written. The last fully green `main` run is 38551536791 at `db611b3`.
   **Next step:** fix F16, then record a green `main` run id here and in the plan.
7. **F7 — should-fix.** The D8 hostile corpus has no RAR case:
   * no traversal, bomb, ratio, or BLAKE2sp fixture;
   * multi-volume RAR (D8 rule 8) is never read as a complete set;
   * no WinRAR-written or current-`rar` archive;
   * 8 mutation survivors are recorded.

   **Next step:** obtain RAR fixtures under a compatible license, or written by the owner
   with a licensed `rar` (reading only; MOCHI never writes RAR), or drop "WinRAR" and
   "multi-volume RAR" from the D8 claims for 1.0.
8. **F8 — should-fix.** Release gate 5 is not met as its own status line defines it.
   `docs/user/` is CLI-oriented and is not shipped: the installers bundle no user
   documentation, and the app links to none. The app's own text covers parts of the four
   topics (§4, gate 5). **Next step:** bundle the guide (or a desktop page of it) with
   both installers and add a Help entry, with a line on the Test screen that a passing
   test does not make the file a backup. Alternatively, the owner records that the
   in-app text plus the published guide meet gate 5.
9. **F9 — should-fix.** The owner's review (K11) of the delegated freezes and calls is
   still pending (G12–G15, D10–D15, D24, K10–K26). It is a precondition of W20.
10. **F10 — should-fix.** The release checklist (`docs/packaging.md`) has never been run.
    It covers updater, WebView2 bootstrap, shell integration, and screen readers, and
    Windows Server CI cannot reproduce any of them (AGENTS.md "Tests required").
    **Next step:** owner run on client hardware, recorded in the release notes.
11. **F11 — should-fix.** Gate evidence G1–G9 rests on CI runs from `Sepiolina/MOCHI`
    PRs (#2–#5) and early `immerh8` runs. The tests still pass today (run 38551536791),
    but the checklist's "Gates" section does not say so. **Next step:** append the
    current run id to `docs/b2-implementation-checklist.md` "CI evidence" at the next
    status update.
12. **F12 — nit.** The TAR "pinned tool/version matrix" (§8.1) is not pinned: CI uses the
    runner image's tools and prints their versions. **Next step:** make
    `ci/tar-interop.sh` (or the workflow) fail when a printed version is not in
    `docs/c10-tar-compat.md`'s table, so the claim and CI cannot drift silently.
13. **F13 — nit.** §23.3 #8 (partial coverage shown as incomplete) has no Windows UI run:
    the vitest job is Ubuntu-only, and the E2E covers only complete coverage. **Next
    step:** an E2E case over an archive with a damaged image (`c13`'s fixture shape), or
    run `pnpm test` on `windows-latest` too.
14. **F14 — nit.** "Stale writer resumes" and "key service unavailable" have no 1.0 entry
    point that could return `UNSUPPORTED`. The plan's sentence "that behaviour is itself
    tested" holds only for inventory and disaster recovery. **Next step:** say so in
    plan §8.1.
15. **F15 — nit.** Spec §10.4.1 is still marked "(Proposed, open)". `AGENTS.md` and
    `apps/mochi-desktop/README.md` status lines lag (§8.2). The D6 forwarded `argv`
    loses unpaired surrogates on a second launch (recorded in D6; Windows-only, rare).
16. **F16 — blocker (real bug; makes `main` CI red).** A crafted 358-byte 7z makes the
    listing loop without end:
    * **Where:** in `sevenz_rust2` 0.20,
      `Archive::read` → `try_to_locale_end_header` → `init_archive` → `read_header` →
      `read_variable_u64`, which spins with constant memory (about 4 MB resident).
    * **How it was found:** CI `fuzz smoke (foreign_sevenz)` on `main` run 38558591812
      (head `eae258b`, #54), artifact `timeout-9b2ba6ed372fbec405e789b92be1223e9c9fbf77`.
    * **Impact:** in the product the helper's wall-time limit (default 600 s,
      `crates/mochi-foreign/src/client.rs`) ends it with a `HELPER_*` error. Until then,
      opening the file in the app burns a core for up to ten minutes.
    * **Reproduction:** write the bytes below to `t.7z`; a 4-line binary that calls
      `mochi_foreign::fuzz::exercise_sevenz_listing(&std::fs::read("t.7z")?)` (release
      build, on `main` `8cac973`) had not returned after 300 s, and gdb showed the stack
      above. Or `cargo +nightly fuzz run foreign_sevenz t.7z`. SHA-1
      `9b2ba6ed372fbec405e789b92be1223e9c9fbf77`, hex:

      ```text
    377abcaf271c0004000000000000000000000000000000000000000000000000fffffffffffffffff7ffffffffffffff
    ffffffffffffffff0022000000000000001cf00100000000000008da630118af3442196effffff196e0421d2cfff251c
    483ee8ffffffffffffffffffffffffffffffffffffffffffffffffffffff71ffffffffffffff2cc96c85ff544dac9218
    1a9fd702ff0001000000000000000a0102fb415cfa105e0408438100003b0400000000fd0000ffffffffffffffffffff
    ffffffffffffffffffffffffffffffffff71717171717171717171717171717171717171717171717171717171717171
    717171717171717171717171717171717171717171717171717171717171717171717171717171717171717171ffffff
    ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
    ffffffffffffffffffc0ffffffffffffff0000000000
      ```
    * **Next step:** bound the end-header search and every count read in `sevenfmt`
      before handing input to `sevenz-rust2` (or patch or upgrade the crate; versions
      after 0.20 need rustc 1.93, plan D8). Then add the input to
      `fixtures/fuzz-regressions/foreign_sevenz` with the fix. Until the fix lands, the
      `foreign_sevenz` smoke job can fail on any PR. That is the reason this PR does not
      add the input now: it would turn every run red.
