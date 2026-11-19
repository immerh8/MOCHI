# How MOCHI works

This page explains, in plain words, what happens inside a `.mochi` file and why MOCHI
behaves the way it does. You do not need it to use MOCHI, but it makes the messages
and the choices easier to understand. The exact rules are in the specification
(`docs/spec.md`); this page names the sections it summarizes.

## The short version

* A `.mochi` file is a **stack of versions**. Every time you create or add to an
  archive, MOCHI writes a new version at the end of the file. Older versions are never
  changed.
* Your files are cut into **chunks**, each one compressed and given a fingerprint (a
  BLAKE3 hash). A chunk that is already in the archive is not stored again.
* A new version only counts once its **seal** (a footer) is written and synced to disk. If the power
  goes out halfway, the archive still opens at the last sealed version.
* Everything MOCHI reads is **checked against its fingerprint** before it is used, and a
  file is only written out after its whole content matches.
* `verify` tells you **what it checked and what it could not check**, and never calls a
  check that did not run a pass.
* When something is damaged, `repair` builds a **new, repaired archive** and leaves the
  damaged one untouched.
* A `.mochi` file is still one file on one disk: **it is not a backup** (see
  [why an archive is not a backup](not-a-backup.md)).

## An archive is a stack of versions

Each `mochi create` or `mochi append` (in the app: Create, Add, Delete) adds one
**commit** to the end of the file. A commit records what changed. The **snapshot** of a
commit is what the archive contains after it: every file and folder, with its content,
size, times and permissions. The newest commit is the **head**, and it is what you see
when you open the archive.

```
photos.mochi   (the file only ever grows at the end)

| descriptor | chunks ... | commit 0 | seal | chunks ... | commit 1 | seal | ...
              \___________ version 0 ________/ \__________ version 1 ________/
```

Because nothing is overwritten:

* **Old versions stay readable.** `mochi list photos.mochi --snapshot 0` shows the archive
  as it was after its first commit, and `mochi get` can extract from any version. In the
  app, the version list does the same.
* **Deleting a file removes it from the new snapshot, not from history.** The earlier
  versions still contain it. To really drop old versions, you expire them
  (`mochi snapshot expire`) and then write a new, smaller archive without them
  (`mochi gc` or `mochi compact`); MOCHI never shrinks the only good copy in place.
* **The descriptor** at the very start of the file says which format and profile the
  archive uses (for example Encrypted). It is written once and never changes.

(Spec §10 snapshots, §12 commits, §16 retention, §18 compaction and garbage collection.)

## How your files are stored

**Chunks.** Each file is cut into chunks of up to 8 MiB (the app's and the command
line's default; the size is fixed for an archive's life). Each chunk is compressed with
Zstandard, the same compression `zstd` uses, at the level you choose (in the app,
from Turbo to Extreme; Balanced is recommended).

**Fingerprints.** MOCHI computes a BLAKE3-256 hash, a 64-character fingerprint, for
everything it stores: the compressed bytes on disk, each chunk's original bytes, and each
whole file. Changing even one bit changes the fingerprint completely, so a damaged byte
cannot go unnoticed when it is read. The whole-file fingerprint is the same value the
`b3sum` tool prints, so you can check an extracted file with a tool that is not MOCHI.

**Stored once.** When a chunk you add is identical to one the archive already holds,
MOCHI checks it byte for byte and then points to the existing copy instead of storing it
again. Adding the same photo twice, or appending a folder where little changed, costs
little space. This happens inside one archive only, and not in TAR-compatible archives.

**The catalog.** The list of names, sizes, times, permissions and which chunks make up
which file is kept in a small database (SQLite) stored inside the archive, compressed
and fingerprinted like everything else. Every commit also writes a short **recovery
manifest**: a plain description of what that commit changed. If the catalog is ever
damaged, MOCHI can rebuild it from the manifests. Now and then a commit also stores a
complete copy of the catalog (a **checkpoint**), so opening an archive with a long
history stays fast.

(Spec §9 objects and integrity, §9.4 deduplication, §10 catalog, §11 recovery manifests,
§13 compression and chunking.)

## How a new version is saved

A commit is written in a fixed order:

1. MOCHI takes a lock, so only one program writes to the archive at a time.
2. It checks that the current head is sound.
3. It writes the new chunks, then the recovery manifest and the catalog, then the
   commit record.
4. It asks the operating system to put all of that on the disk (a *sync*).
5. It writes the **seal** (the footer), which names the commit and its fingerprint.
6. It syncs again, and on a new archive makes sure the file's name is saved too.

Only then does MOCHI report the commit as saved: on the command line,
`LOCAL_COMMITTED`. That word means saved **on this disk**, nothing more.

If anything stops before the seal is on disk (a crash, a power cut, a full disk), the
previous sealed version is still the head, and the archive opens as if the interrupted
commit never happened. The unsealed bytes at the end are an **interrupted tail**. MOCHI
does not quietly cut them off, because it can never be completely sure they are not a
damaged later commit: `mochi append` refuses until you ask it to remove the tail with
`--truncate-tail`, and even then it first keeps a verified copy of those bytes in a
`.mochiq` file next to the archive.

If the operating system ever reports that a sync failed, MOCHI stops writing to that
archive (the write fails with `WRITER_POISONED`) instead of trying again and pretending
it worked.

(Spec §5.1, §12.2, Annex B.2 D13 and D14.)

## Reading and extracting: checked every time

When MOCHI reads anything from an archive, it first checks the stored bytes against
their fingerprint, then decompresses them and checks the chunk's own fingerprint. When it
extracts a file, it writes it under a temporary name, checks the whole file's
fingerprint, and only then gives it its real name. A file that fails a check is never
put in place; it is reported instead.

Extraction never overwrites anything by default. The command line skips names that are
already there and lists them (`mochi get` exits 2). The app asks first: add only new files, replace (your old
file goes to the Recycle Bin or the Trash), or extract to a new folder.

Archives are treated as untrusted. A name like `../../something` or a link is never
followed out of the folder you chose, and every size read from an archive is checked
before memory is set aside for it.

(Spec §5, §9.)

## Checking an archive

`mochi verify` (in the app: **Test archive**) reads the archive without changing a byte
and reports what it found, level by level:

| Level | What is checked |
|---|---|
| Structural | The descriptor, every seal and commit, and the catalog's structure |
| Referential | Every file's chunks exist and nothing it needs is missing |
| Stored integrity | Every stored byte is read and its fingerprint checked |
| Content integrity | Every chunk is decompressed (and decrypted) and checked |
| Restoration | Every file is reassembled and its whole-file fingerprint compared |

The report keeps separate answers for separate questions (Is the data intact? Can it be
repaired? Is this the newest copy?) and uses a small set of words: `PASS`, `FAIL`,
`DEGRADED`, `UNKNOWN`, `OVERDUE` and `UNSUPPORTED`. A check that did not run is never
`PASS`. For example, MOCHI cannot know on its own whether someone replaced your archive
with an older copy, so "freshness" stays `UNKNOWN` until it has something to compare
with (the head it saw last time, or one you give it).

The details, and what each word promises, are in [What the checks prove](verification.md).

(Spec §20.)

## When something is damaged

`mochi repair` works in two steps: `repair plan` reads the damaged archive and says what
it can bring back and what it cannot; `repair apply` writes a **new** archive from that
plan, checks the new archive before publishing it, and never writes to the damaged one.
In the app, the Repair screen does both.

To bring things back, MOCHI tries the least invasive source first:

1. Earlier sealed versions, when only the end of the file is damaged.
2. The recovery manifests, to rebuild a damaged catalog.
3. The **recovery record**, if the archive has one: extra parity data that can rebuild
   damaged parts, up to a stated amount (see [Recovery record](recovery-record.md)).
4. Other copies of the same archive that you give it (`--copy`), for any part that
   matches its fingerprint.
5. A careful scan of the raw bytes (`--salvage`), only when you ask for it.

Whatever comes back is checked against its fingerprint before it is used. A repair that
could not bring everything back is labelled **partial** and lists what is missing.

(Spec §22.)

## Choices made when an archive is created

Three kinds of archive are chosen at creation and are fixed for the archive's life:

| Choice | What it does | Read more |
|---|---|---|
| Encrypted (`--encrypted`) | Names, sizes, folders and content are sealed with XChaCha20-Poly1305 under a random key, which each passphrase unlocks. Lose every passphrase and the archive is lost: there is no back door | [Encrypted archives](encrypted.md) |
| Recovery record (`--recovery-record PERCENT`) | Adds Reed–Solomon parity, about PERCENT % of each commit's size, that `verify` checks and `repair` can use | [Recovery record](recovery-record.md) |
| TAR-compatible (`--tar-compatible`) | Every commit also carries a standard TAR stream, so `zstd` and `tar` can read the archive without MOCHI. Costs space and turns off storing chunks once | [TAR-compatible archives](tar-compatible.md) |

An archive cannot be both Encrypted and TAR-compatible.

## Finding files across many archives

**Find** (in the app, and `mochi find` on the command line) looks for file names inside
every `.mochi` file under the folders you choose. It opens each archive read-only, reads
only the names of its newest version, and never reads file content. It says which
archives it could not search and why (an Encrypted archive's names are hidden without
the passphrase), and it only says "no matches" when it really searched everything. In
the app you can then tick the matches and **Retrieve** them, from every archive they are
in, into one folder.

## What MOCHI does not do

* It does not make copies for you. Keep the archive on more than one disk, in more than
  one place, if you cannot recreate what is in it.
* It does not split an archive into volumes, mount it as a drive, or sign it.
* It does not share stored chunks between different archives.
* It does not change old versions, or rewrite your only good copy in place.

## Words you will see

| Word | Meaning |
|---|---|
| Commit, version | One saved change to the archive |
| Snapshot | What the archive contains after a given commit |
| Head | The newest sealed commit, the one an archive opens at |
| Seal, footer | The small record that makes a commit count |
| Chunk | A piece of a file, compressed and fingerprinted on its own |
| Fingerprint, hash | A BLAKE3-256 value that changes completely if any bit changes |
| Catalog | The list of names, sizes, times and chunks inside the archive |
| Recovery manifest | A plain record of what one commit changed, used to rebuild the catalog |
| Interrupted tail | Bytes after the last seal, left by a write that did not finish |
| Recovery record | Optional parity data that can rebuild some damage |
| `LOCAL_COMMITTED` | Saved on this disk; not a backup |
