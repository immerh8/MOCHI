"""tools/compare_r8.py: exact comparison, a printed list of mismatches, a failing exit status."""
import json
import pathlib
import shutil
import subprocess
import sys

import pytest

from conftest import GOLDEN, GOLDEN_PASSPHRASE

pytestmark = pytest.mark.skipif(not GOLDEN.is_dir(), reason="fixtures/golden is absent")
TOOL = pathlib.Path(__file__).resolve().parents[1] / "tools" / "compare_r8.py"


def verify(archive, *extra):
    p = subprocess.run([sys.executable, "-I", "-m", "mochi_verify", str(archive), "--summary", *extra],
                       capture_output=True, text=True, check=True)
    return p.stdout


def compare(root):
    return subprocess.run([sys.executable, str(TOOL), str(root)], capture_output=True, text=True)


def test_matching_and_mismatching_cases(tmp_path):
    shutil.copy(GOLDEN / "c5" / "valid-archive-3-commits.mochi", tmp_path / "plain.mochi")
    (tmp_path / "plain.summary.json").write_text(verify(tmp_path / "plain.mochi", "--case", "plain"))
    shutil.copy(GOLDEN / "c11" / "valid-archive-encrypted.mochi", tmp_path / "sealed.mochi")
    (tmp_path / "sealed.passphrase").write_text(GOLDEN_PASSPHRASE + "\n")
    (tmp_path / "sealed.summary.json").write_text(
        verify(tmp_path / "sealed.mochi", "--case", "sealed", "--passphrase-file", tmp_path / "sealed.passphrase"))
    ok = compare(tmp_path)
    assert ok.returncode == 0 and "2 cases compared, 0 differ" in ok.stdout

    doc = json.loads((tmp_path / "plain.summary.json").read_text())
    doc["snapshots"][0]["entries"][0]["size"] += 1
    doc["findings"] = [{"code": "STORED_INTEGRITY_FAILED", "object": None}]
    (tmp_path / "plain.summary.json").write_text(json.dumps(doc))
    bad = compare(tmp_path)
    assert bad.returncode == 1 and "MISMATCH plain" in bad.stdout and "sealed" not in bad.stdout.replace("2 cases", "")
    assert "$.snapshots[0].entries[0].size" in bad.stdout and "$.findings" in bad.stdout


def test_missing_directory_is_not_an_error(tmp_path):
    p = compare(tmp_path / "does-not-exist")
    assert p.returncode == 0 and "nothing to compare" in p.stdout
