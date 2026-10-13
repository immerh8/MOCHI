# R3 — Canonical serialization and domain separators (FROZEN, draft 2)

> **Status 2026-10-12: frozen as part of draft 2** (gate G12, [delegated 2026-10-12];
> owner review pending at the desktop checkpoint, plan K11), with R1, R2, and R4, by the
> review in §11. Written the same day from the working code at `main` commit `17fe094`
> and the golden vectors in `fixtures/golden/`, as plan §6 and
> `docs/ratification-core-plan.md` W13 require. The file name keeps "draft" for links.
> A change to an encoding rule, a schema, a separator, or the commit ID construction is
> a new draft identifier and an Annex B entry (spec B.2.14), never an edit. Tables marked
> *(checked)* are compared with the code by
> `crates/mochi-cli/tests/ratification_drafts.rs`. The CDDL files in `docs/schemas/` are
> checked against the bytes the code writes by `crates/mochi-testkit/tests/r3_cddl.rs`
> (§8). The schema texts the writing of this file corrected are listed in §9; the freeze
> changed no schema rule.

Sources: spec §9.2, Annex B.1 D2, Annex B.2 D10, D11, D12, D14, D15, B.2.2, B.2.3, and
the Encrypted and Redundancy profiles (B.2.10 D20, B.2.11 D21). Plan O2 and O20.
Code: `crates/mochi-format/src/cbor.rs` (the one codec), `digest.rs` (the separators),
`repr.rs` (`CanonicalCommitBody`), and the record codecs in
`crates/mochi-core/src/{descriptor,commit,manifest,keys,retention,quarantine}.rs`.
Schemas: `docs/schemas/*.cddl`.

R3 owns four things: the **encoding** every canonical structure uses (§1, §2), the
**schemas** and which version a writer uses when (§3, §6), the **commit ID**
construction (§4), and the **domain separators** (§5). It also lists what the schemas
cannot say (§7), which is the list a second implementation (R9) must check by hand.

## 1. The encoding (D2)

Every canonical structure in MOCHI (the archive descriptor, commit records, recovery
manifests, key envelopes, and the tail-quarantine sidecar's metadata) is **deterministic
CBOR** (RFC 8949 §4.2.1 core deterministic encoding), restricted to a subset, through
the one codec in `mochi-format/src/cbor.rs`. Opaque payloads (catalog images, parity
frames) do not use it; they carry the binary envelope of R2. Nothing serializes a
canonical structure with a general-purpose CBOR library.

The subset:

- **Major types.** 0 (unsigned integer), 1 (negative integer, down to −2^64), 2 (byte
  string), 3 (UTF-8 text string), 4 (array), 5 (map). Major type 6 (tags) is refused.
- **Major type 7.** Only `false` (`f4`), `true` (`f5`), and `null` (`f6`). Floats,
  `undefined`, and every other simple value are refused.
- **Lengths and integers are definite and shortest-form.** An argument that fits in a
  shorter head is refused, in an integer, in a string or array or map length, and in a
  map key. Indefinite lengths and the reserved additional-information values 28 to 30
  are refused.
- **Maps** have unsigned-integer keys in **strictly increasing** order. For
  shortest-form integer keys that equals RFC 8949 §4.2.1's bytewise ordering of the
  encoded keys, and it makes a duplicate key impossible. A map key of any other type is
  refused.
- **Text strings** must be valid UTF-8. The codec applies no normalization; a text
  string in a record is opaque.
- **Exactly one value, no trailing bytes.**
- **The decoder re-encodes what it read and requires identical bytes** (§2.1).

### 1.1 Constructs the codec accepts and refuses

*(checked: every row is decoded by `mochi_format::cbor::decode`.)* The input column is
hex; `XX×N` repeats a byte N times. A limits cell of `items=N` lowers the item limit to
N for that row; `default` uses `CborLimits::default()`.

| Construct | Input (hex) | Limits | Verdict | Fault |
|---|---|---|---|---|
| unsigned 0 | `00` | default | accepted | — |
| unsigned 23, the last one-byte head | `17` | default | accepted | — |
| unsigned 24, the first two-byte head | `18 18` | default | accepted | — |
| unsigned 255 | `18 ff` | default | accepted | — |
| unsigned 256 | `19 01 00` | default | accepted | — |
| unsigned 65536 | `1a 00 01 00 00` | default | accepted | — |
| unsigned 2^32 | `1b 00 00 00 01 00 00 00 00` | default | accepted | — |
| unsigned 2^64 − 1 | `1b ff×8` | default | accepted | — |
| negative −1 | `20` | default | accepted | — |
| negative −2^64 | `3b ff×8` | default | accepted | — |
| false | `f4` | default | accepted | — |
| true | `f5` | default | accepted | — |
| null | `f6` | default | accepted | — |
| empty byte string | `40` | default | accepted | — |
| byte string | `44 01 02 03 04` | default | accepted | — |
| empty text string | `60` | default | accepted | — |
| text string | `62 c3 a9` | default | accepted | — |
| empty array | `80` | default | accepted | — |
| array | `82 01 02` | default | accepted | — |
| empty map | `a0` | default | accepted | — |
| map, increasing keys | `a2 00 01 01 02` | default | accepted | — |
| map, key 24 in its shortest form | `a1 18 18 00` | default | accepted | — |
| 0 in two bytes | `18 00` | default | refused | NotShortest |
| 23 in two bytes | `18 17` | default | refused | NotShortest |
| 255 in three bytes | `19 00 ff` | default | refused | NotShortest |
| 65535 in five bytes | `1a 00 00 ff ff` | default | refused | NotShortest |
| 2^32 − 1 in nine bytes | `1b 00 00 00 00 ff ff ff ff` | default | refused | NotShortest |
| negative integer, not shortest | `38 00` | default | refused | NotShortest |
| byte-string length, not shortest | `58 00` | default | refused | NotShortest |
| text-string length, not shortest | `78 00` | default | refused | NotShortest |
| array length, not shortest | `98 00` | default | refused | NotShortest |
| map length, not shortest | `b8 00` | default | refused | NotShortest |
| map key, not shortest | `a1 18 00 00` | default | refused | NotShortest |
| tag 0 | `c0 60` | default | refused | Tag |
| tag 24 | `d8 18 40` | default | refused | Tag |
| half-precision float | `f9 3c 00` | default | refused | Float |
| single-precision float | `fa 3f 80 00 00` | default | refused | Float |
| double-precision float | `fb 3f f0 00 00 00 00 00 00` | default | refused | Float |
| `undefined` | `f7` | default | refused | SimpleValue |
| simple value 0 | `e0` | default | refused | SimpleValue |
| simple value 32 | `f8 20` | default | refused | SimpleValue |
| `false` in two bytes | `f8 14` | default | refused | SimpleValue |
| indefinite byte string | `5f ff` | default | refused | Indefinite |
| indefinite text string | `7f ff` | default | refused | Indefinite |
| indefinite array | `9f ff` | default | refused | Indefinite |
| indefinite map | `bf ff` | default | refused | Indefinite |
| a lone break | `ff` | default | refused | Indefinite |
| additional information 28 | `1c` | default | refused | ReservedAdditionalInfo |
| additional information 29 | `3d` | default | refused | ReservedAdditionalInfo |
| additional information 30 | `5e` | default | refused | ReservedAdditionalInfo |
| text key | `a1 61 61 00` | default | refused | NonIntegerKey |
| byte-string key | `a1 41 00 00` | default | refused | NonIntegerKey |
| negative key | `a1 20 00` | default | refused | NonIntegerKey |
| keys not increasing | `a2 01 00 00 00` | default | refused | KeyOrder |
| duplicate key | `a2 00 01 00 02` | default | refused | KeyOrder |
| invalid UTF-8 | `61 ff` | default | refused | InvalidUtf8 |
| overlong UTF-8 | `62 c0 80` | default | refused | InvalidUtf8 |
| an encoded surrogate | `63 ed a0 80` | default | refused | InvalidUtf8 |
| empty input | `` | default | refused | Truncated |
| head cut short | `18` | default | refused | Truncated |
| head cut short, longer | `19 01` | default | refused | Truncated |
| nested head cut short | `81 18` | default | refused | Truncated |
| string longer than the input | `44 01` | default | refused | LengthExceedsInput |
| array longer than the input | `83 00` | default | refused | LengthExceedsInput |
| map longer than the input | `a2 00` | default | refused | LengthExceedsInput |
| a length of 2^64 − 1 | `5b ff×8` | default | refused | LengthExceedsInput |
| a second value | `00 00` | default | refused | TrailingBytes |
| 64 nested arrays | `81×64 00` | default | accepted | — |
| 65 nested arrays | `81×65 00` | default | refused | TooDeep |
| a map with one pair is 3 items | `a1 00 00` | items=3 | accepted | — |
| a map with one pair is 3 items | `a1 00 00` | items=2 | refused | TooManyItems |
| an array of 3 is 4 items | `83 00 00 00` | items=4 | accepted | — |
| an array of 4 is 5 items | `84 00 00 00 00` | items=4 | refused | TooManyItems |

Notes on the table:

- **`NotCanonical` has no row.** It is the decoder's last guard: after every check above
  has passed, the value is re-encoded and compared with the input (§2.1). The individual
  checks are meant to leave it unreachable; it is there so that a gap in one of them
  still cannot admit a non-canonical input.
- **Depth and items** count as the decoder counts them: the root is depth 0, each array
  element or map value is one deeper (a key adds no depth), and every value *and every
  map key* is one item.
- **Order of checks.** A head is read and validated before its length is compared with
  the input, so `5b ff×8` is `LengthExceedsInput`, not an allocation.

### 1.2 Codec faults and their error codes

*(checked: every fault is constructed, mapped with `MochiError::from`, and compared; the
list of faults is an exhaustive `match`, so a new fault fails the test until this table
lists it.)*

| Fault | Error code | Meaning |
|---|---|---|
| Truncated | TRUNCATED | The input ends inside a head |
| NotShortest | RECORD_INVALID | An integer, length, or key not in its shortest form |
| ReservedAdditionalInfo | RECORD_INVALID | Additional information 28, 29, or 30 |
| Indefinite | RECORD_INVALID | Indefinite length (additional information 31) or a stray break |
| Tag | RECORD_INVALID | Major type 6 |
| Float | RECORD_INVALID | A half, single, or double float |
| SimpleValue | RECORD_INVALID | A simple value other than false, true, null |
| NonIntegerKey | RECORD_INVALID | A map key that is not an unsigned integer |
| KeyOrder | RECORD_INVALID | Map keys not strictly increasing (unsorted or duplicate) |
| InvalidUtf8 | RECORD_INVALID | A text string that is not UTF-8 |
| LengthExceedsInput | TRUNCATED | A declared length larger than the remaining input |
| TooDeep | LIMIT_EXCEEDED | Nesting deeper than the depth limit |
| TooManyItems | LIMIT_EXCEEDED | More items than the item limit |
| TrailingBytes | RECORD_INVALID | Bytes after the one value |
| NotCanonical | RECORD_INVALID | Decoded, but did not re-encode to the same bytes |

Plan W13 expected every codec rejection to be `RECORD_INVALID`. The code is finer, and
the table states what it does: a record that is *cut short* is `TRUNCATED` and one that
exceeds a *limit* is `LIMIT_EXCEEDED`, because neither says the writer was wrong (a
reader with larger limits, or the rest of the bytes, may accept it). Open item 1 asks
that the plan text follow the table.

The record layers re-map codec faults to their own code: the archive descriptor reports
every decode failure as `DESCRIPTOR_INVALID` except refusals (`UNSUPPORTED_FEATURE`) and
reader limits (`LIMIT_EXCEEDED`), per D12. §2.2 lists the rest.

### 1.3 Writer refusals

*(checked.)* The encoder never repairs a value: it refuses, and no record is published.

| Case | Result |
|---|---|
| a map with keys 1 then 0 | `encode` fails with INVALID_ARGUMENT (a caller bug; keys are never re-sorted) |
| 65 nested arrays around the integer 0 | `encode_within` fails with CAPACITY_EXCEEDED (depth) |
| 64 nested arrays around the integer 0 | `encode_within` succeeds |
| an array of 2 under items=2 | `encode_within` fails with CAPACITY_EXCEEDED (items: the array and 2 elements make 3) |
| an array of 1 under items=2 | `encode_within` succeeds |

Writers encode every record with `encode_within` and the **reader defaults** (B.2.3,
"writer default rule"), whatever limits they read with, so a default reader can always
decode what a default writer wrote.

### 1.4 Limits

| Limit | Default | Source |
|---|---|---|
| Depth | 64 | B.2.3 "CBOR items / depth" |
| Items | 16,777,216 (16 Mi) | B.2.3 |

*(checked against `CborLimits::default()`.)* Both are reader limits, not wire rules: a
reader may be configured lower or, explicitly, higher. The comment on
`CborLimits` in `cbor.rs` still calls them placeholders (open item 6).

## 2. Rejections above the codec

### 2.1 The re-encoding rule

D2: *a reader MUST reject any input that does not re-encode to identical bytes.* The
codec does it as its last step (`NotCanonical`, §1.2). The record layers add nothing to
the rule and never accept bytes the codec refused. The commit ID makes the same
requirement from the other side: it is a hash of a canonical encoding, so two encodings
of one record would be two records (§4).

### 2.2 Record-level causes

*(checked: each row's vector is looked up in its `vectors.txt` and must list the code.)*
After the codec, each record type is read through a **closed schema**: a missing
required key, an unknown key, a value of the wrong CBOR type, and a byte string of the
wrong size are all errors, because a new field means a new schema version (D10, D11).

| Cause | Code | Vector |
|---|---|---|
| a manifest key not in non-shortest form | RECORD_INVALID | `c4/reject-manifest-noncanonical-cbor.bin` |
| a commit key not in non-shortest form | RECORD_INVALID | `c5/reject-commit-noncanonical-cbor.bin` |
| a descriptor key not in non-shortest form | DESCRIPTOR_INVALID | `b2/reject-descriptor-noncanonical-cbor.bin` |
| bytes after the manifest map | RECORD_INVALID | `c4/reject-manifest-payload-not-consumed.bin` |
| bytes after the commit map | RECORD_INVALID | `c5/reject-commit-payload-not-consumed.bin` |
| an unknown manifest key | RECORD_INVALID | `c4/reject-manifest-unknown-key.bin` |
| an unknown commit key | RECORD_INVALID | `c5/reject-commit-unknown-key.bin` |
| an unknown descriptor key | DESCRIPTOR_INVALID | `b2/reject-descriptor-unknown-key.bin` |
| a missing manifest key | RECORD_INVALID | `c4/reject-manifest-missing-key.bin` |
| a missing commit key | RECORD_INVALID | `c5/reject-commit-missing-key.bin` |
| a missing descriptor key | DESCRIPTOR_INVALID | `b2/reject-descriptor-missing-key.bin` |
| a transaction ID of 15 bytes (manifest) | RECORD_INVALID | `c4/reject-manifest-short-transaction-id.bin` |
| a transaction ID of 15 bytes (commit) | RECORD_INVALID | `c5/reject-commit-short-transaction-id.bin` |
| an archive ID of the wrong size (descriptor) | DESCRIPTOR_INVALID | `b2/reject-descriptor-short-archive-id.bin` |
| a schema version this build does not know (manifest) | UNSUPPORTED_FEATURE | `c4/reject-manifest-schema-version.bin` |
| a schema version this build does not know (commit) | UNSUPPORTED_FEATURE | `c5/reject-commit-schema-version.bin` |
| a schema version this build does not know (descriptor) | UNSUPPORTED_FEATURE | `b2/reject-descriptor-schema-version.bin` |
| the legacy manifest schema 0 | UNSUPPORTED_FEATURE | `c4/reject-manifest-legacy-v0.bin` |
| the legacy commit schema 0 | UNSUPPORTED_FEATURE | `c5/reject-commit-legacy-v0.bin` |
| an unknown required feature (manifest) | UNSUPPORTED_FEATURE | `c4/reject-manifest-required-feature.bin` |
| an unknown required feature (commit) | UNSUPPORTED_FEATURE | `c5/reject-commit-required-feature.bin` |
| an unknown required feature (descriptor) | UNSUPPORTED_FEATURE | `b2/reject-descriptor-unknown-feature.bin` |
| required features not strictly increasing (manifest) | ENVELOPE_INVALID | `c4/reject-manifest-features-not-increasing.bin` |
| required features not strictly increasing (commit) | ENVELOPE_INVALID | `c5/reject-commit-features-not-increasing.bin` |
| required features not strictly increasing (descriptor) | DESCRIPTOR_INVALID | `b2/reject-descriptor-features-not-increasing.bin` |
| a symbolic-link entry (kind 2, reserved) | UNSUPPORTED_FEATURE | `c4/reject-manifest-symlink-kind.bin` |
| a commit ID that is not the recomputed one | RECORD_INVALID | `c5/reject-commit-id-mismatch.bin` |
| a stored path that is not a valid path | PATH_INVALID | `c4/reject-manifest-traversal-path.bin` |
| a record's payload in a frame of another kind (manifest) | MALFORMED_FRAME | `c4/reject-manifest-wrong-frame-kind.bin` |
| a second frame after the record (commit) | MALFORMED_FRAME | `c5/reject-commit-trailing-frame.bin` |

An unknown or legacy **schema version**, an unknown **required feature**, and a
**reserved kind** are *refusals*, not damage: a newer or older writer produced something
this build will not interpret (`UNSUPPORTED_FEATURE`, exit 4). Features that are not
strictly increasing are the shared D11 rule (`ENVELOPE_INVALID`), checked before the
"known" test so that a fault in the list itself keeps its own code.

## 3. Schema registry

One row per schema version. *(checked: the CDDL file exists and contains its version
literal; the frame kind is registered; the versions a build reads and the legacy version
equal the code's constants.)* The **Written when** column is stated exactly in §6.

| Record | Version | Frame kind | CDDL file | Written when | Status |
|---|---|---|---|---|---|
| Archive descriptor | 0 | `0x184D2A57` | `archive-descriptor-v0.cddl` | always | frozen |
| Commit record | 0 | `0x184D2A51` | `commit-record-v0.cddl` | never: legacy, refused | legacy |
| Commit record | 1 | `0x184D2A51` | `commit-record-v1.cddl` | the commit lists no required feature | frozen |
| Commit record | 2 | `0x184D2A51` | `commit-record-v2.cddl` | Encrypted profile | frozen; keys 11 and 12 frozen with R5 |
| Recovery manifest | 0 | `0x184D2A58` | `recovery-manifest-v0.cddl` | never: legacy, refused | legacy |
| Recovery manifest | 1 | `0x184D2A58` | `recovery-manifest-v1.cddl` | no retention data, no provenance, not Encrypted | frozen |
| Recovery manifest | 2 | `0x184D2A58` | `recovery-manifest-v2.cddl` | retention data or provenance, not Encrypted | frozen |
| Recovery manifest | 3 | `0x184D2A58` | `recovery-manifest-v3.cddl` | Encrypted profile | frozen; key 13 and the provenance reason frozen with R5 |
| Key envelope | 0 | `0x184D2A5C` | `key-envelope-v0.cddl` | Encrypted profile | frozen with R5 |
| Tail-quarantine sidecar metadata | 0 | none (a tool file) | `tail-quarantine-v0.cddl` | `append --truncate-tail` | frozen (Appendix A) |

The catalog image, the sealed object, and the parity frame are not CBOR records. Their
layouts are R2 (binary envelope v0), R5 §5 (sealed object, frozen), and R6 §4 (parity
frame), and R1 §5 lists their record schema versions.

Every schema file is **complete and standalone** (K14 c): it defines every rule it uses,
draws every key the code accepts, and defers to no other file for a definition. §8
describes the mechanical check. Version numbers are not renumbered, and commit and
manifest schema 0 stay refused as legacy (K14 b).

Schema versions are chosen by the record's **key 0**. A reader reads it first; an
unknown value is refused (§2.2) before any other key is interpreted.

## 4. Commit ID

The commit ID is the one digest that is defined by the canonical encoding rather than by
stored bytes (spec §9.2: *domain-separated canonical commit body, excluding the ID field
itself*).

*(checked against the vectors below and every commit in the golden archives.)*

1. Take the commit record as the map it is stored as (commit-record-v1.cddl or
   commit-record-v2.cddl).
2. **Remove key 9** (the ID). Every other key and value is unchanged. The result is the
   **body**; it has one entry fewer than the record.
3. Encode the body as canonical CBOR with the codec of §1. (It is not stored; it is
   recomputed.)
4. The commit ID is BLAKE3-256 of `COMMIT_ID_DOMAIN` (§5) followed by the body bytes.
5. Key 9 of the stored record **must equal** the recomputed value; otherwise the commit
   is `RECORD_INVALID` (§2.2).

Hash acyclicity (D10, D11): every object a commit references (descriptor, manifests,
catalog image, key envelopes) lies before the commit frame and none contains the
commit's ID. They carry only the archive ID, the sequence, and the transaction ID. In
commit schema 2 the ID also covers keys 11 and 12, so the envelope set and the data
region are bound by the chain.

The ID is a type of its own (`Digest<CommitIdScope>`), constructible only from a
`CanonicalCommitBody`, which is a byte-string newtype that cannot be made from stored
bytes or from compressed-plaintext representations (`repr.rs`).

Vectors *(checked)*, from `fixtures/golden/c5/vectors.txt`:

| Vector | Commit ID |
|---|---|
| `c5/valid-commit-root.bin` | `b4592ef9ac9cc216937605d9a2f5067c827e6f033bda0391a6fb10f7162ca692` |
| `c5/valid-commit-child.bin` | `d899e30833e2ee8dd89f07ab6f25eeb035894ee18af657d8ca196b9f37b25c56` |
| `c5/valid-commit-delta.bin` | `a7cf5aed31f4aaa2061c4002bd7a618d43781cf628602f777e02166de7e7d2b8` |

A separate implementation must reproduce these three values from the three files with
nothing but a CBOR decoder, a CBOR encoder that honours §1, and BLAKE3.

## 5. Domain separators

Every BLAKE3 digest scope except two begins with a **domain separator**: the ASCII
string `MOCHI2-<SCOPE>` followed by **one zero byte**. The footer's separator is
spec-given (§8.4); the others are the strings of `digest.rs`, which this document
froze as written (K14 a). Two AEAD associated-data prefixes follow the same shape.
Each is defined once, in `mochi-format/src/digest.rs`; no other module spells one.

*(checked: the bytes, the lengths, and the scope names equal `digest::ALL_DOMAINS`,
`AEAD_DOMAINS`, and `Digest::scope_name()`; every digest vector in
`fixtures/golden/c2/vectors.txt` is recomputed with the bytes in this table.)*

| Constant | Bytes | Length | Scope | Input |
|---|---|---|---|---|
| `FOOTER_DOMAIN` | `MOCHI2-FOOTER ‖ 00` | 14 | footer | footer payload bytes 0 to 31, then the stored commit frame (R1 §3) |
| `CHUNK_CONTENT_DOMAIN` | `MOCHI2-CHUNK-CONTENT ‖ 00` | 21 | chunk-content | the exact decoded chunk bytes |
| `STORED_OBJECT_DOMAIN` | `MOCHI2-STORED-OBJECT ‖ 00` | 21 | stored-object | the exact stored object bytes, framing included; also the metadata-object and recovery-manifest hashes (O20) |
| `DICTIONARY_DOMAIN` | `MOCHI2-DICTIONARY ‖ 00` | 18 | dictionary | the exact dictionary bytes |
| `COMMIT_ID_DOMAIN` | `MOCHI2-COMMIT-ID ‖ 00` | 17 | commit-id | the canonical commit body (§4) |
| `PARITY_SHARD_DOMAIN` | `MOCHI2-PARITY-SHARD ‖ 00` | 20 | parity-shard | one data shard, zero-padded to the shard size (R6) |
| `PARITY_FRAME_DOMAIN` | `MOCHI2-PARITY-FRAME ‖ 00` | 20 | parity-frame | every byte of a parity frame before its digest (R6) |

The two AEAD prefixes are not BLAKE3 scopes. They begin the associated data of a key
wrap and of a sealed object, so that a ciphertext made for one purpose cannot
authenticate as the other (R5 §3 and §5, frozen). *(checked, as above.)*

| Constant | Bytes | Length | Scope | Input |
|---|---|---|---|---|
| `KEY_WRAP_DOMAIN` | `MOCHI2-KEY-WRAP ‖ 00` | 16 | key-wrap | prefix of the wrap associated data (spec B.2.10 item 3) |
| `OBJECT_SEAL_DOMAIN` | `MOCHI2-OBJECT-SEAL ‖ 00` | 19 | object-seal | prefix of the sealed-object associated data (spec B.2.10 item 5) |

Two scopes are **deliberately unseparated** (O20, K14 a). *(checked: both constants are
empty.)*

| Constant | Bytes | Scope | Why |
|---|---|---|---|
| `FILE_CONTENT_DOMAIN` | `` | file-content | The file-content hash is plain BLAKE3-256, equal to `b3sum` of the restored file, so a user can check a restoration with a stock tool and a separate reader needs nothing MOCHI-specific to compute it. It survives a later wire generation unchanged (§26). |
| `TAIL_QUARANTINE_DOMAIN` | `` | tail-quarantine | The sidecar's tail hash is plain BLAKE3 by the spec's own definition (B.2.2), so `b3sum` over the removed bytes checks it. It is not part of the archive format. |

**Prefix-freeness.** Each separator above contains exactly one zero byte, and it is the
last byte. A string that is a proper prefix of another would have to end in a zero byte
inside the longer one, which has none before its end, so no separator is a prefix of
another, and a hash input from one scope can never be parsed as the separator of
another. *(checked: the test asserts the one-zero-at-the-end shape of every separator
and that none is a prefix of another.)* `PARITY_SIGNATURE` (`MOCHI2-PARITY` and three
zero bytes) is a payload signature, not a hash separator, and is never an input prefix.

**The cost of the unseparated scope**, stated so no one rediscovers it: a file whose
bytes begin with a MOCHI separator has a file-content hash equal to that scope's hash of
the remainder. That is harmless only because digests are never compared across scopes.
Types enforce it in the code (`Digest<S>`), and every serialization that carries a
digest keeps scopes in distinct, labelled fields (catalog columns, manifest keys,
reports). **A separate implementation must do the same.**

Final strings: the seven BLAKE3 separators and the two AEAD prefixes above are frozen
with R3 (draft 2). A change to any of them is a new wire generation, not an edit.

## 6. One logical structure, one encoding

A record has exactly one valid encoding, and a writer must choose the schema version the
record's content selects. A reader refuses a record written under any other version, so
that two archives with equal content are equal at the byte level of their records and a
manifest's hash cannot differ between writers.

*(checked: the "Schema" column is computed by the code's `schema_version()` for a record
built to satisfy the condition.)*

| Record | Condition | Schema | Wrong-schema vector |
|---|---|---|---|
| Commit record | the commit lists no required feature | 1 | — |
| Commit record | the commit lists required feature 1 (Encrypted) | 2 | — |
| Recovery manifest | no retention operation, an empty retention state, no provenance, not Encrypted | 1 | `c4/reject-manifest-unknown-key.bin` |
| Recovery manifest | a delta with at least one retention operation | 2 | `c4/reject-manifest-retention-schema-2-empty.bin` |
| Recovery manifest | a snapshot with a non-empty retention state | 2 | `c4/reject-manifest-retention-schema-2-missing-key.bin` |
| Recovery manifest | provenance, whether or not retention data | 2 | `c4/reject-manifest-retention-schema-2-empty.bin` |
| Recovery manifest | lists required feature 1 (Encrypted), whatever else it holds | 3 | — |
| Archive descriptor | always | 0 | — |
| Key envelope | always | 0 | — |

Consequences, each enforced on decode:

- **Schema 2 without retention data and without provenance is refused**, and a schema-1
  manifest with key 11 or key 12 is refused. A schema-2 delta may carry an empty key 11
  only together with provenance (the delta of commit 0 of a rewritten archive).
- **Schema 3 exactly in an Encrypted archive.** A manifest whose Encrypted feature
  disagrees with the commit that references it is `RECORD_INVALID`; a commit whose
  disagrees with the archive descriptor is `DESCRIPTOR_INVALID` (D12: a mismatched
  descriptor). The descriptor, the commits, and the manifests of one archive must agree.
- **Commit schema 2 exactly with feature 1.** A schema-1 commit that lists 1 and a
  schema-2 commit that does not are `RECORD_INVALID`, after the shared D11 checks on the
  feature list have passed.
- **Defaults are written by absence.** A provenance whose reason is collection or
  compaction has no key 3; an explicit `0` is refused (open item 2). A commit without a
  recorded time has no key 8 (and an Encrypted commit never has one, D20 item 6). A
  descriptor without the Redundancy profile has no key 1 in `constraints`.
- **Arrays are sorted** wherever the schema says (§7.1), so one logical manifest has one
  byte sequence.

No golden vector exists for the commit rows or for schema 3 (the wrong-schema vector
column says `—`): §7.2 marks them as gaps for the G1 audit.

## 7. What CDDL cannot say, and the vector index

### 7.1 Rules the code checks that the schemas cannot state

The `cddl` crate, and CDDL itself (RFC 8610 with RFC 9165), cannot express relations
between values, sortedness, hash equality, or state replayed across records. Each rule
below is checked by the code at the place named, has the vector shown (a **gap** where
none exists), and is a check a separate implementation (R9) must write by hand. The
schema cannot be validated *around* these rules: a record can satisfy its CDDL and still
be refused.

| Schema | Rule | Checked in | Vector |
|---|---|---|---|
| all | features strictly increasing, and every entry known | `envelope::check_required_features` | `c5/reject-commit-features-not-increasing.bin`, `c5/reject-commit-required-feature.bin` |
| descriptor | the draft identifier is the build's own (null is a ratified archive) | `descriptor.rs` | `b2/reject-descriptor-draft-1.bin`, `b2/reject-descriptor-draft-3.bin`, `b2/reject-descriptor-draft-null.bin` |
| descriptor | the redundancy suite is known | `descriptor.rs` | gap |
| descriptor | the Encrypted feature cannot be combined with the TAR-compatible constraint | `descriptor.rs` | gap |
| commit | parent sequence = sequence − 1 | `commit.rs` `check_structure` | `c5/reject-commit-parent-seq-gap.bin` |
| commit | a base sequence is below the commit's sequence | `commit.rs` `check_structure` | `c5/reject-commit-base-not-before.bin` |
| commit | the descriptor reference is at offset 0 | `commit.rs` `check_structure` | `c5/reject-commit-descriptor-offset.bin` |
| commit | key 9 equals the recomputed commit ID (§4) | `commit.rs` `decode` | `c5/reject-commit-id-mismatch.bin` |
| commit | a parent's footer offset resolves to a valid footer of that commit; every reference ends before the commit frame | `publish.rs` | `c5/reject-archive-parent-offset-no-footer.mochi` |
| commit v2 | key 11 envelopes exist, are distinct, and are listed in increasing envelope-ID order | `keys::read_envelopes` | gap |
| commit v2 | the data region ends before the delta manifest and walks as complete sealed frames of kind data | `commit.rs`, `publish.rs` | gap |
| commit v2 | schema 2 and required feature 1 agree | `commit.rs` `decode` | gap |
| manifest | arrays 5, 6, and 8 are sorted by their first field without duplicates; dependencies sorted | `manifest.rs` `check_structure` | `c4/reject-manifest-unsorted-versions.bin` (versions only; chunks, entries, and dependencies are gaps) |
| manifest | parent sequence = sequence − 1 | `manifest.rs` `check_structure` | `c4/reject-manifest-parent-seq-gap.bin` |
| manifest | a snapshot is self-contained: every version and chunk it references is in it | `manifest.rs` `check_structure` | `c4/reject-manifest-snapshot-not-self-contained.bin` |
| manifest | extents cover exactly [0, logical length) with ordinal = position and length > 0 | `manifest.rs`, `catalog/extent.rs` | gap |
| manifest | stored paths are valid (spec 10.4, O24) | `catalog/path.rs` | `c4/reject-manifest-traversal-path.bin` |
| manifest | an mtime in seconds fits a signed 64-bit integer | `manifest.rs` `decode_int` | gap |
| manifest | retention operations are judged in order against the replayed state; expired and held sequences are bounded by the commit's sequence; expired and holds strictly increase | `retention.rs` | `c4/reject-manifest-retention-expire-self.bin`, `c4/reject-manifest-retention-expired-duplicate.bin`, `c4/reject-manifest-retention-expired-not-earlier.bin`, `c4/reject-manifest-retention-hold-future.bin`, `c4/reject-manifest-retention-holds-unsorted.bin` |
| manifest | provenance: source sequences strictly increase; collected sequences strictly increase, are before the source head, and are not also kept | `manifest.rs` `Provenance::check` | `c4/reject-manifest-provenance-unsorted.bin`, `c4/reject-manifest-provenance-collected-head.bin`, `c4/reject-manifest-provenance-collected-kept.bin` |
| manifest v3 | key operations replay validly: no duplicate add, no remove of a stranger, never an empty set, at most 32 in one commit; a commit's key 11 set equals the replayed set | `manifest.rs`, `keys.rs`, `publish.rs` | gap |
| key envelope | the KDF cost fields: m ≥ 8·p, p ≥ 1, t ≥ 1 (the schema states them) are checked when the passphrase is applied, not when the envelope is decoded (open item 4) | `keys.rs` `unwrap` | `c11/reject-envelope-kdf-memory-below-8-per-lane.bin`, `c11/reject-envelope-kdf-zero-lanes.bin` |
| key envelope | the KDF cost fields are at most the reader's limits, checked before any Argon2 memory is allocated | `kdf.rs` | `c11/reject-envelope-kdf-memory.bin`, `c11/reject-envelope-kdf-iterations.bin`, `c11/reject-envelope-kdf-lanes.bin` |
| key envelope | the wrapped key authenticates under the derived key (a failure is `KEY_UNAVAILABLE`, never damage) | `keys.rs` `unwrap` | `c11/reject-envelope-wrapped-key-flipped.bin` |
| sidecar | the timestamp is a real calendar time, and the pattern is anchored (the `cddl` crate matches `.regexp` as a search, not RFC 8610's full match) | `timestamp.rs` | gap |
| sidecar | the file length equals 12 + L + the tail length, and the tail hashes to key 6 | `quarantine.rs` | gap |

Three lines of that table are a property of the **validator**, not of the format: the
`cddl` crate treats a bare range (`0..4095`) over a byte string as a range of its length,
and `.regexp` as a search. The schemas avoid bare ranges for that reason (`uint .le N`),
and the anchoring is a hand check above.

### 7.2 Vector index

For every position in every schema, the golden files that exercise it. *(checked: every
file named exists in `fixtures/golden/`.)* "Valid" files hold a record that has the
position (a `.mochi` file holds the record inside a whole archive). "Reject" files fail
at the position (schema-level) or exercise the rule of §7.1. **gap** marks a position no
file exercises: it is the input to W16's G1 audit, and this draft fills none of them.
`r3_cddl.rs` still exercises every gap by generated mutants (§8), so a gap here is a gap
in the *golden set*, not in the check. The data comes from
`cargo test -p mochi-testkit --test r3_cddl print_vector_index -- --ignored --nocapture`.

| Schema | Position | Valid | Reject |
|---|---|---|---|
| archive-descriptor-v0 | 0 schema version | `b2/valid-descriptor-minimal.bin` | `b2/reject-descriptor-schema-version.bin` |
| archive-descriptor-v0 | 1 archive ID (32 bytes) | `b2/valid-descriptor-minimal.bin` | `b2/reject-descriptor-short-archive-id.bin` |
| archive-descriptor-v0 | 2 wire generation = 2 | `b2/valid-descriptor-minimal.bin` | `b2/reject-descriptor-generation.bin` |
| archive-descriptor-v0 | 3 draft identifier | `b2/valid-descriptor-minimal.bin` | `b2/reject-descriptor-draft-type.bin` |
| archive-descriptor-v0 | 4 required features | `c11/valid-archive-encrypted.mochi` | `b2/reject-descriptor-features-not-increasing.bin`; gap: an entry that is not an unsigned integer |
| archive-descriptor-v0 | 5 constraints, 5.0 TAR flag | `c10/valid-archive-tar-4-commits.mochi` | `b2/reject-descriptor-constraint-type.bin` |
| archive-descriptor-v0 | 5.1 redundancy | `c12/valid-archive-recovery-record.mochi` | `b2/reject-descriptor-constraint-unknown-key.bin`; gap: a percentage outside 1 to 100, an unknown suite |
| archive-descriptor-v0 | 6 declared limits | `b2/valid-descriptor-declared-limits.bin` | `b2/reject-descriptor-declared-limits-missing-key.bin` |
| archive-descriptor-v0 | unknown key; missing key | — | `b2/reject-descriptor-unknown-key.bin`, `b2/reject-descriptor-missing-key.bin` |
| commit-record-v1 | 0 schema version | `c5/valid-commit-root.bin` | `c5/reject-commit-schema-version.bin`, `c5/reject-commit-legacy-v0.bin` |
| commit-record-v1 | 1 archive ID | `c5/valid-commit-root.bin` | gap |
| commit-record-v1 | 2 sequence, root form and child form | `c5/valid-commit-root.bin`, `c5/valid-commit-child.bin` | `c5/reject-commit-orphan.bin`, `c5/reject-commit-root-with-parent.bin` |
| commit-record-v1 | 3 transaction ID | `c5/valid-commit-root.bin` | `c5/reject-commit-short-transaction-id.bin` |
| commit-record-v1 | 4 parent | `c5/valid-commit-child.bin` | `c5/reject-commit-root-with-parent.bin`; gap: a parent whose commit ID is short |
| commit-record-v1 | 5 checkpoint form | `c5/valid-commit-root.bin` | `c5/reject-commit-checkpoint-missing-snapshot.bin`, `c5/reject-commit-metadata-form.bin` |
| commit-record-v1 | 5 delta-on-base form | `c5/valid-commit-delta.bin` | `c5/reject-commit-delta-with-snapshot.bin`, `c5/reject-commit-root-delta.bin` |
| commit-record-v1 | 6 delta-manifest reference | `c5/valid-commit-root.bin` | `c5/reject-commit-missing-key.bin` |
| commit-record-v1 | 7 required features | `c5/valid-commit-root.bin` | `c5/reject-commit-required-feature.bin` (hand check) |
| commit-record-v1 | 8 informational time | `c5/valid-archive-3-commits.mochi` | gap: nanoseconds of 10^9 or more |
| commit-record-v1 | 9 commit ID | `c5/valid-commit-root.bin` | `c5/reject-commit-id-mismatch.bin` (hand check) |
| commit-record-v1 | 10 descriptor reference | `c5/valid-commit-root.bin` | `c5/reject-commit-missing-descriptor.bin` |
| commit-record-v1 | object reference (offset, length ≥ 8, hash) | `c5/valid-commit-root.bin` | gap: a length below 8, a short hash |
| commit-record-v1 | unknown key | — | `c5/reject-commit-unknown-key.bin` |
| commit-record-v2 | keys 0 to 10 as v1, 7 = [1] | `c11/valid-archive-encrypted.mochi` | gap: no reject vector exists for commit schema 2 |
| commit-record-v2 | 11 key envelopes | `c11/valid-archive-encrypted.mochi` | gap |
| commit-record-v2 | 12 data region | `c11/valid-archive-encrypted.mochi` | gap |
| recovery-manifest-v1 | 0 schema version | `c4/valid-manifest-root-delta.bin` | `c4/reject-manifest-schema-version.bin`, `c4/reject-manifest-legacy-v0.bin` |
| recovery-manifest-v1 | 1 archive ID | `c4/valid-manifest-root-delta.bin` | gap |
| recovery-manifest-v1 | 2, 3 root delta (sequence 0, no parent) | `c4/valid-manifest-root-delta.bin` | `c4/reject-manifest-root-delta-with-parent.bin` |
| recovery-manifest-v1 | 2, 3 child delta (sequence ≥ 1, parent) | `c4/valid-manifest-child-delta.bin` | `c4/reject-manifest-orphan-delta.bin` |
| recovery-manifest-v1 | snapshot (no parent, no operations) | `c4/valid-manifest-snapshot.bin` | `c4/reject-manifest-snapshot-with-parent.bin`, `c4/reject-manifest-snapshot-with-ops.bin` |
| recovery-manifest-v1 | delta with entries (key 8 not empty) | — | `c4/reject-manifest-delta-with-entries.bin` |
| recovery-manifest-v1 | 5 chunk (keys 0 to 8) | `c4/valid-manifest-root-delta.bin` | gap: a non-zero encoding, protection 1, a short hash |
| recovery-manifest-v1 | 5 chunk dependencies | — | gap: no valid vector has a dependency (no 1.0 writer emits one) |
| recovery-manifest-v1 | 6 file version, regular and directory | `c4/valid-manifest-root-delta.bin` | gap: a directory with a content hash or extents |
| recovery-manifest-v1 | 6 extents, data and hole | `c4/valid-manifest-root-delta.bin` | gap: a hole with a non-zero chunk offset |
| recovery-manifest-v1 | 6 attributes, POSIX | `c4/valid-manifest-root-delta.bin` | `c4/reject-manifest-mode-bits.bin` |
| recovery-manifest-v1 | 6 attributes, Windows | `c4/valid-manifest-root-delta.bin` | `c4/reject-manifest-windows-bits.bin` |
| recovery-manifest-v1 | 6 attributes, mtime | `c4/valid-manifest-root-delta.bin` | gap: nanoseconds of 10^9 or more |
| recovery-manifest-v1 | 6 kind 2 (symbolic link, reserved) | — | `c4/reject-manifest-symlink-kind.bin` |
| recovery-manifest-v1 | 7 operations, put and delete | `c4/valid-manifest-child-delta.bin` | gap: an unknown operation kind |
| recovery-manifest-v1 | 8 entries | `c4/valid-manifest-snapshot.bin` | gap |
| recovery-manifest-v1 | 9 required features | `c4/valid-manifest-root-delta.bin` | `c4/reject-manifest-required-feature.bin` (hand check) |
| recovery-manifest-v1 | 10 transaction ID | `c4/valid-manifest-root-delta.bin` | `c4/reject-manifest-missing-transaction-id.bin`, `c4/reject-manifest-short-transaction-id.bin` |
| recovery-manifest-v1 | unknown key; missing key | — | `c4/reject-manifest-unknown-key.bin`, `c4/reject-manifest-missing-key.bin` |
| recovery-manifest-v2 | 11 retention operations (delta) | `c4/valid-manifest-retention-delta.bin` | `c4/reject-manifest-retention-empty-label.bin`, `c4/reject-manifest-retention-unknown-op.bin`; gap: a valid `release` |
| recovery-manifest-v2 | 11 retention state (snapshot) | `c4/valid-manifest-retention-snapshot.bin` | `c4/reject-manifest-retention-state-in-delta.bin`, `c4/reject-manifest-retention-ops-in-snapshot.bin` |
| recovery-manifest-v2 | schema 2 with no retention data or provenance | — | `c4/reject-manifest-retention-schema-2-empty.bin`, `c4/reject-manifest-retention-schema-2-missing-key.bin` |
| recovery-manifest-v2 | 12 provenance (delta of commit 0 only) | `c4/valid-manifest-provenance-root-delta.bin` | `c4/reject-manifest-provenance-empty.bin`, `c4/reject-manifest-provenance-not-root.bin` |
| recovery-manifest-v3 | keys 0 to 13, delta and snapshot | `c11/valid-archive-encrypted.mochi` | gap: no reject vector exists for manifest schema 3 (every manifest is sealed) |
| recovery-manifest-v3 | 12.3 re-encryption reason | — | gap: no file; `r3_cddl.rs` generates it |
| key-envelope-v0 | keys 0 to 10 | `c11/valid-key-envelope.bin` | `c11/reject-envelope-kdf-memory-below-8-per-lane.bin`, `c11/reject-envelope-kdf-zero-lanes.bin`; gap: a wrong size for the nonce, wrapped key, salt, or IDs; a suite or KDF other than 1; features other than [1] |
| tail-quarantine-v0 | keys 0 to 10 | — | gap: no golden sidecar file; `r3_cddl.rs` builds one and `t24_quarantine.rs` reads real ones |

**G1 audit result (2026-10-13, W16; a note, not an edit: the table above records the
freeze).** The gaps are filled in `fixtures/golden/r8/g1/` (48 vectors: a verdict and a
CDDL check for each, `g1/vectors.txt`) and in R8 whole-archive cases: the descriptor,
commit schema 1 and 2, manifest schema 1 to 3, and key-envelope positions as vectors; the
rules that need an archive (key envelopes in order and distinct, the data region, extents
that cover the length, a wrong AEAD tag) as `enc-corrupt-envelopes-unordered`,
`enc-corrupt-envelope-duplicate`, `enc-corrupt-data-region-kind`,
`core-corrupt-short-extents`, and `enc-corrupt-aead-tag`; and a rewritten Encrypted archive
as `enc-valid-reencrypted` (open item 8). Two findings, neither changing a byte:
`Manifest::decode` accepts extents that do not cover the logical length (the catalog
refuses them when the manifest is applied, `EXTENT_INVALID`), and 33 key operations are
`RECORD_INVALID`, not `LIMIT_EXCEEDED`. The tail-quarantine sidecar is a tool file
(Appendix A), not archive bytes, and has no R8 case.

### 7.3 Conventions the rules and schemas share

Fixed at the freeze; each was a guess a reader would have had to make.

* **"Sorted" means the order of the first field's value, not of its CBOR encoding.**
  Byte strings and text strings compare lexicographically on their raw bytes (shorter
  first when one is a prefix of the other); unsigned integers compare numerically. (CBOR's
  encoded-bytes order differs for variable-length strings, because the length comes
  first.) Entries sort by stored path bytes, chunks and file versions by ID, retention
  holds by label bytes. Duplicates are refused wherever "without duplicates" is said.
* **Codes for value-level violations.** A closed-schema violation — a wrong type, a byte
  string of the wrong size, an integer outside its drawn range (nanoseconds ≥ 10⁹, a mode
  above 0o7777, Windows attributes outside the mask, a chunk encoding or protection not
  drawn), a hole with a non-zero chunk offset, an unknown file-version or operation
  kind — is `RECORD_INVALID` (`DESCRIPTOR_INVALID` in the descriptor, §1.2). The
  refusals are `UNSUPPORTED_FEATURE`: an unknown schema version, an unknown required
  feature, a reserved file-version kind (symbolic link), and an unknown suite, KDF, or
  version identifier in a key envelope.
* **Seconds** in an mtime are an integer in [−2⁶³, 2⁶³ − 1]; the codec admits down to
  −2⁶⁴ and the record refuses the rest as `RECORD_INVALID`.
* **Codec codes survive in the records.** The commit, manifest, key envelope and
  sidecar decoders propagate the codec's code unchanged (`TRUNCATED`, `LIMIT_EXCEEDED`,
  `RECORD_INVALID`); only the descriptor re-maps (§1.2). Order among simultaneous faults
  in one input is **not** wire format: every golden reject has one defect, and the
  precedence tables of §1.1 ("order of checks") and R2 §2 describe the reference.
* **Which hash an object reference holds.** Every object reference in a commit — the
  descriptor, each manifest, the catalog image, each key envelope, and the data region
  (key 12) — holds the `STORED_OBJECT_DOMAIN` hash of the exact stored bytes (§5). The
  footer holds its own scope. No reference holds a hash of decoded or decrypted bytes.
* **16 and 32 in the Encrypted schemas.** The numbers in `commit-record-v2.cddl` (at
  most 16 key envelopes) and `recovery-manifest-v3.cddl` (key state 1 to 16, 32
  operations) are the defaults. The envelope count is a reader limit
  (`max-key-envelopes`, B.2.10 item 14): a reader configured higher accepts more, a
  default reader refuses more as `LIMIT_EXCEEDED`, and writers never write more
  (the writer default rule). The CDDL draws the default so that the check is exact for a
  default reader.
* **Key-envelope cost fields are not refused at decode.** A reader must not refuse an
  envelope whose `m`, `p`, or `t` violates the lower bounds the schema draws until a
  passphrase is applied (`RECORD_INVALID` then); a keyless read lists it. The schema is
  stricter than that on purpose (it states the writer's obligation), and `r3_cddl.rs`
  names the position as an exception.
* **Paths** in a manifest are valid by the rules in R4 §3.1 (`PATH_INVALID`).

## 8. How the schemas are checked

`crates/mochi-testkit/tests/r3_cddl.rs` (dev-dependency `cddl` 0.10.7, MIT, in
`mochi-testkit` only) checks, against the production decoders:

1. **Every schema file parses and is standalone.** It defines every rule it uses, defines
   none twice, has no rule nothing uses, never says "restated" or "exactly as in", and
   says `LEGACY (refused)` if and only if it is a schema-0 file. Every file in
   `docs/schemas/` is listed in the test.
2. **Every valid golden record validates** against the schema its key 0 selects: the
   `.bin` vectors, every CBOR record inside the valid whole-archive fixtures
   (`c5`, `c10`, `c11`, `c12`), the **plaintext** of every manifest in the Encrypted
   archive (opened with its golden passphrase), generated schema-3 manifests carrying
   each provenance reason, and the sidecar metadata of Appendix A. The production decoder
   accepts each one.
3. **Every CBOR reject vector is classified**, and the classification is enforced
   (88 vectors). *Schema*: the schema rejects it. *Semantic*: the schema accepts it and
   the code refuses it, for a rule §7.1 lists. *Frame*: the payload is valid and its
   frame is wrong. *Codec*: the payload is not canonical CBOR (§1). *Version* and
   *Legacy*: no current schema applies, or the legacy schema accepts it and no current
   one does. The test fails when a vector is added without a classification.
4. **A differential run over mutants** of every distinct kind of record position: a key removed, an
   unknown key added, a value replaced by every other CBOR type, an integer moved by one,
   a byte string made longer or shorter. Wherever the code accepts a mutant, the schema
   accepts it (the schema is never stricter than the code); wherever the mutation is
   structural and the code refuses it, the schema refuses it too. The one exception, a
   null draft identifier, is named in the test with its reason. Where only the *value*
   differs and the code refuses it, the schema may be looser only at the positions
   `expected_value_gap` lists, each with the §7.1 rule that refuses it.
5. **The bounded values** are walked on both sides of each edge, in every manifest
   schema and in the commit's time: POSIX mode (0o7777), uid and gid (32 bits), all
   sixteen Windows values and every other value up to 0x80, nanoseconds (below 10^9),
   and the 64-bit range of seconds. A bound the schema states wider or narrower than
   the code's fails. (468 cases; mutating the Windows mask or the mode bound is caught
   only here, because a mutant that moves a value by one cannot find a bound that is
   too wide by more.)

The check is as strong as the validator. The `cddl` crate has two quirks the schemas are
written around (§7.1), and it cannot express a relation between two values. Everything it
cannot express is in §7.1.

**Licence and maintenance of `cddl`** (AGENTS.md "New dependencies"): MIT. Developed in
the open at `github.com/anweiss/cddl` and published on crates.io (0.10.7, 2026-08-10;
about 690,000 downloads). It is a **dev-dependency of `mochi-testkit` only**: no shipped
crate depends on it (`cargo tree -p mochi-cli -e normal` does not mention it). It brings
42 packages into `Cargo.lock`, all dev-only and all MIT, Apache-2.0, or both, except
`base16` and `hexf-parse` (CC0-1.0, a public-domain dedication). A
`[profile.dev.package.cddl] opt-level = 3` entry keeps the test to seconds (about 11 ms
per record instead of about 120 ms unoptimized). If the crate were abandoned, the test
would pin a version and the schemas would remain valid RFC 8610 text for any other
validator.

## 9. CDDL corrections made with this draft

Writing the tables from the code found places where the schema text said less, or more,
than the code does. All are **text corrections to documents**; no byte the code writes
changes, every existing fixture still passes byte for byte, and `git diff fixtures/` is
empty. They are listed so that the W15 reviewer sees every semantic edit to a schema.

| File | Correction | Why |
|---|---|---|
| `recovery-manifest-v2.cddl` | Key 12 (provenance) drawn. Key 11 may be empty when provenance is present. | The code accepts and writes both (`manifest.rs` `schema_version`: provenance makes schema 2); the file drew neither. The golden `valid-manifest-provenance-root-delta.bin` failed validation before. |
| `recovery-manifest-v1.cddl`, `-v2`, `-v3` | The delta is two rules, root (sequence 0, `3: null`) and child (sequence ≥ 1, a parent). | "Parent is null exactly when sequence = 0" was "checked in code"; CDDL can say it. |
| `recovery-manifest-v3.cddl` | Key 12 is no longer allowed in a snapshot. | The code refuses provenance outside delta(0) (`check_structure`); the file allowed it. |
| `recovery-manifest-v1.cddl`, `-v2` | Chunk protection is `0` only; the AEAD value 1 is schema 3's. | A manifest outside the Encrypted profile that lists a sealed chunk is refused. |
| all manifests | A file version is a regular file or a directory (a directory has length 0, no hash, no extents); an extent is data or a hole (a hole has chunk offset 0); POSIX mode ≤ 0o7777, uid and gid 32-bit, Windows attributes in mask 0x27. | Rules the code applies; the file left them as comments. |
| `recovery-manifest-v3.cddl` | Provenance reason is `? 3: 1`, not `0 / 1`. | The code never writes an explicit 0 and refuses it (open item 2). |
| `recovery-manifest-v3.cddl` | Key state is 1 to 16 envelope IDs; commit 0's key operations are adds only. | `check_structure` enforces both. |
| `commit-record-v2.cddl` | Key 11 is 1 to 16 references. "Restated from R3's draft" removed; the header is now complete. | K14 (c). |
| `commit-record-v1.cddl`, `-v2` | An object reference's length is `uint .ge 8`. | `check_structure` refuses less than a frame header. |
| `tail-quarantine-v0.cddl` | Key 10 has the D15 timestamp pattern. | The spec defines the format; the file said `tstr`. |
| `archive-descriptor-v0.cddl`, `commit-record-v0.cddl`, `recovery-manifest-v0.cddl` | Header only: the hand-checked rules are listed; the v0 files say `LEGACY (refused)`. | K14 (c). |
| `commit-record-v2.cddl` | The header says a commit under a descriptor that does not agree about feature 1 is `DESCRIPTOR_INVALID`, not `RECORD_INVALID` (open item 9). | `publish.rs` raises `DESCRIPTOR_INVALID` (D12: a mismatched descriptor). |
| `key-envelope-v0.cddl` | None. Frozen with R5; it was already complete. | |

## 10. Open items

Each item is a place where the spec, the code, and the schemas disagreed, or where the
spec was silent. Each had a **proposed call** when this file was a draft; the calls were
confirmed at the freeze (table after item 9). No byte changed.

1. **Codec faults and error codes (plan W13 vs the code).** W13 says every codec
   rejection is `RECORD_INVALID`. The code maps a cut-short input to `TRUNCATED` and a
   depth or item overrun to `LIMIT_EXCEEDED` (§1.2). *Proposed call:* the code is right,
   because neither says the writer erred; correct the plan text (W13 and K14's "every
   rejection … `RECORD_INVALID`") to point at §1.2.
2. **Provenance reason 0 (spec D20 item 10, R5, the code).** The spec says a collection
   or compaction "carries reason 0". The code writes no key 3 for it and refuses an
   explicit `0` (`RECORD_INVALID`, "the default and must be absent"); R5's frozen CDDL
   said `? 3: 0 / 1`, which accepted a record the code refuses. *Proposed call:* the
   code stands (one logical structure, one encoding, §6). `recovery-manifest-v3.cddl` now
   says `? 3: 1`; amend D20 item 10 to "reason 0 is written by the absence of key 3".
   This narrows the text of a partly frozen file to what every archive ever written
   already satisfies; the W15 review should confirm it as an erratum.
3. **The descriptor table in spec B.2.2 omits key 5.1.** It lists constraints as
   `{0: TAR-compatible}`; the code and `archive-descriptor-v0.cddl` also have the
   Redundancy profile's `1: {suite, percentage}` (D21). *Proposed call:* add the row to
   B.2.2. The schema and the code are already consistent with D21.
4. **Key-envelope cost fields are checked at use, not at decode.** The schema requires
   m ≥ 8·p, p ≥ 1, t ≥ 1 and D20 item 1 makes a violation `RECORD_INVALID`, but
   `KeyEnvelope::decode` accepts them and only `unwrap` refuses. A keyless
   `read_envelopes` therefore reads such an envelope without complaint; the verdict is
   the same `RECORD_INVALID` once a passphrase is applied. *Proposed call:* move the
   lower-bound checks into `decode` (a code change in a later PR; the two golden rejects
   stay `RECORD_INVALID`). The upper bounds depend on reader limits and stay at use.
5. **Wire generation and draft-identifier classification** are "this build's reading of
   D12 and §26, which do not say" (`descriptor.rs`, already open in
   `docs/b2-implementation-checklist.md`). R3 inherits it: both are schema-valid and
   refused as `UNSUPPORTED_FEATURE`. *Proposed call:* decided with D24 at W15.
6. **`CborLimits` is documented as placeholder defaults (plan O18).** B.2.3 makes 16 Mi
   items and depth 64 the defaults ("unchanged"), and the code agrees. *Proposed call:*
   fix the comment in `cbor.rs` in the next code PR; no behaviour changes.
7. **No reject vector exists for commit schema 2, manifest schema 3, or the sidecar**, and
   22 positions in §7.2 and 10 rules in §7.1 have none. *Proposed call:* W16
   adds them (the G1 audit, R2 decision 4); this draft deliberately fills none.
8. **The golden set has no rewritten Encrypted archive.** The only schema-3 manifests
   that carry provenance are generated inside `r3_cddl.rs`. *Proposed call:* W16 adds
   one `rekey --reencrypt` archive.

9. **The Encrypted-profile disagreement code (R5 text vs the code).** The header of
   `commit-record-v2.cddl` said that a schema-2 commit under a descriptor that does not
   list feature 1 is `RECORD_INVALID`. The code raises `DESCRIPTOR_INVALID` (a
   mismatched descriptor, D12); `RECORD_INVALID` is what a manifest or a commit whose own
   schema and feature list disagree gets. *Proposed call:* the code stands. The header
   sentence is corrected here as text only; the W15 review should confirm it as an
   erratum, together with item 2.

**Calls at the freeze (2026-10-12; confirmed as proposed, none changes a byte).**

| Item | Call | Done |
|---|---|---|
| 1. Codec fault codes | **Code stands.** The plan text follows §1.2. | Plan W13 status note and K14 corrected at the freeze. |
| 2. Provenance reason 0 | **Code stands**; the narrowed `? 3: 1` is an erratum to the partly frozen R5 schema (no archive ever written carries an explicit 0, which the code has always refused). | Spec B.2.10 item 10 says reason 0 is the absence of key 3. |
| 3. Descriptor key 5.1 | **Added** to B.2.2. | Spec B.2.2. |
| 4. KDF lower bounds | **Keep at use, not at decode** (no code change in a format freeze). It is now a rule (§7.3), because a keyless reader is a conformance case. | §7.3. |
| 5. Wire generation and draft identifier | **Decided with D24:** both are schema-valid and refused as `UNSUPPORTED_FEATURE`; the draft identifier is 2. | R1 §1. |
| 6. `CborLimits` comment | **Fixed** (comment only). | `cbor.rs`. |
| 7. Missing reject vectors | **W16** (G1 audit). Kept as gaps in §7.2. | — |
| 8. No rewritten Encrypted archive | **W16.** | — |
| 9. Encrypted-profile disagreement code | **Code stands**: a commit that disagrees with the descriptor is `DESCRIPTOR_INVALID`. | Spec B.2.10 item 4 and the v2 header. |

## Appendix A. Tail-quarantine sidecar (a tool file, not archive format)

`tail-quarantine-v0` is written beside an archive by `mochi append --truncate-tail`
before an explicit tail truncation (D14). It is **not part of the `.mochi` wire format**;
it freezes with R3 because it uses the same encoding and the same hash. *(checked: the
layout is compared with `SidecarMetadata::header`, and the name with `sidecar_name`.)*

| Offset | Size | Field | Rule |
|---|---|---|---|
| 0 | 8 | Magic | `MOCHITQ` ‖ `00` (R1 §4) |
| 8 | 4 | L, metadata length | unsigned little-endian, 1 ≤ L ≤ 65536 |
| 12 | L | Metadata | deterministic CBOR (§1); the map of `tail-quarantine-v0.cddl` |
| 12 + L | *tail length* | The removed tail bytes | exactly the length in metadata key 5 |

The file length equals 12 + L + key 5.

**File name.** `<archive file name>.tail-<tail offset in decimal>-<first 16 lowercase hex
digits of key 6>.mochiq`, in the archive's directory, created exclusively (never
replacing an existing file). Example for an archive named `a.mochi`, offset 4096, and a
tail hash of 32 bytes `7a`: `a.mochi.tail-4096-7a7a7a7a7a7a7a7a.mochiq`.

**Metadata keys**, from `quarantine.rs` (schema in `tail-quarantine-v0.cddl`):

| Key | Meaning |
|---|---|
| 0 | Sidecar schema version = 0 |
| 1 | Archive ID (32 bytes) |
| 2 | Head commit ID at truncation time (32 bytes) |
| 3 | Head commit sequence |
| 4 | Tail offset: the end of the head footer |
| 5 | Tail length (> 0) |
| 6 | Plain BLAKE3-256 of the tail bytes, read under the archive lock (unseparated, §5) |
| 7 | Frame magics of the complete frames in the tail, in order |
| 8 | `true` if the tail ends in a frame cut short by end-of-file |
| 9 | Tool name and version (text) |
| 10 | Time written, D15 timestamp (text; exactly nine fractional digits, `Z`) |

*(checked: the key set equals the keys the code writes.)* The JSON tool formats (plans,
reports) belong to R7, not here (K14 f).

## 11. Freeze review (2026-10-12)

Run together with R1's (R1 §7 has the method, authority, and the stop rule). This section
records what concerns serialization.

**Checked.**

* **Drift test and CDDL check pass.** The drift test's R3 tests (codec table, fault
  table, schema registry, commit IDs, separators, record-level causes, vector index) and
  `r3_cddl.rs` (7 tests: standalone schemas, every valid golden record, every reject
  vector classified — 88 now, the draft-1 and draft-3 descriptor vectors replacing the one
  draft-2 vector — the differential run over mutants, and the bounded values) all pass
  after the regeneration.
* **The commit IDs of the three commit vectors are unchanged**
  (`b4592ef9…`, `d899e308…`, `a7cf5aed…`): those `.bin` vectors are hand-built and hold no
  descriptor hash, so the freeze did not touch `c5/*.bin`, `c4/*`, `c2/*`, or `c1/*`.
* **The separators and the codec are the code's.** Compared by the drift test; the nine
  digest and AEAD strings are unchanged.
* **The schemas carry no new rule.** The freeze edited their header comments only
  ("DRAFT" → "FROZEN with draft 2", the descriptor's draft identifier text, one
  "draft separator" wording); `r3_cddl.rs` classifies the files as before.

**Found and fixed at the freeze** (text only).

1. **The path rules** were not in the text (R4 §3.1 now states them; §7.3 points there).
2. **Eight conventions a reader would have guessed** — sort order, value-level codes,
   the seconds range, codec codes in records, hash scopes, the meaning of 16 and 32, key
   envelope cost fields, and paths — are §7.3.
3. **The open items had only proposed calls**; the table in §10 records the calls, and
   spec B.2.10 items 4 and 10 and B.2.2 now say what the table says.
4. **Stale status**: the banner, the §3 status column, "freezes with R3 at W15", and the
   schemas' "DRAFT" headers.

**Cold read.** A fresh subagent was given only `docs/spec.md`, this file, and the ten
`docs/schemas/*.cddl` files (the schemas are R3's, and it is not implementable without
them). Findings and calls (B = could change a verdict, code, or digest):

| # | Finding | Call |
|---|---|---|
| 1 | B: open items 1, 2, 4, 5, 9 undecided; items 2 and 9 contradicted the spec | **Fixed** (table in §10; the spec corrected). |
| 2 | B: which draft identifier value | **Fixed** (R1 §1: 2). |
| 3 | B: "sorted bytewise" | **Fixed** (§7.3). |
| 4 | B: fault precedence in one input | **Decided** (§7.3): not wire format; single-defect vectors. |
| 5 | B: record-layer precedence | **Decided** (R2 §6 finding 3; §7.3). |
| 6 | B: codec versus record codes | **Fixed** (§7.3). The sidecar is a tool file that an archive reader never opens; its failure codes are the tool's and R9 has no obligation to read it. |
| 7 | B: value-level violations with no code | **Fixed** (§7.3). |
| 8 | B: seconds range | **Fixed** (§7.3). |
| 9 | B: path validity | **Fixed** (R4 §3.1). |
| 10 | B: hash scope of descriptor, key envelope, commit references | **Fixed** (§7.3). |
| 11 | B: 16 as wire rule or reader limit | **Fixed** (§7.3). |
| 12 | Sidecar rules (zero tail length, key 7 and 8 cross-checks, name check, `:60` seconds) | **Decided:** a tool file (Appendix A), not archive format; the reference refuses a zero tail length (key 5 > 0), checks the length and the tail hash only, and does not cross-check keys 7 and 8 or the file name. An archive reader needs none of it. Key 7 lists the 4-byte little-endian frame magics, as the numbers in R1 §2. |

Text-only items fixed: "restated from" / "unchanged from v0" wording in the v1 schema's
commit-ID comment; the D20 item 6 stale open item (g) ("v2 manifest lacks key 12") is
spec text that §9 already corrected; stale draft wording throughout (banner, §3, §5).
Dependencies the reader was not given (R1, R2, R4, R5, R6, R7, plan O20/O24, `digest.rs`,
the golden files) are cross-references; the three commit IDs of §4 cannot be reproduced
without the three files, which is R9's input, not a gap in the text.

**Calls on the open items.** The nine calls of §10 are confirmed; none changes a byte.

**What the review did not do.** It did not repeat the cold read after the fixes; it did
not run a fuzz campaign; and the G1 audit's gaps (§7.2) are W16's, not closed here.
