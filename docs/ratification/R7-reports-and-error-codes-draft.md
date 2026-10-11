# R7 — Report schema and stable error codes (DRAFT, not frozen)

> **Status 2026-10-11: draft.** Written from the working code at `main` commit
> `57e3a69`, as plan §6 requires. It is **not frozen**: it freezes at Beta. Every
> table marked *(checked)* is compared with the code by
> `crates/mochi-cli/tests/ratification_drafts.rs`: the code registry in order, each
> code's exit and verification class from the two exhaustive matches, the status,
> dimension, level, severity, and anchor values, and the report's field names.

Sources: spec §20.1–§20.5, §23.2, Annex B.1 D8, Annex B.2 D15, B.2.2 ("New error
codes"), B.2.9, B.2.10. Code: `crates/mochi-core/src/error.rs` (the only place codes
are defined), `status.rs`, `report.rs`, `exit.rs`, `verify.rs` (`classify`),
`crates/mochi-cli/src/lib.rs` (`exit_code_for`). Field meanings:
`docs/report-schema-v1.md`, which stays the user-facing reference; this file is the
registry it draws from.

**Stability rule (AGENTS.md).** Adding a code is allowed. Renaming a code, removing
one, or changing its meaning is a breaking change. After the freeze it needs a new
report schema version.

## 1. Status values (§20.4) *(checked)*

| Value | Meaning |
|---|---|
| `PASS` | Required checks completed successfully within policy |
| `FAIL` | A required check found a violation |
| `DEGRADED` | Some capability remains, but a required protection is reduced |
| `UNKNOWN` | Evidence is insufficient or unavailable |
| `OVERDUE` | Required evidence is older than policy permits |
| `UNSUPPORTED` | The implementation cannot perform the required interpretation or check |

Rollup order (D15), worst first: `FAIL` > `UNSUPPORTED` > `DEGRADED` > `OVERDUE` >
`UNKNOWN` > `PASS`. An empty rollup is `UNKNOWN`, never `PASS`. Only `PASS` may be
shown with success styling (§23.3).

## 2. Dimensions (§20.3) *(checked)*

`durability`, `integrity`, `recoverability`, `searchability`, `freshness`,
`retention_compliance`, `key_availability`.

Every report carries all seven. A new report starts with every dimension unknown (status UNKNOWN).

## 3. Verification levels (§20.1) *(checked)*

| Value | 1.0 |
|---|---|
| `structural` | Supported |
| `referential` | Supported |
| `stored_integrity` | Supported |
| `content_integrity` | Supported |
| `restoration` | Supported |
| `search` | Optional (C13) |
| `inventory` | Accepted, reported `UNSUPPORTED` (Preservation profile) |
| `disaster_recovery` | Accepted, reported `UNSUPPORTED` (Preservation profile) |

## 4. Other enumerations *(checked)*

| Field | Values |
|---|---|
| `findings[].severity` | `info`, `warning`, `error` |
| `freshness_anchor` | `none`, `user`, `local-history` |

## 5. Exit codes (§23.2, D15) *(checked)*

| Exit | Constant | Meaning |
|---|---|---|
| 0 | `OK` | Requested checks passed |
| 1 | `FAILED` | Verification or policy failure |
| 2 | `DEGRADED` | Degraded, unknown, or overdue required evidence |
| 3 | `ERROR` | Invocation, configuration, or operational error |
| 4 | `UNSUPPORTED` | Unsupported required feature or verification capability |

**Precedence for a run with a report** (D15, `exit::for_results`); the first rule
that matches wins: 1 if any reported dimension is `FAIL`, required or not; 3 if an
operational error occurred; 4 if the policy result is `UNSUPPORTED`; 2 if it is
`DEGRADED`, `OVERDUE`, or `UNKNOWN`; else 0. Codes already computed combine in the
same order (`exit::combine`); an unregistered code counts as 3.

**A run without a report** (a command that fails before or outside verification)
exits with the code its error maps to (§6, column "Exit as error").

## 6. Error codes *(checked)*

Two placements per code, both exhaustive matches in the code:

- **Exit as error**: `mochi_cli::exit_code_for`, the exit when a command fails with
  this code.
- **Verification class**: `mochi_core::verify::classify`, what the code means as
  evidence when verification meets it: `violation` makes a dimension `FAIL`,
  `unsupported` makes it `UNSUPPORTED`, `operational` concludes nothing about the
  archive (the run was compromised; exit 3).

The order is the registry's (declaration order, `ErrorCode::ALL`), which is also the
order codes were added.

| Code | Exit as error | Verification class | Added | Meaning |
|---|---|---|---|---|
| `IO_ERROR` | 3 | operational | C0 | Storage reported an I/O failure |
| `OUT_OF_BOUNDS` | 3 | operational | C0 | A read or seek fell outside an object's bounds (checked before use) |
| `LIMIT_EXCEEDED` | 3 | operational | C0 | A configured reader limit (§8.5) was exceeded |
| `LOCK_CONFLICT` | 3 | operational | C0 | Another writer holds the publication lock (§12.5) |
| `INVALID_ARGUMENT` | 3 | operational | C0 | Invalid argument or configuration, including a path absent from a snapshot |
| `CANCELLED` | 3 | operational | C0 | Cancelled through the job's token |
| `UNSUPPORTED_FEATURE` | 4 | unsupported | C0 | A required feature or check this build does not support; results are never partial (§7.7, §26) |
| `NOT_IMPLEMENTED` | 3 | operational | C0 | In 1.0 scope but not built in this development build; not a conforming end state |
| `REPORT_INCONSISTENT` | 3 | operational | C0 | A report contradicts the reporting invariants (§5.4, §20.3) |
| `MALFORMED_FRAME` | 1 | violation | C1 | Bytes are not a structurally valid frame (§8.5, §8.6) |
| `TRUNCATED` | 1 | violation | C1 | Input ended inside a structure |
| `FOOTER_INVALID` | 1 | violation | C1 | A footer failed validation (§8.4) |
| `ENVELOPE_INVALID` | 1 | violation | C1 | A record envelope failed validation (§8.3, D11) |
| `STORED_INTEGRITY_FAILED` | 1 | violation | C2 | Stored length or stored-object hash mismatch |
| `CONTENT_INTEGRITY_FAILED` | 1 | violation | C2 | Stored bytes verified but decoding (or AEAD opening) did not yield the recorded length and content hash |
| `PATH_INVALID` | 1 | violation | C3 | An archive path breaks §10.4 |
| `EXTENT_INVALID` | 1 | violation | C3 | Extents have a gap, overlap, out-of-range read, or length mismatch (§10.3) |
| `NAMESPACE_INVALID` | 1 | violation | C3 | Namespace operations leave an invalid snapshot or delete an absent path (§10.2) |
| `CATALOG_INVALID` | 1 | violation | C3 | A catalog image fails structural, schema, or relationship checks (§10.5, R4) |
| `IDENTITY_CONFLICT` | 1 | violation | C3 | An immutable ID exists with different content (§10.2) |
| `RECORD_INVALID` | 1 | violation | C4 | A canonical record is not canonical CBOR in the D2 subset, or breaks its closed schema |
| `NO_VALID_HEAD` | 1 | violation | C5 | No valid committed footer anywhere |
| `UNCOMMITTED_TAIL` | 3 | operational | C5 | Bytes after the head are eligible for truncation (D14); append refused until an explicit truncation |
| `TAIL_UNRESOLVED` | 1 | violation | C5 | Bytes after the head are not eligible for truncation; they may hold a damaged commit |
| `COMMIT_UNCONFIRMED` | 3 | operational | C5 | Failure after the footer was appended; the commit may or may not be the head |
| `WRITER_POISONED` | 3 | operational | C5 | The writer refuses work after a durability failure |
| `DESTINATION_EXISTS` | 3 | operational | B.2 | Creation found a file at the final name; nothing replaced (D13) |
| `CAPACITY_EXCEEDED` | 3 | operational | B.2 | A writer refused output a default reader would reject; no head published (B.2.3) |
| `CHECKPOINT_MISMATCH` | 3 | violation | B.2 | A checkpoint's image or snapshot manifest disagrees with the source snapshot (D10 item 7) |
| `DESCRIPTOR_INVALID` | 1 | violation | B.2 | The descriptor is missing, damaged, or mismatched (D12) |
| `RETENTION_UNRESOLVED` | 1 | violation | B.2 | GC cannot rebuild retention state (D10 item 10) |
| `QUARANTINE_FAILED` | 3 | operational | B.2 | A tail-quarantine step failed; truncation blocked (D14) |
| `DURABILITY_UNCONFIRMED` | 3 | operational | B.2 | Directory durability unconfirmed; truncation blocked unless waived (D14) |
| `PROFILE_CHANGE_UNSUPPORTED` | 4 | unsupported | B.2 | In-place change to a creation-time constraint (D12) |
| `NAME_COLLISION` | 3 | operational | C6 | Restore: a name exists or folds onto another at the destination; nothing overwritten |
| `NAME_UNSUPPORTED` | 3 | operational | C6 | Restore: the destination cannot hold a name; the entry was skipped, the name not altered |
| `ATTRIBUTE_NOT_RESTORED` | 3 | operational | C6 | Restore: a promised attribute could not be applied; content restored |
| `REFERENCE_INVALID` | 1 | violation | C7 | An object reference does not resolve, or a delta references outside the baseline view (Q64) |
| `FRESHNESS_FAILED` | 1 | violation | C7 | The verified history does not contain the freshness anchor (D8) |
| `PROFILE_VIOLATION` | 1 | violation | C10 | A TAR-compatible archive's stream does not match its commits (D19) |
| `KEY_UNAVAILABLE` | 3 | operational | C11 | No passphrase given, or none opens a key envelope (D20 item 9); never a finding |
| `KDF_COST_BELOW_DEFAULT` | 3 | operational | R5 | Informational finding only: a key envelope's Argon2id cost is below the writer default (D20 item 14); never raised as an error |
| `LIMIT_NOT_DEFAULT` | 3 | operational | R7 | Informational finding only: a reader limit in force differs from its default (`--limit`); `expected` is the default, `observed` the value (§20.5 "configuration"); never raised as an error |

Codes reported only as findings carry their meaning through the report (`findings[]`
and the dimension they set); their "exit as error" column applies only if a command
ever returns one as an error.

## 7. Report fields (schema v1) *(checked)*

Top-level fields of `mochi_core::report::Report` as serialized, in order. Types and
meanings: `docs/report-schema-v1.md`.

`schema_version`, `archive_id`, `checked_commit`, `expected_head`,
`freshness_anchor`, `tool`, `started_at`, `completed_at`, `level`, `scope`,
`coverage`, `skipped`, `findings`, `repair_actions`, `dimensions`, `overall_status`,
`policy`, `policy_result`, `operational_error`, `exit_code`.

Nested objects:

| Object | Fields |
|---|---|
| `tool` | `name`, `version`, `spec_revision`, `wire_generation`, `format_status` |
| `coverage` | `expected_objects`, `checked_objects`, `expected_bytes`, `checked_bytes`, `evidence_age_seconds` |
| `skipped[]` | `item`, `reason` |
| `findings[]` | `code`, `severity`, `message`, `expected`, `observed`, `affected` (the last four omitted when absent) |
| `findings[].affected` | `first`, `last` |
| `policy` | `required`, `freshness` |
| `policy.freshness` | `expected_head_supplied`, `archive_in_local_history`, `requested` |

## 8. Decisions on the open items (delegated, 2026-10-11)

1. **Every violation exits 1, from any command.** An error exits 1 exactly when
   `verify::classify` counts its code as a violation, so automation that reads only
   the exit code learns "the archive is wrong" from `ls` or `get` as it does from
   `verify` (plan O22, extended). Twelve codes moved from 3 to 1: `MALFORMED_FRAME`,
   `TRUNCATED`, `FOOTER_INVALID`, `ENVELOPE_INVALID`, `PATH_INVALID`, `EXTENT_INVALID`,
   `NAMESPACE_INVALID`, `CATALOG_INVALID`, `IDENTITY_CONFLICT`, `RECORD_INVALID`,
   `NO_VALID_HEAD`, `TAIL_UNRESOLVED`. The one exception is `CHECKPOINT_MISMATCH`: as
   an error it only comes from a writer (B.2.2, "3 (writer)"), and `verify` reports it
   through a `FAIL` dimension. Input typed on the command line is parsed into
   `INVALID_ARGUMENT` before core sees it, so a bad argument never reads as a damaged
   archive. Pre-1.0 is the time to make this change; the test
   `exit_code_for_agrees_with_classify` pins it.
2. **§20.5 says "Expected head".** Amended (the field is `expected_head`, the D8
   anchor).
3. **Configuration in reports: one `info` finding per non-default reader limit.** New
   code `LIMIT_NOT_DEFAULT` (§6): `expected` is the default, `observed` the value; it
   changes no dimension and no exit code, like `KDF_COST_BELOW_DEFAULT`. Adding a code
   is not a breaking change, so the report schema stays v1. Writer settings are not
   reported: they are recorded in the archive (`writer_params`, R4).
4. **§20.6's example is replaced** with an abridged real v1 report when R7 freezes,
   generated from a golden fixture so it cannot drift; until then the spec marks the
   current example as non-normative (it already says "illustrative") and this draft
   records that its fields and codes are not the schema's.
5. **Carried items.** The JSON Schema document is written at the freeze, from
   `Report`. Control objects get no coverage counts: findings cover them, and counts
   would suggest a sampling that does not happen. `UNCOMMITTED_TAIL` stays a warning
   that does not lower durability: durability is about whether committed bytes
   reached stable media, and the tail is uncommitted. `health` gets no marker: `level`
   (`structural`) and `scope` ("no check was run") already distinguish it. No
   not-found code for a path absent from a snapshot in 1.0: `INVALID_ARGUMENT`
   stays, and a dedicated code can be added later without breaking anything.
6. **`NOT_IMPLEMENTED` stays registered** (retiring a code is a breaking change), and
   a test makes sure a 1.0 build returns it from no command: every command spec §23.2
   lists is run past argument parsing (`exit_codes.rs`,
   `no_one_dot_zero_command_is_not_implemented`). Today every 1.0 command is built.
