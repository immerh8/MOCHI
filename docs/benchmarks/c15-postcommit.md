# C15: what runs after a commit, and how long it takes

Prompted by desktop feedback: "Verifying committed archive took very long;
MOCHI should be fast to know, verify, and see if files exist." Spec §27
decomposition below; the benchmark is
`crates/mochi-testkit/examples/c15_postcommit_bench.rs`.

## What actually runs after a commit

There is **no post-commit verification** in the desktop or in `mochi-core`,
and the spec does not ask for one (§12.2 ends at "report local commit
completion"; §20 defines verification as a separate, read-only operation).
What the user sees after Add / Create / Delete is:

1. `ArchiveWriter::open_append`: hash-verify and open the head (catalog
   image or replayed segment, full catalog consistency check).
2. `commit` (§12.2 steps 3-10): content, catalog update, delta manifest;
   on a **checkpoint** also the snapshot manifest, the catalog image and the
   D10.7 adoption read-back (spec-mandated: re-read both representations and
   compare them with the writer's state before the commit record exists).
3. `reopen` in the desktop: commit history, `open_head` (hash-verify the
   catalog image, full catalog check again), `segment_state`, snapshot index.

The progress phases of step 2 (`content`, `catalog`, `manifest`,
`checkpoint`, `adopt`, `sync-content`, ...) had **no label** in the UI, so they
all read "Working: N", and `adopt` (a read-back-and-compare) looked like a
long verification with no name. Progress events were also forwarded
unthrottled (one IPC event per object, file or path).

## Setup (§27)

- **Dataset:** one create commit of 10 000 files (1-8 KiB pseudo-random, 100
  folders) plus 3 incompressible files of 64 MiB: 243.6 MiB archive. Then
  four appends of one 4 KiB file each (the fourth forces a checkpoint), as a
  fresh writer session each, as the desktop does.
- **Hardware:** 4 vCPU Intel Xeon @ 2.1 GHz VM, 16 GiB RAM, virtio disk,
  ext2/3-family filesystem, Linux 6.18, rustc 1.91.1, `--release`.
- **Cache state:** warm (the archive was just written; page cache holds it).
- **Settings:** writer defaults (Core profile, T14 checkpoint trigger, default
  chunk size and zstd level, `record_time`), real `fdatasync` on the real
  file. No encryption, no recovery record. `verify` at the stated level,
  `deep` off.
- **Method:** the bench was run three times, alternating before/after
  binaries; the table gives the median of the three runs. fsync times on this
  VM vary by hundreds of ms between runs, which is most of the spread.
  "Before" is `HEAD` (5970048), "after" is this change.

## Where the time went (before)

Create commit (one run), ms: content 2233 (hash + zstd of 243 MiB: inherent),
catalog 94, manifest 39, **checkpoint 952** (snapshot manifest + image),
**adopt 691** (D10.7 read-back), commit record 15, sync 211.

Append of one file to the 10 000-file archive (delta commit), ms:
open_append ~305 (catalog image decode + full catalog check), then
content 230-250 (of which almost all is `dedup_index_at_head`: one
`file_version` and one `object` lookup per file, each preparing its SQL
statement again), catalog 17, manifest 4, syncs ~2-60.

Cause: the per-file-version loops in `Catalog::verify`,
`dedup_index_at_head`, `AuthoritativeState::from_catalog`, the snapshot
builder and the extent checks issued 3-4 `conn.prepare` calls per version and
per chunk (SQLite statement compilation dominates a primary-key lookup).
Nothing hashes data objects, re-reads the archive, or does anything
proportional to the 192 MiB of file data after the content phase.

## Changes

1. `mochi-core/src/catalog/mod.rs`: point lookups (`meta`, `object`,
   `object_location`, `chunk_decoded_len`, `file_version` and its extents,
   `kinds_for`, dependencies) use `prepare_cached`; `Catalog::verify` reads
   all file versions, extents and chunk lengths in three queries instead of
   a lookup per version and per chunk. The checks are identical (same
   `validate_extents` rules, same order of versions), only fetched in bulk.
   The catalog image is still hash-verified and envelope-bound before
   SQLite sees it, and still fully checked after.
2. `mochi-core/src/verify/scoped.rs`: `verify_commits_since` (below).
3. `mochi-desktop/src-tauri/src/jobs.rs`: progress forwarding is throttled to
   one event per 50 ms per phase; a phase's first event and its completing
   event (`completed >= total`) always go out. Test:
   `a_flood_of_progress_is_thinned_but_phase_edges_survive`.
4. UI: labels for the commit phases and `verify-scoped` in en, zh-CN, th
   (`common.phase.*`), so the progress line says what is happening.

No wire-format change; golden fixtures (`r8_golden`) are unchanged.

## Numbers (median of 3 runs, ms)

| step | before | after |
|---|---:|---:|
| create commit, 243.6 MiB (10 000 + 3 files) | 4650 | 3274 |
| append 1 small file, whole session (open + commit + close) | 609 | 262 |
| append that is a checkpoint (adoption read-back included) | 2295 | 955 |
| desktop reopen: `open_head` | 274 | 61 |
| desktop reopen: `segment_state` / snapshot index | 45 / 25 | 45 / 25 |
| scoped check of the newest commit (1 object) | 248 | 70 |
| scoped check of the four appended commits (4 objects) | 238 | 64 |
| full `verify`, Structural | 1625 | 598 |
| full `verify`, Referential | 1878 | 666 |
| full `verify`, StoredIntegrity | 1987 | 821 |
| full `verify`, ContentIntegrity | 2634 | 1246 |
| full `verify`, Restoration (the default) | 3469 | 2090 |

("Scoped before" is the same new function on the old catalog code.)

After the change, what is left in an append is the SQLite `integrity_check`
and namespace replay of the head catalog (about 55 ms for 10 000 files, done
once at open and once at reopen), the dedup index build (about 75 ms), and
fsync. The checkpoint itself (snapshot manifest and image: about 400 ms) and
its adoption read-back (about 270 ms) are the D10.7 mandatory work and are
paid only when the T14 trigger makes a commit a checkpoint.

## Scoped verification: `verify_commits_since`

For a client that wants to know the commit it just made is sound without
re-verifying the archive. Given the last verified head it:

- opens the head (hash-verify before parse, as every reader does),
- checks the **chain link** (the previous head is in the history, at its
  sequence, with its commit ID: an older or different archive is `FAIL`
  with `FRESHNESS_FAILED`),
- hash-checks, decodes and chunk-hash-checks **only the data objects the new
  commits introduce** (from their delta manifests).

Its report says exactly what it covered. `scope_status()` is the status of
that scope only; `whole_archive` is **always `UNKNOWN`**, and `not_checked`
lists "commits 0 through N" and "file reassembly". It is not a restoration
test, not a freshness verdict, and not a health report; `verify` remains the
only operation that reports health dimensions. Cancellation or an I/O error
is `operational_error` and the scope is `UNKNOWN`, never `PASS`.

Tests (`crates/mochi-testkit/tests/c15_scoped_verify.rs`): a healthy new
commit passes its scope and claims nothing wider; flipping a byte in each
object of the new commit is `FAIL` (`STORED_INTEGRITY_FAILED`) affecting only
that commit; flipping a byte in an old object is not read (a read-range
recorder proves no old object was touched) and the scope is not reported as
the archive being sound, while full `verify` does fail; a foreign archive, a
wrong commit ID and a rolled-back archive fail the chain link; a cancelled
run is not `PASS`.

The desktop does not call it: nothing in the desktop verified after commit
before, and adding a verification step to Add/Delete is a product decision
(see the report's open questions).
