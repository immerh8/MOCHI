# The R9 task (W17), as the verifier's author read it

This is section W17 of the retired ratification plan, kept verbatim because it is the
task text the independent verifier in this directory was written from (see
`README.md`, "What was read"). It is a historical record, not a current plan.

### W17 — R9 independent verifier (XL; cold session)

**Who.** Not the session that wrote W10–W16. Create a **new session** with
`create_session`:
- `source_url`: this repository;
- `sparse_checkout_paths`: `["docs", "fixtures/golden", "interop"]`;
- `prompt`: the W17 kickoff prompt in §4.

If `create_session` is unavailable, the owner starts the session by hand with the same
prompt. The workhorse session must not edit `interop/` itself.

**Summary format** `mochi-interop-summary-v1` (normative for R9; the Rust side produces
the same JSON in W16). Keys sorted; all bytes as lowercase hex; arrays sorted as stated:

```json
{
  "format": "mochi-interop-summary-v1",
  "case": "<name>",
  "head": {"status": "opened", "code": null},
  "archive_id": "<hex>|null",
  "profile": {"encrypted": false, "tar_compatible": false, "recovery_percent": null},
  "commits": [{"seq": 0, "commit_id": "<hex>", "footer_offset": 123, "checkpoint": true}],
  "snapshots": [{"seq": 0, "entries": [
      {"path": "<hex of path bytes>", "kind": "file|dir|symlink", "size": 0,
       "content_hash": "<hex>|null", "target": "<hex>|null",
       "attributes": {"posix_mode": 420, "uid": 0, "gid": 0, "mtime_ns": 0, "windows": null}}]}],
  "findings": [{"code": "STORED_INTEGRITY_FAILED", "object": "<stored hash hex>|null"}],
  "parity": {"commits": 3, "damaged_shards": 0, "rebuilt": 0, "beyond_capacity": 0}
}
```

The fields mean:
- `head.status`: `opened`, or `refused` with the one R7 code.
- `commits`: the verified chain, ascending.
- `snapshots`: every snapshot the verified chain retains, ascending. Entries are sorted
  by path bytes, and attributes are the promised ones as recorded.
- `findings`: the sorted, unique set of **violation-class** findings: code plus the
  stored-object hash it concerns, or null. Information and operational findings are
  excluded.
- `parity`: null without a recovery record.
- Encrypted cases are summarized **with** the passphrase. Keyless cases have their own
  case names, in which content-level fields are null.

**Clarified by W18 (2026-10-13; the format, `mochi-interop-summary-v1`, is unchanged).**
Where the list above leaves room, the rules in `fixtures/golden/README.md`, "R8
summaries", are part of the format: `head.status` may also be `keyless`; the head's
refusal code is one of the `findings` (a wrong passphrase is a refused head with
`KEY_UNAVAILABLE`, not a missing summary); `object` names a stored-object hash only
for a damaged data chunk, once per code; `snapshots` has one entry per commit of the
chain whose state opens (retention marks collectability, it removes nothing);
`parity.commits` counts every commit the scan reaches; `findings` come from the bytes
as stored, and the chain and snapshots from the parity-rebuilt view. The case's
passphrase and freshness anchor are the `passphrase` and `expected_head` of
`cases.json`.

**Work.**
1. Read the spec and R1–R7, and write `interop/pyverify/READING-LOG.md`: every ambiguity
   met, with the reading taken. This is evidence for W18.
2. Implement `interop/pyverify/` (package `mochi_verify`):
   - CLI: `python3 -I -m mochi_verify ARCHIVE [--passphrase-file F] [--expected-head HEX]
     --summary`.
   - Modules: `cbor` (strict D2 decoder with the re-encode check), `frames`, `footer`,
     `descriptor`, `envelope`, `commit`, `manifest` (replay), `catalog` (R4 check via
     `sqlite3`), `objects`, `crypto` (R5), `parity` (R6, written from R6's text, **not**
     from `gen_vectors.py`), `tar`, `summary`.
3. Tests (`pytest`, pinned in `requirements.txt` with hashes):
   - R5 and R6 `vectors.json` reproduce.
   - The per-phase golden vectors (`c1`, `c2`, `c4`, `c5`, `b2`, `c11`, `c12`) give
     their listed verdicts.
   - Truncation at every byte of the small valid R8 cases never yields a commit outside
     the original prefix.
4. CI job `r9-interop` on ubuntu-22.04 (Python 3.10) and ubuntu-24.04 (Python 3.12):
   install the pins, run pytest, and run the summary over every R8 case and diff against
   `<case>.summary.json`. Mismatches fail the job, and the list is printed.
5. `interop/pyverify/README.md`: the provenance statement (what was read, what was not;
   the session ID), how to run, and the dependencies with licences.

**Rules for this session.**
- Never read `crates/`, `apps/`, `docs/ratification/*/gen_vectors.py`, or any `docs/*.md`
  other than `docs/spec.md`.
- When the text is ambiguous, **do not look for the answer in the expected summaries**:
  record it in the reading log, pick the reading the text best supports, and let W18
  surface the mismatch.

**PR:** "R9: independent read-only verifier (Python)".
