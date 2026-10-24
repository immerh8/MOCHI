# JSON Schemas for MOCHI's machine-readable output (R7, gate G15)

JSON Schema (draft 2020-12) documents for every JSON value the `mochi` CLI writes:
its `--json` output, the plan files it saves, the error line, and the two local
state files. Written at the R7 freeze (`docs/ratification/R7-reports-and-error-codes-draft.md`
§9; plan K24, W19) from the code, and checked against it by
`crates/mochi-cli/tests/r7_json_schemas.rs`:

* real outputs, from the CLI run in-process over all 76 R8 golden cases
  (`fixtures/golden/r8`) and over temporary archives for every command that writes,
  must validate;
* mutated outputs must not (every field removed, retyped, or joined by an unknown one,
  plus targeted mutations of particular meaning; the few mutations a schema allows by
  design are listed in the test with their reasons);
* the enumerations (error codes in registry order, statuses, dimensions, levels,
  severities, exit codes) must be the code's;
* this table must name every function in `crates/mochi-cli/src` that writes JSON, so a
  new output cannot appear without a schema.

`$id`s are under `https://mochi.invalid/schemas/json/`. The `.invalid` domain is
reserved (RFC 2606) and never resolves: the files are here, and a validator is given
them directly (the test resolves `$ref`s from this directory). `common.schema.json`
holds the shared definitions.

## Schemas

| Schema | Written by | Source (`crates/mochi-cli/src`) | Identifier in the output | Status |
|---|---|---|---|---|
| `common.schema.json` | (shared definitions; not an output) | — | — | frozen |
| `report-v1.schema.json` | `verify --json`, `fsck --json`, `health --json`; the desktop "Test archive" export | `verify_cmd`, `health_cmd` | `schema_version: 1` | frozen |
| `error.schema.json` | any command that fails, with `--json` | `render_error` | — | frozen |
| `repair-plan-v2.schema.json` | `repair plan --json`; the `--output` file `repair apply --plan` reads | `repair_plan` | `format: "mochi-repair-plan-v2"` | frozen |
| `gc-plan-v1.schema.json` | `gc plan --json`; the `--output` file `gc apply --plan` reads | `gc_plan` | none (R7 §9, item 6) | frozen |
| `health-evidence-v1.schema.json` | one line of `<state dir>/evidence/<archive id>.jsonl` | `append_evidence` | `schema: 1` | frozen |
| `health-policy-v1.schema.json` | the file `health --policy` reads (an input) | — | `schema: "mochi-health-policy-v1"` | frozen |
| `local-heads-v1.schema.json` | `<state dir>/heads.json` | `record` | `version: 1` | frozen |
| `cli-commit.schema.json` | `create`, `append` (also `append --truncate-tail` with nothing to commit) | `emit_commit`, `append` | `schema: "mochi-cli-commit-v1"` | frozen at the 1.0 flip (W20) |
| `cli-maintenance.schema.json` | `snapshot retain\|expire\|release`, `checkpoint`, `rekey --add-passphrase\|--remove-passphrase` | `commit_maintenance` | `schema: "mochi-cli-maintenance-v1"` | frozen at the 1.0 flip (W20) |
| `cli-list.schema.json` | `list` | `list_cmd` | `schema: "mochi-cli-list-v1"` | frozen at the 1.0 flip (W20) |
| `cli-snapshot-list.schema.json` | `snapshot list` | `snapshot_list` | `schema: "mochi-cli-snapshot-list-v1"` | frozen at the 1.0 flip (W20) |
| `cli-search.schema.json` | `search` | `search_cmd` | `schema: "mochi-cli-search-v1"` | frozen at the 1.0 flip (W20) |
| `cli-dump-index.schema.json` | `dump-index` | `dump_index` | `schema: "mochi-cli-dump-index-v1"` | frozen at the 1.0 flip (W20) |
| `cli-restore.schema.json` | `get -C DIR`, `restore-test` | `emit_restore` | `schema: "mochi-cli-restore-v1"` | frozen at the 1.0 flip (W20) |
| `cli-rewrite.schema.json` | `compact`, `gc apply`, `rekey --reencrypt` | `rewrite`, `reencrypt_cmd` | `schema: "mochi-cli-rewrite-v1"` | frozen at the 1.0 flip (W20) |
| `cli-repair-apply.schema.json` | `repair apply` | `repair_apply` | `schema: "mochi-cli-repair-apply-v1"` | frozen at the 1.0 flip (W20) |
| `cli-rekey-list.schema.json` | `rekey --list` | `rekey` | `schema: "mochi-cli-rekey-list-v1"` | frozen at the 1.0 flip (W20) |
| `cli-plan-saved.schema.json` | `gc plan --output`, `repair plan --output`, with `--json` | `gc_plan`, `repair_plan` | `schema: "mochi-cli-plan-saved-v1"` | frozen at the 1.0 flip (W20) |
| `cli-migrate.schema.json` | `migrate` | `migrate_cmd` | `schema: "mochi-cli-migrate-v1"` | frozen at the 1.0 flip (W20) |
| `cli-find.schema.json` | `find` | `find_cmd` | `schema: "mochi-cli-find-v1"` | frozen when written (B.2.18, 2026-10-24) |

**Frozen** means R7's rule applies: adding an error code is allowed (it appends to
`error-code` in `common.schema.json`); any other change is a new identifier (a new
`schema_version`, `format`, `schema`, or `version`, and a new file here), never an edit.
**Frozen at the 1.0 flip (W20)** is the state of the twelve command outputs. By the
owner's decision O2 (R7 §9, 2026-10-14) each carries an in-band `schema` tag
(`mochi-cli-<name>-v1`, named after its file) that its schema requires as a `const`;
until the flip they were tagged and checked but not frozen. At the flip (1.0, plan
W20) each tag became a frozen identifier, and a later change is a `-v2` tag and a new
file. `cli-migrate.schema.json` is the twelfth: `mochi migrate` is new at the flip, so
it was frozen as it was written. The eight earlier frozen documents received no tag and
no new field. `cli-find.schema.json` is the thirteenth command output: `mochi find`
(spec Annex B.2.18, D28, 2026-10-24) came after the flip, carries its tag
`mochi-cli-find-v1` the same way, and was frozen as it was written.

A consumer that validates an output should use the schema of the tool version that
wrote it (`tool.version` in a report): a newer tool may emit an error code an older
copy of `common.schema.json` does not list. A consumer that only reads should treat an
unknown code as unknown, never as success.

## Not JSON, so not covered

Text output (without `--json`), `--help` and `--version`, `get --stdout` (file bytes),
warnings on standard error, and argument-parsing errors: those are clap's text on
standard error even with `--json`, exit 3, because an invocation that does not parse
has no output mode (R7 §9, item 8). The quarantine sidecar `*.mochiq` and the archives
themselves are MOCHI format, specified by R1 to R6.
