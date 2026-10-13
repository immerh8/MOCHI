# MOCHI user guide

MOCHI is an archive format and archiver. This guide is for people who use the `mochi`
command line tool. Every statement here comes from the specification (`docs/spec.md`),
a frozen ratification artifact (`docs/ratification/`), the CLI reference
(`docs/c14-cli.md`), or the behaviour of the code, and each page says which.

> **Experimental. The format will change.** Every build before 1.0 is
> "experimental / draft-compatible" (spec §28). Do not use it as your only copy.
> See [experimental.md](experimental.md).

Read these first, in this order:

| Page | What it tells you |
|---|---|
| [A `.mochi` file is not a backup](not-a-backup.md) | What an archive is and is not, and what to do about copies |
| [Getting started](getting-started.md) | The commands that exist today, each with an example that was run |
| [Encrypted archives](encrypted.md) | What is visible without the key, what stops working, lost passphrases, removing a passphrase, the equal-content leak |
| [What the checks prove](verification.md) | `verify`, `fsck`, `restore-test`, `health`, and the status values |
| [TAR-compatible archives](tar-compatible.md) | The tested commands and tools, and why generic tools show history |
| [Recovery record](recovery-record.md) | Parity as a repair aid, with its stated capacity |
| [Experimental status](experimental.md) | What "experimental / draft-compatible" means for you |

The desktop application is a client of the same library (spec §23.3). Its "Test archive"
command is `verify`; this guide documents the command line.

Platforms: the desktop application targets Windows 10 22H2 / 11 and Ubuntu 22.04 / 24.04
on x86-64 (plan O11).

Command reference, exit codes, and known concessions: [`docs/c14-cli.md`](../c14-cli.md).
