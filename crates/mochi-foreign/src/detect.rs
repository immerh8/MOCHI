//! Format detection by content, never by extension. Runs inside the helper.
//!
//! A magic-number match is a candidate, not proof (AGENTS.md): ZIP needs a
//! consistent end-of-central-directory record, tar needs a valid header
//! checksum, `.tar.gz` needs a gzip stream whose first block is a tar header.

use std::io::{Read, Seek, SeekFrom};

use flate2::read::GzDecoder;

use crate::types::{ErrorCode, ForeignError, ForeignFormat};

const EOCD_SIG: [u8; 4] = *b"PK\x05\x06";
const ZIP64_LOCATOR_SIG: [u8; 4] = *b"PK\x06\x07";
const EOCD_FIXED: usize = 22;
const MAX_COMMENT: usize = 65_535;

fn err(code: ErrorCode, msg: &str) -> ForeignError {
    ForeignError::new(code, msg)
}

fn io_err(e: std::io::Error) -> ForeignError {
    ForeignError::new(ErrorCode::OpenFailed, format!("cannot read archive: {e}"))
}

enum Eocd {
    Missing,
    /// `total` is the end record's entry count (0xFFFF when ZIP64 holds it).
    Single {
        total: u16,
    },
    Split,
}

/// Looks for a consistent EOCD in the tail. `Split` when it (or its ZIP64
/// locator) says this is one segment of a multi-disk archive.
fn find_eocd<R: Read + Seek>(r: &mut R, len: u64) -> Result<Eocd, ForeignError> {
    let tail_len = len.min((EOCD_FIXED + MAX_COMMENT + 20) as u64);
    r.seek(SeekFrom::Start(len - tail_len)).map_err(io_err)?;
    let mut tail = vec![0u8; tail_len as usize];
    r.read_exact(&mut tail).map_err(io_err)?;
    if tail.len() < EOCD_FIXED {
        return Ok(Eocd::Missing);
    }
    let mut pos = tail.len() - EOCD_FIXED;
    loop {
        if tail[pos..pos + 4] == EOCD_SIG {
            let comment_len = usize::from(u16::from_le_bytes([tail[pos + 20], tail[pos + 21]]));
            if pos + EOCD_FIXED + comment_len == tail.len() {
                let disk = u16::from_le_bytes([tail[pos + 4], tail[pos + 5]]);
                let cd_disk = u16::from_le_bytes([tail[pos + 6], tail[pos + 7]]);
                let mut split = disk != 0 || cd_disk != 0;
                if pos >= 20 && tail[pos - 20..pos - 16] == ZIP64_LOCATOR_SIG {
                    let b = &tail[pos - 20..pos];
                    let eocd64_disk = u32::from_le_bytes([b[4], b[5], b[6], b[7]]);
                    let total_disks = u32::from_le_bytes([b[16], b[17], b[18], b[19]]);
                    split |= eocd64_disk != 0 || total_disks > 1;
                }
                let total = u16::from_le_bytes([tail[pos + 10], tail[pos + 11]]);
                return Ok(if split {
                    Eocd::Split
                } else {
                    Eocd::Single { total }
                });
            }
        }
        if pos == 0 {
            return Ok(Eocd::Missing);
        }
        pos -= 1;
    }
}

fn parse_octal(field: &[u8]) -> Option<u64> {
    let mut v: u64 = 0;
    let mut seen = false;
    for &b in field {
        match b {
            b'0'..=b'7' => {
                v = v.checked_mul(8)?.checked_add(u64::from(b - b'0'))?;
                seen = true;
            }
            b' ' | 0 if !seen => {}
            b' ' | 0 => break,
            _ => return None,
        }
    }
    seen.then_some(v)
}

/// A tar header block: non-zero, with a checksum field that matches.
pub fn looks_like_tar(block: &[u8]) -> bool {
    if block.len() < 512 || block[..512].iter().all(|&b| b == 0) {
        return false;
    }
    let Some(stored) = parse_octal(&block[148..156]) else {
        return false;
    };
    let mut unsigned: u64 = 0;
    let mut signed: i64 = 0;
    for (i, &b) in block[..512].iter().enumerate() {
        let b = if (148..156).contains(&i) { b' ' } else { b };
        unsigned += u64::from(b);
        signed += i64::from(b as i8);
    }
    stored == unsigned || i64::try_from(stored).is_ok_and(|s| s == signed)
}

/// Decides which supported format `r` holds, or why it is not one.
pub fn detect<R: Read + Seek>(r: &mut R) -> Result<ForeignFormat, ForeignError> {
    let len = r.seek(SeekFrom::End(0)).map_err(io_err)?;
    if len == 0 {
        return Err(err(ErrorCode::NotAnArchive, "the file is empty"));
    }
    r.seek(SeekFrom::Start(0)).map_err(io_err)?;
    let mut head = Vec::new();
    r.by_ref()
        .take(512)
        .read_to_end(&mut head)
        .map_err(io_err)?;

    if head.starts_with(b"7z\xBC\xAF\x27\x1C") {
        return Err(err(
            ErrorCode::UnsupportedFormat,
            "7z archives are not supported by this build yet",
        ));
    }
    if head.starts_with(b"Rar!\x1A\x07") {
        return Err(err(
            ErrorCode::UnsupportedFormat,
            "RAR archives are not supported by this build yet",
        ));
    }
    if head.starts_with(b"PK\x07\x08") || head.starts_with(b"PK00") {
        return Err(err(
            ErrorCode::UnsupportedSplitZip,
            "this is the first segment of a split or spanned ZIP archive; split ZIP is not supported",
        ));
    }
    if head.starts_with(b"MZ") || head.starts_with(b"\x7fELF") {
        return match find_eocd(r, len)? {
            Eocd::Missing => Err(err(
                ErrorCode::UnsupportedFormat,
                "an executable file, not an archive",
            )),
            _ => Err(err(
                ErrorCode::UnsupportedSfx,
                "a self-extracting archive (an executable with a ZIP appended); self-extracting archives are not supported",
            )),
        };
    }
    if head.starts_with(b"PK\x03\x04") || head.starts_with(b"PK\x05\x06") {
        return match find_eocd(r, len)? {
            Eocd::Single { .. } => Ok(ForeignFormat::Zip),
            Eocd::Split => Err(err(
                ErrorCode::UnsupportedSplitZip,
                "this ZIP archive is one segment of a split or spanned set; split ZIP is not supported",
            )),
            Eocd::Missing => Err(err(
                ErrorCode::MalformedArchive,
                "ZIP signature found but no end-of-central-directory record (truncated or damaged)",
            )),
        };
    }
    if head.starts_with(&[0x1f, 0x8b]) {
        r.seek(SeekFrom::Start(0)).map_err(io_err)?;
        let mut first = Vec::new();
        let mut dec = GzDecoder::new(&mut *r).take(512);
        let read = dec.read_to_end(&mut first);
        if read.is_err() || !looks_like_tar(&first) {
            return Err(err(
                ErrorCode::UnsupportedFormat,
                "a gzip stream that does not start with a tar header (only .tar.gz is supported, not a gzipped single file)",
            ));
        }
        return Ok(ForeignFormat::TarGz);
    }
    if looks_like_tar(&head) {
        return Ok(ForeignFormat::Tar);
    }
    // The last segment of a split ZIP starts mid-data (no ZIP signature at
    // offset 0) but its end record names a non-zero disk.
    if matches!(find_eocd(r, len)?, Eocd::Split) {
        return Err(err(
            ErrorCode::UnsupportedSplitZip,
            "this looks like the last segment of a split or spanned ZIP set; split ZIP is not supported",
        ));
    }
    Err(err(
        ErrorCode::NotAnArchive,
        "not a ZIP, tar, or tar.gz archive",
    ))
}

/// The entry count the ZIP end record declares, when it is not a ZIP64
/// placeholder. The `zip` crate keys entries by name, so entries that share a
/// name collapse into one; comparing its count with this one exposes that.
pub fn declared_zip_entries<R: Read + Seek>(r: &mut R, len: u64) -> Option<u64> {
    match find_eocd(r, len) {
        Ok(Eocd::Single { total }) if total != u16::MAX => Some(u64::from(total)),
        _ => None,
    }
}
