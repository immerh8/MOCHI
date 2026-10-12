# R4 — Catalog SQLite DDL and constraints (DRAFT, not frozen)

> **Status 2026-10-11: draft.** Written from the working code at `main` commit
> `57e3a69`, as plan §6 requires. It is **not frozen**: it freezes at Beta. The DDL
> in §2 is compared byte for byte with `mochi_core::catalog::schema::DDL`, and the
> tables marked *(checked)* with the code, by
> `crates/mochi-cli/tests/ratification_drafts.rs`.

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
| `user_version` | `0` (draft; ratified schemas start at 1) | `schema::SCHEMA_VERSION`; equals the binary envelope's record schema version |
| Page size | `4096` | `schema::PAGE_SIZE` |
| File format read/write versions | `1` / `1` (rollback journal, not WAL) | header bytes 18–19 |

**`archive_meta` keys written.** *(checked)*

| Key | Value |
|---|---|
| `archive_id` | The 32-byte archive ID |
| `writer_params` | Deterministic CBOR `{0: 0 (chunking kind: fixed size), 1: chunk size, 2: zstd level}` |

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
   `user_version` = 0 (else `UNSUPPORTED_FEATURE`).
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

A failure in 3 or 4 is `CATALOG_INVALID` (or the more specific `EXTENT_INVALID`,
`NAMESPACE_INVALID`, `PATH_INVALID`). The checks run identically on an image opened
for writing (`open_image_writable`); the image bytes are never modified.

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
   hash in R8 changes twice).
4. **`schema.rs`'s stale comment**: fixed with the draft.
5. **Images are compared by content, never by bytes.** Stated in §10.5 (amendment):
   no canonical page layout or row order is defined, and an independent reader (R9)
   must not assume byte-identical images.
