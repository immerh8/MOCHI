"""Catalog-image payload encodings 0 and 2 (spec B.2.2, B.2.15; R2 section 2).

Envelopes are built here from the spec's layout, not copied from the reference implementation."""
import pytest
import zstandard

from mochi_verify import envelope, frames
from mochi_verify.errors import MochiError

AID, SEQ, TXN = b"\xa1" * 32, 7, b"\xb2" * 16


def sqlite_image(user_version=1, pages=2):
    img = bytearray(4096 * pages)
    img[:16] = envelope.SQLITE_SIGNATURE
    img[60:64] = user_version.to_bytes(4, "big")
    return bytes(img)


def zstd_frame(data, checksum=True, content_size=True):
    return zstandard.ZstdCompressor(level=9, write_checksum=checksum, write_content_size=content_size).compress(data)


def envelope_frame(payload, enc, schema=1, kind=frames.K_IMAGE):
    hdr = (80).to_bytes(4, "little") + (0).to_bytes(2, "little") + schema.to_bytes(2, "little") \
        + enc.to_bytes(4, "little") + (0).to_bytes(4, "little") + len(payload).to_bytes(8, "little") \
        + AID + SEQ.to_bytes(8, "little") + TXN
    body = hdr + payload
    return kind.to_bytes(4, "little") + len(body).to_bytes(4, "little") + body


def read(payload, enc):
    env = envelope.decode_binary(envelope_frame(payload, enc), frames.K_IMAGE, (1,))
    env.bind(AID, SEQ, TXN)
    return envelope.decode_image(env)


def test_encoding_2_round_trip():
    img = sqlite_image()
    assert read(zstd_frame(img), 2) == img


def test_encoding_0_still_read():
    img = sqlite_image()
    assert read(img, 0) == img


def test_encoding_3_unregistered():
    with pytest.raises(MochiError) as e:
        envelope.decode_binary(envelope_frame(zstd_frame(sqlite_image()), 3), frames.K_IMAGE, (1,))
    assert e.value.code == "ENVELOPE_INVALID"


def test_encoding_2_in_a_parity_frame_is_refused():
    with pytest.raises(MochiError) as e:
        envelope.decode_binary(envelope_frame(zstd_frame(sqlite_image()), 2, schema=0, kind=frames.K_PARITY),
                               frames.K_PARITY, (0,))
    assert e.value.code == "ENVELOPE_INVALID"


def test_envelope_signature_is_the_zstd_magic():
    with pytest.raises(MochiError) as e:
        envelope.decode_binary(envelope_frame(sqlite_image(), 2), frames.K_IMAGE, (1,))
    assert e.value.code == "ENVELOPE_INVALID"


def test_decoded_signature_is_checked():
    img = bytearray(sqlite_image())
    img[0] ^= 1
    with pytest.raises(MochiError) as e:
        read(zstd_frame(bytes(img)), 2)
    assert e.value.code == "ENVELOPE_INVALID"


def test_decoded_user_version_is_checked():
    with pytest.raises(MochiError) as e:
        read(zstd_frame(sqlite_image(user_version=2)), 2)
    assert e.value.code == "ENVELOPE_INVALID"


@pytest.mark.parametrize("payload", [
    lambda f: f + b"\x00",                                   # bytes after the frame
    lambda f: zstd_frame(sqlite_image(), content_size=False),
    lambda f: zstd_frame(sqlite_image(), checksum=False),
])
def test_frame_shape_is_checked(payload):
    with pytest.raises(MochiError) as e:
        read(payload(zstd_frame(sqlite_image())), 2)
    assert e.value.code == "MALFORMED_FRAME"


def test_two_frames_are_refused():
    f = zstd_frame(sqlite_image())
    with pytest.raises(MochiError):
        read(f + f, 2)


def test_declared_size_above_the_bound_is_refused_before_decoding():
    # a frame header declaring 2**40 decoded bytes, with a body that would never decode
    declared = (1 << 40)
    f = (b"\x28\xb5\x2f\xfd" + bytes([0xC0 | 0x20 | 0x04]) + declared.to_bytes(8, "little")
         + b"\x01\x00\x00" + b"\x00\x00\x00\x00")
    with pytest.raises(MochiError) as e:
        read(f, 2)
    assert e.value.code == "LIMIT_EXCEEDED"


def test_declared_size_differing_from_actual_is_integrity_failure():
    # declares 8192 bytes (4-byte FCS), carries one empty last raw block: it decodes to nothing
    f = (b"\x28\xb5\x2f\xfd" + bytes([0x80 | 0x20 | 0x04]) + (8192).to_bytes(4, "little")
         + b"\x01\x00\x00" + b"\x00\x00\x00\x00")
    with pytest.raises(MochiError) as e:
        read(f, 2)
    assert e.value.code == "CONTENT_INTEGRITY_FAILED"
