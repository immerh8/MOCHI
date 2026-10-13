# R9: interoperability results (gate G14)

Ratification artifact R9, plan W18, spec Annex B.2.6 G14. The independent read-only verifier
`interop/pyverify` (plan W17, written from the specification alone) produced a
`mochi-interop-summary-v1` for every case of the R8 golden set, `fixtures/golden/r8/`, and the
result was compared, as parsed JSON and with no tolerance, against the reference summary
`<case>.summary.json` that `mochi_testkit::interop` produced. The comparator is
`interop/pyverify/tools/compare_r8.py`; CI runs it as job `r9-interop`.

## What happened

* **First run:** 53 of 76 cases differed (70 differences by field, below). The session that ran it
  is not the session that wrote the verifier, and it read the expected summaries, as W18 requires.
* **Classification:** every difference was one of three kinds (plan W18): **(a)** the text left room, so the
  text was clarified and the verifier follows the clarified text; **(b)** a bug in the Rust reference;
  **(c)** a bug in the verifier, fixed only where the reading log or the text shows the text was clear
  (otherwise the case is (a)).
* **No byte changed.** There was no class (a) difference that needed a byte change, so there is no draft
  bump and no Annex B entry (K11). Draft 2 stands. Every (a) edit is wording and is marked
  "Clarified, W18 (R9)" in the file it touches.
* **The comparison was not loosened:** no tolerance list, no skipped case, no field ignored. The one
  change to the comparator makes it stricter (a case without a summary or a summary without a case
  fails; a missing R8 directory fails).
* **Rust reference:** one bug (b), `enc-valid-keyless`; one summary regenerated, one field.
* **Independence:** the verifier changed only for the rows below. Each change follows a clarified
  sentence in the specification or the artifacts, not the Rust code; `interop/pyverify/READING-LOG.md`
  section W18 lists which of its earlier readings were replaced. Where the verifier's reading had been
  clear and right, it was not changed.

## Causes

| Tag | Class | Subject | What was wrong and how it was resolved | Commits |
|---|---|---|---|---|
| P | (c) | Comparator input | `tools/compare_r8.py` looked for `<case>.passphrase` and `<case>.expected-head` next to the archive (a guess recorded in the pyverify README); W16 keeps both in `cases.json`. Encrypted cases were read keylessly and the freshness anchor was never passed. The comparator now reads `cases.json`; a case without a summary, a summary without a case, or a missing directory fails. Nothing in the comparison was loosened. | addc7e3 |
| REF | (a) | W17 does not say whether the head's refusal is a finding | `fixtures/golden/README.md` (R8 summaries) says the refusal code is also a finding; W17 only says "violation-class findings". Clarified in the plan's W17 text; the verifier reports it. | 4aa4e1a, 41e7d3f, addc7e3 |
| FI | (a) | R7 does not say when `FOOTER_INVALID` is reported for a missing footer | R7 says only "a footer failed validation". Clarified: also a finding (not a refusal) when the file does not end in the head's valid footer and the head was found by scanning. Eligible tails stay `UNCOMMITTED_TAIL` (operational). | 4aa4e1a, addc7e3 |
| OBJ | (a) | W17 does not say which objects a finding names | W17: "the stored-object hash it concerns". Clarified in the R8 summary rules: a hash only for a damaged data chunk, one row per code (a code with chunk rows has no null row). The verifier named manifests, images, key envelopes and data regions too. | 4aa4e1a, 41e7d3f, addc7e3 |
| IMG | (a) | Spec D10 item 9: what "a damaged image" is | A hash-verified catalog image with a zeroed page: the reference refuses the head (`CATALOG_INVALID`), the verifier opened it from the snapshot manifest and made it a finding. Clarified (spec D10 item 9, R4 section 3): damage means a failed stored hash or AEAD tag; an authentic image that fails the catalog checks is a writer's fault and refuses the head when it is the head's base. **Decision for the owner:** the alternative (rebuild from the snapshot manifest) is also consistent with item 9 as first written; the reference's choice was kept because it needs no byte change. Reversing it is a rule change for the reference, not for the format. | 4aa4e1a, addc7e3 |
| DICT | (c) | Spec 24.2 is clear | Spec 24.2 (clarified at W10) says a dependency naming an object the catalog does not hold is `REFERENCE_INVALID`. The reading log (D4) had treated every dependency as `UNSUPPORTED_FEATURE`; the text was clear and the verifier missed it. | addc7e3 |
| SNAP | (a) | W17 "retains" | The verifier listed only commits that are roots under the retention rules; the reference lists one snapshot per commit of the chain, since expiry only marks collectability and removes nothing. Clarified in the W17 text and the R8 summary rules. | 41e7d3f, addc7e3 |
| KL | (a) | W17 knows only `opened` and `refused` | An Encrypted archive read without a passphrase has `head.status` `keyless` (an addition already in the R8 summary rules). Clarified in the W17 text; the verifier reports it. | 41e7d3f, addc7e3 |
| KLP | (b) | Rust reference | The reference summary of a keyless Encrypted archive said `profile.encrypted: false`: the profile was filled in only on the path that opens the head. The descriptor is plaintext, so the reference now reads it. Diff: `enc-valid-keyless.summary.json`, `profile.encrypted` false to true, nothing else; no archive byte changes. | 6246bcd |
| ENV | (c) | R3 section 7.1 is clear | R3 section 7.1 lists the envelope rule (distinct, one key ID, increasing ID order) among the rules a record can break while still satisfying its CDDL and then "be refused". The verifier checked this late and made it a finding (against its own rule that commit-record violations refuse). It now refuses the head with `RECORD_INVALID`; R3 section 7.1 says so explicitly and cites the two R8 cases. | 4aa4e1a, addc7e3 |
| KEY | (a) | W17 does not say how an operational refusal appears | A wrong passphrase printed no summary and exited 3 (reading log E2). The reference summary says `head` refused, `KEY_UNAVAILABLE`, with that one finding. Clarified (plan W17 text, R8 summary rules); with `--summary` the verifier prints that document, without it still exits 3. | 4aa4e1a, 41e7d3f, addc7e3 |
| PAR | (a) | W17 gives no units for `parity` | `commits` is the number of commits the scan reaches, whether or not a frame decodes; the verifier skipped a commit none of whose frames decoded. Clarified in the R8 summary rules. | 4aa4e1a, addc7e3 |
| RAW | (a) | Spec B.2.11 item 12 | Damage that parity rebuilds within capacity: the reference reports the stored-integrity finding from the bytes as stored and reads the rebuilt view afterwards; the verifier used only the rebuilt bytes and reported nothing. Clarified in spec B.2.11 item 12; the verifier now makes two passes. | 4aa4e1a, addc7e3 |
| TAR | (c) | R7 is clear | R7: `CONTENT_INTEGRITY_FAILED` means the stored bytes verified. The verifier reported a damaged TAR framing chunk twice, as a stored-integrity and as a content failure. It now reports the stored-integrity failure only. | addc7e3 |

Commits are in this PR: `6246bcd` (Rust reference, class b), `4aa4e1a` (clarified texts, class a, no bytes),
`addc7e3` (verifier and comparator), `41e7d3f` (plan W17 text).

## Every mismatch

One row per case and top-level summary field that differed in the first run. `P` rows are the first
run's reading of Encrypted and freshness cases without the passphrase or the anchor, which the corrected
comparator input removed before any verifier change; the rows with another tag were still different
after that and were resolved as the tag's row above says.

| Case | Field | Tag | Class | Resolution commit |
|---|---|---|---|---|
| `copy-head-destroyed` | `findings` | FI | (a) | 4aa4e1a, addc7e3 |
| `core-corrupt-all-images` | `findings` | OBJ | (a) | 4aa4e1a, 41e7d3f, addc7e3 |
| `core-corrupt-delta-manifest` | `findings` | REF | (a) | 4aa4e1a, 41e7d3f, addc7e3 |
| `core-corrupt-descriptor` | `findings` | REF | (a) | 4aa4e1a, 41e7d3f, addc7e3 |
| `core-corrupt-image-pages` | `archive_id` | IMG | (a) | 4aa4e1a, addc7e3 |
| `core-corrupt-image-pages` | `commits` | IMG | (a) | 4aa4e1a, addc7e3 |
| `core-corrupt-image-pages` | `head` | IMG | (a) | 4aa4e1a, addc7e3 |
| `core-corrupt-image-pages` | `snapshots` | IMG | (a) | 4aa4e1a, addc7e3 |
| `core-corrupt-latest-footer` | `findings` | FI | (a) | 4aa4e1a, addc7e3 |
| `core-corrupt-manifest-cut-short` | `findings` | REF | (a) | 4aa4e1a, 41e7d3f, addc7e3 |
| `core-corrupt-manifest-not-a-frame` | `findings` | REF | (a) | 4aa4e1a, 41e7d3f, addc7e3 |
| `core-corrupt-middle-commit` | `findings` | REF | (a) | 4aa4e1a, 41e7d3f, addc7e3 |
| `core-corrupt-missing-dictionary` | `findings` | DICT | (c) | addc7e3 |
| `core-corrupt-noncanonical-commit` | `findings` | REF | (a) | 4aa4e1a, 41e7d3f, addc7e3 |
| `core-corrupt-older-archive` | `findings` | P | (c) | addc7e3 |
| `core-corrupt-orphan-put` | `findings` | REF | (a) | 4aa4e1a, 41e7d3f, addc7e3 |
| `core-corrupt-oversized-frame` | `findings` | REF | (a) | 4aa4e1a, 41e7d3f, addc7e3 |
| `core-corrupt-oversized-tail-frame` | `findings` | FI | (a) | 4aa4e1a, addc7e3 |
| `core-corrupt-reused-chunk-id` | `findings` | REF | (a) | 4aa4e1a, 41e7d3f, addc7e3 |
| `core-corrupt-short-extents` | `findings` | REF | (a) | 4aa4e1a, 41e7d3f, addc7e3 |
| `core-corrupt-snapshot-bound-elsewhere` | `findings` | REF | (a) | 4aa4e1a, 41e7d3f, addc7e3 |
| `core-corrupt-traversal-path` | `findings` | REF | (a) | 4aa4e1a, 41e7d3f, addc7e3 |
| `core-corrupt-truncated-mid-history` | `findings` | FI | (a) | 4aa4e1a, addc7e3 |
| `core-corrupt-undefined-version` | `findings` | REF | (a) | 4aa4e1a, 41e7d3f, addc7e3 |
| `core-interrupted-after-commit-frame` | `findings` | FI | (a) | 4aa4e1a, addc7e3 |
| `core-interrupted-after-data` | `findings` | FI | (a) | 4aa4e1a, addc7e3 |
| `core-interrupted-compaction` | `findings` | FI | (a) | 4aa4e1a, addc7e3 |
| `core-interrupted-torn-footer` | `findings` | FI | (a) | 4aa4e1a, addc7e3 |
| `core-valid-retention` | `snapshots` | SNAP | (a) | 41e7d3f, addc7e3 |
| `enc-corrupt-aead-tag` | `findings` | P | (c) | addc7e3 |
| `enc-corrupt-aead-tag` | `snapshots` | P | (c) | addc7e3 |
| `enc-corrupt-chunk-head` | `findings` | OBJ | (a) | 4aa4e1a, 41e7d3f, addc7e3 |
| `enc-corrupt-chunk-head` | `snapshots` | P | (c) | addc7e3 |
| `enc-corrupt-data-region-kind` | `snapshots` | P | (c) | addc7e3 |
| `enc-corrupt-envelope-duplicate` | `archive_id` | ENV | (c) | 4aa4e1a, addc7e3 |
| `enc-corrupt-envelope-duplicate` | `commits` | ENV | (c) | 4aa4e1a, addc7e3 |
| `enc-corrupt-envelope-duplicate` | `head` | ENV | (c) | 4aa4e1a, addc7e3 |
| `enc-corrupt-envelope-duplicate` | `profile` | ENV | (c) | 4aa4e1a, addc7e3 |
| `enc-corrupt-envelope-duplicate` | `snapshots` | ENV | (c) | 4aa4e1a, addc7e3 |
| `enc-corrupt-envelopes-unordered` | `archive_id` | ENV | (c) | 4aa4e1a, addc7e3 |
| `enc-corrupt-envelopes-unordered` | `commits` | ENV | (c) | 4aa4e1a, addc7e3 |
| `enc-corrupt-envelopes-unordered` | `head` | ENV | (c) | 4aa4e1a, addc7e3 |
| `enc-corrupt-envelopes-unordered` | `profile` | ENV | (c) | 4aa4e1a, addc7e3 |
| `enc-corrupt-envelopes-unordered` | `snapshots` | ENV | (c) | 4aa4e1a, addc7e3 |
| `enc-corrupt-wrong-passphrase` | `(whole summary: exit 3, none printed)` | KEY | (a) | 4aa4e1a, 41e7d3f, addc7e3 |
| `enc-interrupted-after-data` | `findings` | FI | (a) | 4aa4e1a, addc7e3 |
| `enc-interrupted-after-data` | `snapshots` | P | (c) | addc7e3 |
| `enc-red-corrupt-beyond-capacity` | `findings` | OBJ | (a) | 4aa4e1a, 41e7d3f, addc7e3 |
| `enc-red-corrupt-beyond-capacity` | `snapshots` | P | (c) | addc7e3 |
| `enc-red-interrupted-after-commit-frame` | `findings` | FI | (a) | 4aa4e1a, addc7e3 |
| `enc-red-interrupted-after-commit-frame` | `snapshots` | P | (c) | addc7e3 |
| `enc-red-valid-history` | `snapshots` | P | (c) | addc7e3 |
| `enc-valid-history` | `snapshots` | P | (c) | addc7e3 |
| `enc-valid-hostile-names` | `snapshots` | P | (c) | addc7e3 |
| `enc-valid-keyless` | `head` | KL | (a) | 41e7d3f, addc7e3 |
| `enc-valid-keyless` | `profile` | KLP | (b) | 6246bcd |
| `enc-valid-reencrypted` | `snapshots` | P | (c) | addc7e3 |
| `enc-valid-rekeyed` | `snapshots` | P | (c) | addc7e3 |
| `legacy-draft-1` | `findings` | REF | (a) | 4aa4e1a, 41e7d3f, addc7e3 |
| `red-corrupt-beyond-capacity` | `findings` | OBJ | (a) | 4aa4e1a, 41e7d3f, addc7e3 |
| `red-corrupt-parity-frame` | `parity` | PAR | (a) | 4aa4e1a, addc7e3 |
| `red-corrupt-within-capacity` | `findings` | RAW | (a) | 4aa4e1a, addc7e3 |
| `red-interrupted-after-parity` | `findings` | FI | (a) | 4aa4e1a, addc7e3 |
| `salvage-archive-inside` | `findings` | FI | (a) | 4aa4e1a, addc7e3 |
| `salvage-destroyed-descriptor` | `findings` | REF | (a) | 4aa4e1a, 41e7d3f, addc7e3 |
| `salvage-destroyed-footers` | `findings` | REF | (a) | 4aa4e1a, 41e7d3f, addc7e3 |
| `tar-corrupt-chunk-head` | `findings` | TAR | (c) | addc7e3 |
| `tar-interrupted-after-commit-frame` | `findings` | FI | (a) | 4aa4e1a, addc7e3 |
| `tar-red-corrupt-within-capacity` | `findings` | RAW | (a) | 4aa4e1a, addc7e3 |
| `tar-red-interrupted-after-parity` | `findings` | FI | (a) | 4aa4e1a, addc7e3 |

## Final result

* **Final CI run:** [38364569151](https://github.com/immerh8/MOCHI/actions/runs/38364569151), workflow `ci`, run
  number 117, on commit `ed6661e` (the head before this file's last edit; this edit changes only documentation),
  conclusion `success`. The `r9-interop` job passed on ubuntu-22.04 (Python 3.10) and ubuntu-24.04 (Python 3.12):
  pytest, then `compare_r8.py` over `fixtures/golden/r8/`: 76 cases compared, 0 differ.
* **Versions** (hash-pinned in `interop/pyverify/requirements.txt`): blake3 1.0.8, zstandard 0.25.0, PyNaCl 1.6.2,
  argon2-cffi 25.1.0, pytest 9.1.1; Python 3.10 and 3.12 in CI (3.13.16 locally); SQLite 3.37 or later;
  reference side built with Rust 1.91 (`rust-toolchain.toml`). Draft identifier 2, `user_version` 1.
* **Local checks before the push:** `cargo fmt --all --check`, `cargo clippy --workspace --exclude mochi-desktop
  --all-targets -- -D warnings`, `cargo test --workspace --exclude mochi-desktop` (957 passed), `ci/check-invariants.sh`,
  pyverify pytest (315 passed). `mochi-desktop` needs the webkit2gtk system libraries and was left to CI.

R9 verifies every R8 case.
