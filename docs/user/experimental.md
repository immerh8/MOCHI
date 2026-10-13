# Experimental status

Sources: spec §26, §28; `AGENTS.md`; `mochi --version`.

Every build before 1.0 is **experimental / draft-compatible** (spec §28). The current
layout is frozen as "draft 2", but 1.0 has not been declared, and the specification
requires implementations to describe support this way until its release gates pass.

What that means for you:

* **The format may change.** A change to any frozen byte or rule is a new draft identifier,
  never an edit of the old one. A build may stop reading files written by an earlier draft.
  Pre-batch drafts are already refused as legacy (spec §26).
* **Do not use a pre-1.0 build as your only copy** of anything. `mochi --version`
  says so and so does the README.
* **A reader that does not understand a required feature says `UNSUPPORTED`,** never
  returns partial or empty content as if it were complete (spec §7.7, §26).
* **Not in 1.0** (spec Annex A; these commands exit 4 `UNSUPPORTED_FEATURE`):
  `inventory`, `split`, `join`, `mount`. Passphrase-only encryption (no key files or public
  keys), split volumes, remote storage, signatures, and writing any non-MOCHI archive
  format are also outside 1.0.
* **Version numbers are different things** (spec §1.2, §26): the product release, the
  specification revision, the container wire generation, the metadata schema version.
  A product labelled 1.0 writing wire generation 2 is intentional.
