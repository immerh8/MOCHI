#!/usr/bin/env bash
# Build one unsigned desktop installer (plan D7, O11): `nsis` on Windows, `deb` on
# Ubuntu 22.04. Needs: python3 >= 3.11, pnpm, `cargo-about`, `cargo-tauri` 2.x, and on
# Linux the webkit2gtk 4.1 build dependencies (apps/mochi-desktop/README.md).
# Output: target/release/bundle/<nsis|deb>/ and target/packaging/THIRD-PARTY-LICENSES.txt
#
# Signing is NOT done here (docs/packaging.md lists what the owner must supply).
set -euo pipefail

kind="${1:?usage: build-installer.sh nsis|deb}"
case "$kind" in nsis | deb) ;; *) echo "unknown bundle '$kind' (nsis|deb only: O11)" >&2; exit 2 ;; esac

cd "$(dirname "$0")/.."
licenses=target/packaging/THIRD-PARTY-LICENSES.txt

# 1. The full third-party license list; fails on a license outside packaging/about.toml.
pnpm --dir apps/mochi-desktop/ui install --frozen-lockfile
python3 packaging/licenses.py "$licenses"

# 2. The UI that the release binary embeds (build.frontendDist).
pnpm --dir apps/mochi-desktop/ui build

# 3. Overlay config: ship the list inside the installer (merged over tauri.conf.json).
python3 - "$kind" "$licenses" <<'PY'
import json, os, sys
kind, lic = sys.argv[1], sys.argv[2]
rel = os.path.relpath(lic, "apps/mochi-desktop/src-tauri").replace(os.sep, "/")
if kind == "nsis":  # next to the exe: <install dir>\licenses\
    bundle = {"resources": {rel: "licenses/THIRD-PARTY-LICENSES.txt"}}
else:  # Debian convention
    bundle = {"linux": {"deb": {"files": {"/usr/share/doc/mochi/THIRD-PARTY-LICENSES.txt": rel}}}}
json.dump({"bundle": bundle}, open("target/packaging/bundle-overlay.json", "w"), indent=2)
PY

# 4. Bundle. `--ci` keeps the tool non-interactive; no signing environment is read.
cd apps/mochi-desktop/src-tauri
cargo tauri build --ci --bundles "$kind" --config ../../../target/packaging/bundle-overlay.json -- --locked
