#!/usr/bin/env bash
# Mechanical checks for AGENTS.md rules that clippy cannot express.
# Runs on Linux and Windows (Git Bash), the supported platforms (plan O11).
# Exits non-zero on any violation.
set -u
cd "$(dirname "$0")/.."

fail=0
report() { echo "invariant violated: $1"; echo "$2" | sed 's/^/    /'; fail=1; }

# 1. All I/O in mochi-core goes through the Storage trait. std::fs is allowed
#    only in the OS-backed implementation: storage/os.rs and its per-platform
#    submodules in storage/os/ (restore destinations). (Comment lines are
#    ignored.)
hits=$(grep -rnE --include='*.rs' '^[^/]*\bstd::fs\b' crates/mochi-core/src \
        | grep -vE '^crates/mochi-core/src/storage/os(\.rs|/[a-z_]+\.rs):' || true)
[ -n "$hits" ] && report "std::fs used in mochi-core outside storage/os.rs and storage/os/ (AGENTS.md: Publication and safety)" "$hits"

# 2. Frame magic literals live only in mochi-format's registry module.
hits=$(grep -rniE --include='*.rs' '0x184D_?2A[0-9A-F]{2}|0xFD2F_?B528' crates apps 2>/dev/null \
        | grep -v '^crates/mochi-format/src/registry.rs:' || true)
[ -n "$hits" ] && report "frame magic literal outside mochi-format/src/registry.rs (AGENTS.md: Wire format)" "$hits"
#    Same for the 8-byte magics: the footer payload magic `MOCHI2\0\0` and the
#    tail-quarantine sidecar magic `MOCHITQ\0` (spec Annex B.2.2). Domain
#    separators such as "MOCHI2-FOOTER" are not magics and do not match.
hits=$(grep -rnE --include='*.rs' 'b"MOCHI(2|TQ)\\0' crates apps fuzz 2>/dev/null \
        | grep -v '^crates/mochi-format/src/registry.rs:' || true)
[ -n "$hits" ] && report "8-byte MOCHI magic literal outside mochi-format/src/registry.rs (AGENTS.md: Wire format)" "$hits"

# 3. unsafe is forbidden in the two format-critical library crates.
for f in crates/mochi-format/src/lib.rs crates/mochi-core/src/lib.rs; do
  grep -q 'forbid(unsafe_code)' "$f" || report "missing #![forbid(unsafe_code)]" "$f"
done

# 4. Dependency direction: mochi-format <- mochi-core <- {cli, desktop}. Nothing
#    below the app layer may know about Tauri or the UI.
hits=$(grep -inE 'tauri' crates/mochi-format/Cargo.toml crates/mochi-core/Cargo.toml crates/mochi-testkit/Cargo.toml || true)
[ -n "$hits" ] && report "Tauri referenced below the app layer" "$hits"
grep -qE '^mochi-core' crates/mochi-format/Cargo.toml \
  && report "mochi-format must not depend on mochi-core" "crates/mochi-format/Cargo.toml"

# 5. No secrets-in-Debug hazards or logging macros in library crates yet; keep
#    printing out of mochi-core and mochi-format (the CLI renders output).
hits=$(grep -rnE --include='*.rs' '\b(println|eprintln|print|eprint)!' crates/mochi-core/src crates/mochi-format/src \
        | grep -vE '^[^:]+:[0-9]+:\s*//' || true)
[ -n "$hits" ] && report "printing from a library crate (output belongs to the CLI/UI)" "$hits"

# 6. UnRAR stays in the isolated foreign-format crate (plan D8, O23). Its
#    vendored source is RARLAB freeware, not MIT/Apache as the crate metadata
#    says, and it parses hostile input in C++. No other crate may depend on it.
hits=$(grep -nE '^\s*unrar(_sys|-sys)?\s*=' $(find crates apps -name Cargo.toml 2>/dev/null) 2>/dev/null \
        | grep -v '^crates/mochi-foreign/' || true)
[ -n "$hits" ] && report "unrar dependency outside crates/mochi-foreign (AGENTS.md: Foreign archive formats)" "$hits"

# 7. Archive-supplied strings render as text only (spec §23.3 #9). React's
#    escape hatch is banned outright in the UI source.
#    The UI source only: the lint config names the banned API on purpose.
if [ -d apps/mochi-desktop/ui/src ]; then
  hits=$(grep -rnE 'dangerouslySetInnerHTML|\.innerHTML\s*=' apps/mochi-desktop/ui/src \
          --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
          --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null || true)
  [ -n "$hits" ] && report "HTML injection API in the UI (AGENTS.md: Tauri v2 rules)" "$hits"
fi

# 8. The catalog never touches the filesystem (catalog/mod.rs, plan O25):
#    SQLite runs in memory only, images move as bytes through Storage. Any
#    file-backed open or ATTACH would bypass fault injection and could leave
#    WAL/journal files beside an image.
hits=$(grep -rnE --include='*.rs' 'Connection::open\(|open_with_flags|ATTACH[[:space:]]|VACUUM[[:space:]]+INTO' crates/mochi-core/src \
        | grep -vE '^[^:]+:[0-9]+:\s*//' || true)
[ -n "$hits" ] && report "file-backed SQLite in mochi-core (catalog must stay in memory)" "$hits"

# 9. mochi-core's `test-controls` feature (fault injection, checkpoint
#    policies; review decision 14) is enabled by mochi-testkit only, and no
#    shipped crate may depend on mochi-testkit outside [dev-dependencies].
#    Cargo features are additive, so this is not an isolation boundary for a
#    workspace-wide build; it keeps release builds of shipped crates
#    (`cargo build -p mochi-cli`) free of the controls.
hits=$(grep -rnE 'test-controls' --include=Cargo.toml crates apps fuzz 2>/dev/null \
        | grep -vE '^crates/mochi-(core|testkit)/Cargo.toml:' || true)
[ -n "$hits" ] && report "test-controls enabled outside mochi-testkit (review decision 14)" "$hits"
for f in crates/mochi-cli/Cargo.toml crates/mochi-core/Cargo.toml crates/mochi-format/Cargo.toml apps/mochi-desktop/src-tauri/Cargo.toml; do
  deps=$(awk '/^\[/{sec=$0} sec=="[dependencies]" && /mochi-testkit/' "$f")
  [ -n "$deps" ] && report "shipped crate depends on mochi-testkit (review decision 14)" "$f: $deps"
done

# 10. Least privilege for the webview (AGENTS.md "Tauri v2 rules"): no
#     filesystem, shell, process, or HTTP permission in any capability, and a
#     CSP with no eval and no remote origin (only the app and its IPC). No
#     dialog permission either: the open dialog runs in Rust (D1,
#     src-tauri/src/picker.rs), so the webview never names a path.
caps=apps/mochi-desktop/src-tauri/capabilities
if [ -d "$caps" ]; then
  hits=$(grep -rnE '"(fs|shell|http|process|opener|updater|dialog):' "$caps" 2>/dev/null || true)
  [ -n "$hits" ] && report "broad webview permission in a capability (AGENTS.md: least privilege)" "$hits"
fi
conf=apps/mochi-desktop/src-tauri/tauri.conf.json
if [ -f "$conf" ]; then
  csp=$(grep -nE '"(csp|devCsp)"' "$conf" || true)
  hits=$(printf '%s\n' "$csp" | grep -E "unsafe-eval|wasm-unsafe-eval" || true)
  [ -n "$hits" ] && report "CSP allows eval (AGENTS.md: strict CSP)" "$hits"
  # The only http(s) origin allowed is Tauri's IPC endpoint on Windows; the
  # Vite dev server appears only as ws://localhost in devCsp.
  hits=$(printf '%s\n' "$csp" | grep -oE 'https?://[^ ;"]+' | grep -vxE 'http://ipc\.localhost' || true)
  [ -n "$hits" ] && report "CSP allows a remote origin (AGENTS.md: strict CSP)" "$hits"
  grep -qE '"csp"[[:space:]]*:[[:space:]]*"' "$conf" || report "no CSP in tauri.conf.json (AGENTS.md: strict CSP)" "$conf"
fi

# 11. Foreign archive formats (plan D8, AGENTS.md "Foreign archive formats").
#     (a) The format library, the core, and the test kit never depend on the
#     foreign-format crate, and no source in them names it.
hits=$(grep -nE 'mochi-foreign|mochi_foreign' crates/mochi-format/Cargo.toml crates/mochi-core/Cargo.toml crates/mochi-testkit/Cargo.toml || true)
hits="$hits$(grep -rnE --include='*.rs' 'mochi_foreign' crates/mochi-format/src crates/mochi-core/src 2>/dev/null || true)"
[ -n "$hits" ] && report "mochi-core / mochi-format / mochi-testkit referencing mochi-foreign (plan D8 rule 9)" "$hits"
#     (b) The foreign parsers (zip, tar, flate2, 7z, UnRAR) are dependencies of
#     mochi-foreign only, so they cannot be linked into the app, the CLI, or
#     the core. (The fuzz workspace uses mochi-foreign's exercisers, not the
#     parsers directly.)
hits=$(grep -nE '^\s*(zip|tar|flate2|sevenz-rust2?|unrar(_sys|-sys)?)\s*=' $(find crates apps fuzz -name Cargo.toml -not -path '*/node_modules/*' 2>/dev/null) 2>/dev/null \
        | grep -v '^crates/mochi-foreign/Cargo.toml:' || true)
[ -n "$hits" ] && report "foreign-format parser dependency outside crates/mochi-foreign (plan D8 rule 3)" "$hits"
#     (c) Anything that reaches the helper through the client (the app, the
#     CLI) names mochi-foreign with default-features = false, so the parsers
#     (the "engine" feature) stay out of its process. Only the helper binary
#     and the fuzz workspace use the engine.
hits=$(grep -nE '^\s*mochi-foreign\b' $(find crates apps -name Cargo.toml -not -path '*/node_modules/*' 2>/dev/null) 2>/dev/null \
        | grep -v '^crates/mochi-foreign/Cargo.toml:' | grep -v 'default-features *= *false' || true)
[ -n "$hits" ] && report "mochi-foreign used without default-features = false (the parsers would be linked into that process)" "$hits"
#     (d) The helper's fault hooks (test-faults) are enabled only by
#     mochi-foreign's own dev-dependency, never in a shipped crate.
hits=$(grep -rnE 'test-faults' --include=Cargo.toml crates apps fuzz 2>/dev/null \
        | grep -vE '^crates/mochi-foreign/Cargo.toml:' || true)
[ -n "$hits" ] && report "test-faults enabled outside mochi-foreign (helper fault hooks)" "$hits"
hits=$(awk '/^\[/{sec=$0} sec=="[dependencies]" && /test-faults/' crates/mochi-foreign/Cargo.toml)
[ -n "$hits" ] && report "test-faults in mochi-foreign's [dependencies]; it may appear only under [dev-dependencies]" "$hits"
#     (e) Neither the helper nor the client writes files or calls a library's
#     extract-to-disk function (plan D8 rule 4: only the C6 engine writes).
hits=$(grep -rnE --include='*.rs' '\.extract\(|extract_unwrapped|unpack\(|unpack_in\(|File::create|OpenOptions|create_dir|fs::write|std::fs::(write|remove|rename|copy)' crates/mochi-foreign/src 2>/dev/null \
        | grep -vE '^[^:]+:[0-9]+:\s*//' || true)
[ -n "$hits" ] && report "file writing or library extract-to-disk in mochi-foreign (plan D8 rule 4)" "$hits"

#     (f) `unsafe` in the foreign crate lives only in the two modules that need
#     it (the UnRAR FFI and the Windows Job Object), each block with a SAFETY
#     comment on a line above it (AGENTS.md: any exception needs a justification).
hits=$(grep -rnE --include='*.rs' '\bunsafe\b' crates/mochi-foreign/src \
        | grep -vE '^crates/mochi-foreign/src/(rarfmt|jobobject)\.rs:' \
        | grep -vE '^[^:]+:[0-9]+:\s*(//|\*)' || true)
[ -n "$hits" ] && report "unsafe outside mochi-foreign's rarfmt.rs / jobobject.rs" "$hits"
hits=$(awk '
  FNR==1 { for (k=0;k<8;k++) w[k]=""; n=0 }
  { line=$0; ok=0
    if (line ~ /(^|[^a-z_])unsafe[[:space:]]*(\{|fn|impl)/ && line !~ /^[[:space:]]*(\/\/|\*)/) {
      for (k=0;k<8;k++) if (w[k] ~ /SAFETY:|# Safety/) ok=1
      if (line ~ /SAFETY:/) ok=1
      if (!ok) print FILENAME ":" FNR ": " line
    }
    for (k=7;k>0;k--) w[k]=w[k-1]; w[0]=line }' \
  crates/mochi-foreign/src/rarfmt.rs crates/mochi-foreign/src/jobobject.rs || true)
[ -n "$hits" ] && report "unsafe without a SAFETY comment in the preceding lines (mochi-foreign)" "$hits"
#     (g) UnRAR is only ever asked to TEST an entry (RAR_TEST) or skip it: never
#     RAR_EXTRACT, and RARProcessFile never gets a destination (plan D8 rule 4:
#     its own extract-to-disk path bypasses the restore engine's protections).
hits=$(grep -rnE --include='*.rs' '\bRAR_EXTRACT\b|RARProcessFileW|RARExtract' crates/mochi-foreign/src \
        | grep -vE '^[^:]+:[0-9]+:\s*(//|\*)' || true)
[ -n "$hits" ] && report "UnRAR extract-to-disk operation in mochi-foreign (plan D8 rule 4)" "$hits"
hits=$(grep -n 'RARProcessFile(' crates/mochi-foreign/src/rarfmt.rs | grep -v 'std::ptr::null(), std::ptr::null()' | grep -vE '^[0-9]+:\s*(//|\*)' || true)
hits="$hits$(grep -n -A2 'sys::RARProcessFile(' crates/mochi-foreign/src/rarfmt.rs | grep -E 'dest|path' || true)"
[ -n "$(printf '%s' "$hits" | tr -d '[:space:]')" ] && report "RARProcessFile called with a destination (plan D8 rule 4)" "$hits"
#     (h) sevenz-rust2 is a decoder here: its `compress` feature stays off, and
#     none of its extract-to-disk helpers are called.
hits=$(grep -nE 'sevenz-rust2' crates/mochi-foreign/Cargo.toml | grep -E 'compress|"util"|default-features *= *true' || true)
hits="$hits$(grep -rnE --include='*.rs' 'sevenz_rust2::(decompress|compress|SevenZWriter|SevenZArchiveEntry)|\bdecompress_file|\bdecompress_with' crates/mochi-foreign/src || true)"
[ -n "$(printf '%s' "$hits" | tr -d '[:space:]')" ] && report "sevenz-rust2 compress feature or extract-to-disk helper (plan D8 rules 1 and 4)" "$hits"
#     (i) Nothing writes a RAR: no RAR writer, no Rar! signature emitted outside
#     the detector and the tests that read fixtures.
hits=$(grep -rnE --include='*.rs' 'write_all\([^)]*Rar!|b"Rar!' crates/mochi-foreign/src \
        | grep -vE '^crates/mochi-foreign/src/detect\.rs:' || true)
[ -n "$hits" ] && report "possible RAR writing in mochi-foreign (plan D8 rule 1; MOCHI never writes RAR)" "$hits"

if [ "$fail" -eq 0 ]; then echo "invariants: ok"; fi
exit "$fail"
