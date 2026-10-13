//! Helper-side engine: detect, then list/test/read through the format modules.
//! Everything here runs inside the helper process only; `mochi-core` and
//! `mochi-format` never link this module (checked by `ci/check-invariants.sh`).
//!
//! It is generic over `Read + Seek` so the fuzz targets and tests drive the
//! very code the helper runs, on in-memory bytes.

use std::io::{self, Read, Seek, SeekFrom};

use crate::detect::detect;
use crate::protocol::{Done, Message, Request};
use crate::tarfmt;
use crate::types::*;
use crate::zipfmt;

/// Where the engine sends messages. An `Err` means the consumer is gone.
pub type Out<'a> = dyn FnMut(Message) -> io::Result<()> + 'a;

pub enum EngineError {
    /// The archive could not be processed; becomes an `Error` message.
    Archive(ForeignError),
    /// The output channel failed; nothing more can be reported.
    Sink(io::Error),
}

impl From<io::Error> for EngineError {
    fn from(e: io::Error) -> Self {
        EngineError::Sink(e)
    }
}

impl From<ForeignError> for EngineError {
    fn from(e: ForeignError) -> Self {
        EngineError::Archive(e)
    }
}

/// How an operation ended, for the `Done` message.
#[derive(Default)]
pub struct Tally {
    pub entries: u64,
    pub bytes_out: u64,
    pub complete: bool,
    pub stop_reason: Option<String>,
}

pub fn run<R: Read + Seek>(mut src: R, req: &Request, out: &mut Out) -> Result<(), EngineError> {
    let len = src.seek(SeekFrom::End(0)).map_err(|e| {
        ForeignError::new(ErrorCode::OpenFailed, format!("cannot read archive: {e}"))
    })?;
    let format = detect(&mut src)?;
    src.seek(SeekFrom::Start(0)).map_err(|e| {
        ForeignError::new(ErrorCode::OpenFailed, format!("cannot read archive: {e}"))
    })?;
    out(Message::Format(format))?;
    let tally = match format {
        ForeignFormat::Zip => zipfmt::run(src, len, req, out)?,
        ForeignFormat::Tar => tarfmt::run(src, len, false, req, out)?,
        ForeignFormat::TarGz => tarfmt::run(src, len, true, req, out)?,
    };
    out(Message::Done(Done {
        complete: tally.complete,
        entries: tally.entries,
        bytes_out: tally.bytes_out,
        stop_reason: tally.stop_reason,
    }))?;
    Ok(())
}

pub(crate) fn emit_breach(
    out: &mut Out,
    kind: BreachKind,
    entry: Option<u64>,
    limit: u64,
    observed: u64,
) -> io::Result<Breach> {
    let b = Breach {
        kind,
        entry,
        limit,
        observed,
    };
    out(Message::Breach(b.clone()))?;
    Ok(b)
}

/// The compression-ratio test shared by both formats: enough output to matter,
/// and more than `ratio` times the compressed bytes behind it.
pub(crate) fn ratio_exceeded(limits: &Limits, produced: u64, compressed: u64) -> bool {
    produced > limits.ratio_min_output
        && produced > limits.max_ratio.saturating_mul(compressed.max(1))
}

pub(crate) fn truncate_text(mut s: String) -> String {
    let max = crate::protocol::MAX_MESSAGE_TEXT;
    if s.len() > max {
        let mut i = max;
        while !s.is_char_boundary(i) {
            i -= 1;
        }
        s.truncate(i);
    }
    s
}
