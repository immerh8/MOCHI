# Foreign-format fixtures (plan D8)

Hostile and ordinary ZIP / tar / tar.gz archives for `crates/mochi-foreign`.
They are **generated deliberately** by `gen.py` from independent writers
(Python `zipfile`/`tarfile`, Info-ZIP `zip`, GNU `gzip`), with fixed mtimes and
seeds, and **committed**. Regenerating is a deliberate act: re-run
`python3 -I fixtures/foreign/gen.py`, review the diff, and explain it in the
change. Nothing here is a MOCHI archive and nothing in the `.mochi` golden set
(`fixtures/golden/`) depends on it. The tests do not regenerate anything.

The one fixture class no installed tool can write, AES-encrypted ZIP, is built in
memory by the tests with the `zip` crate itself. Those tests prove the helper's
handling (labels, fail-closed, tamper detection), **not** interoperability with
WinZip or 7-Zip; that is listed under Not done in the plan status.

| File | What it is | Rule it exercises |
|---|---|---|
| `basic_infozip.zip` | Info-ZIP archive: `a.txt`, `empty/`, `sub/b.txt` | list/test/read, "CRC32 matched" |
| `zipcrypto.zip` | Info-ZIP `-P secret`: ZipCrypto (test password: `secret`) | weak-encryption label, password required, wrong password fails closed |
| `traversal.zip` | names `../evil.txt`, `/abs/path.txt`, `a/../../b.txt`, `C:\win.txt`, `dir\back.txt`, `CON`, `nul.txt`, `file.txt:stream`, `A.txt`/`a.txt`, trailing dot, a UTF-8 name | names carried exactly, never judged |
| `duplicate_names.zip` | two entries named `dup.txt`, one `other.txt` | shadowed entries: listing reported incomplete |
| `cp437_name.zip` | name `caf\x82.txt` in CP437 without the UTF-8 flag | exact non-UTF-8 bytes, flag false |
| `symlink.zip` | symlink entries (one escaping with `../../etc/passwd`), a file, a directory | kinds reported, targets readable, never followed |
| `bomb_ratio.zip` | 8 MiB of zeros in 8 KiB | ratio limit (also used to patch a lying header) and entry-size limit |
| `bomb_count.zip` | 300 empty entries | entry-count limit |
| `bomb_total.zip` | six 600 KiB entries | total-output limit |
| `long_name.zip` | one 1,004-byte name | name-length limit |
| `crc_corrupt.zip` | stored entry with one flipped data byte | CRC32 mismatch |
| `deflate_corrupt.zip` | deflate stream with a damaged byte | not reported clean |
| `truncated.zip` | `basic_infozip.zip` without its end record | `MALFORMED_ARCHIVE` |
| `zip64_forced.zip` | entry with ZIP64 local extra field | ZIP64 reads |
| `method_bzip2.zip`, `method_lzma.zip` | methods this build does not decode | per-entry `unsupported` |
| `split.z01`, `split_last.zip` | first and last segments of an Info-ZIP split set | `UNSUPPORTED_SPLIT_ZIP` |
| `sfx.exe` | synthetic `MZ` stub + a ZIP (not executable) | `UNSUPPORTED_SFX` |
| `basic.tar`, `basic.tar.gz` | GNU tar: `d/`, `a.txt`, `d/b.txt` | no per-entry check; gzip stream CRC |
| `pax.tar`, `longname_gnu.tar` | 301-byte pax path, 304-byte GNU long name | long names complete |
| `traversal.tar` | `../evil.txt`, `/abs/path.txt`, `a/../../b.txt`, a symlink escaping, a hard link, a char device, a FIFO, `CON`, `Dup.txt`/`dup.txt` | names/kinds/link targets carried as found |
| `bomb_ratio.tar.gz` | 8 MiB of zeros in a tar in 8 KiB of gzip | ratio / total / entry-size limits mid-stream |
| `bomb_count.tar`, `bomb_count.tar.gz` | 300 empty files | entry-count limit |
| `gz_crc_corrupt.tar.gz` | trailer CRC-32 byte flipped | whole-stream check fails; entries not vouched |
| `truncated.tar.gz` | 20 KB of random data, gzip cut at 60% | incomplete + failed stream |
| `truncated.tar` | tar cut off mid-entry | incomplete (truncation detected without reading the data) |
| `single.gz`, `fake.7z`, `fake.rar`, `garbage.bin`, `empty.bin` | not tar.gz / not supported yet / not archives | `UNSUPPORTED_FORMAT`, `NOT_AN_ARCHIVE` |

`tests/fuzz_smoke.rs` also uses every file here as a seed, and CI's fuzz job
seeds the `foreign_*` targets from this directory.
