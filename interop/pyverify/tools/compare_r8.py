#!/usr/bin/env python3
"""Run the verifier over every case of the R8 golden set and compare with the reference summaries.

For each ``<case>.summary.json`` under the R8 directory the archive is the sibling named after the case
(``<case>.mochi``, or ``<case>`` itself).  Optional siblings: ``<case>.passphrase`` (first line is the
passphrase) and ``<case>.expected-head`` (64 hex digits).  The two JSON documents are compared as
parsed values, so whitespace and key order are irrelevant.  The exit status is 1 if any case differs, and
the differing cases are listed.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys


def diff(a, b, path="$", out=None, limit=12):
    out = [] if out is None else out
    if len(out) >= limit:
        return out
    if type(a) is not type(b):
        out.append(f"{path}: expected {json.dumps(a)[:80]} but got {json.dumps(b)[:80]}")
    elif isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a:
                out.append(f"{path}.{k}: unexpected key")
            elif k not in b:
                out.append(f"{path}.{k}: missing key")
            else:
                diff(a[k], b[k], f"{path}.{k}", out, limit)
    elif isinstance(a, list):
        if len(a) != len(b):
            out.append(f"{path}: expected {len(a)} items but got {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            diff(x, y, f"{path}[{i}]", out, limit)
    elif a != b:
        out.append(f"{path}: expected {json.dumps(a)[:80]} but got {json.dumps(b)[:80]}")
    return out[:limit]


def find_archive(base: pathlib.Path, stem: str):
    for cand in (base / f"{stem}.mochi", base / stem):
        if cand.is_file():
            return cand
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("r8", nargs="?", default=str(pathlib.Path(__file__).resolve().parents[3] / "fixtures" / "golden" / "r8"))
    args = ap.parse_args()
    root = pathlib.Path(args.r8)
    if not root.is_dir():
        print(f"{root} does not exist: nothing to compare")
        return 0
    expected = sorted(root.rglob("*.summary.json"))
    bad: dict[str, list[str]] = {}
    for exp_path in expected:
        stem = exp_path.name[: -len(".summary.json")]
        archive = find_archive(exp_path.parent, stem)
        if archive is None:
            bad[stem] = ["no archive file next to the summary"]
            continue
        cmd = [sys.executable, "-I", "-m", "mochi_verify", str(archive), "--summary", "--case", stem]
        pw = exp_path.parent / f"{stem}.passphrase"
        if pw.is_file():
            cmd += ["--passphrase-file", str(pw)]
        eh = exp_path.parent / f"{stem}.expected-head"
        if eh.is_file():
            cmd += ["--expected-head", eh.read_text().strip()]
        p = subprocess.run(cmd, capture_output=True, text=True)
        if p.returncode != 0:
            bad[stem] = [f"verifier exited {p.returncode}: {p.stderr.strip()[:200]}"]
            continue
        want = json.loads(exp_path.read_text())
        got = json.loads(p.stdout)
        d = diff(want, got)
        if d:
            bad[stem] = d
    print(f"{len(expected)} cases compared, {len(bad)} differ")
    for stem, d in bad.items():
        print(f"MISMATCH {stem}")
        for line in d:
            print(f"    {line}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
