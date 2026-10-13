#!/usr/bin/env bash
# Smoke-check a built .deb (plan D7, O11): metadata, dependency, contents; with
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

if [ "$install" = 1 ]; then
  # Runner images ship a package index that can lag the archive (404s on dependencies).
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends "./$deb"
  bin="/$exe"
  [ -x "$bin" ] || fail "$bin not installed"
  missing=$(ldd "$bin" | grep 'not found' || true)
  [ -z "$missing" ] || fail "unresolved libraries: $missing"
  sudo apt-get remove -y mochi
  [ ! -e "$bin" ] || fail "$bin still present after removal"
fi
echo "deb smoke check passed"
