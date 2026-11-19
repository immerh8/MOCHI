# Developer documents

Notes for people working on MOCHI itself. Users want the [user guide](../user/README.md);
the format is defined by the [specification](../spec.md).

| Document | What it covers |
|---|---|
| [decisions.md](decisions.md) | Load-bearing design decisions, the Definition of Done, and the product decision log (O1–O32) that code comments cite as "plan O*n*" |
| [packaging.md](packaging.md) | Building the Windows and Ubuntu installers, shell integration, the in-app updater, and releasing |
| [release-runbook.md](release-runbook.md) | The checks run by hand before a release is published |
| [encrypted-profile.md](encrypted-profile.md) | How the Encrypted profile and `rekey` are implemented |
| [tar-compatible-profile.md](tar-compatible-profile.md) | How TAR-compatible archives are written, and what was tested with generic tools |
| [restore-platforms.md](restore-platforms.md) | Restoring files on Linux and Windows: names, attributes, durability |
| [windows-crash-replay.md](windows-crash-replay.md) | The crash-replay evidence behind Windows directory durability (gate G6) |
| [performance.md](performance.md) | Measured costs (scaling, append, capacity and memory, read, parity, threads, after a commit), each with its dataset, hardware and settings |

Also: [`AGENTS.md`](../../AGENTS.md) (every rule review checks),
[`CONTRIBUTING.md`](../../CONTRIBUTING.md), the [JSON output schemas](../schemas/json/README.md),
the [report format](../report-schema-v1.md), the [golden fixtures](../../fixtures/golden/README.md),
[fuzzing](../../fuzz/README.md), and the [independent Python verifier](../../interop/pyverify/README.md).

Labels such as C6, D3, R6, T12 or W20 in comments and commit messages name the
development phase in which something was built; [decisions.md](decisions.md) explains them.
