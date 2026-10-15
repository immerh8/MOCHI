#!/usr/bin/env python3
"""Host side of the G6 Windows crash-replay harness (docs/g6-windows-crash-replay.md).

Subcommands (driven by ci/g6-windows-crashreplay.sh, run as root on an
ubuntu runner with /dev/kvm):

    iso-info            resolve Microsoft's evaluation ISO link; print name and size
    iso                 download it and record its SHA-256
    image               unattended install into a qcow2 image (cached by the workflow)
    run                 format, run the workload on a logged disk, replay, judge

Nothing here is Windows-specific logic that decides a verdict: the guest
reports facts over COM1 and the judge is `g6_winworkload check` plus the
facts evaluated in `evaluate()` below.
"""

import argparse
import concurrent.futures
import datetime
import hashlib
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import logwrites as lw  # noqa: E402

# Microsoft Evaluation Center, "Windows 11 Enterprise" 64-bit en-US ISO
# (fwlink resolved on 2026-10-15). The target moves with each release; the
# resolved file name carries the build and is recorded as evidence.
ISO_URL = "https://go.microsoft.com/fwlink/?linkid=2382600&clcid=0x409&culture=en-us&country=us"
OVMF_CODE = "/usr/share/OVMF/OVMF_CODE_4M.secboot.fd"
OVMF_VARS = "/usr/share/OVMF/OVMF_VARS_4M.ms.fd"
GUEST = HERE / "guest"
DM_NAME = "g6log"
BATCH = 12
MEM_MB = 8192
SMP = 4


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%H:%M:%S")


def log(*a):
    print(f"[{now()}]", *a, flush=True)


def run(cmd, check=True, **kw):
    log("+", " ".join(str(c) for c in cmd))
    return subprocess.run([str(c) for c in cmd], check=check, **kw)


def out(cmd):
    return subprocess.run([str(c) for c in cmd], check=True, capture_output=True, text=True).stdout.strip()


def write_json(path, obj):
    pathlib.Path(path).write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n")


def github_output(**kv):
    p = os.environ.get("GITHUB_OUTPUT")
    if p:
        with open(p, "a") as f:
            for k, v in kv.items():
                f.write(f"{k}={v}\n")


# ---- media ------------------------------------------------------------------


def head_iso():
    txt = out(["curl", "-sIL", "-m", "60", ISO_URL])
    name, length = None, None
    for line in txt.splitlines():
        l = line.lower()
        if l.startswith("content-disposition:") and "filename=" in l:
            name = line.split("filename=", 1)[1].split(";")[0].strip().strip('"')
        if l.startswith("content-length:") and line.split(":", 1)[1].strip() not in ("", "0"):
            length = int(line.split(":", 1)[1].strip())
    if not name or not length:
        raise SystemExit(f"could not resolve the evaluation ISO from {ISO_URL}:\n{txt}")
    return name, length


def cmd_iso_info(a):
    name, length = head_iso()
    print(json.dumps({"name": name, "length": length}))
    github_output(iso_name=name, iso_length=length)


def cmd_iso(a):
    work = pathlib.Path(a.work)
    work.mkdir(parents=True, exist_ok=True)
    name, length = head_iso()
    iso = work / "win.iso"
    run(["curl", "-L", "--fail", "--retry", "5", "--retry-delay", "10", "-o", iso, ISO_URL])
    if iso.stat().st_size != length:
        raise SystemExit(f"downloaded {iso.stat().st_size} bytes, expected {length}")
    h = hashlib.sha256()
    with open(iso, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 22), b""):
            h.update(chunk)
    info = {"name": name, "length": length, "sha256": h.hexdigest(), "source": ISO_URL, "downloaded": now()}
    write_json(work / "win.iso.json", info)
    log("ISO", info)


# ---- QEMU -------------------------------------------------------------------


class Serial:
    """Line-oriented client of QEMU's COM1 socket."""

    def __init__(self, path, log_path, on_line):
        self.path, self.on_line = path, on_line
        self.lines = []
        self.sock = None
        self.logf = open(log_path, "a")
        self.thread = None

    def connect(self, timeout=60):
        end = time.time() + timeout
        while True:
            try:
                s = socket.socket(socket.AF_UNIX)
                s.connect(self.path)
                break
            except OSError:
                if time.time() > end:
                    raise
                time.sleep(0.2)
        self.sock = s
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()

    def _read(self):
        buf = b""
        while True:
            try:
                data = self.sock.recv(4096)
            except OSError:
                return
            if not data:
                return
            buf += data
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                text = line.decode("utf-8", "replace").strip("\r\n \x00")
                if not text:
                    continue
                self.logf.write(f"{now()} {text}\n")
                self.logf.flush()
                self.lines.append(text)
                try:
                    self.on_line(text)
                except Exception as e:  # never kill the reader
                    self.logf.write(f"{now()} HOST-ERROR {e!r}\n")

    def send(self, text):
        self.sock.sendall((text + "\n").encode())

    def seen(self, prefix):
        return any(l.startswith(prefix) for l in list(self.lines))


class Qmp:
    def __init__(self, path, timeout=60):
        end = time.time() + timeout
        while True:
            try:
                s = socket.socket(socket.AF_UNIX)
                s.connect(path)
                break
            except OSError:
                if time.time() > end:
                    raise
                time.sleep(0.2)
        self.f = s.makefile("rw")
        self.s = s
        self.f.readline()  # greeting
        self.cmd("qmp_capabilities")

    def cmd(self, name, **args):
        self.f.write(json.dumps({"execute": name, "arguments": args}) + "\n")
        self.f.flush()
        while True:
            line = self.f.readline()
            if not line:
                raise OSError("qmp closed")
            r = json.loads(line)
            if "return" in r:
                return r["return"]
            if "error" in r:
                raise RuntimeError(r["error"])

    def key(self, qcode):
        self.cmd("send-key", keys=[{"type": "qcode", "data": qcode}])


class Vm:
    """One QEMU guest: OVMF Secure Boot, swtpm TPM 2.0, SATA disks, COM1 socket."""

    def __init__(self, work, name, *, sys_disk, vars_src, tpm_src, cds=(), data=(), on_line=None, sys_format="qcow2"):
        self.dir = pathlib.Path(work) / "vm" / name
        if self.dir.exists():
            shutil.rmtree(self.dir)
        self.dir.mkdir(parents=True)
        self.name = name
        self.sys_disk, self.sys_format = sys_disk, sys_format
        self.cds, self.data = list(cds), list(data)
        self.vars = self.dir / "OVMF_VARS.fd"
        shutil.copy(vars_src, self.vars)
        self.tpm = self.dir / "tpm"
        if tpm_src and pathlib.Path(tpm_src).exists():
            shutil.copytree(tpm_src, self.tpm)
        else:
            self.tpm.mkdir()
        self.on_line = on_line or (lambda l: None)
        self.proc = None
        self.serial = None
        self.qmp = None
        self.shots = []

    def _args(self):
        d = self.dir
        a = [
            "qemu-system-x86_64", "-name", self.name,
            "-machine", "q35,accel=kvm,smm=on",
            "-cpu", "host,hv_relaxed,hv_spinlocks=0x1fff,hv_vapic,hv_time",
            "-smp", str(SMP), "-m", str(MEM_MB),
            "-global", "driver=cfi.pflash01,property=secure,value=on",
            "-drive", f"if=pflash,format=raw,unit=0,file={OVMF_CODE},readonly=on",
            "-drive", f"if=pflash,format=raw,unit=1,file={self.vars}",
            "-chardev", f"socket,id=chrtpm,path={self.tpm}/sock",
            "-tpmdev", "emulator,id=tpm0,chardev=chrtpm",
            "-device", "tpm-crb,tpmdev=tpm0",
            "-display", "none", "-vga", "std", "-nic", "none",
            "-rtc", "base=utc",
            "-chardev", f"socket,id=ser0,path={d}/serial.sock,server=on,wait=off",
            "-serial", "chardev:ser0",
            "-qmp", f"unix:{d}/qmp.sock,server=on,wait=off",
            "-drive", f"if=none,id=sys,file={self.sys_disk},format={self.sys_format},cache=unsafe",
            "-device", "ide-hd,drive=sys,bus=ide.0,bootindex=2,serial=G6SYS",
        ]
        for i, cd in enumerate(self.cds):
            a += [
                "-drive", f"if=none,id=cd{i},file={cd['path']},media=cdrom,readonly=on,format=raw",
                "-device", f"ide-cd,drive=cd{i},bus=ide.{i + 1}" + (",bootindex=1" if cd.get("boot") else ""),
            ]
        for j in range(0, (len(self.data) + 5) // 6):
            a += ["-device", f"ich9-ahci,id=ahci{j + 1}"]
        for j, dd in enumerate(self.data):
            a += [
                "-drive", f"if=none,id=dd{j},file={dd['path']},format=raw,cache=none,aio=native",
                "-device", f"ide-hd,drive=dd{j},bus=ahci{j // 6 + 1}.{j % 6},serial={dd['serial']},write-cache=on,rotation_rate=1",
            ]
        return a

    def start(self):
        # Not --daemon: a failure must be visible. Ubuntu confines swtpm with
        # AppArmor; setup disables that profile, and stderr is kept regardless.
        self.swtpm = subprocess.Popen(
            ["swtpm", "socket", "--tpm2", "--tpmstate", f"dir={self.tpm}",
             "--ctrl", f"type=unixio,path={self.tpm}/sock", "--log", f"file={self.tpm}/swtpm.log,level=5"],
            stdout=open(self.tpm / "swtpm.out", "w"), stderr=subprocess.STDOUT)
        for _ in range(100):
            if (self.tpm / "sock").exists():
                break
            if self.swtpm.poll() is not None:
                break
            time.sleep(0.1)
        if not (self.tpm / "sock").exists():
            for n in ("swtpm.out", "swtpm.log"):
                f = self.tpm / n
                print(f"--- {n}", f.read_text() if f.exists() else "(missing)", flush=True)
            raise SystemExit(f"swtpm did not start (exit {self.swtpm.poll()})")
        args = self._args()
        (self.dir / "cmdline").write_text(" ".join(args) + "\n")
        log("+", " ".join(args))
        self.proc = subprocess.Popen(args, stdout=open(self.dir / "qemu.out", "w"), stderr=subprocess.STDOUT)
        self.serial = Serial(f"{self.dir}/serial.sock", self.dir / "serial.log", self.on_line)
        self.serial.connect()
        self.qmp = Qmp(f"{self.dir}/qmp.sock")
        # Serial lines the guest sent before we connected would be lost; the
        # guest takes far longer than this to boot.

    def shot(self):
        n = len(self.shots)
        d = self.dir / "shots"
        d.mkdir(exist_ok=True)
        p = d / f"{n:03d}.png"
        try:
            self.qmp.cmd("screendump", filename=str(p), format="png")
            self.shots.append(p)
            while len(self.shots) > 10:
                old = self.shots.pop(0)
                old.unlink(missing_ok=True)
        except Exception as e:
            log("screendump failed:", e)

    def wait(self, timeout, until=None, spam_keys=0, shot_every=240, tick=None):
        t0 = time.time()
        last_shot, last_key, last_tick = 0.0, 0.0, 0.0
        while True:
            t = time.time() - t0
            if self.proc.poll() is not None:
                return "exited"
            if until and until():
                return "until"
            if t > timeout:
                return "timeout"
            if tick and t - last_tick >= 300:
                tick(t)
                last_tick = t
            try:
                if spam_keys and t < spam_keys and t - last_key >= 2:
                    self.qmp.key("ret")
                    last_key = t
                if shot_every and t - last_shot >= shot_every:
                    self.shot()
                    last_shot = t
            except Exception:
                pass
            time.sleep(0.5)

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.shot()
            try:
                self.qmp.cmd("quit")
            except Exception:
                pass
            try:
                self.proc.wait(20)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        sw = getattr(self, "swtpm", None)
        if sw and sw.poll() is None:
            sw.terminate()
            try:
                sw.wait(10)
            except subprocess.TimeoutExpired:
                sw.kill()


def build_iso(out_iso, label, files):
    """files: {name_on_disc: source_path}"""
    stage = pathlib.Path(str(out_iso) + ".stage")
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    for name, src in files.items():
        shutil.copy(src, stage / name)
    run(["xorriso", "-as", "mkisofs", "-quiet", "-J", "-R", "-V", label, "-o", out_iso, stage])
    shutil.rmtree(stage)


# ---- image ------------------------------------------------------------------


def cmd_image(a):
    work = pathlib.Path(a.work)
    img = work / "image"
    if img.exists():
        shutil.rmtree(img)
    img.mkdir(parents=True)
    iso_info = json.loads((work / "win.iso.json").read_text())
    sysdisk = work / "sys.qcow2"
    run(["qemu-img", "create", "-f", "qcow2", sysdisk, "80G"])
    unattend = work / "unattend.iso"
    build_iso(unattend, "G6UNATTEND", {
        "autounattend.xml": GUEST / "image/autounattend.xml",
        "provision.ps1": GUEST / "image/provision.ps1",
        "agent.ps1": GUEST / "image/agent.ps1",
    })
    info = {}

    def on_line(l):
        if l.startswith("BUILD "):
            info.update(json.loads(l[6:]))

    vm = Vm(work, "install", sys_disk=sysdisk, vars_src=OVMF_VARS, tpm_src=None,
            cds=[{"path": work / "win.iso", "boot": True}, {"path": unattend}], on_line=on_line)
    t0 = time.time()
    try:
        vm.start()
        how = vm.wait(a.timeout * 60, spam_keys=75, shot_every=300,
                      tick=lambda t: log(f"install: {t / 60:.0f} min, serial lines so far: {len(vm.serial.lines)}"))
        log("install finished:", how, f"after {(time.time() - t0) / 60:.1f} min")
    finally:
        vm.stop()
        keep_logs(vm, work / "evidence-image")
    if not vm.serial.seen("PROVISIONED"):
        show_serial(vm, 80)
        raise SystemExit("image build failed: the guest never reported PROVISIONED (see evidence-image/)")
    run(["qemu-img", "convert", "-O", "qcow2", "-c", sysdisk, img / "base.qcow2"])
    shutil.copy(vm.vars, img / "OVMF_VARS.fd")
    shutil.copytree(vm.tpm, img / "tpm", ignore=shutil.ignore_patterns("sock", "*.pid", "*.log", "*.out"))
    info["iso"] = iso_info
    info["built"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    info["install_minutes"] = round((time.time() - t0) / 60, 1)
    write_json(img / "build-info.json", info)
    sysdisk.unlink()
    run(["chmod", "-R", "a+rX", img])
    log("image ready", info)


def show_serial(vm, n=60):
    """Print the tail of a VM's serial log into the job log (artifact blobs are not always reachable)."""
    try:
        lines = (vm.dir / "serial.log").read_text().splitlines()
    except OSError:
        lines = ["(no serial log)"]
    print(f"--- serial log of {vm.name} (last {n} of {len(lines)} lines)", flush=True)
    for l in lines[-n:]:
        print("    " + l[:400], flush=True)


def keep_logs(vm, dest):
    dest = pathlib.Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    for n in ("serial.log", "qemu.out", "cmdline"):
        if (vm.dir / n).exists():
            shutil.copy(vm.dir / n, dest / f"{vm.name}.{n}")
    for n in ("swtpm.out", "swtpm.log"):
        if (vm.tpm / n).exists():
            shutil.copy(vm.tpm / n, dest / f"{vm.name}.{n}")
    if (vm.dir / "shots").exists():
        shutil.copytree(vm.dir / "shots", dest / f"{vm.name}.shots", dirs_exist_ok=True)


# ---- logged disk ------------------------------------------------------------


class LoggedDisk:
    """A raw file behind dm-log-writes, as the guest's data disk."""

    def __init__(self, raw, logfile, log_bytes=8 << 30):
        self.raw, self.logfile, self.log_bytes = pathlib.Path(raw), pathlib.Path(logfile), log_bytes
        self.loops = []
        self.dev = f"/dev/mapper/{DM_NAME}"

    def __enter__(self):
        with open(self.logfile, "wb") as f:
            f.truncate(self.log_bytes)
        data = out(["losetup", "--find", "--show", self.raw])
        self.loops.append(data)
        logdev = out(["losetup", "--find", "--show", self.logfile])
        self.loops.append(logdev)
        sectors = out(["blockdev", "--getsz", data])
        run(["dmsetup", "create", DM_NAME, "--table", f"0 {sectors} log-writes {data} {logdev}"])
        return self

    def mark(self, label):
        run(["dmsetup", "message", DM_NAME, "0", f"mark {label}"])

    def __exit__(self, *exc):
        for _ in range(10):
            if subprocess.run(["dmsetup", "remove", DM_NAME]).returncode == 0:
                break
            time.sleep(1)
        for l in self.loops:
            subprocess.run(["losetup", "-d", l])


# ---- run --------------------------------------------------------------------


def payload_iso(work, name, mode, extra):
    mode_file = work / f"mode-{name}.txt"
    mode_file.write_text(mode + "\n")
    files = {"entry.ps1": GUEST / "payload/entry.ps1", "common.ps1": GUEST / "payload/common.ps1",
             f"{mode}.ps1": GUEST / "payload" / f"{mode}.ps1", "mode.txt": mode_file}
    files.update(extra)
    iso = work / f"payload-{name}.iso"
    build_iso(iso, "G6PAYLOAD", files)
    return iso


def vm_from_image(work, name, image, cds, data, on_line):
    overlay = work / "vm" / f"{name}.overlay.qcow2"
    overlay.parent.mkdir(parents=True, exist_ok=True)
    overlay.unlink(missing_ok=True)
    run(["qemu-img", "create", "-f", "qcow2", "-b", image / "base.qcow2", "-F", "qcow2", overlay])
    return Vm(work, name, sys_disk=overlay, vars_src=image / "OVMF_VARS.fd", tpm_src=image / "tpm",
              cds=cds, data=data, on_line=on_line)


def cmd_run(a):
    work = pathlib.Path(a.work)
    image = work / "image"
    ev = pathlib.Path(a.evidence) / a.label
    ev.mkdir(parents=True, exist_ok=True)
    bins = pathlib.Path(a.bins)
    exe = {"g6_winworkload.exe": bins / "g6_winworkload.exe", "mochi.exe": bins / "mochi.exe"}
    summary = {"label": a.label, "started": datetime.datetime.now(datetime.timezone.utc).isoformat(),
               "seed": a.seed, "max_flush_points": a.max_flush, "between_points": a.between}
    if (bins / "BUILD.txt").exists():
        summary["subject_build"] = (bins / "BUILD.txt").read_text().strip()
    summary["windows"] = json.loads((image / "build-info.json").read_text())
    guest_facts = {}

    def facts(l):
        for k in ("VOLUME ", "DISKINFO ", "FORMATTED "):
            if l.startswith(k):
                guest_facts[k.strip().lower()] = l[len(k):]

    # 1. The guest formats the data disk.
    base = work / "base-data.raw"
    if not base.exists():
        with open(base, "wb") as f:
            f.truncate(1 << 30)
        pl = payload_iso(work, "format", "format", {})
        vm = vm_from_image(work, "format", image, [{"path": pl}], [{"path": base, "serial": "G6D000"}],
                           lambda l: (facts(l), vm.serial.send(f"MARKED {l[8:]}") if l.startswith("MARKREQ ") else None))
        try:
            vm.start()
            how = vm.wait(20 * 60)
        finally:
            vm.stop()
            keep_logs(vm, ev)
        if how != "exited" or not vm.serial.seen("FORMAT-DONE"):
            show_serial(vm)
            raise SystemExit(f"format phase failed ({how}); see {ev}")

    # 2. The workload, on a logged copy.
    raw = work / f"data-{a.label}.raw"
    shutil.copyfile(base, raw)
    logfile = work / f"log-{a.label}.bin"
    pl = payload_iso(work, "run-" + a.label, "run", exe)
    with LoggedDisk(raw, logfile) as disk:
        def on_line(l):
            facts(l)
            if l.startswith("MARKREQ "):
                label = l[8:]
                disk.mark(label)
                vm.serial.send(f"MARKED {label}")

        vm = vm_from_image(work, "run-" + a.label, image, [{"path": pl}], [{"path": disk.dev, "serial": "G6D000"}], on_line)
        try:
            vm.start()
            how = vm.wait(a.run_timeout * 60)
        finally:
            vm.stop()
            keep_logs(vm, ev)
    if how != "exited" or not vm.serial.seen("RUN-DONE"):
        show_serial(vm)
        raise SystemExit(f"run phase failed ({how}); see {ev}")
    if any(l.startswith(("RUN-ERROR", "WORKLOAD-RC")) and not l.startswith("WORKLOAD-RC 0") for l in vm.serial.lines):
        summary["workload_problem"] = [l for l in vm.serial.lines if l.startswith(("RUN-ERROR", "WORKLOAD-RC", "WL "))]
        write_json(ev / "summary.json", summary)
        raise SystemExit("the workload did not finish cleanly; see summary.json")

    for l in vm.serial.lines:
        if l.startswith(("WL ", "WORKLOAD-RC", "VOLUME ", "DISKINFO ", "FORMATTED ", "ENTRY")):
            print("    guest:", l[:300], flush=True)

    # 3. Read the log and choose points.
    entries = lw.parse(logfile)
    marks = [e for e in entries if e.is_mark]
    begin = lw.find_mark(entries, "workload:begin")
    end = lw.find_mark(entries, "workload:end")
    if not begin or not end:
        raise SystemExit("the log has no workload:begin / workload:end marks")
    acks = [m for m in marks if m.label.startswith("ack:") and begin.idx < m.idx < end.idx]
    summary["log"] = {
        "entries": len(entries), "marks": len(marks),
        "barriers_total": sum(1 for e in entries if e.is_barrier),
        "barriers_in_workload": sum(1 for e in entries[begin.idx:end.idx + 1] if e.is_barrier),
        "acks": len(acks),
    }
    points = lw.select_points(entries, begin.idx, end.idx, acks, a.max_flush, a.between, a.seed)
    points.append({"kind": "edge", "anchor": begin.idx, "limit": begin.idx + 1})
    points.append({"kind": "edge", "anchor": end.idx, "limit": end.idx + 1})

    ctl_sha = {}
    for m in marks:
        parts = m.label.split(":")
        if parts[0] == "ctl" and len(parts) == 5:
            _, kind, k, sha, size = parts
            ctl_sha[(kind, int(k))] = (sha, int(size), m)
    for (kind, k), (sha, size, m) in sorted(ctl_sha.items(), key=lambda kv: kv[1][2].idx):
        if kind == "synced":
            probe = [f"ctl\\synced_{j}.bin" for j in range(1, k + 1)]
            points.append({"kind": "ctl-synced", "anchor": m.idx, "limit": m.idx + 1, "probe": probe,
                           "expect": {p: ctl_sha[("synced", j)][:2] for j, p in zip(range(1, k + 1), probe)}})
        else:
            b = lw.last_barrier_before(entries, m.idx)
            points.append({"kind": "ctl-unsynced", "anchor": b.idx, "limit": lw.durable_limit(b),
                           "probe": [f"ctl\\unsynced_{k}.bin"], "expect": {f"ctl\\unsynced_{k}.bin": (sha, size)}})
    for i, p in enumerate(points):
        p["id"] = i
        if p["kind"] not in ("ctl-synced", "ctl-unsynced"):
            p["acks"] = [" ".join(m.label.split(":")[1:]) for m in acks if m.idx < p["limit"]]
    write_json(ev / "points.json", points)
    summary["points"] = {k: sum(1 for p in points if p["kind"] == k) for k in sorted({p["kind"] for p in points})}
    log("points:", summary["points"])

    # 4. Replay each point onto a fresh copy of the formatted disk, then judge it.
    results = {}
    t_check = time.time()
    for b0 in range(0, len(points), BATCH):
        batch = points[b0:b0 + BATCH]
        pdir = work / "points"
        if pdir.exists():
            shutil.rmtree(pdir)
        pdir.mkdir()
        data = []
        with concurrent.futures.ThreadPoolExecutor(4) as ex:
            def mk(j_p):
                j, p = j_p
                f = pdir / f"p{p['id']:03d}.raw"
                run(["cp", "--sparse=always", base, f])
                run(["replay-log", "--log", logfile, "--replay", f, "--limit", p["limit"]],
                    stdout=subprocess.DEVNULL)
                return {"path": f, "serial": f"G6D{j:03d}"}
            data = list(ex.map(mk, enumerate(batch)))
        guest_points = [{"id": p["id"], "serial": data[j]["serial"], "kind": p["kind"],
                         "acks": p.get("acks", []), "probe": p.get("probe", [])} for j, p in enumerate(batch)]
        meta = work / "points.json"
        write_json(meta, guest_points)
        pl = payload_iso(work, "check", "check", {**exe, "points.json": meta})

        def on_check(l):
            if l.startswith("RESULT "):
                r = json.loads(l[7:])
                results[r["id"]] = r

        vm = vm_from_image(work, f"check{b0 // BATCH}", image, [{"path": pl}], data, on_check)
        try:
            vm.start()
            how = vm.wait(a.check_timeout * 60)
        finally:
            vm.stop()
            keep_logs(vm, ev)
        got = sum(1 for p in batch if p["id"] in results)
        log(f"batch {b0 // BATCH}: {how}, {got}/{len(batch)} results")
        if got < len(batch):
            show_serial(vm)
    summary["check_minutes"] = round((time.time() - t_check) / 60, 1)

    # 5. Evaluate.
    verdict = evaluate(points, results, summary)
    summary["guest"] = guest_facts
    summary["finished"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    write_json(ev / "summary.json", summary)
    write_json(ev / "results.json", results)
    (ev / "summary.md").write_text(render_md(summary))
    for f in (logfile,):
        f.unlink(missing_ok=True)
    log("RESULT", a.label, "PASS" if verdict else "FAIL")
    sys.exit(0 if verdict else 1)


def evaluate(points, results, summary):
    hard, soft = [], []
    controls = {"synced": [], "unsynced": []}
    missing = [p["id"] for p in points if p["id"] not in results]
    if missing:
        hard.append(f"no result from the guest for points {missing}")
    for p in points:
        r = results.get(p["id"])
        if r is None:
            continue
        tag = f"point {p['id']} ({p['kind']}, limit {p['limit']})"
        if r.get("error") or r.get("mount") != "ok":
            hard.append(f"{tag}: volume did not come up after NTFS recovery: {r.get('error') or r.get('mount')}")
            continue
        if p["kind"] == "ctl-synced":
            ok = all(r["facts"].get(f, {}).get("exists") and
                     (r["facts"][f].get("sha256"), r["facts"][f].get("size")) == tuple(exp)
                     for f, exp in p["expect"].items())
            controls["synced"].append(ok)
        elif p["kind"] == "ctl-unsynced":
            (f, exp), = p["expect"].items()
            fact = r["facts"].get(f, {})
            controls["unsynced"].append(not fact.get("exists") or (fact.get("sha256"), fact.get("size")) != tuple(exp))
        else:
            try:
                judge = json.loads(r.get("judge", "{}").splitlines()[-1])
            except Exception:
                judge = {}
            if r.get("judge_rc") != 0 or judge.get("result") != "pass":
                hard.extend(f"{tag}: {h}" for h in (judge.get("hard") or [f"judge failed: {r.get('judge')!r}"]))
            soft.extend(f"{tag}: {s}" for s in judge.get("soft", []))
            for name, v in (r.get("verify") or {}).items():
                if v.get("rc") in (1, 3):
                    hard.append(f"{tag}: mochi verify {name} exited {v['rc']}: {v.get('out')}")
                elif v.get("rc") != 0:
                    soft.append(f"{tag}: mochi verify {name} exited {v['rc']}")
            if r.get("chkdsk_rc") not in (0, None):
                soft.append(f"{tag}: chkdsk /scan exited {r['chkdsk_rc']}: {r.get('chkdsk_tail')}")
    c_ok = bool(controls["synced"]) and all(controls["synced"]) and any(controls["unsynced"])
    summary["controls"] = {
        "synced_data_survived": f"{sum(controls['synced'])}/{len(controls['synced'])}",
        "unsynced_data_droppable": f"{sum(controls['unsynced'])}/{len(controls['unsynced'])} (at least one required)",
        "valid": c_ok,
    }
    if not c_ok:
        hard.append("controls failed: the logged device does not behave as the method requires "
                    "(synced data must survive every replay; unsynced data must be droppable)")
    judged = [p for p in points if p["kind"] in ("flush", "between", "edge")]
    summary["judged_points"] = len(judged)
    summary["hard_failures"] = hard
    summary["soft_observations"] = soft
    summary["verdict"] = "PASS" if not hard else "FAIL"
    return not hard


def render_md(s):
    w = s.get("windows", {})
    lines = [
        f"# G6 crash replay: {s['label']} ({s['verdict']})", "",
        f"* Windows: {w.get('ProductName')} {w.get('DisplayVersion')} build {w.get('CurrentBuild')}.{w.get('UBR')} ({w.get('EditionID')})",
        f"* ISO: `{w.get('iso', {}).get('name')}` sha256 `{w.get('iso', {}).get('sha256')}`",
        f"* Subject: {s.get('subject_build', 'n/a')}",
        f"* Log: {s.get('log')}", f"* Points: {s.get('points')}", f"* Controls: {s.get('controls')}",
        f"* Hard failures: {len(s['hard_failures'])}; soft observations: {len(s['soft_observations'])}", "",
    ]
    lines += [f"- HARD {h}" for h in s["hard_failures"][:50]]
    lines += [f"- soft {h}" for h in s["soft_observations"][:50]]
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", default=os.environ.get("G6_WORK", "/var/tmp/g6"))
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("iso-info").set_defaults(f=cmd_iso_info)
    sub.add_parser("iso").set_defaults(f=cmd_iso)
    p = sub.add_parser("image")
    p.add_argument("--timeout", type=int, default=60, help="minutes")
    p.set_defaults(f=cmd_image)
    p = sub.add_parser("run")
    p.add_argument("--label", required=True)
    p.add_argument("--bins", required=True)
    p.add_argument("--evidence", default=os.environ.get("G6_EVIDENCE", "/var/tmp/g6/evidence"))
    p.add_argument("--max-flush", type=int, default=72)
    p.add_argument("--between", type=int, default=24)
    p.add_argument("--seed", type=int, default=20261015)
    p.add_argument("--run-timeout", type=int, default=40, help="minutes")
    p.add_argument("--check-timeout", type=int, default=30, help="minutes per batch")
    p.set_defaults(f=cmd_run)
    a = ap.parse_args()
    a.f(a)


if __name__ == "__main__":
    main()
