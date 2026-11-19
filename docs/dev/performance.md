# Performance measurements

Measured costs behind the specification's claims (spec §27). Each section gives its
dataset, hardware, cache state and settings, as §27 requires. The benchmark programs
are in `crates/mochi-testkit/examples/` (`c5_append_bench`, `c12_parity_bench`, ...);
run them with `cargo run --release -p mochi-testkit --example <name>`.

| Section | What it measures |
|---|---|
| [Archive size and append cost as history grows](#scaling) | Checkpoint trigger: archive size and per-commit cost over 10,000 commits (gate G3) |
| [Append cost versus prior commits (before checkpoints)](#append) | The first writer, with a full catalog per commit: why checkpoints were needed |
| [Capacity and memory](#capacity-memory) | Largest archives and memory use within the default limits (gates G4, G5) |
| [Read path, decomposed](#read) | Footer lookup, catalog open, replay and file read, each measured separately, warm and cold |
| [Recovery record (Redundancy profile) cost](#parity) | Size and time cost of 1–100 % parity, and repair speed (gate G11) |
| [Compressing on several cores](#threads) | Speed-up from compressing on several threads |
| [What runs after a commit, and how long it takes](#post-commit) | What the app does after Add, Create or Delete (there is no post-commit verification), and its timings |

<a id="scaling"></a>

## Archive size and append cost as history grows

Spec Annex B.2.3 (checkpoint trigger, storage bound) and B.2.6 gate G3:
"Four workloads, each from 10 to 10,000 commits: a growing catalog,
repeated updates, tiny commits, and a large import. Plus a forced-checkpoint
run. Report Δ, *B*, *k*, replay operations, and open time. The α/*F*
defaults are confirmed or revised from these results." Reproduce with
`cargo run --release -p mochi-testkit --example t32_scaling [max_n] [α as n/d] [F]`
(`MOCHI_T32_ONLY=<workload>` runs one workload).

### Setup (§27 required statements)

| Item | Value |
|---|---|
| Dataset | Per workload, below. Files are 256 bytes of pseudo-random data with POSIX attributes. |
| Trigger | Production policy (T14), default α = 1, *F* = 1 MiB unless stated. |
| Hardware | Cloud container: 4 vCPU Intel Xeon @ 2.10 GHz, 15 GiB RAM, kernel 6.18. Runs are single-threaded; the α = 1/2 and α = 2 runs and the forced run shared the machine (3 processes on 4 vCPUs). |
| Storage, cache | In memory (`SimStorage`): no syncs, warm. Write times are CPU and SQLite cost only (the C5 benchmark covers syncs). |
| Chunking | Fixed-size, 8 MiB maximum (product default); every file is one chunk. |
| Compression | Zstandard level 3. |
| Encryption | None (Core profile). |
| Verification level | Opening = footer, commit, descriptor, and every referenced object's stored-object hash; envelope binding; SQLite integrity and MOCHI catalog verification of the base image; each replayed delta decoded, identity-bound, linked (Q22), and applied under D10.4. No content-object reads. |
| Build | `--release`, Rust 1.91.1, bundled SQLite (libsqlite3-sys 0.38.2), zstd 1.5.7. |
| Open time | Median of 5. "Head" opens the last commit; "longest replay" opens the commit with the largest Δ at its decision. |

Every figure is computed from the archive bytes (history entries and object
references), not from the writer's counters. Columns:

* **ΣΔ**: delta-manifest, commit-record, and footer bytes of the delta
  commits, as the trigger counts them. **final B**: the last base's image +
  snapshot. **metadata**: every byte that is not a data object.
* **bound as worded**: (1 + 1/α + *k*)·ΣΔ + *B*₀ + Σ*B*_forced with *B*₀ =
  commit 0's image + snapshot. **bound, full B₀**: the same with ΣΔ = every
  commit after 0 (checkpoint commits' own records included) and *B*₀ = all of
  commit 0's metadata, as B.2.3 now defines them. **✗** marks a violated bound.
* **k**: (*B*ᵢ − *B*ᵢ₋₁)/Δᵢ per triggered interval; "–" when the trigger
  never fired after commit 0.
* **replay limit**: α·max(*B*, *F*) at the base plus that commit's own
  metadata, B.2.3's replay claim.

### Results (α = 1, *F* = 1 MiB)

Workloads: **growing catalog** (one new file per commit); **repeated
updates** (100 files at commit 0, then one rewritten per commit);
**tiny commits** (empty transactions); **large import** (10,000 files and
their directories at commit 0, then one new file per commit); **forced**
(growing catalog with `request_checkpoint` every N/10 commits).

#### growing catalog (one new file per commit)

| commits | checkpoints | ΣΔ KiB | final B KiB | metadata MiB | bound as worded MiB | bound, full B₀ MiB | data MiB | k max | k median | longest replay (deltas) | longest replay KiB | replay limit KiB | open head ms | open longest-replay ms | write s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 1 | 6.8 | 44.5 | 0.051 | 0.057 | 0.058 | 0.00 | – | – | 9 | 6.8 | 1024.8 | 0.9 | 1.0 | 0.0 |
| 100 | 1 | 76.0 | 44.5 | 0.118 | 0.192 | 0.193 | 0.03 | – | – | 99 | 76.0 | 1024.8 | 6.2 | 6.2 | 0.1 |
| 1000 | 1 | 772.4 | 44.5 | 0.798 | 1.552 | 1.553 | 0.26 | – | – | 999 | 772.4 | 1024.8 | 61.2 | 62.4 | 5.6 |
| 10000 | 5 | 7772.5 | 7234.2 | 21.244 | 22.327 | 22.338 | 2.57 | 0.94 | 0.93 | 4823 | 3753.7 | 3754.0 | 325.6 | 507.3 | 556.7 |

#### repeated updates (100 files, one rewritten per commit)

| commits | checkpoints | ΣΔ KiB | final B KiB | metadata MiB | bound as worded MiB | bound, full B₀ MiB | data MiB | k max | k median | longest replay (deltas) | longest replay KiB | replay limit KiB | open head ms | open longest-replay ms | write s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 1 | 6.9 | 118.0 | 0.152 | 0.129 **✗** | 0.158 | 0.03 | – | – | 9 | 6.9 | 1024.8 | 3.1 | 3.0 | 0.0 |
| 100 | 1 | 76.1 | 118.0 | 0.219 | 0.264 | 0.294 | 0.05 | – | – | 99 | 76.1 | 1024.8 | 8.4 | 8.1 | 0.1 |
| 1000 | 1 | 771.5 | 118.0 | 0.898 | 1.622 | 1.652 | 0.28 | – | – | 999 | 771.5 | 1024.8 | 68.7 | 67.7 | 5.4 |
| 10000 | 5 | 7746.0 | 2882.2 | 14.194 | 19.336 | 19.374 | 2.60 | 0.54 | 0.54 | 3368 | 2611.4 | 2883.0 | 448.4 | 445.8 | 495.3 |

#### tiny commits (empty transactions)

| commits | checkpoints | ΣΔ KiB | final B KiB | metadata MiB | bound as worded MiB | bound, full B₀ MiB | data MiB | k max | k median | longest replay (deltas) | longest replay KiB | replay limit KiB | open head ms | open longest-replay ms | write s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 1 | 4.1 | 44.2 | 0.048 | 0.051 | 0.052 | 0.00 | – | – | 9 | 4.1 | 1024.5 | 0.4 | 0.4 | 0.0 |
| 100 | 1 | 45.8 | 44.2 | 0.088 | 0.133 | 0.133 | 0.00 | – | – | 99 | 45.8 | 1024.5 | 1.3 | 1.3 | 0.1 |
| 1000 | 1 | 467.0 | 44.2 | 0.500 | 0.955 | 0.956 | 0.00 | – | – | 999 | 467.0 | 1024.5 | 10.2 | 10.1 | 3.5 |
| 10000 | 5 | 4714.4 | 132.2 | 5.037 | 9.359 | 9.363 | 0.00 | 0.02 | 0.02 | 2188 | 1024.4 | 1024.5 | 90.2 | 22.6 | 330.0 |

#### large import (10,000 files at commit 0, then one file per commit)

| commits | checkpoints | ΣΔ KiB | final B KiB | metadata MiB | bound as worded MiB | bound, full B₀ MiB | data MiB | k max | k median | longest replay (deltas) | longest replay KiB | replay limit KiB | open head ms | open longest-replay ms | write s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 1 | 6.9 | 7389.1 | 10.304 | 7.229 **✗** | 10.311 | 2.58 | – | – | 9 | 6.9 | 7389.9 | 221.9 | 218.9 | 2.7 |
| 100 | 1 | 76.7 | 7389.1 | 10.372 | 7.366 **✗** | 10.447 | 2.60 | – | – | 99 | 76.7 | 7389.9 | 235.7 | 240.4 | 6.3 |
| 1000 | 1 | 778.4 | 7389.1 | 11.057 | 8.736 **✗** | 11.818 | 2.83 | – | – | 999 | 778.4 | 7389.9 | 298.6 | 287.4 | 47.4 |
| 10000 | 2 | 7800.7 | 14282.8 | 31.864 | 29.559 **✗** | 32.642 | 5.15 | 0.93 | 0.93 | 9472 | 7389.3 | 7389.9 | 585.7 | 965.4 | 1016.3 |

#### forced checkpoints (growing catalog, `checkpoint` every N/10 commits)

| commits | checkpoints | ΣΔ KiB | final B KiB | metadata MiB | bound as worded MiB | bound, full B₀ MiB | data MiB | k max | k median | longest replay (deltas) | longest replay KiB | replay limit KiB | open head ms | open longest-replay ms | write s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 10 | 0.0 | 47.2 | 0.455 | 0.447 **✗** | 0.463 | 0.00 | – | – | 0 | 0.0 | 0.0 | 0.6 | 0.3 | 0.0 |
| 100 | 10 | 69.4 | 111.7 | 0.791 | 0.851 | 0.866 | 0.03 | – | – | 9 | 7.0 | 1024.8 | 4.7 | 2.5 | 0.2 |
| 1000 | 10 | 768.7 | 701.7 | 4.445 | 5.188 | 5.203 | 0.26 | – | – | 99 | 77.1 | 1024.8 | 34.3 | 15.4 | 6.3 |
| 10000 | 10 | 7769.9 | 6537.5 | 39.769 | 47.349 | 47.364 | 2.57 | – | – | 999 | 777.5 | 1024.8 | 363.2 | 97.9 | 562.1 |

### α sensitivity (growing catalog)

#### α = 1/2

| commits | checkpoints | ΣΔ KiB | final B KiB | metadata MiB | bound as worded MiB | bound, full B₀ MiB | data MiB | k max | k median | longest replay (deltas) | longest replay KiB | replay limit KiB | open head ms | open longest-replay ms | write s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| commits | checkpoints | ΣΔ KiB | final B KiB | metadata MiB | bound as worded MiB | bound, full B₀ MiB | data MiB | k max | k median | longest replay (deltas) | longest replay KiB | replay limit KiB | open head ms | open longest-replay ms | write s |
| 10 | 1 | 6.8 | 44.5 | 0.051 | 0.063 | 0.064 | 0.00 | – | – | 9 | 6.8 | 512.8 | 0.9 | 1.0 | 0.0 |
| 100 | 1 | 76.0 | 44.5 | 0.118 | 0.266 | 0.267 | 0.03 | – | – | 99 | 76.0 | 512.8 | 6.6 | 6.3 | 0.1 |
| 1000 | 2 | 772.9 | 530.1 | 1.317 | 3.024 | 3.027 | 0.26 | 0.95 | 0.95 | 663 | 512.2 | 512.8 | 42.8 | 40.5 | 5.7 |
| 10000 | 8 | 7772.8 | 6793.3 | 26.946 | 30.083 | 30.106 | 2.57 | 0.96 | 0.93 | 2983 | 2321.6 | 2322.4 | 351.0 | 428.0 | 556.5 |

#### α = 2

| commits | checkpoints | ΣΔ KiB | final B KiB | metadata MiB | bound as worded MiB | bound, full B₀ MiB | data MiB | k max | k median | longest replay (deltas) | longest replay KiB | replay limit KiB | open head ms | open longest-replay ms | write s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| commits | checkpoints | ΣΔ KiB | final B KiB | metadata MiB | bound as worded MiB | bound, full B₀ MiB | data MiB | k max | k median | longest replay (deltas) | longest replay KiB | replay limit KiB | open head ms | open longest-replay ms | write s |
| 10 | 1 | 6.8 | 44.5 | 0.051 | 0.053 | 0.054 | 0.00 | – | – | 9 | 6.8 | 2048.8 | 0.9 | 0.9 | 0.0 |
| 100 | 1 | 76.0 | 44.5 | 0.118 | 0.155 | 0.156 | 0.03 | – | – | 99 | 76.0 | 2048.8 | 6.0 | 6.0 | 0.1 |
| 1000 | 1 | 772.4 | 44.5 | 0.798 | 1.175 | 1.176 | 0.26 | – | – | 999 | 772.4 | 2048.8 | 64.7 | 63.6 | 5.6 |
| 10000 | 3 | 7768.9 | 5565.6 | 14.971 | 18.475 | 18.480 | 2.57 | 0.93 | 0.93 | 5008 | 3897.6 | 3897.9 | 422.7 | 452.4 | 556.9 |

### Findings

1. **The trigger behaves as B.2.3 says.** In every row the longest replay is
   below its limit, α·max(*B*, *F*) plus one commit; at 10,000 commits it
   lands within a few hundred bytes of it (growing: 3,753.7 of 3,754.0 KiB;
   tiny: 1,024.4 of 1,024.5 KiB; import: 7,389.3 of 7,389.9 KiB), which is
   the trigger firing on the first commit that reaches the threshold. No
   commit is skipped and none fires early.
2. **The storage bound holds once its terms are defined (B.2.3 amended).**
   With *B*₀ = all of commit 0's metadata and ΣΔ over every commit after 0,
   no row violates it. As worded before, it failed for every size of the
   large import and for small runs of the repeated-updates and forced
   workloads, because commit 0's own delta manifest (3.6 MiB for the
   10,000-file import) is outside both terms.
3. ***k* is below 1** on every workload: 0.93 to 0.96 (growing catalog,
   large import), 0.54 (repeated updates), 0.02 (tiny commits). A checkpoint
   costs at most about one interval's Δ more than its base, so the bound's
   coefficient 1 + 1/α + *k* is about 2.9 at α = 1. Measured metadata at
   10,000 commits is 2.8× ΣΔ for the growing catalog and 1.1× for tiny
   commits. These are estimates over these workloads, not a proof (B.2.3
   "Evidence, not proof").
4. **Open time = base open + replay.** Replay costs about 10 µs (empty
   deltas) to 60 µs (one-file deltas) per delta in memory (1,000 deltas:
   61 ms growing, 10 ms tiny). Base open grows
   with the catalog: 220 ms for the 7 MiB image of the 10,000-file import,
   rising to 586 ms at its head with a 14 MiB base. The worst open measured
   is 965 ms (import, 9,472 deltas on a 7 MiB base). Opening a delta head is
   never worse than base open plus the bounded replay.
5. **Forced checkpoints cost Σ*B*_forced, as the bound says.** Ten forced
   checkpoints in 10,000 commits of a growing catalog: 39.8 MiB of metadata
   against 21.2 MiB without them, and the longest replay drops from 4,823 to
   999 deltas.
6. **Writer cost per commit grows with the catalog** (found here, not a
   format property): 10,000 commits took 557 s for the growing catalog
   (5.6 s for the first 1,000), 1,016 s for the large import. Every commit,
   delta or checkpoint, copies the writer's in-memory catalog before applying
   the transaction (the C5 "head catalog copy" phase). Recorded for C6 as a
   writer optimization; it does not affect the archive or the bound.

### Decision: α and *F*

| α | checkpoints | metadata | longest replay | head open | worst open |
|---:|---:|---:|---:|---:|---:|
| 1/2 | 8 | 26.9 MiB | 2,983 deltas, 2.3 MiB | 351 ms | 428 ms |
| **1** | **5** | **21.2 MiB** | **4,823 deltas, 3.8 MiB** | **326 ms** | **507 ms** |
| 2 | 3 | 15.0 MiB | 5,008 deltas, 3.9 MiB | 423 ms | 452 ms |

(Growing catalog, 10,000 commits. Open times are medians of 5 on a shared
machine; differences under about 100 ms are within noise here.)

**α = 1 and *F* = 1 MiB are confirmed, not revised.** Halving α costs 27%
more metadata for about 80 ms on the worst open; doubling it saves 30% of
metadata, and the measured worst open does not move beyond noise, but the
replay *guarantee* doubles to 2·max(*B*, *F*), which is what a user with a
large base would feel (estimated from twice the replay: the import's worst open would rise
toward 1.4 s).
α = 1 keeps checkpoint storage at most equal to delta storage (1/α = 1) and
replay at most one base's worth. *F* = 1 MiB only decides while *B* < *F*
(small catalogs): there the worst replay is about 2,200 empty deltas and
under 100 ms (tiny commits: 90 ms head, 22.6 ms longest replay), so a
smaller floor would add checkpoints without a visible gain. Both stay
configurable (`WriterOptions::checkpoint_trigger`); α = 2 is a reasonable
choice for storage-constrained archives.

<a id="append"></a>

## Append cost versus prior commits (before checkpoints)

Two record sets: **schema 1** (plan T8/T9, current) and the original
**schema 0** run, kept below for comparison. Same dataset, settings, and VM.

**Since T14 (2026-10-05)** the production writer makes a commit a checkpoint
only when the Annex B.2.3 trigger fires. Every table here measures a
checkpoint on **every** commit, and the example now selects that policy
explicitly, so these numbers stay reproducible. The trigger's own
measurements belong to T32 (gate G3).

Plan C5 exit criterion; reported per spec §27. Reproduce with
`cargo run --release -p mochi-testkit --example c5_append_bench [dir]`.

### Setup (§27 required statements)

| Item | Value |
|---|---|
| Dataset | Commit 0 creates directory `d`; each later commit adds one new 4 KiB pseudo-random (incompressible) file under it. History and catalog both grow linearly with N. |
| Hardware | Sandbox VM: 1 vCPU, Intel Xeon @ 2.80 GHz, 3 GiB RAM, ext4 on a virtio disk (`/dev/vda`), kernel 6.18. **Not representative hardware**: see the sync caveat below. |
| Cache state | Warm: the archive was just written by the same process. |
| Chunking | Fixed-size, 8 MiB maximum (product default, spec §13); each 4 KiB file is one chunk. |
| Compression | Zstandard level 3 (data is incompressible, so near-raw frames). |
| Encryption | None (Core profile). |
| Verification level | Opening = footer validation, commit decode, manifest and checkpoint stored-object hash, full SQLite + MOCHI catalog verification including namespace replay. No content-object verification. |
| Build | `--release`, Rust 1.91.1, bundled SQLite (rusqlite 0.40). |
| Measurement | Median of 7 appends per row; each append is a fresh writer session (open, commit, close), as one CLI invocation would be. |

### Results, schema 1 (plan T8/T9; milliseconds)

Every commit is still a checkpoint, and now binds three objects (D10.2):
delta manifest, **snapshot manifest**, catalog image. Columns changed:
*snapshot manifest KiB* is new; *checkpoint (snapshot + image)* now covers
building the snapshot from the catalog, encoding, hashing, and writing it, as
well as the image; *append open* is new and times `open_append`, which,
unlike `open_head`, also reads and decodes the head's snapshot manifest (the
writer needs its promised attributes). Second of two runs; the first run's
N=100 row was 2× slower in open and checkpoint and is treated as VM noise.
Run-to-run variation on this 1-vCPU VM is roughly 10–20% on the larger rows.

| prior commits | archive MiB | catalog image KiB | snapshot manifest KiB | footer lookup | open (verify + catalog) | append open (+ snapshot read) | head catalog copy + replay | content | catalog update | delta manifest | checkpoint (snapshot + image) | commit record | sync objects | footer + sync | **append total** (ms) |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 0.4 | 44 | 2 | 0.02 | 0.93 | 0.97 | 0.34 | 0.32 | 0.13 | 0.02 | 1.80 | 0.02 | 0.68 | 0.35 | **4.64** |
| 10 | 0.8 | 44 | 5 | 0.02 | 1.65 | 1.43 | 0.43 | 0.34 | 0.27 | 0.02 | 2.95 | 0.02 | 0.73 | 0.34 | **6.52** |
| 100 | 8.8 | 100 | 30 | 0.01 | 3.97 | 4.31 | 0.94 | 0.32 | 0.70 | 0.02 | 8.09 | 0.06 | 0.68 | 0.27 | **15.32** |
| 1000 | 403.2 | 472 | 287 | 0.01 | 44.20 | 41.13 | 6.99 | 0.55 | 7.12 | 0.05 | 86.16 | 0.26 | 1.44 | 0.49 | **145.29** |

**T10 note (not re-run).** T10 adds an 80-byte envelope header per image
and an additional image-sized copy in the current implementation (envelope
body, then frame). Performance and peak-memory impact were not remeasured;
evaluation is deferred to T14/G3. The storage increase (80 bytes per image)
is established; the runtime and memory effect of the extra copy is not, and
near the 268,434,864-byte image budget that copy is a buffer of the same size.

#### What changed against schema 0

* **Append total at N=1000: 85 → 135–145 ms** (+60–70%, two runs). Almost
  all of it is the checkpoint phase (33 → 76–86 ms): a snapshot manifest is
  built from the catalog and written on every commit.
* **Archive size at N=1000: 262 → 403 MiB** (+54%). Each commit now stores
  the image (472 KiB) *and* a snapshot (287 KiB), so the quadratic growth
  noted below is steeper by the snapshot's share. This is the full-checkpoint
  writer by design until the checkpoint trigger (plan T14) makes most commits
  deltas; G3 is where that is measured.
* **Reading the head snapshot on append is not a significant term**: append
  open (41 ms) is within noise of `open_head` (44 ms), which does not read it.
* Snapshot size per file: 287 KiB / 1001 entries ≈ 294 bytes for a
  single-chunk file with *no* attributes and a 9-byte path. B.2.4 estimates
  318 bytes with POSIX attributes and a 22-byte path, which is consistent but
  **not** a G5 measurement: G5 needs the item count and attributed files.
* Unchanged: footer lookup constant; content constant per byte; open linear
  in catalog size.

### Results, schema 1 with adoption (plan T15, 2026-10-05; milliseconds)

Annex B.2 D10.7 and §18.1 require the writer to re-read both checkpoint
representations before publishing and compare each with the source state.
Adoption is mandatory and has no opt-out. It re-reads the snapshot manifest
and the image from storage, hash-verifies them, decodes the snapshot without
SQLite, and opens the image **exactly as a reader does** (SQLite integrity
check, foreign keys, every version's extents, full namespace replay). Its own
progress phase, `adopt`, sits between `checkpoint` and `commit-record`, so
the *checkpoint* column below is the same quantity as in the schema 1 table
above and *adopt* is new.

#### Setup (§27)

| Item | Value |
|---|---|
| Dataset, chunking, compression, encryption, build, measurement | As the schema 1 setup above (4 KiB incompressible files, one commit each; fixed-size chunks; zstd 3; Core profile; `--release`; median of 7 fresh writer sessions per row). |
| Hardware | **Different from the earlier runs:** sandbox VM, 4 vCPU, Intel Xeon @ 2.10 GHz, 15 GiB RAM, ext4 on a virtio disk, kernel 6.18. The earlier tables ran on a 1-vCPU 2.80 GHz VM. **Absolute times are not comparable across the two machines**; the within-run *adopt / checkpoint* ratio is. |
| Cache state | Warm (the archive was just written by the same process). |
| Run | One clean run (an earlier attempt had two copies running at once and was discarded). Not repeated; run-to-run variation on these VMs is 10 to 20%. |

| prior commits | archive MiB | catalog image KiB | snapshot manifest KiB | footer lookup | open (verify + catalog) | append open (+ snapshot read) | head catalog copy + replay | content | catalog update | delta manifest | checkpoint (snapshot + image) | adopt (re-read + compare) | adopt / checkpoint | commit record | sync objects | footer + sync | **append total** (ms) |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 0.4 | 44 | 2 | 0.01 | 0.75 | 0.83 | 0.26 | 0.23 | 0.09 | 0.02 | 1.46 | 0.95 | 0.65 | 0.03 | 0.51 | 0.21 | **4.55** |
| 10 | 0.8 | 44 | 5 | 0.01 | 0.80 | 0.90 | 0.21 | 0.18 | 0.11 | 0.01 | 1.92 | 1.22 | 0.64 | 0.02 | 0.60 | 0.18 | **5.53** |
| 100 | 8.8 | 100 | 30 | 0.01 | 3.58 | 4.34 | 0.75 | 0.18 | 0.63 | 0.01 | 10.60 | 7.27 | 0.69 | 0.03 | 0.78 | 0.28 | **24.98** |
| 1000 | 403.3 | 472 | 287 | 0.01 | 29.62 | 38.28 | 5.88 | 0.33 | 5.44 | 0.02 | 93.54 | 63.49 | 0.68 | 0.18 | 1.51 | 0.47 | **207.10** |

#### What this shows

* **Adoption costs about two thirds of the checkpoint phase at every size**
  (ratio 0.64 to 0.69, flat from N=1 to N=1000). It grows linearly with the
  catalog, like the checkpoint and the open, because it is the same work in
  the other direction: decode the snapshot, open and verify the image.
* **Share of the append:** with adoption removed, the same rows total about
  3.6, 4.3, 17.7, and 143.6 ms, so adoption adds roughly 26%, 28%, 41%, and
  44% (N = 1, 10, 100, 1000). At N=1000 the 143.6 ms agrees with the earlier
  schema 1 run (145 ms) although the hardware differs; treat that agreement as
  loose, not as a controlled comparison.
* **Not 10× the checkpoint phase at any N**, so the plan's stop-and-ask
  condition did not trigger.
* **Why it is kept as it is.** Adoption is required by §18.1 and D10.7; the
  full reader open is the point (it proves a reader can open what is about to
  be published). It is paid per checkpoint, and until the T14 trigger
  (Δ ≥ α·max(*B*, *F*)) every commit is a checkpoint. T14 makes checkpoints
  rare and so bounds this cost by design; the cost belongs to G3's inputs,
  not to a reason to weaken the check.
* Unchanged: footer lookup constant, content constant per byte, archive size
  as before (adoption writes nothing).

### Results, schema 0 (C5 original; milliseconds)

| prior commits | archive MiB | catalog image KiB | footer lookup | open (verify + catalog) | head catalog copy + replay | content | catalog update | manifest | checkpoint publish | commit record | sync objects | footer + sync | **append total** (ms) |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 0.4 | 44 | 0.01 | 0.64 | 0.22 | 0.20 | 0.08 | 0.01 | 0.83 | 0.01 | 0.37 | 0.20 | **2.56** |
| 10 | 0.8 | 44 | 0.01 | 0.82 | 0.24 | 0.21 | 0.13 | 0.01 | 1.14 | 0.01 | 0.48 | 0.27 | **3.27** |
| 100 | 7.2 | 100 | 0.01 | 3.86 | 0.78 | 0.23 | 0.73 | 0.02 | 4.07 | 0.02 | 0.51 | 0.20 | **10.26** |
| 1000 | 261.9 | 472 | 0.01 | 35.81 | 6.60 | 0.40 | 6.65 | 0.03 | 32.68 | 0.08 | 1.32 | 0.39 | **84.68** |

Columns, in §27 terms: *footer lookup* is §27 "footer lookup"; *open* is
"catalog opening" plus "metadata replay" (verification replays the whole
namespace); *head catalog copy + replay* and *catalog update* are metadata
replay and dependency checks inside the commit; *checkpoint publish* is
serializing the full catalog image (VACUUM + serialize + hash + write);
*sync* columns are the §12.2 step 6 and step 8 flushes.

### What this shows

* **Footer lookup is constant** (0.01 ms at every size), as §27 allows.
* **Content cost is constant per byte** (0.2–0.4 ms for one 4 KiB file).
* **Everything metadata-shaped is linear in catalog size**: open/verify,
  the head-catalog copy and replay, the namespace check, and above all the
  full checkpoint publish. Append total grows 33× from N=1 to N=1000.
* **Archive size grows roughly quadratically.** 1000 commits holding about
  4 MiB of file data produce a **262 MiB** archive, because every commit
  stores a complete catalog image (472 KiB at the end). This is the direct
  cost of the C5 choice to write a checkpoint on every commit, because the
  spec does not define a metadata delta (plan §9, **O26**). It is not
  acceptable for a release; it is the strongest reason to settle O26 before
  C6, and a checkpoint interval (§18.1) will be needed once deltas exist.
* Opening also replays the whole namespace on every open (the C3 note:
  "C6 caches it"). That is the second linear term.

### Caveat on sync timings

0.2–1.3 ms per `fdatasync` is faster than most physical devices. Virtio
disks in this kind of VM commonly acknowledge flushes from a host cache, so
these numbers show protocol overhead, not device durability latency. Real
numbers need the CI runners named in plan O11 (Ubuntu and Windows), on local
disks, reported with the same table.

<a id="capacity-memory"></a>

## Capacity and memory

Spec Annex B.2.4 (capacity) and B.2.3 (the resource rows "Catalog memory"
and "Decoded-CBOR memory"); gates G4 and G5 (B.2.6). Measured from the MOCHI
writer and codec, replacing B.2.4's estimates, which came from a
general-purpose CBOR library. Reproduce with
`cargo run --release -p mochi-testkit --example t32_capacity`.

### Setup (§27 required statements)

| Item | Value |
|---|---|
| Dataset | One commit (commit 0) importing N files into one directory: each file single-chunk, 64 bytes of pseudo-random data, POSIX attributes (mode, uid, gid, mtime with nanoseconds), path exactly 22 bytes (`dir00/file-NNNNNNNNNNN`), the shape B.2.4's estimate assumed. N = 1,000, 4,000, 16,000. Multi-chunk: 1,000 files of 1, 2, and 5 chunks. |
| Hardware | Cloud container: 4 vCPU Intel Xeon @ 2.10 GHz, 15 GiB RAM, kernel 6.18. |
| Storage, cache | In memory (`SimStorage`); warm. |
| Chunking | Fixed-size, 64-byte chunks (so a file's chunk count is set exactly). |
| Compression | Zstandard level 3. |
| Encryption | None (Core profile). |
| Verification level | Opening the head = footer, commit, descriptor, delta manifest, and image stored-object hashes, envelope binding, SQLite integrity and MOCHI catalog verification. Snapshot decode = stored-object hash, canonical-CBOR decode, schema and identity checks. |
| Build | `--release`, Rust 1.91.1, bundled SQLite (libsqlite3-sys 0.38.2), zstd 1.5.7. |
| Item counting | Every CBOR data item, map keys included, as `CborLimits::max_items` counts them (T4). |
| Memory | A counting global allocator in the example: peak heap growth above the level at the start of the measured call. |

### Capacity (G5)

| files | snapshot bytes | snapshot items | image bytes |
|---:|---:|---:|---:|
| 1,000 | 320,446 | 49,048 | 475,224 |
| 4,000 | 1,286,323 | 196,048 | 1,769,560 |
| 16,000 | 5,149,831 | 784,048 | 6,873,176 |

Per file (slope from 1,000 to 16,000 files): **322.0 snapshot bytes, 49.00
items, 426.5 image bytes.** The item count is exact (49 per file plus 48
fixed); bytes vary with varint widths.

Files at each reader-default limit, from those slopes:

| limit | value | files | B.2.4 estimate |
|---|---:|---:|---:|
| CBOR items per record | 16 Mi (16,777,216) | **342,391** | about 340,000 |
| Skippable payload (snapshot) | 268,435,456 bytes | 833,761 | about 840,000 |
| Image budget | 268,434,864 bytes | 629,231 | roughly 600,000 |

**The item limit binds first**, at about 342,000 files of this shape, as
B.2.4 said. Every estimate is within 5% of the measurement.

#### Multi-chunk files (1,000 files)

| chunks per file | snapshot bytes | snapshot items | image bytes |
|---:|---:|---:|---:|
| 1 | 320,446 | 49,048 | 475,224 |
| 2 | 484,446 | 73,048 | 749,656 |
| 5 | 978,446 | 145,048 | 1,605,720 |

Per extra chunk: **24.00 items, 164.5 snapshot bytes, 282.6 image bytes**
(B.2.4 estimated about 25 items). A file of *c* chunks costs 49 + 24(*c* − 1)
items, so with large files the item limit binds sooner: at 8 MiB chunks, a
store of 1 GiB files (128 chunks each) reaches 16 Mi items at about 5,400
files.

### Memory (G4)

| files | snapshot decode peak | per decoded item | per stored byte | head open peak | per image byte |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 2,443,123 B | 49.8 B | 7.62 | 2,463,500 B | 5.18 |
| 4,000 | 9,773,096 B | 49.9 B | 7.60 | 9,854,873 B | 5.57 |
| 16,000 | 39,090,988 B | 49.9 B | 7.59 | 39,420,365 B | 5.74 |

* **Decoded-CBOR memory: about 50 bytes per item, 7.6× the stored size.**
  The format does not bound it (B.2.3); the item limit does. At the default
  16 Mi items, one snapshot decode peaks near **800 MiB**.
* **Catalog memory: about 5.2 to 5.7× the image size, rising slowly with
  size**, not "≈ image size" as the B.2.3 table says. The open holds the
  stored image, SQLite's in-memory copy, and verification's working set at
  once. At the full image budget (256 MiB) that extrapolates to about
  **1.5 GiB**.

These are peaks for one operation in a process that holds nothing else
large. They are the inputs B.2.3's "measured (G4)" rows asked for, not
limits.

### What changes in the spec (recorded in the checklist, Q49–Q51)

* B.2.4's figures are replaced by these measurements, and its "unmeasured"
  label is removed.
* B.2.3's "Catalog memory ≈ image size" is replaced by the measured ratio.

<a id="read"></a>

## Read path, decomposed

Plan C6 exit: "Benchmarks per §27: footer lookup, catalog open, replay,
selected-file read — each reported separately, with dataset, hardware, and
cache state." Measured 2026-10-06. Reproduce with

```text
cargo run --release -p mochi-testkit --example c6_read_bench [dir]          # warm
sudo cargo run --release -p mochi-testkit --example c6_read_bench [dir] --cold
```

### Setup (§27 required statements)

| Item | Value |
|---|---|
| Dataset | One archive, 73,299,098 bytes, one replay segment. Commit 0 (checkpoint): directory `small/` with 1,000 files of 4 KiB, plus `large.bin`, 64 MiB; all pseudo-random (incompressible), POSIX attributes. Then 200 delta commits, one new 4 KiB file each. Base image 467,032 bytes; 1,201 files at the head. |
| Writer | Production defaults: checkpoint trigger α = 1, *F* = 1 MiB (the 200 deltas stay in commit 0's segment, so opening the head replays all 200). |
| Hardware | Cloud VM container: 4 vCPU Intel Xeon @ 2.10 GHz, 15 GiB RAM, kernel 6.18.44, ext4 on a virtio disk (`/dev/vda`). Single-threaded; nothing else running. |
| Storage | A real file read through `OsReadStorage` (positional reads, no `mmap`). |
| Cache state | **Warm:** one discarded warm-up, then 7 samples. **Cold:** `sync` and `drop_caches` (guest page cache) before each of 7 samples, and again between opening and reading for file reads. The host's cache below the VM is not controlled, so "cold" is guest-cold only. |
| Chunking | Fixed-size, 8 MiB maximum (product default): `large.bin` is 8 chunks; each small file is 1. |
| Compression | Zstandard level 3 (product default), checksum on. |
| Encryption | None (Core profile). |
| Verification level | Opening: footer; commit record, descriptor, delta manifest, and catalog image each hash-verified (stored-object hash) before parsing; envelope binding; SQLite integrity and MOCHI catalog checks on the base image; every replayed delta decoded, identity-bound, linked, and applied under D10.4. File read: every chunk checked as stored and decoded bytes, plus the whole-file content hash. |
| Build | `--release`, Rust 1.91.1, bundled SQLite (libsqlite3-sys 0.38.2), zstd 1.5.7. |
| Statistic | Median of 7, with minimum and maximum. |

What each row covers (all public API; see the example's header):

* **footer lookup** — `publish::locate_head`: the footer at end of file is
  validated. The tail is clean, so there is no scan.
* **catalog open** — `publish::open_at_footer` at the base checkpoint:
  commit record, descriptor, and delta manifest read and verified; the
  catalog image read, verified, deserialized into SQLite, and checked. No
  replay.
* **metadata replay** — **derived**, not timed alone: `open_head` minus
  catalog open minus footer lookup (medians). The public API has no
  replay-only entry point.
* **selected-file read** — `read::read_file` of one file into a sink, the
  head already open (not timed).

### Results

#### Warm

| measurement | median ms | min ms | max ms | covers |
|---|---:|---:|---:|---|
| footer lookup | 0.003 | 0.003 | 0.003 | `locate_head`: footer at EOF validated |
| catalog open | 27.334 | 25.815 | 27.748 | `open_at_footer` at the base checkpoint, no replay |
| (open head) | 41.901 | 40.681 | 43.340 | `open_head`: lookup + base open + replay |
| metadata replay | 14.564 | – | – | derived: open head − catalog open − footer lookup (medians), 200 deltas |
| selected-file read, 4 KiB | 2.682 | 2.618 | 2.918 | `read_file` to a sink, verified |
| selected-file read, 64 MiB | 89.565 | 84.379 | 96.680 | `read_file` to a sink, verified; 715 MiB/s at the median |

#### Cold (guest page cache dropped)

| measurement | median ms | min ms | max ms | covers |
|---|---:|---:|---:|---|
| footer lookup | 0.233 | 0.174 | 18.362 | `locate_head`: footer at EOF validated |
| catalog open | 26.904 | 25.881 | 28.372 | `open_at_footer` at the base checkpoint, no replay |
| (open head) | 51.228 | 49.547 | 53.790 | `open_head`: lookup + base open + replay |
| metadata replay | 24.092 | – | – | derived: open head − catalog open − footer lookup (medians), 200 deltas |
| selected-file read, 4 KiB | 3.085 | 2.885 | 4.455 | `read_file` to a sink, verified |
| selected-file read, 64 MiB | 96.995 | 94.812 | 224.221 | `read_file` to a sink, verified; 660 MiB/s at the median |

### Reading the numbers

* **Footer lookup is constant-time and negligible** (3 µs warm; 0.2 ms
  cold median, one 72-byte read; one cold sample took 18 ms). §27: "A
  footer seek may be constant-time."
* **Opening is dominated by the catalog, not the footer.** Catalog open
  (~27 ms for a 456 KiB image) costs the same warm and cold here, which
  suggests it is CPU-bound (verification, SQLite deserialization and
  checks) rather than I/O-bound; not profiled.
* **Replay of 200 deltas** adds ~15 ms warm, ~24 ms cold (each delta is a
  separate small read). It grows with the segment, which the checkpoint
  trigger bounds (T32: `t32-scaling.md`). §27: "Opening an archive with an
  unbounded metadata chain is not necessarily constant-time"; this one is
  bounded by B.2.3.
* **Selected-file read** costs ~2.7 ms for 4 KiB (dominated by catalog
  queries and per-file setup) and ~90 ms for 64 MiB (~700 MiB/s, warm),
  which is proportional to the content produced, as §27 says it must be at
  least. Cold reads are ~10% slower; one cold 64 MiB sample took 224 ms
  (host-side cache miss, presumably; not controlled).
* **Not measured here**, because C6 does not claim them: dependency lookup
  and decryption (C9, C11), search (C13), full verification and restoration
  (C7). Restore to a directory adds directory and file creation and syncs
  on top of selected-file read.

<a id="parity"></a>

## Recovery record (Redundancy profile) cost

Plan W14 and K15 items 3 and 5; reported per spec §27. Annex B.2.11 item 10 says "no speed
is claimed"; this file is the measurement that closes R6 open item 5 before the freeze. It
measures what a recovery record costs to **write**, to **verify**, and to **rebuild
with**, and quantifies the hash-table overhead (R6 §9 item 3). Reproduce with

```text
cargo run --release -p mochi-testkit --example c12_parity_bench [dir] [--quick]
```

`--quick` drops the 512 MiB rows. The example asserts, for every write row, that the bytes
between the commit frame and its footer equal the layout rule's prediction (frames ×
frame length), and for every rebuild row that each damaged shard of the healed view equals
the pristine file byte for byte. The tables below are that program's output, unedited,
from the second of two full runs on the same VM (the first lacked only the "parity frames
as % of the commit" column); the first run's numbers are cited where the two differ.

### Setup (§27 required statements)

| Item | Value |
|---|---|
| Dataset | One commit holding a single file of 100 KiB, 4 MiB, 64 MiB, or 512 MiB of deterministic pseudo-random bytes (incompressible: Zstandard level 3 emits near-raw frames, so stored size is decoded size plus framing). The file is the archive's only content, so the protected range is the descriptor plus that commit's objects (commit 0). |
| Hardware | Sandbox VM, **not representative hardware**: 4 vCPU Intel Xeon @ 2.10 GHz (AVX2 present, unused), 16 GiB RAM, ext4 on a virtio disk (`/dev/vda`), kernel 6.18.44. The benchmark is single-threaded. Real `fdatasync`; a virtual disk's sync latency is not a physical disk's. |
| Cache state | **Write:** warm (the file was just created; the parity phase reads the range back from the page cache). **Verify and rebuild:** *cold* = page cache dropped first (`/proc/sys/vm/drop_caches`, which was permitted in this run), *warm* = the archive was just read by the same process. |
| Chunking | Fixed-size, 8 MiB maximum (product default, spec §13). |
| Compression | Zstandard level 3. |
| Encryption | **Off** (Core profile plus the Redundancy profile). Encrypted archives were **not** measured. |
| Verification level | `stored_integrity`: every data object's stored bytes (length and stored-object hash) and, with a recovery record, the parity check of B.2.11 item 12. Not deep; no freshness anchor. The table reports the Integrity dimension. |
| Build | `--release`, Rust 1.91.1, `main` at `17fe094` plus this change (the example). |
| Measurement | **Write:** wall time of `ArchiveWriter::commit` (objects, catalog and checkpoint, commit record, parity, syncs, footer). The **parity phase** runs from the writer's first `parity` progress event to its first `sync-content` event: reading the range back, hashing each data shard, the field arithmetic, encoding, and appending the frames, but not the sync. Median of 7 runs (100 KiB, 4 MiB), 5 (64 MiB), or 1 (512 MiB), after one unmeasured warm-up archive of the same size. **Verify:** median of 7 (4 MiB), 5 (64 MiB), or 3 (512 MiB) runs. **Rebuild:** one run per cache state. |
| Percentages | 0 (none), 1, 5, 10, 50, 100. The percentage is fixed at creation (B.2.11 item 11), so each is its own archive. |

### Write

*s* is the shard size, *G* the groups, *k* the data and *m* the parity shards per group,
*frames* = *G*·*m*. "Parity frames MiB" is measured as footer offset minus commit-frame end
and equals the layout rule's prediction exactly. "File growth" is the whole file against the
r = 0 archive; it also carries the descriptor's profile field and a catalog image that
differs by a few bytes to about a kilobyte, so it is not exactly the parity frames.
"Table share" is the data-shard hash tables' share of the parity frames' bytes (K15 item 3).
Times are milliseconds; throughput is MiB/s of the commit's range.

| commit | r % | s KiB | groups G | k | m | frames | whole commit ms | parity phase ms | parity MiB/s of commit | file MiB | file growth over r=0 MiB | parity frames MiB (measured = predicted) | parity frames as % of the commit | table share of parity bytes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 KiB | none | | | | | | 3.7 | | | 0.14 | 0 | 0 | | |
| 100 KiB | 1 | 16 | 1 | 10 | 1 | 1 | 3.6 | 0.2 | 477 | 0.16 | 0.02 | 0.02 | 11.4 % | 1.9 % |
| 100 KiB | 5 | 16 | 1 | 10 | 1 | 1 | 4.0 | 0.2 | 482 | 0.16 | 0.02 | 0.02 | 11.4 % | 1.9 % |
| 100 KiB | 10 | 16 | 1 | 10 | 1 | 1 | 3.3 | 0.2 | 567 | 0.16 | 0.02 | 0.02 | 11.4 % | 1.9 % |
| 100 KiB | 50 | 16 | 1 | 10 | 5 | 5 | 3.8 | 0.5 | 185 | 0.22 | 0.08 | 0.08 | 56.8 % | 1.9 % |
| 100 KiB | 100 | 16 | 1 | 10 | 10 | 10 | 4.6 | 0.9 | 113 | 0.30 | 0.16 | 0.16 | 113.6 % | 1.9 % |
| 4 MiB | none | | | | | | 18.2 | | | 4.04 | 0 | 0 | | |
| 4 MiB | 1 | 16 | 3 | 87 | 1 | 3 | 22.5 | 4.1 | 972 | 4.10 | 0.06 | 0.06 | 1.4 % | 14.4 % |
| 4 MiB | 5 | 16 | 3 | 87 | 5 | 15 | 30.5 | 11.2 | 358 | 4.32 | 0.28 | 0.28 | 6.8 % | 14.4 % |
| 4 MiB | 10 | 16 | 3 | 87 | 9 | 27 | 37.6 | 18.6 | 216 | 4.54 | 0.50 | 0.50 | 12.3 % | 14.4 % |
| 4 MiB | 50 | 16 | 3 | 87 | 44 | 132 | 110.0 | 82.6 | 48 | 6.48 | 2.44 | 2.44 | 60.2 % | 14.4 % |
| 4 MiB | 100 | 16 | 3 | 87 | 87 | 261 | 189.7 | 161.7 | 25 | 8.86 | 4.81 | 4.81 | 119.1 % | 14.4 % |
| 64 MiB | none | | | | | | 228.5 | | | 64.05 | 0 | 0 | | |
| 64 MiB | 1 | 64 | 8 | 128 | 2 | 16 | 538.5 | 83.5 | 766 | 65.11 | 1.07 | 1.07 | 1.7 % | 5.9 % |
| 64 MiB | 5 | 64 | 8 | 128 | 7 | 56 | 446.6 | 217.0 | 295 | 67.78 | 3.73 | 3.73 | 5.8 % | 5.9 % |
| 64 MiB | 10 | 64 | 8 | 128 | 13 | 104 | 594.1 | 366.9 | 174 | 70.98 | 6.93 | 6.93 | 10.8 % | 5.9 % |
| 64 MiB | 50 | 64 | 8 | 128 | 64 | 512 | 2183.8 | 1928.4 | 33 | 98.17 | 34.12 | 34.12 | 53.3 % | 5.9 % |
| 64 MiB | 100 | 64 | 8 | 128 | 128 | 1024 | 4003.5 | 3709.5 | 17 | 132.28 | 68.23 | 68.23 | 106.5 % | 5.9 % |
| 512 MiB | none | | | | | | 1849.0 | | | 512.10 | 0 | 0 | | |
| 512 MiB | 1 | 512 | 8 | 128 | 2 | 16 | 4799.8 | 678.2 | 755 | 520.17 | 8.07 | 8.07 | 1.6 % | 0.8 % |
| 512 MiB | 5 | 512 | 8 | 128 | 7 | 56 | 3519.6 | 1846.5 | 277 | 540.34 | 28.23 | 28.23 | 5.5 % | 0.8 % |
| 512 MiB | 10 | 512 | 8 | 128 | 13 | 104 | 5001.1 | 3242.0 | 158 | 564.54 | 52.44 | 52.44 | 10.2 % | 0.8 % |
| 512 MiB | 50 | 512 | 8 | 128 | 64 | 512 | 25448.9 | 20781.2 | 25 | 770.25 | 258.15 | 258.15 | 50.4 % | 0.8 % |
| 512 MiB | 100 | 512 | 8 | 128 | 128 | 1024 | 45759.2 | 43920.7 | 12 | 1028.40 | 516.30 | 516.30 | 100.8 % | 0.8 % |

#### Reading the write table

* **The parity phase is linear in *m* and in the commit's size.** Each data shard is
  multiplied into *m* parity shards, so the work is about *L*·*m* byte multiply-adds. In the
  64 MiB and 512 MiB rows that is about **1.4 to 2.2 GiB/s of multiply-add** (512 MiB at
  100 %: 64 GiB in 43.9 s; 64 MiB at 10 %: 832 MiB in 0.37 s), table-driven scalar code on
  one thread. This is a cost model for this VM, not a claim about other hardware.
* **Absolute cost on a 512 MiB commit:** the parity phase takes 0.68 s at 1 %, 1.8 s at
  5 %, 3.2 s at 10 %, 21 s at 50 %, and 44 s at 100 %, against a whole commit of 1.8 s
  without a recovery record. No default percentage is set or recommended by this file.
* **Whole-commit time is noisy; the parity phase is not.** Between the two full runs the
  64 MiB whole-commit median at 1 % went from 326 ms to 539 ms, and in the second run the
  512 MiB commit at 1 % (4.8 s, one sample) is slower than at 5 % (3.5 s), which no cost
  model explains: sync and writeback on a virtual disk dominate. The parity-phase column
  moved by under 10 % between runs.
* **Space is the percentage, plus a floor.** Large commits pay *r* % plus tables and
  headers. A **small commit pays at least one whole shard per parity shard**: a 100 KiB
  commit at 1 % to 10 % writes one frame of 16,880 bytes, **11.4 % of the commit**, and at
  100 % it writes ten, 113.6 %. The relative cost of a recovery record is therefore highest
  for archives made of many small commits, which is the Core profile's usual append pattern.
  (The floor is the layout rule's: *s* is at least 16 KiB and *m* is at least 1.)

#### Hash-table overhead (K15 item 3)

Each frame repeats its group's 32·*k* bytes of shard hashes and adds 176 bytes of skippable
header, envelope, fixed fields, and digest (176 + 8·*n* with *n* = 0 required features).
Against the shard it carries:

| Range | s | k | Tables + fixed bytes per frame | Share of the frame |
|---|---|---|---|---|
| 100 KiB | 16 KiB | 10 | 496 B | 2.9 % (tables 1.9 %) |
| 2 MiB | 16 KiB | 128 | 4,272 B | 20.7 % (tables 19.8 %): the worst case |
| 4 MiB | 16 KiB | 87 | 2,960 B | 15.3 % (tables 14.4 %) |
| 64 MiB | 64 KiB | 128 | 4,272 B | 6.1 % (tables 5.9 %) |
| 512 MiB | 512 KiB | 128 | 4,272 B | 0.8 % |

The worst case is a range just at the point where *s* is still at its 16 KiB floor with
128 data shards (2 MiB); beyond it *s* grows with *L* and the share falls (the 100 KiB,
4 MiB, 64 MiB, and 512 MiB rows are measured; the 2 MiB row is computed from the layout
rule). Per protected byte, one frame's table is 4,096 / (128 · 16 KiB) = 0.2 % of a 2 MiB
commit, so at 10 % (*m* = 13 frames) the tables add about 2.5 % to the 10 % in shard bytes.
An index frame per group would remove most of it at the price of a single point of failure;
the numbers do not change K15's call to keep the layout.

### Verify: `stored_integrity` with and without a recovery record

| commit | recovery record | cache | verify ms | MiB/s | Integrity |
|---|---|---|---:|---:|---|
| 4 MiB | none | cold | 7.5 | 537 | Pass |
| 4 MiB | none | warm | 3.1 | 1303 | Pass |
| 4 MiB | 10 % | cold | 9.4 | 481 | Pass |
| 4 MiB | 10 % | warm | 5.1 | 886 | Pass |
| 64 MiB | none | cold | 75.9 | 843 | Pass |
| 64 MiB | none | warm | 33.4 | 1918 | Pass |
| 64 MiB | 10 % | cold | 116.8 | 608 | Pass |
| 64 MiB | 10 % | warm | 71.1 | 999 | Pass |
| 512 MiB | none | cold | 532.9 | 961 | Pass |
| 512 MiB | none | warm | 221.2 | 2315 | Pass |
| 512 MiB | 10 % | cold | 710.9 | 794 | Pass |
| 512 MiB | 10 % | warm | 426.8 | 1323 | Pass |

A recovery record makes the verify **1.25 to 2.1 times as long** in these rows (warm: 64 MiB
33 ms → 71 ms, 512 MiB 221 ms → 427 ms; cold: 64 MiB 76 ms → 117 ms, 512 MiB 533 ms →
711 ms). The extra work is reading the parity region (10 % more bytes at this setting) and
`parity::scan`'s second pass over the range, which hashes every data shard and decodes every
frame. The Integrity dimension is `PASS` in every row. When damage is present, B.2.11
item 12 applies and any rebuild happens in memory only.

### Rebuild: `parity::scan` with *m* damaged data shards in every group

The damage is the capacity: one byte flipped in each of the first *m* real data shards of
every group, so 3 to 512 damaged shards, the whole of every group's budget. "Scan ms" is the
run of `parity::scan` (the footer walk, every frame's decode, every shard's hash, the solve,
and the check that each rebuilt shard hashes to its table entry). It does not include
`repair` steps 1 to 4 over the healed view or writing the repaired archive, which cost what
they cost without parity.

| commit | r % | s KiB | G | k | m | shards damaged | shards rebuilt | rebuilt MiB | cache | scan ms | rebuilt MiB/s | protected range MiB/s | identical to pristine |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---|
| 4 MiB | 1 | 16 | 3 | 87 | 1 | 3 | 3 | 0.05 | cold | 14.6 | 3 | 276 | yes |
| 4 MiB | 1 | 16 | 3 | 87 | 1 | 3 | 3 | 0.05 | warm | 8.6 | 5 | 471 | yes |
| 4 MiB | 10 | 16 | 3 | 87 | 9 | 27 | 27 | 0.42 | cold | 26.2 | 16 | 155 | yes |
| 4 MiB | 10 | 16 | 3 | 87 | 9 | 27 | 27 | 0.42 | warm | 17.2 | 25 | 235 | yes |
| 4 MiB | 50 | 16 | 3 | 87 | 44 | 132 | 132 | 2.06 | cold | 97.6 | 21 | 41 | yes |
| 4 MiB | 50 | 16 | 3 | 87 | 44 | 132 | 132 | 2.06 | warm | 90.3 | 23 | 45 | yes |
| 64 MiB | 1 | 64 | 8 | 128 | 2 | 16 | 16 | 1.00 | cold | 170.1 | 6 | 377 | yes |
| 64 MiB | 1 | 64 | 8 | 128 | 2 | 16 | 16 | 1.00 | warm | 103.3 | 10 | 620 | yes |
| 64 MiB | 10 | 64 | 8 | 128 | 13 | 104 | 104 | 6.51 | cold | 537.6 | 12 | 119 | yes |
| 64 MiB | 10 | 64 | 8 | 128 | 13 | 104 | 104 | 6.51 | warm | 473.1 | 14 | 135 | yes |
| 64 MiB | 50 | 64 | 8 | 128 | 64 | 512 | 512 | 32.03 | cold | 2034.7 | 16 | 31 | yes |
| 64 MiB | 50 | 64 | 8 | 128 | 64 | 512 | 512 | 32.03 | warm | 2017.8 | 16 | 32 | yes |
| 512 MiB | 10 | 512 | 8 | 128 | 13 | 104 | 104 | 52.01 | cold | 5132.5 | 10 | 100 | yes |
| 512 MiB | 10 | 512 | 8 | 128 | 13 | 104 | 104 | 52.01 | warm | 4523.0 | 11 | 113 | yes |

* **Everything was rebuilt and identical.** In every row all damaged shards were rebuilt and
  the healed view's bytes equal the pristine file's; the example asserts it.
* **Cost grows with *m*.** Each damaged shard needs a multiply-add over *k* source shards.
  At 10 % the scan takes 0.47 s on 64 MiB (warm) and 4.5 s on 512 MiB (warm); at 50 % it
  takes 2.0 s on 64 MiB. Throughput is 100 to 235 MiB/s of protected range at 10 % and
  falls to about 30 to 45 MiB/s at 50 %.
* **Cold against warm** differs by up to about 1.7× on the small rows and by 10 to 15 % on
  the large ones.

### What this does not measure

* The Encrypted profile with parity, TAR-compatible archives, and archives of many commits
  (each commit pays for its own range only, so each is one row of the write table).
* Peak memory. B.2.11 item 10 bounds the writer at (*m* + 1)·*s* ≤ 129 MiB; that is a design
  bound, not a measurement.
* Other hardware, other filesystems, Windows. Every number here is from one Linux VM.
* The cost of `repair apply` end to end, and of a `verify` of a damaged archive.
* An optimised multiply (SIMD nibble tables) or groups run in parallel. Both are
  implementation changes with no wire effect (the arithmetic is the suite's, and the
  independent vectors would catch a difference). None is claimed or needed for the freeze.

### What this changes

Nothing in the format. The measured parity bytes equal the layout rule's prediction in every
row, and the overheads are as R6 §2 and B.2.11 item 10 state. The one number that argues for
revisiting the layout is the small-commit floor (11.4 % for a 100 KiB commit at 1 % to
10 %); it is the trade K15 item 3 already accepted, and it is now quantified.

<a id="threads"></a>

## Compressing on several cores

Desktop feedback: compressing a large file or folder used one processor
core. Since 0.9.11 the writer reads, hashes and compresses a commit's file
content ahead of itself on worker threads (`mochi_core::encode_ahead`,
`WriterOptions::threads`; `None` = the processor count, at most 8). The
writer still takes every piece in order and draws object IDs as it stores
them, so the archive is **byte for byte the same** for every thread count:
`crates/mochi-testkit/tests/c14_encode_ahead.rs` checks 1, 2, 4 and 7 threads
in the default and TAR-compatible profiles, and every golden-fixture test
runs with the threads on (64-byte test chunks). Sealing (Encrypted profile)
stays on the writer's thread; reading and hashing still move to the workers.
Encode-ahead is used when there are at least two chunks of content (16 MiB
at the default chunk size) and more than one thread.

Memory: at most `2 × threads` pieces are read and not yet stored, each up
to one chunk plus its frame (about 128 MiB with 4 threads and 8 MiB chunks).

### Setup (§27)

* Benchmark: `cargo run --release -p mochi-testkit --example c14_threads_bench [dir] [MiB]`.
* Dataset: 512 MiB of log-like, compressible text (timestamps, barcodes,
  numbers), as one file and as 64 files of 8 MiB, streamed from disk
  (`put_file_from`). Product defaults: 8 MiB chunks, default level.
* Hardware: 4-vCPU VM, Intel Xeon @ 2.10 GHz, ext4 on virtio disk, Linux
  6.18. Cache: warm (the source was just written). One fresh archive per
  case on `OsStorage` with `fdatasync`; IDs from `SeqIds`, no recorded time.

### Results (2026-10-26)

| Content | 1 thread | 2 threads | 4 threads (auto) |
|---|---|---|---|
| 1 file, 512 MiB | 2.29 s (223 MiB/s) | 1.01 s (507 MiB/s, 2.3×) | 0.72 s (710 MiB/s, 3.2×) |
| 64 files, 512 MiB | 2.50 s (205 MiB/s) | 1.42 s (361 MiB/s, 1.8×) | 1.03 s (499 MiB/s, 2.4×) |

Two threads gain more than 2× on one file because the reader and the
hashing also leave the writer's thread. The 64-file case gains less because
each 8 MiB file is a single chunk and its end is a point the writer waits at.
The archives of every thread count were compared byte for byte in the run.

Not measured: a cold cache, a network share, the Smaller preset (level 19,
where compression dominates even more), and machines with more than 4 cores.

### Related: streaming small files (0.9.11)

`put_file_from` zero-filled a whole chunk-sized buffer (8 MiB) for every
file it streamed, so a 2 KiB file cost about 1 ms. The buffer now grows with
the data (from 64 KiB). Committing 10,000 files of 2 KiB from file sources:
10.9 s before, 1.8 s after, the same as in-memory `put_file`.

<a id="post-commit"></a>

## What runs after a commit, and how long it takes

Prompted by desktop feedback: "Verifying committed archive took very long;
MOCHI should be fast to know, verify, and see if files exist." Spec §27
decomposition below; the benchmark is
`crates/mochi-testkit/examples/c15_postcommit_bench.rs`.

### What actually runs after a commit

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

### Setup (§27)

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

### Where the time went (before)

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

### Changes

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

### Numbers (median of 3 runs, ms)

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

### Scoped verification: `verify_commits_since`

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
