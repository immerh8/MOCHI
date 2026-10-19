# Getting started with the `mochi` command line

Sources: `docs/c14-cli.md`, spec §23. Every example below was run against a temporary
directory with a build of this repository.

> A `.mochi` file is not a backup; archives from before 1.0 need `mochi migrate` ([experimental.md](experimental.md)).

## Build

```bash
cargo build -p mochi-cli --release      # the binary is target/release/mochi
mochi --help
```

(Rust 1.89 or newer; `rust-toolchain.toml` pins 1.91. Installers are not available yet.)
The examples below assume `mochi` is on your `PATH`; otherwise use
`cargo run -p mochi-cli --` in its place.

## Create, change, list, restore

```bash
mochi create photos.mochi photos         # photos/ becomes a top-level entry
mochi append photos.mochi new.txt --delete photos/2026/old.txt
mochi list photos.mochi                  # the latest snapshot
mochi list photos.mochi --snapshot 0     # an earlier snapshot, still there
mochi snapshot list photos.mochi         # every commit
mochi get photos.mochi -C restored       # everything, into ./restored
mochi get photos.mochi photos/2026/a.txt --stdout
```

* `create` never replaces a file. If `photos.mochi` exists it stops with
  `DESTINATION_EXISTS` (exit 3) and changes nothing.
* Each input becomes a top-level entry named after its last component.
* `append` writes one new commit: deletions first, then the inputs added or replaced.
  The message says the entries were removed "from this snapshot (still in history)".
* `get` verifies each file before it is published. A file that fails verification is absent, not
  partial, and the exit code is 1. It never overwrites or merges into existing files.
  The restore reports name collisions and unsupported names instead of renaming.
* Symbolic links, devices, FIFOs, and sockets are skipped and listed, and the command
  exits 2 (`docs/c14-cli.md` rule 5). Links are never followed.

After each commit the tool prints `LOCAL_COMMITTED` and reminds you to keep an
independent copy. That line means the commit is complete in this file
([not-a-backup.md](not-a-backup.md)).

## The desktop app, in four steps

The desktop app does the same work without a terminal. With no archive open, its first screen
asks **What would you like to do?** and offers three buttons.

1. **Create archive** — add files and folders (the buttons, or drop them on the window),
   see where the new file will be saved (next to the first item, named after it; a file
   that already exists is never replaced, a number is added to the name instead) and press
   **Create archive**. **Options** (size and speed, password protection, extra repair data,
   opening with standard tar tools) is closed unless you want it. The result says what was
   created and keeps the precise status as a technical line.
2. **Open archive** — look inside, pick an entry, then **Extract selected**, or add and remove
   entries. You can also drop a `.mochi` file on the window, or pick one from **Recent archives**.
3. **Extract** (in an open archive; or **More > Open and extract…** to choose an archive and
   extract it at once) — extracts into a **new folder next to the archive**, named after it. Nothing already on your computer is overwritten;
   a name collision is listed first and skipped. **Show in folder** opens the result.
4. **Test**, **Find** and **Info** in the toolbar test the open archive, search its names and
   show details; **More** has passphrases, repair, other archive formats and settings; **?** has
   help. The same tools are in the **Advanced** drawer at the bottom.

Plain words on these screens map to the precise terms used below: a **version** is a snapshot
(one commit); the **Technical details** areas hold IDs and hashes. Deleting removes an entry
from the current version only; earlier versions still have it. An archive is not a backup
([not-a-backup.md](not-a-backup.md)).

## Check

```bash
mochi verify photos.mochi                # read-only; default level: restoration
mochi verify photos.mochi --level stored # only read and hash the stored bytes
mochi verify photos.mochi --json         # the machine-readable report
mochi fsck photos.mochi                  # verify, plus every commit checked on its own
mochi restore-test photos.mochi -C rt    # restore into a directory that must not exist
mochi health photos.mochi                # summarize what earlier runs recorded
```

What each proves is in [verification.md](verification.md).

## Search and inspect

```bash
mochi search photos.mochi a.txt          # names containing "a.txt"; prints its coverage
mochi dump-index photos.mochi            # read-only: row counts per catalog table
```

`search` states how many snapshots it searched; file content is not searched, and
`--content` exits 4.

## Options for protection

```bash
mochi create --tar-compatible t.mochi src          # see tar-compatible.md
mochi create --recovery-record 10 rr.mochi big.bin # see recovery-record.md
mochi create --encrypted --passphrase-file pass.txt vault.mochi photos   # see encrypted.md
```

These are fixed when the archive is created; nothing converts an archive in place.
(`--encrypted` cannot be combined with `--tar-compatible`.)

## Maintenance (each writes a new archive; the old one is kept)

```bash
mochi checkpoint photos.mochi                            # one commit, namespace unchanged
mochi compact photos.mochi --output photos-compact.mochi # every snapshot, new archive
mochi migrate old.mochi --output new.mochi                # a pre-1.0 (draft 2) archive into a 1.0 archive
mochi gc plan photos.mochi --output gc.plan              # read-only plan
mochi gc apply photos.mochi --plan gc.plan --output photos-gc.mochi
mochi repair plan photos.mochi --output repair.plan      # read-only; see below
mochi repair apply photos.mochi --plan repair.plan --output photos-fixed.mochi
mochi snapshot expire photos.mochi 0 --confirm           # irreversible (no un-expire)
```

* `compact` and `gc apply` never remove or change the source; removing it is your decision.
* `repair` is a plan, then an apply. The plan changes nothing. The apply writes a new
  archive, re-verifies it before publishing, and leaves the damaged source alone. A repair
  that recovered only part is labelled `PARTIAL` and exits 2.
* `gc apply` refuses a plan that no longer matches the archive.

## How much one archive can hold (spec D10, B.2.4)

An archive in 1.0 has a fixed ceiling on how many files it can track. Each commit
writes the whole archive state as one bounded record, and that record has a size limit
(measured, gate G5, `docs/benchmarks/t32-capacity-memory.md`):

* about **342,391** files when each file is a single chunk;
  (the ceiling counts the catalog's size once decoded; the catalog is stored compressed,
  which makes small archives much smaller but does not raise it);
* fewer when files are large: each extra chunk of a file costs about as much as half a
  small file.

At the ceiling, reading, listing, checking, and restoring keep working. A commit that
would grow the state further is refused with `CAPACITY_EXCEEDED` (exit 3), and the
archive stays as it was; commits that remove files still succeed. Raising the ceiling
needs a new format version. If you expect more files than this, split them across
several archives.

## Exit codes (spec §23.2)

| Code | Meaning |
|---|---|
| 0 | Requested checks passed |
| 1 | Verification or policy failure |
| 2 | Degraded, unknown, or overdue required evidence (also: some entries skipped) |
| 3 | Invocation, configuration, or operational error (for example a missing or wrong passphrase) |
| 4 | Unsupported required feature or capability |

Not in 1.0, exit 4: `inventory`, `split`, `join`, `mount`.

## Local history file

The CLI keeps the last head it saw for each archive in a small state directory
(`--state-dir`, or `$MOCHI_STATE_DIR`, or the platform default). It is how `verify` can tell
that an older copy has replaced a newer archive. `--no-local-history` turns that off, and
freshness is then `UNKNOWN` ([verification.md](verification.md)).
