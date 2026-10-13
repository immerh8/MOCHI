# R4 — Catalog SQLite DDL and constraints (FROZEN, draft 2)

> **Status 2026-10-12: frozen as part of draft 2** (gate G12, [delegated 2026-10-12];
> final under the standing delegation, AGENTS.md "Decision authority"), with R1, R2, and R3, by the
> review in §6. Written 2026-10-11 from the working code at `main` commit `57e3a69`; the
> freeze set `user_version` to **1** (decision 3). The file name keeps "draft" for links.
> A change to the DDL, a header value, or a rule below is a new draft identifier and an
> Annex B entry (spec B.2.14), never an edit. The DDL in §2 is compared byte for byte
> with `mochi_core::catalog::schema::DDL`, and the tables marked *(checked)* with the
> code, by `crates/mochi-cli/tests/ratification_drafts.rs`. **Reader-side indexes are not
> wire** (plan K12): a reader may `CREATE INDEX` on the in-memory catalog after
> `Catalog::open_image`; the stored image and its DDL do not change for that.

Sources: spec §10.1–§10.5, §17, Annex B.1 D2, Annex B.2 D10, D11, B.2.2, plan O25
(in-memory SQLite, images moved as bytes). Code: `crates/mochi-core/src/catalog/schema.rs`
(the DDL), `catalog/mod.rs` (header checks, hardening, `Catalog::verify`),
`catalog/extent.rs`, `catalog/namespace.rs`, `catalog/path.rs`, `image.rs`.

## 1. The image

A catalog image is a complete SQLite 3 database file, stored as the payload of a
`0x184D2A50` frame behind binary envelope v0 (R2), or sealed inside a `0x184D2A59`
frame in the Encrypted profile (R5). It is never opened from a file: images move as
bytes and are deserialized into an in-memory connection (O25).

**Header values.** *(checked)*

| Field | Value | Where |
|---|---|---|
| `application_id` | `0x4D4F4348` (ASCII `MOCH`) | `schema::APPLICATION_ID` |
| `user_version` | `1` (frozen; `0` was the pre-freeze draft and is refused) | `schema::SCHEMA_VERSION`; equals the binary envelope's record schema version |
| Page size | `4096` | `schema::PAGE_SIZE` |
| File format read/write versions | `1` / `1` (rollback journal, not WAL) | header bytes 18–19 |

**`archive_meta` keys written.** *(checked)*

| Key | Value |
|---|---|
| `archive_id` | The 32-byte archive ID |
| `writer_params` | Deterministic CBOR `{0: 0 (chunking kind: fixed size), 1: chunk size, 2: zstd level}` |

`archive_id` is required and must equal the archive ID of the commit that references the
image; `writer_params` is required in a catalog the writer built and absent in one rebuilt
from a manifest (below). No other key is written, and the code does not read others.
The chunk-size and level in `writer_params` are informational for readers.

A catalog rebuilt from a snapshot manifest (repair, baseline recovery) has no
`writer_params` row (plan review decision Q29). An unknown chunking kind is
`UNSUPPORTED_FEATURE`.

## 2. DDL

Exactly this text is run, inside one transaction, on a fresh in-memory connection to
build a working catalog. Every table is `STRICT`; IDs and digests are 32-byte BLOBs
checked by length; integers are SQLite's signed 64 bits, and a `u64` above `i64::MAX`
is refused at insert and rejected at read, never wrapped. Digest scopes have their
own columns (`stored_hash`, `content_hash`) because the file-content hash is
unseparated (O20).

```sql
CREATE TABLE archive_meta (
    key   TEXT PRIMARY KEY,
    value BLOB NOT NULL
) STRICT;

CREATE TABLE commits (
    seq        INTEGER PRIMARY KEY CHECK (seq >= 0),
    parent_seq INTEGER REFERENCES commits(seq),
    CHECK (parent_seq IS NULL OR parent_seq < seq)
) STRICT;

CREATE TABLE objects (
    object_id   BLOB PRIMARY KEY CHECK (length(object_id) = 32),
    stored_len  INTEGER NOT NULL CHECK (stored_len > 0),
    stored_hash BLOB NOT NULL CHECK (length(stored_hash) = 32)
) STRICT, WITHOUT ROWID;

CREATE TABLE object_locations (
    object_id     BLOB PRIMARY KEY REFERENCES objects(object_id),
    stored_offset INTEGER NOT NULL CHECK (stored_offset >= 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE chunks (
    object_id    BLOB PRIMARY KEY REFERENCES objects(object_id),
    encoding     TEXT NOT NULL CHECK (encoding IN ('zstd-frame')),
    protection   TEXT NOT NULL CHECK (protection IN ('none', 'aead')),
    decoded_len  INTEGER NOT NULL CHECK (decoded_len >= 0),
    content_hash BLOB NOT NULL CHECK (length(content_hash) = 32)
) STRICT, WITHOUT ROWID;

CREATE TABLE chunk_dependencies (
    object_id       BLOB NOT NULL REFERENCES chunks(object_id),
    dependency_kind TEXT NOT NULL CHECK (dependency_kind IN ('dictionary', 'key-envelope')),
    dependency_id   BLOB NOT NULL CHECK (length(dependency_id) = 32),
    PRIMARY KEY (object_id, dependency_kind, dependency_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE file_versions (
    file_version_id BLOB PRIMARY KEY CHECK (length(file_version_id) = 32),
    kind            TEXT NOT NULL CHECK (kind IN ('file', 'directory')),
    logical_len     INTEGER NOT NULL CHECK (logical_len >= 0),
    content_hash    BLOB,
    CHECK ((kind = 'file' AND length(content_hash) = 32)
        OR (kind = 'directory' AND content_hash IS NULL AND logical_len = 0))
) STRICT, WITHOUT ROWID;

CREATE TABLE file_extents (
    file_version_id BLOB NOT NULL REFERENCES file_versions(file_version_id),
    ordinal         INTEGER NOT NULL CHECK (ordinal >= 0),
    logical_offset  INTEGER NOT NULL CHECK (logical_offset >= 0),
    length          INTEGER NOT NULL CHECK (length > 0),
    chunk_id        BLOB REFERENCES chunks(object_id),
    chunk_offset    INTEGER NOT NULL CHECK (chunk_offset >= 0),
    CHECK (chunk_id IS NOT NULL OR chunk_offset = 0),
    PRIMARY KEY (file_version_id, ordinal)
) STRICT, WITHOUT ROWID;

CREATE TABLE namespace_ops (
    commit_seq      INTEGER NOT NULL REFERENCES commits(seq),
    op_seq          INTEGER NOT NULL CHECK (op_seq >= 0),
    op              TEXT NOT NULL CHECK (op IN ('put', 'delete')),
    path            BLOB NOT NULL CHECK (length(path) > 0),
    file_version_id BLOB REFERENCES file_versions(file_version_id),
    CHECK ((op = 'put') = (file_version_id IS NOT NULL)),
    PRIMARY KEY (commit_seq, op_seq)
) STRICT, WITHOUT ROWID;
```

### What the stored schema looks like

`Catalog::open_image` (§3 step 3) compares `SELECT type, name, tbl_name, sql FROM
sqlite_schema ORDER BY type, name` of the image with that of a fresh catalog, **as
stored text**. SQLite keeps each `CREATE` statement's text as written, so the rows are
fixed by running §2's text verbatim (without its terminating semicolons). Ten rows: the
nine tables, each with `sql` = its `CREATE TABLE …` text beginning at the keyword, and
one index, `sqlite_autoindex_archive_meta_1` on `archive_meta` with `sql` NULL (the only
table that has an automatic index; the others are `WITHOUT ROWID` or key on the rowid).
There is no `sqlite_sequence`, `sqlite_stat1`, view, or trigger, and any such row is
refused. SQLite 3.37 or later is required (`STRICT`); the reference build bundles
SQLite 3.53.2 through `rusqlite`. A second implementation that builds its
reference rows from §2's text with any 3.37+ engine gets the same ten rows (checked
with 3.45.1 for this review).

### Column notes

| Table | Notes |
|---|---|
| `archive_meta` | Keys in §1. Values are opaque bytes to SQLite; each key's decoder checks its own encoding |
| `commits` | Ordering only: sequence and parent sequence. Commit IDs, footers, and record fields live in the commit records, not here. The chain is linear (Core has a single writer, §12.5) |
| `objects` | Object identity, stored length (> 0), and stored-object hash (BLAKE3, `MOCHI2-STORED-OBJECT` scope). Identity is separate from location (§17) |
| `object_locations` | Byte offset of the object's frame in a monolithic archive. A segmented layout (R10, post-1.0) would add columns or a table here, not change `objects` |
| `chunks` | `encoding` is always `zstd-frame` (one Zstandard frame per chunk, O21). `protection` is `aead` exactly in the Encrypted profile (the stored object is a sealed frame) and `none` otherwise; manifests enforce the same rule. `content_hash` is over **decoded** bytes, `MOCHI2-CHUNK-CONTENT` scope (§9.3) |
| `chunk_dependencies` | Declared dictionary or key-envelope dependencies. No 1.0 writer emits any; a chunk that declares one is `UNSUPPORTED_FEATURE` on read (plan K4), and a sealed chunk that declares a key envelope is `RECORD_INVALID` (the data key is archive-wide, D20) |
| `file_versions` | `kind` is `file` or `directory`; a directory has length 0 and no content hash. `content_hash` is plain BLAKE3 of the logical stream (O20), never compared with a domain-separated digest |
| `file_extents` | Ordered extents covering exactly `[0, logical_len)`. A null `chunk_id` is an explicit hole and has `chunk_offset` 0 |
| `namespace_ops` | Ordered `put`/`delete` per commit (§10.2). `path` is the archive path's bytes, components joined by `/`, never normalized (O24) |

## 3. What a reader checks before trusting an image

The caller has already hash-verified the image's stored bytes against the commit that
references it (AGENTS.md: SQLite has no page checksums, and a flipped bit in a stored
value yields a different, fully valid catalog). Then, in order (`Catalog::open_image`):

1. **Before SQLite parses anything** (`check_header`): length within
   `CatalogLimits::max_image_len` (default *S* − 592 = 268,434,864 bytes); a whole
   number of 4096-byte pages; the SQLite signature; page size 4096; file format
   versions 1/1 (no WAL); `application_id` = `MOCH` (else `CATALOG_INVALID`);
   `user_version` = 1 (else `UNSUPPORTED_FEATURE`; `0` is the pre-freeze draft).
2. **Connection hardening** before reading: `SQLITE_DBCONFIG_DEFENSIVE` on,
   `TRUSTED_SCHEMA` off, `temp_store = MEMORY`, `mmap_size = 0`,
   `cell_size_check = ON`, `foreign_keys = ON`, then `query_only = ON`.
3. **Exact schema.** The image's `sqlite_schema` rows (type, name, table, SQL) must
   equal those a fresh catalog gets from §2. Any extra table, index, view, or
   trigger, or any altered definition, is refused: a trigger in an untrusted image
   would run on the writer's own inserts.
4. **`Catalog::verify`**: `PRAGMA integrity_check` returns exactly `ok`;
   `PRAGMA foreign_key_check` returns nothing; every file version's extents pass the
   §10.3 rules (no gap, overlap, read past a chunk's decoded length, length mismatch,
   bad ordinal, or empty extent; overflow-checked); and a full namespace replay of
   every commit validates (paths by §10.4, no delete of an absent path, puts of known
   versions).

**Codes.** In step 1: an image above `max_image_len` is `LIMIT_EXCEEDED`; not a whole
number of pages, a wrong signature, page size, or journal mode, and a wrong
`application_id` are `CATALOG_INVALID`; a `user_version` other than 1 (including 0, the
pre-freeze draft, and any other value) is `UNSUPPORTED_FEATURE`. The limit applies to the
SQLite bytes and is *S* − 592 = 268,434,864 for every record, whatever its feature count;
the largest image that is also a whole number of pages is 268,431,360 bytes (65,535
pages). The envelope's own comparison of record schema version with `user_version`
(R2 §2) runs before the catalog sees the image. Step 3 and the `PRAGMA` checks of step 4
are `CATALOG_INVALID`; the extent rules are `EXTENT_INVALID`, the namespace replay
`NAMESPACE_INVALID`, and a stored path `PATH_INVALID`, each from the rules in §3.1. **[Clarified, W18 (R9), 2026-10-13; no byte
changes]** These checks run on an image whose stored-object hash (and, when sealed, AEAD tag) has
already verified; an image that fails the hash is damage, not an invalid catalog, and reads
rebuild from the snapshot manifest (spec D10 item 9). A hash-verified head base image that
fails any check of this section refuses the head. The
header fields not listed (text encoding, reserved space, change counter, free-list and
vacuum fields) are not checked by `check_header`; `PRAGMA integrity_check` and the
exact-schema step decide the rest. Hostile storage-class values (a REAL or TEXT in an
`INTEGER` column) are impossible under `STRICT`; a `u64` above `i64::MAX` is refused at
insert and never read. When several checks fail, the first in this order is reported. The checks run identically on an image opened
for writing (`open_image_writable`); the image bytes are never modified.

### 3.1 Rules the checks apply (frozen with the DDL)

Step 4 applies these. They are R4's wire rules: the spec's §10.3 and §10.4 name the
defect classes but not the bytes, and this section is where they are defined.

**Paths** (`catalog/path.rs`; spec §10.4, plan O24). A stored path is non-empty
components joined by `/`. A component is non-empty, is not `.` or `..`, and contains no
`/` and no NUL (`PATH_INVALID`). Bounds, enforced by writer and reader alike and
refused as `PATH_INVALID`: a component at most 1,024 bytes, the stored path at most
16,384 bytes, at most 1,024 components. These bounds are part of draft 2 (a wire
rule of the catalog, not a configurable reader limit; the reference has no knob for
them). Nothing else is required: POSIX names are arbitrary bytes, Windows names are
WTF-8 by convention, and the reader neither requires nor checks UTF-8 or WTF-8
validity, never normalizes, and never case-folds.

**Extents** (`catalog/extent.rs`; §10.3). For each file version: ordinals are exactly
0, 1, 2, … in order; every length is greater than zero (a hole too); each extent starts
where the previous ended and the first at 0 (no gap, no overlap); the total is exactly
`logical_len`; a chunk extent reads `[chunk_offset, chunk_offset + length)` within the
chunk's `decoded_len`; a hole has `chunk_offset` 0; the chunk exists. Adjacent extents
may point into the same chunk. A directory has no extents and a zero-length file has
none. All sums are overflow-checked. `content_hash` is not recomputed here: that
needs the decoded content and belongs to the content levels of `verify`.

**Namespace** (`catalog/namespace.rs`; §10.2). Operations replay in commit-chain order,
then by `op_seq` within a commit. `put` creates or replaces; `delete` of an absent path
is invalid; every entry's parent exists as a directory at the end of the commit
(top-level entries have the implicit root); deleting or replacing a directory with a
file leaves no entry beneath it (non-recursive); a put names a known file version. The
state is judged **after** the whole commit, so a rename (delete then put) and a child
created before its parent in one commit are valid. Replay covers the rows of `commits` in `seq` order: the first row has no parent and
each later row's `parent_seq` equals the previous row's `seq`, otherwise the chain is not
linear (`CATALOG_INVALID`); the catalog does not itself require consecutive sequence
numbers. The caller then requires the catalog's head `seq` to equal the sequence of the
commit that references the image, and `archive_meta.archive_id` to equal that
commit's archive ID (`RECORD_INVALID`, `publish.rs`). Rows with no referrer —
an object without a chunk, a chunk with no extent (stream-only chunks, D19), a file
version no commit puts — are allowed.

**Cross-record consistency** is not the catalog's: `objects.stored_len` and
`stored_hash` against the real frame bytes, `object_locations` against the file, and
`protection = 'aead'` against the descriptor's Encrypted feature are checked by
`verify`'s object levels and by the manifests' own rules (R3 §7.1).

## 4. §10.1 tables this DDL does not have

§10.1 lists twelve logical tables; seven are in §2. The other five are not tables in
1.0. Where their information lives instead:

| §10.1 table | 1.0 location |
|---|---|
| `dictionaries` | None: no dictionaries are written. `chunk_dependencies` reserves the `dictionary` kind |
| `key_envelopes` | Key envelopes are their own frames (R5 §3), listed by every commit (commit key 11); key operations and state are in the manifests (manifest key 13). Nothing in the catalog |
| `parity_groups` | Not a record: each parity frame self-describes its group, checked against the commit chain and the descriptor (D21 item 7, R6 §5) |
| `retained_roots` | Retention operations and state are in the recovery manifests (manifest key 11, D18), rebuilt by replay |
| `search_documents` | None: 1.0 search reads the namespace and file versions directly (C13); no extraction index |

Conversely, two DDL tables are not named in §10.1. They split a §10.1 table's
purpose into its own relation:

| DDL table | Split from | Why |
|---|---|---|
| `object_locations` | `objects` ("sizes and locations") | Identity is kept separate from location (§17), so a location can change (compaction, a future segmented layout) without touching identity |
| `chunk_dependencies` | `chunks` ("encoding dependencies") | A chunk may declare several dependencies; one row each |

Preserved attributes (§10.4.1, D6) are likewise **not** catalog columns: the
manifests carry them (manifest file-version key 5), and restore rebuilds them from
the segment's snapshot manifest and deltas (`publish::promised_attributes`).

## 5. Decisions on the open items (delegated, 2026-10-11)

1. **§10.1 lists logical records.** The spec is amended (§10.1): a logical record may
   live outside the SQLite catalog when another structure is its authority, and the
   1.0 placements of §4 are named. No tables are added. The manifests are the
   authority by design (D10, D18, D20), and a second copy in the catalog would be a
   second truth to keep consistent.
2. **Attributes are manifest-only in 1.0.** Stated in the same §10.1 amendment:
   restoring attributes needs the segment's manifests, not only the head's image.
3. **`user_version` becomes 1 at the R4 freeze**, in the same change that freezes the
   DDL, and before the R8 golden set is regenerated (never after, or every stored
   hash in R8 changes twice). **Done 2026-10-12** (§6): `schema::SCHEMA_VERSION` is 1.
4. **`schema.rs`'s stale comment**: fixed with the draft.
5. **Images are compared by content, never by bytes.** Stated in §10.5 (amendment):
   no canonical page layout or row order is defined, and an independent reader (R9)
   must not assume byte-identical images.

## 6. Freeze review (2026-10-12)

Run together with R1's (R1 §7 has the method, authority, and the stop rule). This
section records what concerns the catalog.

**Checked.**

* **The drift test passes**: the DDL byte for byte, the header values, the `archive_meta`
  keys, and the §10.1 table list against the spec.
* **`user_version` 1 is written and 0 is refused.** `SCHEMA_VERSION` is 1; the envelope's
  record schema version follows it (`IMAGE_RECORD_SCHEMA`). `c3/valid-catalog-v0.sqlite`
  was regenerated: **it differs from the old file in one byte, offset 63** (`user_version`
  0 → 1) and in nothing else, and the `c3` test opens it with the same expected content.
  The file name keeps "v0" (the c3 vector set's name); the header value is 1.
* **Every golden archive that embeds an image was regenerated** (R1 §7 and the PR list
  each file): their images differ from the old ones in the `user_version` byte and in the
  hashes, offsets, and IDs that depend on the descriptor.
* **The stored-schema rows** of §2 reproduce with SQLite 3.45.1 (Python `sqlite3`): ten
  rows as described, the autoindex row's `sql` NULL.

**Found and fixed at the freeze** (text only, plus the one planned value).

1. **The path rules were nowhere in the text** — neither the spec (§10.4 names no bytes)
   nor R3 nor this file (cold reads of R3 and R4 both found it). `path.rs` has them;
   §3.1 states them. The three length bounds were commented "draft limits
   (placeholders)" in the code; the call is that they are fixed by draft 2 (§3.1),
   because the reference refuses beyond them today, so freezing them changes no archive
   any build accepts. A later raise is a new draft.
2. **The extent and namespace rules** were referenced ("the §10.3 rules") but not
   stated; §3.1 states them from `extent.rs` and `namespace.rs`.
3. **The exact-schema comparison** was not specified as stored text; §2 now says so,
   with the ten rows.
4. **Which check gives which code**, which headers fields are not checked, the size
   limit and its page rounding: §3 "Codes".
5. **Stale banner and future-tense text** ("not frozen", "freezes at Beta", decision 3
   "becomes 1").

**Cold read.** A fresh subagent was given only `docs/spec.md` and this file (no code).
It read spec lines 1 to 700, §17, §20, §26 to §28, and Annex B up to B.2.5. Findings and
calls (B = could change a verdict):

| # | Finding | Call |
|---|---|---|
| 1 | B: exact-schema comparison unspecified | **Fixed** (§2). |
| 2 | B: header fields beyond bytes 16 to 19 | **Fixed** (§3 Codes): not checked; `integrity_check` decides. |
| 3 | B: check order and error codes | **Fixed** (§3 Codes). |
| 4 | B: `user_version` versus envelope; other values | **Fixed** (§3 Codes; R2 §2). |
| 5 | B: size limit and pages | **Fixed** (§3 Codes). |
| 6 | B: extent rules | **Fixed** (§3.1). |
| 7 | `content_hash` recomputation | **Fixed** (§3.1): a content-level check, not the catalog's. |
| 8 | B: namespace and path rules | **Fixed** (§3.1). |
| 9 | `commits` versus the chain | **Fixed** (§3.1). |
| 10 | Orphan rows | **Fixed** (§3.1): allowed. |
| 11 | `archive_meta` required keys | **Fixed** (§1). |
| 12 | Cross-table consistency | **Fixed** (§3.1, last paragraph). |
| 13 | Integer and storage-class rules | **Fixed** (§3 Codes). |
| 14 | SQLite version; conformance versus advice | **Fixed** (§2: 3.37+). §3 step 2's settings are the reference reader's hardening, not wire requirements; the wire requirements are steps 1, 3, and 4. A reader may harden differently. |

Text-only items: the "§10.1 lists twelve logical tables" arithmetic is 7 + 5 = 12 and
holds (the two split tables are extra, in the second table of §4); "images are compared
by content" (decision 5) means a replay-state comparison, defined by the manifests
(R3 §7.1, snapshot self-containment), not by this file; the sealed form's order (hash,
then tag, then header checks) is R5 §5. The spec's "proposed page size" was corrected
(§10.5). The stale-banner contradictions the reader listed are the fixes above.

**Calls on the open items.** Decisions 1 to 5 (§5) stand; decision 3 is done.

**What the review did not do.** It did not benchmark in-memory indexes (K12 says a reader
may add them; D1's 100k-entry browsing is the desktop's concern), and it did not repeat
the cold read after the fixes.
