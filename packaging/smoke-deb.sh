#!/usr/bin/env bash
# Smoke-check a built .deb (plan D7, D6, O11): metadata, dependency, contents, the
# .desktop MimeType and the shared-mime-info type for .mochi; with
# --install, also install it with apt, check that every shared library resolves,
# then remove it. Usage: smoke-deb.sh [--install] path/to/mochi.deb
set -euo pipefail
install=0
if [ "${1:-}" = "--install" ]; then install=1; shift; fi
deb="${1:?usage: smoke-deb.sh [--install] file.deb}"
fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

dpkg-deb --info "$deb"
pkg=$(dpkg-deb --field "$deb" Package)
[ "$pkg" = "mochi" ] || fail "package name is '$pkg', expected 'mochi'"
[ "$(dpkg-deb --field "$deb" Architecture)" = "amd64" ] || fail "not amd64 (O11: x86-64 only)"
depends=$(dpkg-deb --field "$deb" Depends)
echo "Depends: $depends"
case ", $depends," in *", libwebkit2gtk-4.1-0"*) ;; *) fail "Depends lacks libwebkit2gtk-4.1-0" ;; esac
case "$depends" in *libwebkit2gtk-4.0*) fail "Depends names the 4.0 series, not 4.1" ;; esac

# Member paths may or may not carry a leading "./" (dpkg-deb --build adds it,
# Tauri's builder does not): compare them without.
contents=$(dpkg-deb --contents "$deb" | sed -E 's# \./# #')
echo "$contents"
exe=$(echo "$contents" | awk '$1 ~ /^-..x/ && $6 ~ /^usr\/bin\// {print $6}')
[ "$(echo "$exe" | grep -c .)" = 1 ] || fail "expected exactly one executable in /usr/bin, got: $exe"
echo "$contents" | grep -Eq ' usr/share/applications/[^ ]*\.desktop$' || fail "no .desktop entry"
lic=usr/share/doc/mochi/THIRD-PARTY-LICENSES.txt
echo "$contents" | grep -q " $lic\$" || fail "third-party license list ($lic) missing"
dir=$(mktemp -d); trap 'rm -rf "$dir"' EXIT
dpkg-deb --extract "$deb" "$dir"
grep -q "Rust crates:" "$dir/$lic" && grep -q "npm packages (UI bundle):" "$dir/$lic" \
  && grep -q "MIT License" "$dir/$lic" || fail "license list lacks an expected section"

# D6 (O10): .mochi association and "Open with". The .desktop passes the file
# (%f) and lists application/x-mochi; the foreign formats are only listed; the
# package sets no default for any type.
desktop=$(echo "$contents" | awk '$6 ~ /^usr\/share\/applications\/.*\.desktop$/ {print $6}')
[ "$(echo "$desktop" | grep -c .)" = 1 ] || fail "expected exactly one .desktop file, got: $desktop"
grep -q '^Exec=.* %f$' "$dir/$desktop" || fail "$desktop: Exec must end in ' %f' so the file manager passes the file"
mimetype=$(grep '^MimeType=' "$dir/$desktop" || true)
[ -n "$mimetype" ] || fail "$desktop has no MimeType"
for t in application/x-mochi application/zip application/x-7z-compressed application/vnd.rar application/x-tar application/x-compressed-tar application/gzip; do
  case ";${mimetype#MimeType=}" in *";$t;"*) ;; *) fail "$desktop: MimeType lacks $t" ;; esac
done
# Only the first entry is MOCHI's own type; everything after it is an "Open with" offer.
case "${mimetype#MimeType=}" in application/x-mochi\;*) ;; *) fail "$desktop: application/x-mochi must come first" ;; esac
if echo "$contents" | grep -Eq ' usr/(share|local/share)/(applications/)?(mimeapps|defaults)\.list$'; then
  fail "the package must not set default applications (it would take over ZIP/RAR/...)"
fi
mime=usr/share/mime/packages/mochi.xml
echo "$contents" | grep -q " $mime\$" || fail "shared-mime-info type ($mime) missing"
python3 - "$dir/$mime" <<'PY' || fail "$mime is not the expected shared-mime-info type"
import sys, xml.etree.ElementTree as ET
ns = "{http://www.freedesktop.org/standards/shared-mime-info}"
root = ET.parse(sys.argv[1]).getroot()
assert root.tag == ns + "mime-info", root.tag
types = {t.get("type"): t for t in root.findall(ns + "mime-type")}
assert list(types) == ["application/x-mochi"], list(types)
globs = [g.get("pattern") for g in types["application/x-mochi"].findall(ns + "glob")]
assert globs == ["*.mochi"], globs
PY
if command -v desktop-file-validate > /dev/null; then
  desktop-file-validate "$dir/$desktop" || fail "$desktop does not validate"
fi

if [ "$install" = 1 ]; then
  # Runner images ship a package index that can lag the archive (404s on dependencies).
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends "./$deb"
  bin="/$exe"
  [ -x "$bin" ] || fail "$bin not installed"
  missing=$(ldd "$bin" | grep 'not found' || true)
  [ -z "$missing" ] || fail "unresolved libraries: $missing"
  # dpkg triggers (shared-mime-info, desktop-file-utils) registered the type.
  if [ -d /usr/share/mime ] && command -v update-mime-database > /dev/null; then
    grep -q 'application/x-mochi:\*\.mochi' /usr/share/mime/globs2 || fail "update-mime-database did not register *.mochi"
  fi
  sudo apt-get remove -y mochi
  [ ! -e "$bin" ] || fail "$bin still present after removal"
  [ ! -e "/$mime" ] || fail "/$mime still present after removal"
  if [ -f /usr/share/mime/globs2 ]; then
    ! grep -q 'application/x-mochi' /usr/share/mime/globs2 || fail "*.mochi still registered after removal"
  fi
fi
echo "deb smoke check passed"
