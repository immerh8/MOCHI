"""The ``mochi-interop-summary-v1`` document (docs/ratification-core-plan.md, W17)."""
from __future__ import annotations

import json

from .archive import Result

FORMAT = "mochi-interop-summary-v1"


def _entry(path: bytes, ver) -> dict:
    mtime = None
    if ver.mtime is not None:
        mtime = ver.mtime[0] * 1_000_000_000 + ver.mtime[1]
    posix = ver.posix
    return {
        "path": path.hex(),
        "kind": "dir" if ver.kind == 1 else "file",
        "size": ver.length,
        "content_hash": ver.content_hash.hex() if ver.content_hash is not None else None,
        "target": None,
        "attributes": {
            "posix_mode": posix[0] if posix else None,
            "uid": posix[1] if posix else None,
            "gid": posix[2] if posix else None,
            "mtime_ns": mtime,
            "windows": ver.windows,
        },
    }


def _parity(res: Result):
    d = res.descriptor
    if res.head_status != "opened":
        return None
    if res.parity is not None:
        return res.parity
    if d is not None and d.recovery is not None and res.head_status == "opened":
        return {"commits": 0, "damaged_shards": 0, "rebuilt": 0, "beyond_capacity": 0}
    return None


def summarize(case: str, res: Result) -> dict:
    opened = res.head_status == "opened"
    # A refused head verified nothing: the document then carries the refusal and nothing else.
    d = res.descriptor if opened else None
    profile = {
        "encrypted": bool(d.encrypted) if d else False,
        "tar_compatible": bool(d.tar_compatible) if d else False,
        "recovery_percent": d.recovery[1] if d and d.recovery else None,
    }
    commits = []
    snapshots = []
    if opened:
        for nd in res.nodes:
            commits.append({"seq": nd.seq, "commit_id": nd.commit.commit_id.hex(),
                            "footer_offset": nd.footer.offset, "checkpoint": nd.commit.checkpoint})
        if res.keyless:
            snapshots = None                    # content-level fields are null without the key
        else:
            for seq in sorted(res.snapshots):
                st = res.snapshots[seq]
                entries = [_entry(p, st.versions[st.ns[p]]) for p in sorted(st.ns)]
                snapshots.append({"seq": seq, "entries": entries})
    findings = sorted(({"code": c, "object": o} for c, o in res.findings) if opened else [],
                      key=lambda f: (f["code"], f["object"] or ""))
    return {
        "format": FORMAT,
        "case": case,
        "head": {"status": res.head_status, "code": res.head_code},
        "archive_id": res.archive_id.hex() if (opened and res.archive_id) else None,
        "profile": profile,
        "commits": commits,
        "snapshots": snapshots,
        "findings": findings,
        "parity": _parity(res),
    }


def dumps(doc: dict) -> str:
    return json.dumps(doc, sort_keys=True, indent=2) + "\n"
