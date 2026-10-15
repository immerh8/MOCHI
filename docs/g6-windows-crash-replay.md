# G6 on Windows without hardware: block-level crash replay (G6b)

Status: harness built; evidence section below is filled from CI runs only.
Gate G6 (spec Annex B.2.6): *documented evidence matching the guarantee to NTFS on the supported versions, plus release-checklist results. Until G6 passes, Windows reports `Unconfirmed`.* This document describes a hardware-free way to produce that evidence. **It does not change what Windows reports**: `Unconfirmed` stays until a separate change flips it, after this harness passes on the G6a code.

Files: workflow `.github/workflows/g6-windows.yml`; driver `ci/g6-windows-crashreplay.sh`; host logic `ci/g6-windows/` (`orchestrate.py`, `logwrites.py`, `test_logwrites.py`); guest scripts `ci/g6-windows/guest/`; guest workload and judge `crates/mochi-testkit/examples/g6_winworkload.rs`. The Linux counterpart is G7's `ci/g7-powercut.sh` (`dm-flakey`); this is the same question asked of NTFS.

## Method

This is the CrashMonkey / `dm-log-writes` approach: record every write, FLUSH and FUA the guest sends to a disk, in order; then rebuild the disk as it would be if power had failed at a chosen point in that sequence, and ask the file system and the application what they find.

1. **VM host.** A GitHub-hosted `ubuntu-24.04` runner. `/dev/kvm` is present on the standard runners for public repositories and is made usable with a udev rule (`MODE="0666"`); `setup` exits 3 with an error if it is not. The harness **never falls back to TCG emulation**: a run without KVM is a failed run. QEMU 8.2 with OVMF (Secure Boot, Microsoft keys enrolled) and `swtpm` (TPM 2.0), which is what Windows 11 setup checks for. No setup check is bypassed.
2. **Guest.** Microsoft's *Windows 11 Enterprise* evaluation ISO from the Evaluation Center (`go.microsoft.com/fwlink/?linkid=2382600`), installed unattended from `ci/g6-windows/guest/image/autounattend.xml` (UEFI/GPT, local throwaway account, first-logon provisioning from a second disc). Only Microsoft-published media; no activation workaround; nothing from it is committed. The installed image is cached with `actions/cache` keyed on the answer-file and provisioning scripts, the ISO file name (which carries the Windows build and timestamp) and the calendar month (an evaluation image is good for 90 days; the monthly key keeps a cached image well inside that). The ISO's SHA-256 is recorded in the evidence rather than used as the key because the key must be known before the 8 GB download.
3. **Logged data disk.** The archives live on a separate 1 GiB disk. The guest formats it NTFS itself (`format.ps1`). On the host it is a raw file behind a loop device behind `dm-log-writes` (`log-writes` target, log on a second loop file) and is given to QEMU as a block device with `cache=none,aio=native` (`O_DIRECT`): a guest FLUSH CACHE reaches the device as a flush and is recorded; nothing is absorbed by the host page cache. The disk is SATA (AHCI) because Windows has an inbox driver for it and it needs no extra driver media.
4. **Workload in the guest** (`g6_winworkload workload`). It calls the real storage path of `mochi-core` (`OsDir`, `ArchiveWriter::create_in`, then `commit` for the remaining scripted steps) for four archives of three commits. After each acknowledgement it sends `MARKREQ ack:<name>:<seq>:<D|U>` to the host on **COM1** (an emulated 16550 serial port, never the data disk) and waits for `MARKED`. The host answers by inserting a **mark** into the `dm-log-writes` log (`dmsetup message … mark …`), so the log orders every acknowledgement after every write the guest had completed when it was acknowledged. `D` is `PublishDurability::Durable`, `U` is `DirectoryUnconfirmed`.
5. **Replay and judge.** The log is parsed (`logwrites.py`, checked against the real `replay-log` by `test_logwrites.py`). Replay points are:
   * every FLUSH/FUA entry inside the workload, always including the barrier just before and just after each acknowledgement, thinned evenly to `--max-flush` (default 72);
   * `--between` (default 24) seeded points after ordinary writes, i.e. the log cut mid-epoch, so the writes after the cut and any unflushed ones are dropped;
   * the first and last points of the workload;
   * the control points below.

   Each point is `replay-log --log … --replay <fresh copy of the formatted disk> --limit N`. Up to twelve replayed disks are attached to one boot of the checker VM (the same image, fresh overlay). The guest brings them online one at a time; **mounting the volume makes NTFS run its own log recovery**. The disks share a GPT GUID, so each is taken offline before the next is brought online, and the image's SAN policy is *OfflineAll* so that none is mounted (or `chkdsk`ed at boot) before the harness asks. The judge runs in the guest on each mounted volume and the result goes back over COM1 as one JSON line per point.

### The judge

`g6_winworkload check` applies the G7 rules, extended to appends. At each archive's final name there is **nothing, or an archive that opens and whose state is exactly the state after some scripted commit** (never a mixed or partial commit); if present its head is at least the highest `Durable` acknowledgement before the point; a `Durable` creation acknowledgement means the name is present; leftover temporary files are removable; nothing else is in the directory. Then, from the same guest run: `mochi verify … --json --no-local-history` on every archive present (exit 1 or 3 fails; other non-zero exits are recorded), and `chkdsk /scan` (recorded; not a verdict). A volume that does not mount as NTFS after recovery fails the point.

A name that is absent although only `DirectoryUnconfirmed` was acknowledged is **allowed**, because the acknowledgement said so, and is counted as a *soft observation*. This is what the current Windows publication (link then unlink, no directory flush) is expected to show; it is the baseline.

### Controls (as in G7)

The method is only valid if the logged device behaves as assumed, so the run starts with a control: three times, the guest writes a file and calls `FlushFileBuffers`, marks, then writes another file *without* flushing, and marks. A replay to just after the mark must contain every flushed file complete (**synced data survives**); a replay to the last barrier before the second mark must not contain the unflushed file complete (**unsynced data is droppable**; at least one of the three, because the lazy writer may legitimately flush early). If either fails the run fails, whatever else it found.

## What it proves, and what it does not

It shows that for the exact Windows build below, on an NTFS volume on a disk that **honours FLUSH/FUA**, every replayed crash state of the tested sequence either recovers to a state the application accepts or is reported by the judge. That is evidence about the **ordering and flush discipline of the code**: that after `FlushFileBuffers` and the publication step it uses, what was acknowledged is in the write stream before the acknowledgement, in the order NTFS's recovery needs.

It does **not** show:

* **Anything about a device that lies about flushes.** The method assumes the disk persists what it acknowledged as flushed. A consumer disk that acknowledges FLUSH from a volatile cache is out of scope for any software test, exactly as for G7. The specification already reports a lying device as degraded.
* **That Windows Server or a different Windows build behaves the same.** One client build is tested; the build is in the evidence.
* **Behaviour of real storage stacks** (NVMe, USB, BitLocker, Storage Spaces, antivirus filters, network shares). The disk is emulated SATA. A filter driver that reorders or drops flushes on real systems is not modelled.
* **Reordering inside an epoch.** `replay-log` replays prefixes. Writes between two barriers are replayed in issue order, never permuted or partially dropped by subset, so a device that legally reorders unflushed writes is not fully explored (CrashMonkey permutes; this does not).
* **Exhaustive coverage.** Points are sampled (bounded, seeded, boundary-biased).
* **Faults other than power loss** (torn sectors, bit rot, failing media).
* **Windows 10 22H2.** See below.

### Supported versions

Plan O11 names Windows 10 22H2 and Windows 11. **Windows 10 is a documented gap.** Windows 10 22H2 left mainstream support on 2025-10-14 and, as checked on 2026-10-15, Microsoft's Evaluation Center no longer offers it: `microsoft.com/en-us/evalcenter/download-windows-10-enterprise` answers `301 Moved Permanently` to a Windows blog post on moving to Windows 11. Only Microsoft-published evaluation media are used, so no Windows 10 image is run. Windows 11 Enterprise LTSC 2024 evaluation (build 26100, `linkid=2289029`) is still offered, but it is Windows 11 and does not stand in for 22H2. NTFS is the same on-disk format and driver family on both, which is an argument, not evidence; G6 as worded asks for evidence on the supported versions, so this gap needs an owner decision (see the PR description for the proposed wording).

## Running it

Workflow `g6-windows` (`workflow_dispatch`, weekly schedule; never on pull requests):

```text
gh workflow run g6-windows.yml --ref <harness branch> -f ref=<code under test> -f baseline_ref=main
```

`ref` is the tested tree (for example the G6a branch); `baseline_ref` the reference run (default `main`, the current link-then-unlink publication; empty skips). The harness example `g6_winworkload.rs` is overlaid on the tested tree and built with `crt-static`, so a ref that predates the harness can be tested. The candidate's outcome decides the job; the baseline's is reported only.

Locally the host side needs root, KVM, `dm-log-writes`, QEMU/OVMF/swtpm and `replay-log`; `ci/g6-windows-crashreplay.sh setup` installs them on an Ubuntu 24.04 host. Only the log reader can be run without a Windows image: `ci/g6-windows-crashreplay.sh selftest`.

## Evidence it produces

The `g6-evidence` artifact (90 days) holds, per run label (`candidate`, `baseline`): `summary.json` and `summary.md` (exact Windows build, ISO name and SHA-256, QEMU/kernel/tool versions, parameters and seed, log statistics, control results, point counts by kind, hard failures, soft observations), `results.json` (every point's raw guest result), `points.json`, and the serial log of each VM boot. A failed image build uploads the serial log and the last screenshots.

## Differences from the method as first proposed

* **Serial port, not virtio-serial.** Windows ships no virtio drivers, and obtaining them is another download to trust. COM1 (an emulated 16550, inbox driver) carries the same acknowledgements.
* **SATA, not virtio-blk, for the same reason.** Flushes still reach the host as flushes.
* **Batches of disks per boot, not a `savevm` snapshot.** A snapshot of a Secure Boot, SMM, swtpm guest is fragile. Twelve replayed disks per checker boot amortise the boot instead.

## Evidence (filled in from CI)

*Not yet recorded.* This section is completed from the first green runs of `g6-windows`: run URLs, the exact Windows build and ISO hash, point counts, and the control results, for the candidate and the baseline.
