# R7 — Report schema and stable error codes (frozen 2026-10-14, gate G15)

> **Status 2026-10-14: frozen** (gate G15, [delegated 2026-10-14]; owner review pending
> at the desktop checkpoint, plan K11). Written from the working code at `main` commit
> `57e3a69` as a draft (2026-10-11) and frozen at `cb3871f` with the JSON Schemas of
> `docs/schemas/json/` (§9; the file name is kept for links). Every table marked
> *(checked)* is compared with the code by
> `crates/mochi-cli/tests/ratification_drafts.rs`: the code registry in order, each
> code's exit and verification class from the two exhaustive matches, the status,
> dimension, level, severity, and anchor values, and the report's field names. The
> schemas are checked against real outputs by `crates/mochi-cli/tests/r7_json_schemas.rs`.

Sources: spec §20.1–§20.5, §23.2, Annex B.1 D8, Annex B.2 D15, B.2.2 ("New error
codes"), B.2.9, B.2.10. Code: `crates/mochi-core/src/error.rs` (the only place codes
are defined), `status.rs`, `report.rs`, `exit.rs`, `verify.rs` (`classify`),
`crates/mochi-cli/src/lib.rs` (`exit_code_for`). Field meanings:
`docs/report-schema-v1.md`, which stays the user-facing reference; this file is the
registry it draws from.

**Stability rule (AGENTS.md).** Adding a code is allowed: it appends a row to §6, a
value to `error-code` in `docs/schemas/json/common.schema.json`, and a variant to the
registry, which the tests keep equal. Renaming a code, removing one, or changing its
meaning is a breaking change, and so is any other change to a frozen schema: it needs a
new identifier (a new report `schema_version`, plan `format`, evidence `schema`, policy
`schema`, or heads `version`), never an edit (plan K11).

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
| `search` | Optional (C13); verification at this level reports searchability `UNSUPPORTED` and exits 4 in 1.0, since no search index exists to verify (§9, item 5) |
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
| `FOOTER_INVALID` | 1 | violation | C1 | A footer failed validation (§8.4). **[Clarified, W18, no byte changes]** Also a finding, not a refusal, when the last 72 bytes of the file are not the valid footer of the head and the head was found by the forward scan (an interrupted publication, a torn or damaged final footer) |
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
| `PROFILE_VIOLATION` | 1 | violation | C10 | A TAR-compatible archive's stream does not match its commits (D19); or a Redundancy-profile commit's parity frames verify but disagree with it, or it has none (D21) |
| `KEY_UNAVAILABLE` | 3 | operational | C11 | No passphrase given, or none opens a key envelope (D20 item 9); never a violation. An error everywhere except one place: `verify` and `fsck`, given passphrases none of which opens an envelope, report it as an `error` finding with `operational_error` true, every archive dimension unassessed, and exit 3 (§9, item 1 and owner item O1) |
| `KDF_COST_BELOW_DEFAULT` | 3 | operational | R5 | Informational finding only: a key envelope's Argon2id cost is below the writer default (D20 item 14); never raised as an error |
| `LIMIT_NOT_DEFAULT` | 3 | operational | R7 | Informational finding only: a reader limit in force differs from its default (`--limit`); `expected` is the default, `observed` the value (§20.5 "configuration"); never raised as an error |
| `PARITY_DAMAGED` | 1 | violation | C12 | A parity frame is damaged or missing, or a group has no intact frame (D21). Reported as a warning finding: integrity unaffected, recoverability `DEGRADED` |
| `PARITY_CAPACITY_EXCEEDED` | 1 | violation | C12 | A parity group has more damaged shards than intact parity shards (D21): recoverability `FAIL`; repair leaves out what the damage touches, never rebuilding wrong bytes |
| `ARCHIVE_ID_AMBIGUOUS` | 3 | operational | W12 | Repair's salvage scan (step 7) found commits of more than one archive, and neither the source descriptor nor `--archive-id` picks one (B.2.13 D23 item 4); the error lists the IDs; never a finding about the archive |

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

## 9. Freeze review (2026-10-14)

The review pass gate G15 asks for (plan K24, W19), in the form of R5 §12. It read this
file, spec §20 and Annex B.2.6, `docs/report-schema-v1.md`, `docs/c14-cli.md`, the
code that defines or writes every machine-readable output (`mochi-core`: `error.rs`,
`status.rs`, `report.rs`, `exit.rs`, `verify.rs`, `health.rs`, `gc.rs`, `compact.rs`,
`repair.rs`, `copies.rs`, `parity.rs`, `salvage.rs`, `rekey.rs`; `mochi-cli`:
`commands.rs`, `lib.rs`, `state.rs`, `render.rs`), and the R8 golden set. Every call
below is **[delegated 2026-10-14]**: the owner reviews this freeze at the desktop
checkpoint, and a change asked for then is a new identifier (§ stability rule), never
a silent edit (K11). Two questions are the owner's to decide and are written as options
(O1, O2); neither changes a schema, a code, or an exit code, so the freeze does not
wait for them. **Both were decided by the owner on 2026-10-14** (see "Owner decisions" at
the end of this section).

**What is frozen.** This file's tables (§1 to §7), with the decisions of §8 and of this
section, and eight JSON Schema documents in `docs/schemas/json/`: the shared
definitions (`common`), report v1, the error line, `mochi-repair-plan-v2`, the GC plan
(v1), health evidence (schema 1), health policy (`mochi-health-policy-v1`), and the
local head history (`heads.json`, version 1). Eleven more schemas, one for each other
command's `--json` output, were written and checked but not frozen: each output carries an
in-band `schema` tag (owner decision O2, 2026-10-14). **They froze at the 1.0 flip
(W20, 2026-10-15)**, together with a twelfth, `cli-migrate.schema.json`
(`mochi-cli-migrate-v1`, for the new command `mochi migrate`): twenty documents, twenty
frozen. A later change to one is a `-v2` tag and a new file.
`docs/schemas/json/README.md` lists all twenty, what writes each, and what is not
JSON.

**Checked.**

* **The tables are the code.** The drift test (`ratification_drafts.rs`) passes
  unchanged: the registry in order with both placements, the five exit codes, the
  enumerations, and the report's fields.
* **Every output has a schema, and real outputs match it**
  (`crates/mochi-cli/tests/r7_json_schemas.rs`, 10 tests, about 8 s in a debug build).
  The CLI runs in-process over all 76 R8 cases: 228 `verify` and `fsck` reports (at
  every level, with and without `--require-freshness`, with the case's expected head),
  74 `health` reports, 140 evidence lines, 37 head histories, 72 repair plans (all three
  outcomes; parity, copies, and salvage each present), and 519 outputs of `gc plan`,
  `list`, `snapshot list`, `search`, `dump-index`, and `rekey --list`; every failure
  among them is an error line that matches its schema and exits with `exit_code_for`
  of its code. Temporary archives cover the commands that write (`create`, `append`
  with deletions, with a truncation, and with a truncation alone; the four maintenance
  commits; `get` with a collision; `restore-test`; `gc plan --output` and `gc apply`;
  `compact`; `repair plan --output` and a partial and a complete `repair apply`;
  `create --encrypted`, `rekey` add, list, remove, and `--reencrypt`; a policy file;
  the error line). Standard output is one line of JSON in every case, and each
  `exit_code` field equals the process's exit code.
* **The schemas reject what is wrong.** 4,346 mutations of 46 real outputs (every field
  removed, given another JSON type, or joined by an unknown key, and every array given
  a foreign element; plus 60 targeted mutations, such as `PRESERVED` as a commit
  status, a status outside §20.4, an unregistered code, `PASS` overall over an
  unsupported dimension, freshness `PASS` without an anchor, a repair plan's exit code
  that disagrees with its outcome, `revocation: true`): 4,260 killed, all 60 targeted
  ones included. The 86 survivors are on an explicit list in the test, each with its
  reason (optional fields, the evidence line's subset of dimensions, free-form maps,
  catalog cells), and the test fails if one is no longer needed. Six mutations of the
  CLI's code (a new field in `list`, `PRESERVED` written, a new JSON-writing function
  without a schema, `revocation: true`, a renamed `full_text` value, an empty GC reason)
  were all killed.
* **The enumerations are the code's.** The schemas' error codes equal `ErrorCode::ALL`
  in order and §6's first column; statuses, dimensions, levels, severities, anchors, and
  exit codes equal their Rust types; the report schema's required fields are what
  `Report` serializes.
* **The policy schema is the parser.** For 18 policy files (5 accepted, 13 refused), the
  schema accepts exactly those `mochi health --policy` accepts.
* **Spec §20.6** is now a real report (decision 4): `verify --json` of
  `fixtures/golden/r8/core-corrupt-chunk-older.mochi`, abridged only in its two
  wall-clock times; the test regenerates and compares it.
* **Desktop and foreign-format codes.** The desktop app and `mochi-foreign` (PR #48)
  register no code of their own, so the schemas list none.

**Found and fixed at the freeze** (no code byte, error code, or exit code changed).

1. **The JSON Schema did not exist** (decision 5 carried it): written, nineteen documents.
2. **§20.6 showed invented fields and codes** (`stored_bytes_complete`,
   `REPLICA_BELOW_POLICY`): replaced (decision 4).
3. **A schema bug found by the negative tests.** The repair plan's ladder used
   `prefixItems` with `items`, and in 2020-12 `items` does not apply to the elements
   `prefixItems` covers, so a step's status went unchecked. Each position now carries
   the step schema itself.
4. **§6 said `KEY_UNAVAILABLE` is "never a finding"** and §3 said the `search` level is
   "Optional": both rows now describe what the code does (items 1 and 5 below).

**Disagreements between the draft, the documents it draws on, and the code.** The
code's behaviour stands in each, since none breaks the spec (item 1 is the owner's to
confirm, O1); none renames a code or changes its meaning.

| # | Where | Document | Code | Call |
|---|---|---|---|---|
| 1 | `KEY_UNAVAILABLE` | §6 and `report-schema-v1.md`: never a finding. Spec B.2.10 item 12: a passphrase that opens nothing "is `KEY_UNAVAILABLE` (exit 3), not a report" | `verify` and `fsck` given such a passphrase print a report: one `error` finding with this code, `operational_error` true, nothing assessed, exit 3. Every other command fails with the error line | **Code stands; §6 says so, and spec B.2.10 item 12 now says "not a verification result" instead of "not a report"** (owner decision O1 (a), 2026-10-14). The report claims nothing about the archive and exits 3 as the spec requires; it lists what was not checked |
| 2 | Report `scope` | `report-schema-v1.md`: a string | `Option<String>`, set by every producer (`verify`, `fsck`, `health`) | **A non-null string in v1**, as every producer writes and the field reference says |
| 3 | Evidence `level` | `c14-cli.md` rule 13 lists it | `Option`, always written; `health` reads `null` | **String or null**: the log is also an input, and its reader accepts null |
| 4 | Evidence `scope` | Rule 13 lists it unconditionally | Omitted when absent, like `finding_codes` | **Optional.** Rule 13's wording is left for its owner (outside this task) |
| 5 | Level `search` | §3: optional (C13) | `UNSUPPORTED` searchability, exit 4: C13 built search, not a search index to verify | **Code stands**; §3 says so. An optional check that is not performed is never `PASS` (§20.4) |
| 6 | The GC plan's version | K24 names it as a frozen document | No in-band identifier | **Frozen as `gc-plan-v1`.** Safe without a tag: `gc apply` compares the whole value with a fresh plan, so a plan of another shape is refused as stale. A change is `gc-plan-v2` and adds a tag |
| 7 | `repair apply`'s input | The plan is `mochi-repair-plan-v2` | Reads a v2 plan without `parity`, `copies`, `donations`, `salvage` (they default to empty); every writer writes them | **The schema describes what is written** and requires them; the reader's leniency is harmless (a plan is applied only if it equals a fresh one) |
| 8 | Errors under `--json` | `c14-cli.md`: errors in `--json` mode are one JSON line on standard output | Argument-parsing errors are clap's text on standard error, exit 3 | **Code stands**: an invocation that does not parse has no output mode. The schema README says so; `c14-cli.md` is left for its owner |
| 9 | `repair_actions` | §20.5: "if separately performed" | Always empty: no producer of a v1 report repairs (§20.2) | **Empty in v1** (`maxItems` 0). A report that carries repair actions is a new schema version |
| 10 | `report-schema-v1.md` | Calls itself a draft; says recoverability has no parity in 1.0 | R7 frozen; parity since C12 | **Stale text, left for its owner** (outside this task's files); the facts are in this section and the schema |
| 11 | §20.6 and `tool` | — | The example shows `tool.version` and `format_status` | **Accepted**: a version bump, and the 1.0 flip (W20), change the example; the test then prints the new block to paste |

**Calls on the open items** (§8, and K24's scope).

| Item | Call | Why |
|---|---|---|
| §8.1 every violation exits 1 | **Keep**, frozen as §6. | Unchanged since 2026-10-11; `exit_code_for_agrees_with_classify` pins it. |
| §8.2 "expected head" | **Done.** | Spec §20.5 amended. |
| §8.3 `LIMIT_NOT_DEFAULT` | **Keep.** `expected` and `observed` are strings in the schema, as for every finding. | It changes no dimension or exit code. |
| §8.4 §20.6's example | **Done**, from `core-corrupt-chunk-older`. | A damaged data object of an older commit shows coverage short of expectation, two error findings, two `FAIL` dimensions, and exit 1 in one short report. |
| §8.5 carried items | **JSON Schema written. Keep** the rest: coverage counts data objects only (the schema says so); `UNCOMMITTED_TAIL` is a warning that does not lower durability; `health` has no marker; a path absent from a snapshot stays `INVALID_ARGUMENT`. | As decided on 2026-10-11; a not-found code can be added later without breaking anything. |
| §8.6 `NOT_IMPLEMENTED` | **Keep** registered (it is in the schema's enum). | Retiring a code is a breaking change; no 1.0 command returns it. |
| K24 "every machine-readable JSON" | **Nineteen schemas**: the five K24 names, the shared definitions, the error line, `heads.json`, and eleven command outputs K24 did not list. Text output, help, `get --stdout`, warnings, and argument-parsing errors are not JSON. | A JSON output without a schema would be an undocumented interface; the README test fails when one appears. |
| Validating against an older schema | **A consumer validates with the schema of the tool version that wrote the output** (the README says so). | Adding a code extends `error-code`, so an older copy rejects a newer output; a reader that only reads treats an unknown code as unknown, never as success. |

**Owner decisions** (options, not guesses; the provisional state is what is in the
tree).

* **O1. `KEY_UNAVAILABLE` from `verify` and `fsck`** (item 1). **Decided (a)
  [owner, 2026-10-14].** Keep the report that `verify` and `fsck` print (nothing
  assessed, `operational_error` true, one `error` finding with this code, exit 3) and
  amend spec B.2.10 item 12's "not a report" to say a wrong passphrase is
  `KEY_UNAVAILABLE` (operational, exit 3) and **not a verification result**: `verify`
  and `fsck` may print a report with no dimension assessed, and every other command
  prints the error line. The options were (a) this, and (b) making the two commands fail
  with the error line (a CLI and core change). This is a clarification of text to match
  frozen behaviour: **no code, byte, exit code, or error-code meaning changes.** The
  spec, §6, and `report-schema-v1.md` now agree.
* **O2. Are the eleven command-output schemas guaranteed?** **Decided (2)
  [owner, 2026-10-14].** Each of the eleven command-output documents carries an
  in-band tag, `"schema": "mochi-cli-<name>-v1"` (`mochi-cli-commit-v1`,
  `-maintenance-v1`, `-list-v1`, `-snapshot-list-v1`, `-search-v1`, `-dump-index-v1`,
  `-restore-v1`, `-rewrite-v1`, `-repair-apply-v1`, `-rekey-list-v1`, `-plan-saved-v1`),
  and its JSON Schema requires the tag as a `const`. **The eleven freeze at the 1.0 flip
  (W20), not now (done 2026-10-15, with `mochi-cli-migrate-v1` as the twelfth):** until then a change to one is made in the same pull request as its
  schema and the test, and at the flip each tag becomes a frozen identifier (a change
  is then a `-v2` and a new file). The eight frozen documents are untouched: no field was
  added to a report, the error line, either plan, the evidence line, the policy, or
  `heads.json` (the saved-plan wrapper carries the tag; the plan inside it is the frozen
  value, unchanged). A CLI change, no format change.

**Gate G15** is met (spec Annex B.2.6): R7 is frozen, every machine-readable output has
a JSON Schema, and real outputs are validated against them in tests.
