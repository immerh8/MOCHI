# C12 benchmark: the Redundancy profile's cost (R6, gate G11)

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

## Setup (§27 required statements)

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

## Write

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

### Reading the write table

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

### Hash-table overhead (K15 item 3)

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

## Verify: `stored_integrity` with and without a recovery record

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

## Rebuild: `parity::scan` with *m* damaged data shards in every group

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

## What this does not measure

* The Encrypted profile with parity, TAR-compatible archives, and archives of many commits
  (each commit pays for its own range only, so each is one row of the write table).
* Peak memory. B.2.11 item 10 bounds the writer at (*m* + 1)·*s* ≤ 129 MiB; that is a design
  bound, not a measurement.
* Other hardware, other filesystems, Windows. Every number here is from one Linux VM.
* The cost of `repair apply` end to end, and of a `verify` of a damaged archive.
* An optimised multiply (SIMD nibble tables) or groups run in parallel. Both are
  implementation changes with no wire effect (the arithmetic is the suite's, and the
  independent vectors would catch a difference). None is claimed or needed for the freeze.

## What this changes

Nothing in the format. The measured parity bytes equal the layout rule's prediction in every
row, and the overheads are as R6 §2 and B.2.11 item 10 state. The one number that argues for
revisiting the layout is the small-commit floor (11.4 % for a 100 KiB commit at 1 % to
10 %); it is the trade K15 item 3 already accepted, and it is now quantified.
