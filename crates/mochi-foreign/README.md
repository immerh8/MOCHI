# mochi-foreign

Read-only access to **foreign archive formats** for the MOCHI desktop app (plan
phase D8, decision O9): browse, test, and stream entries out of **ZIP**,
**tar**, and **tar.gz / .tgz**. 7z and RAR are a later slice of D8; this build
answers them `UNSUPPORTED_FORMAT`.

These formats are outside the MOCHI specification. Nothing here touches the
`.mochi` wire format.

## Shape

```
app / CLI                         mochi-foreign-helper (child process)
  mochi_foreign::ForeignClient  ── stdin/stdout, protocol v1 ──▶  engine: detect, zip, tar, gzip
  (no parser linked)                                              (all parsing happens here)
```

* **All parsing runs in the helper process**, under memory, time, and output
  limits. `mochi-core` and `mochi-format` never depend on this crate, and the
  app/CLI name it with `default-features = false`, which leaves out the
  `engine` feature (the `zip`, `tar`, and `flate2` crates). Both are checked by
  `ci/check-invariants.sh`.
* **The helper never writes a file** and no library's extract-to-disk function
  is used. It streams entry bytes; the C6 restore engine is the only writer, so
  every §10.4 protection (traversal, reserved names, symlink escapes, ...)
  applies unchanged. The helper does not judge names: it carries the exact
  bytes the archive stored, never normalized, case-folded, or decoded.
* **Nothing here uses MOCHI's verification wording or health dimensions.**
  Results name the check that ran ("CRC32 matched"). `recoverability`,
  `freshness`, and `retention` are fixed at `UNSUPPORTED`.

## Operations

| Op | What it does |
|---|---|
| `list` | Entry metadata only. For `.tar.gz` this still decompresses the whole stream (tar has no index), under the same limits, which also reaches the gzip trailer check. |
| `test` | Streams every entry through its decompressor, runs the format's own check, discards the bytes. |
| `read` | Streams one entry's bytes to the caller's sink (for the C6 engine). |

## What each format checks (and nothing more)

| Format | Per entry | Whole stream |
|---|---|---|
| ZIP | CRC32 ("CRC32 matched"); AES entries: the AES authentication code (AE-2 has no CRC32) | none |
| tar | none ("read without error; this format has no per-entry check") | none |
| tar.gz | none | gzip trailer CRC-32 + length; if it fails, **no** entry read from the stream is vouched for |

* **ZipCrypto** entries are labelled `weak encryption (ZipCrypto)`. Its password
  test is one byte, so a wrong password can pass it and then fail the CRC:
  the outcome says "damaged data, or a wrong password that passed the weak
  password test".
* **Wrong password fails closed.** Encrypted entries are held in the helper
  until their authentication passes; a wrong password delivers no bytes.
* Split/spanned ZIP (`.z01`, a non-zero disk number) and self-extracting
  executables return `UNSUPPORTED_SPLIT_ZIP` / `UNSUPPORTED_SFX`.
* ZIP entries using bzip2, LZMA, zstd, or PPMd are listed and reported
  `unsupported` per entry (those decoders are not built in).
* Entries that share a name: the `zip` library keeps one per name. The helper
  compares its count with the end record's and reports the listing as
  **incomplete** with the reason, rather than presenting a smaller archive as
  the whole.

## Limits

`Limits` (what the helper may produce; every breach is reported by entry and
ends the operation cleanly, none panics):

| Limit | Default | Breach |
|---|---|---|
| `max_total_output` | 8 GiB | `LIMIT_TOTAL_OUTPUT` (stops the operation) |
| `max_entry_size` | 4 GiB | `LIMIT_ENTRY_SIZE` (skips that entry) |
| `max_entries` | 1,000,000 | `LIMIT_ENTRY_COUNT` (stops; the listing is partial) |
| `max_ratio` / `ratio_min_output` | 200 : 1, after 1 MiB | `LIMIT_COMPRESSION_RATIO` |
| `max_name_len` | 65,535 | `LIMIT_NAME_LENGTH` (the name is not carried or truncated) |

The ratio is evaluated per ZIP entry against the *declared* compressed size (a
claim) and for the whole operation against the *real* archive bytes (file
length; gzip bytes consumed). `RunLimits` bound the helper *process*: wall time
(default 10 min, then killed), address space (default 2 GiB, `RLIMIT_AS`, Unix
only), and listing bytes accepted (default 256 MiB). A panic, abort, memory
breach, hang, flood, or protocol violation becomes a typed `ForeignError`
(`HELPER_PANIC`, `HELPER_CRASHED`, `HELPER_TIMEOUT`, `HELPER_OUTPUT_LIMIT`,
`HELPER_PROTOCOL`); the caller is unaffected and the next call spawns a fresh
helper.

## Protocol, version 1

One helper process serves **one request**. The parent starts it with no
arguments (a password is never an argument), the helper writes `HELLO`, the
parent writes `REQUEST`, the helper streams messages until `DONE` or `ERROR`,
then exits. The parent treats the helper as untrusted: lengths, counts,
ordering, and totals are validated; anything off is `HELPER_PROTOCOL`.

Frame: `len: u32 LE` (counts `kind` + body; 1 ..= 1 MiB; validated before any
allocation), `kind: u8`, body. Integers are little-endian; *bytes* = `u32` length
+ data; *opt* = `u8` 0/1 flag then the value. Decoding is strict: unknown kinds
or codes, short bodies, and trailing bytes are errors.

| Kind | Direction | Body |
|---|---|---|
| `0x01 REQUEST` | parent → helper | `u16` version (1), `u8` op (1 list, 2 test, 3 read), `u64` read index, limits (`u64` total, entry, entries, ratio, ratio-min-output; `u32` name length), opt `u64` address-space limit, opt `u64` CPU seconds, *bytes* archive path (raw bytes on Unix, UTF-16LE on Windows), opt *bytes* password |
| `0x80 HELLO` | helper → parent | `u16` version, text id |
| `0x81 FORMAT` | h → p | `u8` 1 ZIP, 2 tar, 3 tar.gz |
| `0x82 ENTRY` | h → p | `u64` index, *bytes* name, `u8` kind, opt `u64` size, opt `u64` compressed size, encryption (`u8` + `u16` bits), text method, opt *bytes* link target, opt `u64` mode, opt `i64` mtime, `u8` UTF-8-flag state, opt text error |
| `0x83 RESULT` | h → p | `u64` index, outcome (tag `u8` + payload) |
| `0x84 DATA` | h → p | raw entry bytes (≤ 64 KiB per frame), `read` only |
| `0x85 STREAM_CHECK` | h → p | whole-stream check: not applicable / matched / failed / not reached |
| `0x86 BREACH` | h → p | `u8` kind, opt `u64` entry, `u64` limit, `u64` observed |
| `0x87 DONE` | h → p | `u8` complete, `u64` entries, `u64` bytes out, opt text stop reason |
| `0x8F ERROR` | h → p | `u8` code (helper-originated codes 1–9 only), text |

Order: `HELLO`, then (after the request) `FORMAT`, then per entry `ENTRY`
(+ `RESULT` for `test`) in index order with `BREACH` messages interleaved,
`STREAM_CHECK`, `DONE`. A version change is a new `PROTOCOL_VERSION` and a new
section here, never an edit.

## Tests

Hostile-archive fixtures live in `fixtures/foreign/` (generator and
explanation in its README). `tests/`: `zip_fixtures`, `tar_fixtures`,
`detect`, `limits`, `supervision` (crash/limit breach with the parent
surviving; helper fault hooks behind the `test-faults` feature, enabled only by
this crate's dev-dependency on itself), `protocol`, `fuzz_smoke` (stable-Rust
exerciser over the corpus, truncations, and seeded flips; the cargo-fuzz targets
`foreign_zip`, `foreign_tar`, `foreign_targz`, `foreign_protocol` call the same
functions in `mochi_foreign::fuzz`).
