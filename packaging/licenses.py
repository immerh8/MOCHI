#!/usr/bin/env python3
"""Generate THIRD-PARTY-LICENSES.txt for the desktop installers (plan D7, O23).

Rust: `cargo about generate --format json` over the desktop crate (policy and
targets in packaging/about.toml; it fails on a license not accepted).
JS:   `pnpm licenses list --prod --json` in the UI (the packages that end up in
the bundle), checked against the same accepted list, with each package's
license file read from node_modules.

Output: one text file with MOCHI's own licenses, THIRD-PARTY-NOTICES.md, then
every dependency grouped by license text. Exit 1 on a disallowed or
unreadable license. Standard library only.
"""
import json
import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ABOUT = ROOT / "packaging" / "about.toml"
DESKTOP_MANIFEST = ROOT / "apps" / "mochi-desktop" / "src-tauri" / "Cargo.toml"
UI = ROOT / "apps" / "mochi-desktop" / "ui"
LICENSE_FILES = ("LICENSE", "LICENCE", "LICENSE.md", "LICENSE.txt", "LICENSE-MIT", "COPYING")


def accepted_list():
    return set(tomllib.loads(ABOUT.read_text())["accepted"])


def expr_allowed(expr, accepted):
    """SPDX-lite: `A OR B` needs one allowed alternative, `A AND B` all."""
    expr = expr.replace("(", " ").replace(")", " ")
    for alt in expr.split(" OR "):
        if all(t.strip() in accepted for t in alt.split(" AND ")):
            return True
    return False


def run(cmd, cwd=None):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(r.stderr)
        sys.exit(f"licenses.py: {' '.join(cmd)} failed ({r.returncode})")
    return r.stdout


def rust_entries():
    out = run(["cargo", "about", "generate", "--config", str(ABOUT),
               "--manifest-path", str(DESKTOP_MANIFEST), "--format", "json", "--fail"])
    data = json.loads(out)
    entries = []  # (name, version, spdx, text)
    for lic in data["licenses"]:
        for used in lic["used_by"]:
            c = used["crate"]
            entries.append((c["name"], c["version"], lic["id"], lic["text"]))
    return entries


def js_entries(accepted):
    out = run(["pnpm", "licenses", "list", "--prod", "--json"], cwd=UI)
    entries, bad = [], []
    for spdx, pkgs in json.loads(out).items():
        ok = expr_allowed(spdx, accepted)
        for p in pkgs:
            if not ok:
                bad.append(f"{p['name']} ({spdx})")
                continue
            for ver, path in zip(p["versions"], p["paths"]):
                text = next((f.read_text(errors="replace") for n in LICENSE_FILES
                             if (f := Path(path) / n).is_file()), None)
                if text is None:
                    bad.append(f"{p['name']}@{ver}: no license file in {path}")
                else:
                    entries.append((p["name"], ver, spdx, text))
    if bad:
        sys.exit("licenses.py: npm packages not allowed or without license text:\n  " + "\n  ".join(bad))
    return entries


def render(rust, js):
    parts = ["MOCHI - third-party licenses\n"
             "============================\n\n"
             "MOCHI is licensed under MIT OR Apache-2.0. Generated at build time from the\n"
             "dependency graph of this installer's app and UI bundle (plan D7, O23).\n\n"]
    for f in ("LICENSE-MIT", "LICENSE-APACHE", "THIRD-PARTY-NOTICES.md"):
        parts.append(f"\n{'#' * 78}\n# {f}\n{'#' * 78}\n\n{(ROOT / f).read_text()}\n")
    for title, entries in (("Rust crates", rust), ("npm packages (UI bundle)", js)):
        groups = {}
        for name, ver, spdx, text in entries:
            groups.setdefault((spdx, text.strip()), []).append(f"{name} {ver}")
        parts.append(f"\n{'#' * 78}\n# {title}: {len(entries)} packages\n{'#' * 78}\n")
        for (spdx, text), users in sorted(groups.items()):
            parts.append(f"\n--- {spdx} ---\nUsed by: {', '.join(sorted(set(users)))}\n\n{text}\n")
    return "".join(parts)


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: licenses.py OUTPUT_FILE")
    accepted = accepted_list()
    rust, js = rust_entries(), js_entries(accepted)
    if not rust or not js:
        sys.exit("licenses.py: empty dependency list; refusing to write a bogus file")
    out = Path(sys.argv[1])
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(rust, js))
    print(f"wrote {out}: {len(rust)} Rust crate entries, {len(js)} npm entries")


if __name__ == "__main__":
    main()
