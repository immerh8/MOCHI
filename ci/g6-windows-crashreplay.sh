#!/usr/bin/env bash
# Gate G6 Windows durability: block-level crash replay of a real Windows client
# build in a QEMU/KVM VM (docs/g6-windows-crash-replay.md). The Linux power-cut
# test ci/g7-powercut.sh is the model; this is its Windows counterpart.
#
# Runs on an ubuntu-24.04 GitHub-hosted runner (KVM available to public repos).
# Subcommands (all but `selftest` need root and are re-executed under sudo):
#
#   setup      packages, KVM access, dm-log-writes, replay-log (exits 3 without KVM)
#   free-disk  remove preinstalled toolchains the runner does not need here
#   selftest   unit-test the log reader (against the real replay-log) and the verdict logic
#   iso-info   resolve the Microsoft evaluation ISO (name, size)
#   iso        download it and record its SHA-256
#   image      unattended Windows install into $G6_WORK/image (cache this directory)
#   run        <label> <bin dir> [orchestrate.py run options]
#              format, workload on a dm-log-writes disk, replay, judge
#
# Environment: G6_WORK (default /var/tmp/g6), G6_EVIDENCE (default $G6_WORK/evidence).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ORCH="$HERE/g6-windows/orchestrate.py"
export G6_WORK=${G6_WORK:-/var/tmp/g6}
export G6_EVIDENCE=${G6_EVIDENCE:-$G6_WORK/evidence}
XFSTESTS_URLS=(https://git.kernel.org/pub/scm/fs/xfs/xfstests-dev.git https://github.com/kdave/xfstests)

as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -E "$@"; fi; }

setup() {
    as_root mkdir -p "$G6_WORK" "$G6_EVIDENCE"
    echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' \
        | as_root tee /etc/udev/rules.d/99-kvm4all.rules >/dev/null
    as_root udevadm control --reload-rules
    as_root udevadm trigger --name-match=kvm || true
    as_root udevadm settle || true
    # The trigger is asynchronous: give the new mode a moment to apply.
    for _ in $(seq 1 20); do [ -r /dev/kvm ] && [ -w /dev/kvm ] && break; sleep 0.5; done
    if [ ! -w /dev/kvm ]; then
        echo "::error::/dev/kvm is not usable on this runner. The harness does not fall back to TCG emulation (G6b)."
        ls -l /dev/kvm || true
        exit 3
    fi
    echo "KVM usable: $(ls -l /dev/kvm)"
    as_root apt-get update -qq
    as_root apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils ovmf swtpm \
        xorriso libdevmapper-dev dmsetup build-essential git curl python3 apparmor-utils tesseract-ocr
    as_root modprobe dm-log-writes || {
        as_root apt-get install -y "linux-modules-extra-$(uname -r)"
        as_root modprobe dm-log-writes
    }
    as_root modprobe loop || true
    # Ubuntu confines swtpm (and QEMU) with AppArmor profiles that do not expect
    # state under /var/tmp; this is a throwaway CI host.
    if command -v aa-disable >/dev/null 2>&1; then
        as_root aa-disable /usr/bin/swtpm 2>&1 || true
    fi
    if [ -d /etc/apparmor.d ] && [ -e /etc/apparmor.d/usr.bin.swtpm ]; then
        as_root mkdir -p /etc/apparmor.d/disable
        as_root ln -sf /etc/apparmor.d/usr.bin.swtpm /etc/apparmor.d/disable/ || true
        as_root apparmor_parser -R /etc/apparmor.d/usr.bin.swtpm 2>&1 || true
    fi
    # replay-log is not packaged; xfstests' src/log-writes builds with plain gcc.
    local src=/tmp/xfstests rev=""
    rm -rf "$src"
    for u in "${XFSTESTS_URLS[@]}"; do
        git clone --depth 1 "$u" "$src" && break
    done
    rev=$(git -C "$src" rev-parse HEAD)
    (cd "$src/src/log-writes" && gcc -O2 -D_FILE_OFFSET_BITS=64 -D_LARGEFILE64_SOURCE -I. \
        -o replay-log replay-log.c log-writes.c -ldevmapper)
    as_root install -m 0755 "$src/src/log-writes/replay-log" /usr/local/bin/replay-log
    {
        echo "{\"xfstests_rev\": \"$rev\","
        echo " \"qemu\": \"$(qemu-system-x86_64 --version | head -1)\","
        echo " \"swtpm\": \"$(swtpm --version | head -1)\","
        echo " \"kernel\": \"$(uname -r)\","
        echo " \"cpu\": \"$(lscpu | sed -n 's/^Model name:[ \t]*//p')\"}"
    } | as_root tee "$G6_WORK/tools.json"
}

free_disk() {
    df -h / | tail -1
    as_root rm -rf /usr/local/lib/android /usr/share/dotnet /opt/ghc /opt/hostedtoolcache/CodeQL \
        /usr/local/share/boost /usr/share/swift 2>/dev/null || true
    df -h / | tail -1
}

case "${1:-}" in
    setup) setup ;;
    free-disk) free_disk ;;
    selftest)
        REPLAY_LOG=${REPLAY_LOG:-$(command -v replay-log)} python3 -I "$HERE/g6-windows/test_logwrites.py"
        python3 -I "$HERE/g6-windows/test_evaluate.py" ;;
    iso-info | iso | image)
        cmd=$1; shift
        as_root python3 -I "$ORCH" --work "$G6_WORK" "$cmd" "$@" ;;
    run)
        shift
        label=${1:?usage: run <label> <bin dir> [options]}; bins=${2:?usage: run <label> <bin dir> [options]}; shift 2
        as_root python3 -I "$ORCH" --work "$G6_WORK" run --label "$label" --bins "$bins" --evidence "$G6_EVIDENCE" "$@"
        ;;
    *) sed -n '2,20p' "$0"; exit 2 ;;
esac
