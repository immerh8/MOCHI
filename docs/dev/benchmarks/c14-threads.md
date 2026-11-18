# C14: compressing on several cores (release 0.9.11)

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

## Setup (§27)

* Benchmark: `cargo run --release -p mochi-testkit --example c14_threads_bench [dir] [MiB]`.
* Dataset: 512 MiB of log-like, compressible text (timestamps, barcodes,
  numbers), as one file and as 64 files of 8 MiB, streamed from disk
  (`put_file_from`). Product defaults: 8 MiB chunks, default level.
* Hardware: 4-vCPU VM, Intel Xeon @ 2.10 GHz, ext4 on virtio disk, Linux
  6.18. Cache: warm (the source was just written). One fresh archive per
  case on `OsStorage` with `fdatasync`; IDs from `SeqIds`, no recorded time.

## Results (2026-10-26)

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

## Related: streaming small files (0.9.11)

`put_file_from` zero-filled a whole chunk-sized buffer (8 MiB) for every
file it streamed, so a 2 KiB file cost about 1 ms. The buffer now grows with
the data (from 64 KiB). Committing 10,000 files of 2 KiB from file sources:
10.9 s before, 1.8 s after, the same as in-memory `put_file`.
