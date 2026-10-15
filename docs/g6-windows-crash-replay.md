# G6 on Windows without hardware: block-level crash replay (G6b)

Gate G6 (spec Annex B.2.6): *documented evidence matching the guarantee to NTFS on the supported versions, plus release-checklist results. Until G6 passes, Windows reports `Unconfirmed`.* This document describes a hardware-free way to produce that evidence, and what it found. **It does not change what Windows reports**: `Unconfirmed` stays until a separate change flips it, after the owner has judged this evidence.

Files: workflow `.github/workflows/g6-windows.yml` (manual and weekly, never on pull requests); driver `ci/g6-windows-crashreplay.sh`; host logic `ci/g6-windows/` (`orchestrate.py`, `logwrites.py`, tests `test_logwrites.py` and `test_evaluate.py`); guest scripts `ci/g6-windows/guest/`; guest workload and judge `crates/mochi-testkit/examples/g6_winworkload.rs`. The Linux counterpart is G7's `ci/g7-powercut.sh` (`dm-flakey`); this asks the same question of NTFS.

## What it found (summary)

On Windows 11 Enterprise 26H2 (build 26300.9457) and Windows 10 Enterprise 22H2 (build 19045.2006), both NTFS, both guests behaving identically:

1. **The shipped Windows creation path (G6a, `MoveFileExW` write-through, then the best-effort directory flush) keeps every acknowledged creation and commit across all 71 sampled crash points per OS**, including a crash right after each acknowledgement with every unflushed write dropped, even when a creation acknowledged `DirectoryUnconfirmed` is judged as if it had said `Durable`. The previous link-then-unlink path does too.
2. **That durability comes from the directory flush, not from write-through.** Controls on this NTFS: a rename with no flush is lost (3/3); a rename followed by `FlushFileBuffers` on the directory handle survives (3/3); a `MoveFileExW(MOVEFILE_WRITE_THROUGH)` rename on its own is lost (3/3) and leaves no flush in the log. At archive level, the real publication path with only `sync_directory` suppressed loses the archive's name at the crash point right after each of the four creation acknowledgements (4 hard failures on each OS). G6a (`crates/mochi-core/src/storage/os.rs`, module docs) says it relies on the first sentence of Microsoft's description of `MOVEFILE_WRITE_THROUGH`, "the function does not return until the file is actually moved on the disk", and leaves "whether that is enough for G6" to G6's evidence. On these two NTFS builds it is not enough for a same-volume rename: the sentence that follows it in Microsoft's text, which guarantees the flush for a move performed as copy-and-delete, is the one this behaviour matches.
3. **The harness can see a lost name**, so the passes in (1) are not vacuous.

The consequence for G6a is that write-through does not, on this evidence, make the created name durable by itself; the `FlushFileBuffers`-on-directory step that `sync_directory` already performs (and then reports as `Unconfirmed`, because Microsoft does not document it) does. The Windows guarantee rests on that step in practice. Whether an observed, undocumented behaviour of that step is enough for G6 is the owner's decision.

## Method

This is the CrashMonkey / `dm-log-writes` approach: record every write, FLUSH and FUA the guest sends to a disk, in order; rebuild the disk as it would be had power failed at a chosen point in that sequence; ask the file system and the application what they find.

1. **VM host.** A GitHub-hosted `ubuntu-24.04` runner. `/dev/kvm` is present on standard runners for public repositories and is made usable with a udev rule; `setup` exits 3 with an error if it is not. The harness **never falls back to TCG emulation**. QEMU 8.2, OVMF Secure Boot (Microsoft keys enrolled), `swtpm` TPM 2.0 (what Windows 11 setup checks for; no setup check is bypassed).
2. **Guest.** Microsoft's evaluation media only (below), installed unattended from `ci/g6-windows/guest/image/autounattend.xml` (UEFI/GPT, a throwaway local account that exists only in the VM, first-logon provisioning from a second disc). Nothing from the ISO is committed. The install takes 10–15 minutes under nested KVM and is done fresh on every run (see "Differences").
3. **Logged data disk.** The archives live on a separate 1 GiB NTFS disk formatted by the guest (`format.ps1`). On the host it is a raw file behind a loop device behind `dm-log-writes`, given to QEMU as a block device with `cache=none,aio=native`, so a guest FLUSH reaches the device as a flush and is recorded and nothing is absorbed by the host page cache. The disk is emulated SATA (AHCI), which Windows drives with an inbox driver.
4. **Workload in the guest** (`g6_winworkload workload`). It calls the real storage path of `mochi-core`: `OsDir`, `ArchiveWriter::create_in`, then `commit` for the remaining scripted steps, for four archives of three commits. After each acknowledgement it sends `MARKREQ ack:<name>:<seq>:<D|U>` to the host on **COM1** (an emulated 16550, never the data disk) and waits for `MARKED`. The host answers by inserting a mark into the `dm-log-writes` log, so the log orders every acknowledgement after every write the guest had completed. `D` is `PublishDurability::Durable`, `U` is `DirectoryUnconfirmed`. The workload also prints which `PublishMechanism` ran.
5. **Replay and judge.** The log is parsed (`logwrites.py`, checked against the real `replay-log` by `test_logwrites.py`). Each point is `replay-log --log … --replay <fresh copy of the formatted disk> --limit N`. Points, per run:
   * **flush**: every FLUSH/FUA entry inside the workload, always including the barrier just before and just after each acknowledgement, thinned evenly to `--max-flush` (72);
   * **ack-cut**: for each of the 12 acknowledgements, crash right after it with every write not yet flushed dropped: the log is persisted up to the last barrier before the acknowledgement, and the acknowledgement counts (G7's post-acknowledgement cut). Barrier points alone cannot show this state, because a barrier is always preceded by the writes it flushes;
   * **between**: 24 seeded cuts after ordinary writes (a mid-epoch prefix: everything issued up to that write is persisted, nothing after);
   * **edge**: the first and last points of the workload;
   * the **controls** below.

   Up to twelve replayed disks are attached to one boot of a checker VM (the same image on a fresh overlay). The guest brings them online one at a time; **mounting the volume makes NTFS run its own log recovery**. The disks share a GPT GUID, so each is taken offline before the next is brought online, and the image's SAN policy is *OfflineAll* so that none is mounted (or `chkdsk`ed at boot) before the harness asks. The judge runs in the guest and the result returns over COM1 as one JSON line per point.

### The judge

`g6_winworkload check` applies the G7 rules, extended to appends. At each archive's final name there is **nothing, or an archive that opens and whose state is exactly the state after some scripted commit** (never a mixed or partial commit); if present its head is at least the highest `Durable` acknowledgement before the point; a `Durable` creation acknowledgement means the name is present; leftover temporary files are removable; nothing else is in the directory. From the same guest run: `mochi verify … --json --no-local-history` on every archive present (exit 1 or 3 fails; other non-zero exits are recorded) and `chkdsk /scan` (recorded, not a verdict). A volume that does not mount as NTFS after recovery fails the point.

A name absent although only `DirectoryUnconfirmed` was acknowledged is *allowed*, because the acknowledgement said so, and counted as a soft observation. **`--strict-creation`** (the workflow default) judges a creation acknowledged `DirectoryUnconfirmed` as if it had said `Durable`: the question then is whether the name survives anyway, which is the question G6 poses. A run in which no replayed state, and not the end of the workload, ever holds a complete archive fails as vacuous.

### Controls (as in G7, extended to the namespace)

The method is valid only if the logged device behaves as assumed, so every run starts with controls and fails if they do not hold:

* **synced data survives**: a file written and `FlushFileBuffers`ed is complete in the replay taken just after (3 of 3 required);
* **unsynced data is droppable**: a file written and not flushed is not complete in the replay taken at the last barrier before (at least 1 of 3; the lazy writer may legitimately flush early);
* **an unflushed rename is droppable**: data flushed first, then a plain rename, no flush (at least 1 of 3 lost), so that a lost name is visible;
* **a flushed rename survives**: a rename followed by `FlushFileBuffers` on the directory handle, which is what `sync_directory` does on Windows (3 of 3 required);
* **recorded, not required**: a `MoveFileExW(MOVEFILE_WRITE_THROUGH)` rename on its own. It is the property under test.

## Evidence

Runs of `g6-windows` on harness commit `00b9524` (run 38742640128; the same results held in earlier runs on earlier harness commits, 38735495332 and others):

| | Windows 11 Enterprise eval, 26H2 | Windows 10 Enterprise eval, 22H2 |
|---|---|---|
| Build | 26300.9457 (`ProductName` in the registry still says "Windows 10" on Windows 11 builds; the build number decides) | 19045.2006 |
| ISO | `26300.9457.260913-1737.26h2_ge_release_svc_refresh_CLIENTENTERPRISEEVAL_OEMRET_x64FRE_en-us.iso`, SHA-256 `bc3f24086ebadc94489066b5ad78089e2cf5c3491e90e790bb81a2b199c10e38` | `19045.2006.220908-0225.22h2_release_svc_refresh_CLIENTENTERPRISEEVAL_OEMRET_x64FRE_en-us.iso`, SHA-256 `ef7312733a9f5d7d51cfa04ac497671995674ca5e1058d5164d6028f0938d668` |
| NTFS | version 3.1, LFS 2.0 (`fsutil fsinfo ntfsinfo`, recorded in `build-info.json` for each guest) | recorded in `build-info.json` |
| Controls (every run) | synced 3/3 survive; unsynced 3/3 droppable; unflushed rename 0/3 survived; flushed rename 3/3; `MOVEFILE_WRITE_THROUGH` alone 0/3 | the same |
| Candidate (G6a code, `MoveWriteThrough`), strict creation | **PASS**: 71 judged points, 0 hard failures; `mochi verify` 159 runs, all exit 0; `chkdsk /scan` clean | **PASS**: 71 points, 0 hard; `mochi verify` 153 runs all exit 0 |
| Baseline (`9b3a3a7`, `LinkThenUnlink`), strict creation | **PASS**: 71 points, 0 hard; verify 151 runs all 0 | **PASS**: 71 points, 0 hard; verify 155 runs all 0 |
| Candidate with only `sync_directory` suppressed, strict creation | **FAIL, as the diagnostic intends**: 4 hard failures, "durable creation acknowledged, name is gone", at the ack-cut of each of `a0`–`a3` | the same 4 |

The end of the workload holds all four archives at their last commit in every run. The job verdict is the candidate's; the baseline and the suppressed-flush runs are reference and never fail the job.

Each run uploads an artifact `g6-evidence-<os>` (90 days): per label `summary.json` and `summary.md` (exact build, ISO name and SHA-256, QEMU/kernel/tool versions, parameters and seed, log statistics, control results, point counts, outcome distribution, hard failures, soft observations), `results.json` (every point's raw guest result), `points.json`, and the serial log of each VM boot; and the Windows 10 availability probe `win10-probe.txt`.

## What this proves, and what it does not

It shows that for the exact builds above, on NTFS on a disk that **honours FLUSH/FUA**, the tested sequence recovers at every sampled crash point to a state the application accepts, and says which primitive makes that so. That is evidence about the **ordering and flush discipline of the code** and about NTFS's behaviour on these builds.

It does **not** show:

* **Anything about a device that lies about flushes.** The method assumes the disk persists what it acknowledged as flushed. A consumer disk that acknowledges FLUSH from a volatile cache is out of scope for any software test, exactly as for G7. The specification already reports a lying device as degraded.
* **Other Windows builds.** One build per OS is tested (below); Windows 10 22H2 was tested at its 2022 build, with no cumulative updates, because the guest has no network.
* **Real storage stacks** (NVMe, USB, BitLocker, Storage Spaces, antivirus filters, network shares). The disk is emulated SATA, a filter driver that reorders or drops flushes is not modelled, and the VM is nested virtualization on a cloud host.
* **Reordering inside an epoch.** `replay-log` replays prefixes. Writes between two barriers are never permuted or partly dropped by subset, so a device that legally reorders unflushed writes is not fully explored (CrashMonkey permutes; this does not).
* **Exhaustive coverage.** Points are sampled (bounded, seeded, boundary-biased), over one workload of four archives and twelve acknowledgements, with one run per label.
* **Faults other than power loss** (torn sectors, bit rot, failing media), or concurrency (two writers).
* **That the primitive controls are statistics.** Three samples each; the write-through result is a mechanism observation (no flush appears in the log), consistent across all runs.

## Supported versions and the Windows 10 question

Plan O11 names Windows 10 22H2 and Windows 11.

* **Windows 11**: Microsoft's Evaluation Center page for *Windows 11 Enterprise* is live (`go.microsoft.com/fwlink/?linkid=2382600`, the current 26H2 ISO; the LTSC 2024 evaluation, build 26100, `linkid=2289029`, also resolves).
* **Windows 10 22H2**: Windows 10 left mainstream support on 2025-10-14. On 2026-10-15 Microsoft's Evaluation Center pages for Windows 10 Enterprise, and for its LTSC 2021 edition, no longer present a download: the `download-` and `evaluate-windows-10-enterprise` pages answer `301 Moved Permanently` to a Windows blog post about moving to Windows 11 (observed with a page fetch; a plain HEAD request from a runner is refused with 403, which is bot protection, not evidence either way). **But Microsoft's own download links still resolve and serve the evaluation ISOs from Microsoft's CDN**: `go.microsoft.com/fwlink/p/?LinkID=2208844` redirects to `software-static.download.prss.microsoft.com/dbazure/…/19045.2006.220908-0225.22h2_release_svc_refresh_CLIENTENTERPRISEEVAL_OEMRET_x64FRE_en-us.iso` (5,550,497,792 bytes), and `LinkID=2195404` to the LTSC 2021 evaluation (`19044.1288`, build 21H2, not 22H2). `win10-probe.txt` records the answers on every run. The harness uses the first: it is Microsoft-published evaluation media with the standard 90-day evaluation terms, from Microsoft's domain via Microsoft's link, with no activation workaround and no third-party mirror. **It is, however, a link Microsoft no longer advertises**; whether that counts as obtainable for G6 is the owner's call. The workflow's `windows_10` input switches the Windows 10 leg off.

## Running it

```text
gh workflow run g6-windows.yml --ref <harness branch> -f ref=<code under test> -f baseline_ref=<reference>
```

`ref` is the tested tree (for example a branch under review); `baseline_ref` defaults to `9b3a3a7`, `main` just before G6a (link then unlink); empty skips it. The harness example `g6_winworkload.rs` is overlaid on the tested tree and built with `crt-static`, so a ref that predates the harness can be tested. Inputs also set `strict_creation` (default on), the point counts, `windows_10`, and `image_only`. Wall time is about 45 minutes per OS, the two OSes on parallel runners.

Locally the host side needs root, KVM, `dm-log-writes`, QEMU/OVMF/swtpm and `replay-log`; `ci/g6-windows-crashreplay.sh setup` installs them on Ubuntu 24.04. Without a Windows image only the self-tests run: `ci/g6-windows-crashreplay.sh selftest` (the log reader against the real `replay-log`, and the verdict logic on synthetic results, including a vacuous run, a violation, broken controls, and a missing result).

## Differences from the method as first proposed

* **COM1, not virtio-serial; SATA, not virtio-blk.** Windows ships no virtio drivers and obtaining them is another download to trust. The emulated 16550 and AHCI disk use inbox drivers and carry the same acknowledgements and flushes.
* **Batches of replayed disks per boot, not a `savevm` snapshot.** A snapshot of a Secure Boot, SMM, swtpm guest is fragile. Twelve replayed disks per checker boot amortise the boot instead (about 45 seconds a batch).
* **No cached Windows image.** The installed image archives to 12.2 GB, above the repository's 10 GB cache limit (measured: `actions/cache` reported the save, and the next run missed); a cache that size would also evict the repository's other caches. The install takes 10–15 minutes, and a fresh install keeps the 90-day evaluation image young. The ISO's SHA-256 is recorded rather than used as a key.
* **Points beyond the proposal**: ack-cut points, `--strict-creation`, the namespace controls and the suppressed-directory-flush diagnostic were added after the first green runs passed both publication paths and could not tell them apart. Without them the harness had no demonstrated power.
