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
# pnpm runs inside the UI directory: corepack takes the version from the nearest
# package.json's `packageManager`, and the repository root has none.
(cd apps/mochi-desktop/ui && pnpm install --frozen-lockfile)
python3 packaging/licenses.py "$licenses"

# 2. The UI that the release binary embeds (build.frontendDist).
(cd apps/mochi-desktop/ui && pnpm build)

# 3. The foreign-format helper (plan D8, T16): the isolated process that parses ZIP, 7z,
# RAR and tar (`engine` feature, release profile). Tauri's `bundle.externalBin` takes it
# as binaries/<name>-<target triple>[.exe] and installs it, without the suffix, next to
# the app (NSIS: the install directory; deb: /usr/bin), which is where the app looks
# (mochi_foreign::default_helper_path). It is in the overlay below, not in
# tauri.conf.json, so that a plain `cargo build`/`cargo test` of the app needs no helper.
triple=$(rustc -vV | sed -n 's/^host: //p')
case "$triple" in
  x86_64-pc-windows-msvc) ext=.exe ;;
  x86_64-unknown-linux-gnu) ext= ;;
  *) echo "unsupported build host '$triple' (O11: Windows and Ubuntu x86-64 only)" >&2; exit 2 ;;
esac
cargo build --release --locked -p mochi-foreign --features engine --bin mochi-foreign-helper
mkdir -p apps/mochi-desktop/src-tauri/binaries
cp "target/release/mochi-foreign-helper$ext" "apps/mochi-desktop/src-tauri/binaries/mochi-foreign-helper-$triple$ext"

# 4. Overlay config: ship the list and the helper inside the installer (merged over tauri.conf.json).
python3 - "$kind" "$licenses" <<'PY'
import json, os, sys
kind, lic = sys.argv[1], sys.argv[2]
rel = os.path.relpath(lic, "apps/mochi-desktop/src-tauri").replace(os.sep, "/")
if kind == "nsis":  # next to the exe: <install dir>\licenses\
    bundle = {"resources": {rel: "licenses/THIRD-PARTY-LICENSES.txt"}}
else:  # Debian convention
    bundle = {"linux": {"deb": {"files": {"/usr/share/doc/mochi/THIRD-PARTY-LICENSES.txt": rel}}}}
bundle["externalBin"] = ["binaries/mochi-foreign-helper"]
json.dump({"bundle": bundle}, open("target/packaging/bundle-overlay.json", "w"), indent=2)
PY

# 5. Bundle. `--ci` keeps the tool non-interactive; no signing environment is read.
cd apps/mochi-desktop/src-tauri
cargo tauri build --ci --bundles "$kind" --config ../../../target/packaging/bundle-overlay.json -- --locked
