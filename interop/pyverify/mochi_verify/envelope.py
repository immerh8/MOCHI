"""Binary envelope v0 (spec B.2.2, R2 section 2) and the sealed-object header (R5 section 4)."""
from __future__ import annotations

from dataclasses import dataclass

from . import frames
from .errors import MochiError

SQLITE_SIGNATURE = b"SQLite format 3\x00"
PARITY_SIGNATURE = b"MOCHI2-PARITY\x00\x00\x00"
KNOWN_FEATURES = {1}
READER_FEATURE_LIMIT = 64

ENC_SQLITE = 0
ENC_PARITY = 1
_SIGNATURES = {ENC_SQLITE: SQLITE_SIGNATURE, ENC_PARITY: PARITY_SIGNATURE}
_KIND_ENCODING = {frames.K_IMAGE: ENC_SQLITE, frames.K_PARITY: ENC_PARITY}


@dataclass
class Envelope:
    schema_version: int
    encoding: int
    features: list
    archive_id: bytes
    sequence: int
    transaction_id: bytes
    header_length: int
    payload: bytes      # the record body after the header

    def bind(self, archive_id: bytes, sequence: int, transaction_id: bytes) -> None:
        """Identity obligation (D11): all three must equal the referencing commit's."""
        if self.archive_id != archive_id:
            raise MochiError("ENVELOPE_INVALID", "envelope archive id differs from the commit's")
        if self.sequence != sequence:
            raise MochiError("ENVELOPE_INVALID", "envelope sequence differs from the commit's")
        if self.transaction_id != transaction_id:
            raise MochiError("ENVELOPE_INVALID", "envelope transaction id differs from the commit's")


def decode_binary(data: bytes, expected_kind: int, schema_versions, payload_budget: int = frames.IMAGE_PAYLOAD_LIMIT) -> Envelope:
    """``data`` is a complete stored frame.  Faults in R2 section 2 order."""
    try:
        fr = frames.walk_frame(data, 0)
    except MochiError as e:
        if e.code == "LIMIT_EXCEEDED":
            raise
        raise MochiError("MALFORMED_FRAME", e.message) from None
    if fr.length != len(data):
        raise MochiError("MALFORMED_FRAME", "bytes after the frame")
    if fr.magic != expected_kind:
        raise MochiError("ENVELOPE_INVALID", "frame kind is not the one the reference names")
    if expected_kind not in _KIND_ENCODING:
        raise MochiError("ENVELOPE_INVALID", "frame kind carries no envelope")
    p = data[8:]
    if len(p) < 80:
        raise MochiError("ENVELOPE_INVALID", "fixed header cut short")
    version = int.from_bytes(p[4:6], "little")
    if version != 0:
        raise MochiError("UNSUPPORTED_FEATURE", f"envelope version {version}")
    n = int.from_bytes(p[12:16], "little")
    if n > 64:
        raise MochiError("ENVELOPE_INVALID", "feature count above the wire maximum 64")
    hlen = int.from_bytes(p[0:4], "little")
    if hlen != 80 + 8 * n:
        raise MochiError("ENVELOPE_INVALID", "header length mismatch")
    if len(p) < hlen:
        raise MochiError("ENVELOPE_INVALID", "header cut short")
    plen = int.from_bytes(p[16:24], "little")
    if plen != len(p) - hlen:
        raise MochiError("ENVELOPE_INVALID", "payload length mismatch")
    if plen > payload_budget:
        raise MochiError("LIMIT_EXCEEDED", "payload above the budget")
    enc = int.from_bytes(p[8:12], "little")
    if enc not in _SIGNATURES or _KIND_ENCODING[expected_kind] != enc:
        raise MochiError("ENVELOPE_INVALID", "payload encoding not registered or not the kind's own")
    if n > READER_FEATURE_LIMIT:
        raise MochiError("LIMIT_EXCEEDED", "too many required features")
    feats = [int.from_bytes(p[80 + 8 * i:88 + 8 * i], "little") for i in range(n)]
    for a, b in zip(feats, feats[1:]):
        if not a < b:
            raise MochiError("ENVELOPE_INVALID", "required features not strictly increasing")
    for f in feats:
        if f not in KNOWN_FEATURES:
            raise MochiError("UNSUPPORTED_FEATURE", f"unknown required feature {f}")
    schema = int.from_bytes(p[6:8], "little")
    if schema not in schema_versions:
        raise MochiError("UNSUPPORTED_FEATURE", f"record schema version {schema}")
    payload = bytes(p[hlen:])
    if not payload.startswith(_SIGNATURES[enc]):
        raise MochiError("ENVELOPE_INVALID", "payload lacks its encoding's signature")
    if enc == ENC_SQLITE:
        if len(payload) < 64 or int.from_bytes(payload[60:64], "big", signed=True) != schema:
            raise MochiError("ENVELOPE_INVALID", "SQLite user_version differs from the record schema version")
    return Envelope(schema, enc, feats, bytes(p[24:56]), int.from_bytes(p[56:64], "little"),
                    bytes(p[64:80]), hlen, payload)


@dataclass
class SealedHeader:
    version: int
    suite: int
    kind: int
    key_id: bytes
    nonce: bytes
    ciphertext: bytes
    tag: bytes
    header: bytes        # payload bytes 0..23, part of the AAD


SEAL_DATA, SEAL_IMAGE, SEAL_DELTA, SEAL_SNAPSHOT = 0, 1, 2, 3


def parse_sealed(payload: bytes) -> SealedHeader:
    """Parse a sealed-object payload (the skippable payload of a 0x184D2A59 frame)."""
    if len(payload) < 48 + 1 + 16:
        raise MochiError("RECORD_INVALID", "sealed object too short")
    version = int.from_bytes(payload[0:2], "little")
    suite = int.from_bytes(payload[2:4], "little")
    kind = int.from_bytes(payload[4:8], "little")
    if version != 0:
        raise MochiError("UNSUPPORTED_FEATURE", f"sealed-object version {version}")
    if suite != 1:
        raise MochiError("UNSUPPORTED_FEATURE", f"sealed-object suite {suite}")
    if kind not in (0, 1, 2, 3):
        raise MochiError("UNSUPPORTED_FEATURE", f"sealed-object kind {kind}")
    return SealedHeader(version, suite, kind, bytes(payload[8:24]), bytes(payload[24:48]),
                        bytes(payload[48:-16]), bytes(payload[-16:]), bytes(payload[0:24]))
