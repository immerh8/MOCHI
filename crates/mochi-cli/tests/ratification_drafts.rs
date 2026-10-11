//! Drift test for the draft ratification artifacts R1, R2, R4, and R7
//! (`docs/ratification/`, plan §6, next-work-plan W8).
//!
//! The drafts are written from the code. Every table they mark *(checked)* is
//! parsed here and compared with the code it describes, so a change to the
//! registry, an envelope layout, the DDL, or the error-code registry fails
//! this test until the draft says the same thing. Two lists are compared with
//! the spec instead (R2's D11 obligations, R4's missing §10.1 tables), because
//! the draft restates them from there.
//!
//! The test never spells a frame magic or an 8-byte MOCHI magic: those are
//! read from the documents and compared with `mochi_format::registry`
//! (AGENTS.md, `ci/check-invariants.sh` rule 2).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use mochi_core::report::{Finding, Report, SeqRange, Severity, SkippedItem};
use mochi_core::status::{Dimension, Status, VerificationLevel};
use mochi_core::verify::{classify, ErrorClass};
use mochi_core::ErrorCode;
use mochi_format::envelope::{self, BinaryEnvelope, PayloadEncoding, RecordIdentity};
use mochi_format::registry::{self, FrameKind};

// ---- reading the documents ---------------------------------------------------------

fn repo_file(rel: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// The lines after the first heading that contains `needle`, up to the next
/// heading of the same or a higher level.
fn section<'a>(doc: &'a str, needle: &str) -> Vec<&'a str> {
    let lines: Vec<&str> = doc.lines().collect();
    let start = lines
        .iter()
        .position(|l| l.starts_with('#') && l.contains(needle))
        .unwrap_or_else(|| panic!("no heading containing {needle:?}"));
    let level = lines[start].chars().take_while(|c| *c == '#').count();
    let end = lines[start + 1..]
        .iter()
        .position(|l| {
            let n = l.chars().take_while(|c| *c == '#').count();
            n > 0 && n <= level && l[n..].starts_with(' ')
        })
        .map_or(lines.len(), |i| start + 1 + i);
    lines[start + 1..end].to_vec()
}

/// Strip backticks and surrounding space from a table cell.
fn clean(cell: &str) -> String {
    cell.trim().replace('`', "")
}

/// The `n`th markdown table (0-based) in `lines`: data rows only, cells
/// cleaned.
fn table(lines: &[&str], n: usize) -> Vec<Vec<String>> {
    let mut tables: Vec<Vec<Vec<String>>> = Vec::new();
    let mut in_table = false;
    for line in lines {
        let t = line.trim();
        if t.starts_with('|') {
            if !in_table {
                tables.push(Vec::new());
                in_table = true;
            }
            let cells: Vec<String> = t.trim_matches('|').split('|').map(clean).collect();
            tables.last_mut().unwrap().push(cells);
        } else {
            in_table = false;
        }
    }
    let rows = tables
        .into_iter()
        .nth(n)
        .unwrap_or_else(|| panic!("table {n} missing"));
    // Header row, then the `|---|` separator, then data.
    assert!(rows.len() >= 2 && rows[1].iter().all(|c| c.starts_with('-')));
    rows.into_iter().skip(2).collect()
}

/// Every backticked word in `lines`, in order.
fn backticked(lines: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    for line in lines {
        let mut parts = line.split('`');
        parts.next();
        while let Some(inner) = parts.next() {
            out.push(inner.to_owned());
            parts.next();
        }
    }
    out
}

fn hex(s: &str) -> Vec<u8> {
    let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    assert!(s.len().is_multiple_of(2), "odd hex {s:?}");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap_or_else(|_| panic!("hex {s:?}")))
        .collect()
}

/// A byte expression as the drafts write them: parts joined by `‖`, each
/// either hex digits (with spaces) or ASCII text.
fn bytes_expr(cell: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for part in cell.split('‖') {
        let p = part.trim();
        let is_hex = p.len() >= 2
            && p.chars().all(|c| c.is_ascii_hexdigit() || c == ' ')
            && p.chars().filter(|c| *c != ' ').count() % 2 == 0
            && p.chars().any(|c| c.is_ascii_digit());
        if is_hex && !p.chars().any(|c| c.is_ascii_uppercase()) {
            out.extend(hex(p));
        } else {
            out.extend_from_slice(p.as_bytes());
        }
    }
    out
}

fn magic(cell: &str) -> u32 {
    let h = cell
        .trim()
        .strip_prefix("0x")
        .unwrap_or_else(|| panic!("{cell:?}"));
    u32::from_str_radix(h, 16).unwrap()
}

fn kind_of(cell: &str) -> FrameKind {
    let m = magic(cell);
    FrameKind::from_magic(m).unwrap_or_else(|| panic!("{m:#x} not registered"))
}

/// The JSON string form of a serializable enum value.
macro_rules! json_str {
    () => {
        |v| {
            serde_json::to_value(v)
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned()
        }
    };
}

// ---- R1: frame registry and version mapping ----------------------------------------

const R1: &str = "docs/ratification/R1-frame-registry-draft.md";

#[test]
fn r1_version_identifiers_match_the_code() {
    let doc = repo_file(R1);
    let rows: BTreeMap<String, String> = table(&section(&doc, "1. Version identifiers"), 0)
        .into_iter()
        .map(|r| (r[0].clone(), r[1].clone()))
        .collect();
    assert_eq!(
        rows["Specification revision"],
        mochi_format::version::SPEC_REVISION
    );
    assert_eq!(
        rows["Wire generation"],
        mochi_format::version::WIRE_GENERATION.to_string()
    );
    assert_eq!(bytes_expr(&rows["Footer magic"]), registry::FOOTER_MAGIC);
    assert_eq!(
        rows["Draft identifier"],
        mochi_core::descriptor::DRAFT_ID.to_string()
    );
    assert_eq!(rows["Format status"], mochi_format::version::FORMAT_STATUS);
    assert_eq!(rows.len(), 5);
}

#[test]
fn r1_frame_registry_matches_the_code() {
    let doc = repo_file(R1);
    let rows = table(&section(&doc, "2. Frame registry"), 0);
    let mut seen = BTreeSet::new();
    for r in &rows {
        let m = magic(&r[0]);
        let kind = kind_of(&r[0]);
        assert_eq!(format!("{kind:?}"), r[1], "{m:#x}: kind");
        assert_eq!(
            kind.is_skippable(),
            match r[2].as_str() {
                "yes" => true,
                "no" => false,
                other => panic!("{m:#x}: skippable {other:?}"),
            },
            "{m:#x}: skippable"
        );
        let offset = match r[3].as_str() {
            "—" => None,
            n => Some(n.parse::<u64>().unwrap()),
        };
        assert_eq!(kind.required_offset(), offset, "{m:#x}: offset");
        assert!(seen.insert(m), "{m:#x} listed twice");
    }
    let registered: BTreeSet<u32> = std::iter::once(registry::ZSTD_DATA_FRAME)
        .chain(registry::SKIPPABLE_MIN..=registry::SKIPPABLE_MAX)
        .collect();
    assert_eq!(seen, registered, "R1 lists exactly the registered magics");
}

#[test]
fn r1_footer_layout_matches_an_encoded_footer() {
    let doc = repo_file(R1);
    let rows = table(&section(&doc, "3. Commit footer"), 0);
    let commit_frame = [0x5Au8; 37];
    let (offset, seq) = (0x0102_0304_0506_0708u64, 0x1112_1314_1516_1718u64);
    let frame = mochi_format::footer::encode_footer_frame(offset, seq, &commit_frame);
    let payload = &frame[registry::SKIPPABLE_HEADER_LEN..];
    assert_eq!(payload.len(), registry::FOOTER_PAYLOAD_LEN);
    let mut at = 0;
    for r in &rows {
        let (o, n): (usize, usize) = (r[0].parse().unwrap(), r[1].parse().unwrap());
        assert_eq!(o, at, "{}: footer fields are contiguous", r[2]);
        let field = &payload[o..o + n];
        let expected: Vec<u8> = if r[2].starts_with("Magic") {
            registry::FOOTER_MAGIC.to_vec()
        } else if r[2].starts_with("Commit-frame offset") {
            offset.to_le_bytes().to_vec()
        } else if r[2].starts_with("Commit-frame stored length") {
            (commit_frame.len() as u64).to_le_bytes().to_vec()
        } else if r[2].starts_with("Commit sequence") {
            seq.to_le_bytes().to_vec()
        } else if r[2].starts_with("Footer digest") {
            let mut prefix = [0u8; 32];
            prefix.copy_from_slice(&payload[..32]);
            mochi_format::digest::footer_digest(
                &prefix,
                mochi_format::digest::StoredObjectBytes::new(&commit_frame),
            )
            .to_vec()
        } else {
            panic!("unexpected footer field {:?}", r[2]);
        };
        assert_eq!(field, expected, "{}", r[2]);
        at = o + n;
    }
    assert_eq!(at, registry::FOOTER_PAYLOAD_LEN);
}

#[test]
fn r1_registered_byte_strings_match_the_code() {
    let doc = repo_file(R1);
    let rows = table(&section(&doc, "4. Other registered byte strings"), 0);
    let code: BTreeMap<&str, &[u8]> = [
        ("FOOTER_MAGIC", &registry::FOOTER_MAGIC[..]),
        (
            "TAIL_QUARANTINE_MAGIC",
            &registry::TAIL_QUARANTINE_MAGIC[..],
        ),
        (
            "SQLITE_IMAGE_SIGNATURE",
            &registry::SQLITE_IMAGE_SIGNATURE[..],
        ),
    ]
    .into_iter()
    .collect();
    assert_eq!(rows.len(), code.len());
    for r in &rows {
        assert_eq!(hex(&r[1]), code[r[0].as_str()], "{}", r[0]);
    }
}

#[test]
fn r1_record_schema_versions_match_the_code() {
    use mochi_core::{commit, descriptor, image, keys, manifest};
    let doc = repo_file(R1);
    let rows = table(&section(&doc, "5. Record schema versions"), 0);
    let mut kinds = BTreeSet::new();
    for r in &rows {
        let kind = kind_of(&r[0]);
        let listed: Vec<u64> = r[2].split(',').map(|v| v.trim().parse().unwrap()).collect();
        let code: Vec<u64> = match kind {
            FrameKind::ArchiveDescriptor => vec![descriptor::SCHEMA_VERSION],
            FrameKind::CommitRecord => {
                vec![commit::SCHEMA_VERSION, commit::ENCRYPTED_SCHEMA_VERSION]
            }
            FrameKind::RecoveryManifest => vec![
                manifest::SCHEMA_VERSION,
                manifest::RETENTION_SCHEMA_VERSION,
                manifest::ENCRYPTED_SCHEMA_VERSION,
            ],
            FrameKind::KeyEnvelope => vec![keys::ENVELOPE_SCHEMA_VERSION],
            FrameKind::MetadataDelta => image::IMAGE_SCHEMA_VERSIONS
                .iter()
                .map(|v| u64::from(*v))
                .collect(),
            FrameKind::EncryptedObject => vec![u64::from(mochi_format::seal::SEAL_VERSION)],
            other => panic!("R1 §5 lists {other:?}, which has no record schema"),
        };
        assert_eq!(listed, code, "{kind:?}");
        assert!(kinds.insert(format!("{kind:?}")), "{kind:?} listed twice");
    }
    assert_eq!(kinds.len(), 6);
    // "Required-feature identifiers registered: **1**".
    assert_eq!(mochi_format::seal::FEATURE_ENCRYPTED, 1);
    for known in [
        descriptor::KNOWN_REQUIRED_FEATURES,
        commit::KNOWN_REQUIRED_FEATURES,
        manifest::KNOWN_REQUIRED_FEATURES,
    ] {
        assert_eq!(known, [mochi_format::seal::FEATURE_ENCRYPTED]);
    }
}

// ---- R2: record envelopes -----------------------------------------------------------

const R2: &str = "docs/ratification/R2-record-envelopes-draft.md";

#[test]
fn r2_obligations_list_every_d11_field() {
    let spec = repo_file("docs/spec.md");
    let d11: Vec<&str> = spec
        .lines()
        .skip_while(|l| !l.starts_with("**D11 — Record envelopes"))
        .collect();
    let spec_fields: Vec<String> = table(&d11, 0).into_iter().map(|r| r[0].clone()).collect();
    let doc = repo_file(R2);
    let draft_fields: Vec<String> = table(&section(&doc, "1. Two encodings"), 0)
        .into_iter()
        .map(|r| r[0].clone())
        .collect();
    assert_eq!(draft_fields, spec_fields);
}

#[test]
fn r2_binary_envelope_layout_matches_an_encoded_record() {
    let doc = repo_file(R2);
    let rows = table(&section(&doc, "2. Binary envelope v0"), 0);

    // A minimal SQLite-signed payload whose user_version (bytes 60..64) is 0.
    let mut payload = vec![0u8; 100];
    payload[..16].copy_from_slice(&registry::SQLITE_IMAGE_SIGNATURE);
    let feature = mochi_format::seal::FEATURE_ENCRYPTED;
    let env = BinaryEnvelope {
        record_schema_version: 0,
        encoding: PayloadEncoding::SqliteImage,
        identity: RecordIdentity {
            archive_id: [0xA1; 32],
            commit_sequence: 0x0102_0304_0506_0708,
            transaction_id: [0xB2; 16],
        },
        required_features: vec![feature],
    };
    let frame = envelope::encode_binary_record(
        FrameKind::MetadataDelta,
        &env,
        &payload,
        &[feature],
        &mochi_format::Limits::default(),
    )
    .unwrap();
    let body = &frame[registry::SKIPPABLE_HEADER_LEN..];
    let n = env.required_features.len();
    let header_len = envelope::BINARY_ENVELOPE_FIXED_LEN + 8 * n;

    let mut at = 0;
    for r in &rows {
        let o: usize = r[0].parse().unwrap();
        let size = if r[1] == "8·n" {
            8 * n
        } else {
            r[1].parse().unwrap()
        };
        assert_eq!(o, at, "{}: fields are contiguous", r[2]);
        let expected: Vec<u8> = match r[2].as_str() {
            "Header length" => (header_len as u32).to_le_bytes().to_vec(),
            "Envelope version" => envelope::BINARY_ENVELOPE_VERSION.to_le_bytes().to_vec(),
            "Record schema version" => env.record_schema_version.to_le_bytes().to_vec(),
            "Payload encoding" => env.encoding.code().to_le_bytes().to_vec(),
            "n = required-feature count" => (n as u32).to_le_bytes().to_vec(),
            "Payload length" => (payload.len() as u64).to_le_bytes().to_vec(),
            "Archive ID" => env.identity.archive_id.to_vec(),
            "Commit sequence" => env.identity.commit_sequence.to_le_bytes().to_vec(),
            "Transaction ID" => env.identity.transaction_id.to_vec(),
            "Required features" => feature.to_le_bytes().to_vec(),
            other => panic!("unexpected envelope field {other:?}"),
        };
        assert_eq!(&body[o..o + size], expected, "{}", r[2]);
        at = o + size;
    }
    assert_eq!(at, header_len, "the header ends where the table ends");
    assert_eq!(
        &body[header_len..],
        payload,
        "the payload follows the header"
    );
}

#[test]
fn r2_payload_encodings_and_enveloped_kinds_match_the_code() {
    let doc = repo_file(R2);
    let lines = section(&doc, "2. Binary envelope v0");

    let encodings = table(&lines, 1);
    for r in &encodings {
        let code: u32 = r[0].parse().unwrap();
        let enc = PayloadEncoding::from_code(code).unwrap_or_else(|| panic!("code {code}"));
        assert_eq!(
            bytes_expr(&r[2].replace(" (16 bytes)", "")),
            enc.signature()
        );
    }
    let registered = (0..=1024u32)
        .filter(|c| PayloadEncoding::from_code(*c).is_some())
        .count();
    assert_eq!(
        registered,
        encodings.len(),
        "R2 lists every registered encoding"
    );

    let kinds: BTreeSet<String> = table(&lines, 2)
        .iter()
        .map(|r| format!("{:?}", kind_of(&r[0])))
        .collect();
    let code: BTreeSet<String> = std::iter::once(registry::ZSTD_DATA_FRAME)
        .chain(registry::SKIPPABLE_MIN..=registry::SKIPPABLE_MAX)
        .filter_map(FrameKind::from_magic)
        .filter(|k| envelope::carries_binary_envelope(*k))
        .map(|k| format!("{k:?}"))
        .collect();
    assert_eq!(kinds, code);
}

// ---- R4: catalog DDL ----------------------------------------------------------------

const R4: &str = "docs/ratification/R4-catalog-ddl-draft.md";

#[test]
fn r4_ddl_is_the_code_ddl_byte_for_byte() {
    let doc = repo_file(R4);
    let block: String = section(&doc, "2. DDL")
        .into_iter()
        .skip_while(|l| *l != "```sql")
        .skip(1)
        .take_while(|l| *l != "```")
        .map(|l| format!("{l}\n"))
        .collect();
    assert_eq!(block.trim(), mochi_core::catalog::schema::DDL.trim());
}

#[test]
fn r4_header_values_and_meta_keys_match_the_code() {
    use mochi_core::catalog::schema;
    let doc = repo_file(R4);
    let lines = section(&doc, "1. The image");
    let header: BTreeMap<String, String> = table(&lines, 0)
        .into_iter()
        .map(|r| (r[0].clone(), r[1].clone()))
        .collect();
    let first_word = |s: &str| s.split_whitespace().next().unwrap().to_owned();
    assert_eq!(
        magic(&first_word(&header["application_id"])) as i32,
        schema::APPLICATION_ID
    );
    assert_eq!(
        first_word(&header["user_version"]),
        schema::SCHEMA_VERSION.to_string()
    );
    assert_eq!(header["Page size"], schema::PAGE_SIZE.to_string());

    let keys: BTreeSet<String> = table(&lines, 1).into_iter().map(|r| r[0].clone()).collect();
    let code: BTreeSet<String> = [
        mochi_core::catalog::META_ARCHIVE_ID,
        mochi_core::publish::META_WRITER_PARAMS,
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    assert_eq!(keys, code);
}

#[test]
fn r4_lists_exactly_the_spec_tables_the_ddl_lacks() {
    let ddl_tables: BTreeSet<String> = mochi_core::catalog::schema::DDL
        .lines()
        .filter_map(|l| l.strip_prefix("CREATE TABLE "))
        .map(|l| l.split_whitespace().next().unwrap().to_owned())
        .collect();
    let spec = repo_file("docs/spec.md");
    let spec_tables: BTreeSet<String> = table(&section(&spec, "10.1 Immutable records"), 0)
        .into_iter()
        .map(|r| r[0].clone())
        .collect();
    let doc = repo_file(R4);
    let lines = section(&doc, "4. §10.1 tables");
    let firsts =
        |n| -> BTreeSet<String> { table(&lines, n).into_iter().map(|r| r[0].clone()).collect() };

    let missing: BTreeSet<String> = spec_tables.difference(&ddl_tables).cloned().collect();
    assert_eq!(firsts(0), missing, "§10.1 tables the DDL lacks");
    let extra: BTreeSet<String> = ddl_tables.difference(&spec_tables).cloned().collect();
    assert_eq!(firsts(1), extra, "DDL tables §10.1 does not name");
}

// ---- R7: reports and error codes ----------------------------------------------------

const R7: &str = "docs/ratification/R7-reports-and-error-codes-draft.md";

/// Every `Status`. The match makes a new variant a compile error here.
fn all_statuses() -> Vec<Status> {
    let all = [
        Status::Pass,
        Status::Fail,
        Status::Degraded,
        Status::Unknown,
        Status::Overdue,
        Status::Unsupported,
    ];
    for s in all {
        match s {
            Status::Pass
            | Status::Fail
            | Status::Degraded
            | Status::Unknown
            | Status::Overdue
            | Status::Unsupported => {}
        }
    }
    all.to_vec()
}

/// Every `VerificationLevel`, exhaustively as above.
fn all_levels() -> Vec<VerificationLevel> {
    use VerificationLevel::*;
    let all = [
        Structural,
        Referential,
        StoredIntegrity,
        ContentIntegrity,
        Restoration,
        Search,
        Inventory,
        DisasterRecovery,
    ];
    for l in all {
        match l {
            Structural | Referential | StoredIntegrity | ContentIntegrity | Restoration
            | Search | Inventory | DisasterRecovery => {}
        }
    }
    all.to_vec()
}

#[test]
fn r7_enumerations_match_the_code() {
    let doc = repo_file(R7);

    let statuses: BTreeSet<String> = table(&section(&doc, "1. Status values"), 0)
        .into_iter()
        .map(|r| r[0].clone())
        .collect();
    let code: BTreeSet<String> = all_statuses().iter().map(json_str!()).collect();
    assert_eq!(statuses, code);

    let dims: Vec<String> = backticked(&section(&doc, "2. Dimensions"));
    let code: Vec<String> = Dimension::ALL.iter().map(json_str!()).collect();
    assert_eq!(dims, code);

    let levels: Vec<String> = table(&section(&doc, "3. Verification levels"), 0)
        .into_iter()
        .map(|r| r[0].clone())
        .collect();
    let code: Vec<String> = all_levels().iter().map(json_str!()).collect();
    assert_eq!(levels, code);

    let other: BTreeMap<String, Vec<String>> = table(&section(&doc, "4. Other enumerations"), 0)
        .into_iter()
        .map(|r| (r[0].clone(), r[1].split(", ").map(str::to_owned).collect()))
        .collect();
    let severities: Vec<String> = [Severity::Info, Severity::Warning, Severity::Error]
        .iter()
        .map(json_str!())
        .collect();
    assert_eq!(other["findings[].severity"], severities);
    use mochi_core::report::FreshnessAnchorKind as A;
    let anchors: Vec<String> = [A::None, A::User, A::LocalHistory]
        .iter()
        .map(json_str!())
        .collect();
    assert_eq!(other["freshness_anchor"], anchors);
}

#[test]
fn r7_exit_codes_match_the_code() {
    use mochi_cli::exit;
    let doc = repo_file(R7);
    let rows = table(&section(&doc, "5. Exit codes"), 0);
    let code = [
        ("OK", exit::OK),
        ("FAILED", exit::FAILED),
        ("DEGRADED", exit::DEGRADED),
        ("ERROR", exit::ERROR),
        ("UNSUPPORTED", exit::UNSUPPORTED),
    ];
    assert_eq!(rows.len(), code.len());
    for (r, (name, value)) in rows.iter().zip(code) {
        assert_eq!(r[1], name);
        assert_eq!(r[0], value.to_string(), "{name}");
    }
}

#[test]
fn r7_error_registry_matches_both_exhaustive_matches() {
    let doc = repo_file(R7);
    let rows = table(&section(&doc, "6. Error codes"), 0);
    let listed: Vec<&str> = rows.iter().map(|r| r[0].as_str()).collect();
    let code: Vec<&str> = ErrorCode::ALL.iter().map(|c| c.as_str()).collect();
    assert_eq!(listed, code, "R7 lists the registry in registry order");
    for (r, c) in rows.iter().zip(ErrorCode::ALL) {
        assert_eq!(
            r[1],
            mochi_cli::exit_code_for(*c).to_string(),
            "{c}: exit as error"
        );
        let class = match classify(*c) {
            ErrorClass::Violation => "violation",
            ErrorClass::Unsupported => "unsupported",
            ErrorClass::Operational => "operational",
        };
        assert_eq!(r[2], class, "{c}: verification class");
        assert!(!r[4].is_empty(), "{c}: meaning");
    }
}

#[test]
fn r7_report_fields_match_the_serialized_report() {
    let mut report = Report::new(VerificationLevel::Structural);
    report.skipped.push(SkippedItem {
        item: "i".into(),
        reason: "r".into(),
    });
    report.findings.push(Finding {
        code: ErrorCode::IoError,
        severity: Severity::Info,
        message: Some("m".into()),
        expected: Some("e".into()),
        observed: Some("o".into()),
        affected: Some(SeqRange { first: 0, last: 1 }),
    });
    let text = serde_json::to_string(&report).unwrap();
    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
    let keys = |v: &serde_json::Value| -> BTreeSet<String> {
        v.as_object().unwrap().keys().cloned().collect()
    };

    let doc = repo_file(R7);
    let lines = section(&doc, "7. Report fields");
    let top_end = lines
        .iter()
        .position(|l| l.starts_with("Nested objects"))
        .unwrap();
    let top = backticked(&lines[..top_end])
        .into_iter()
        .filter(|w| !w.contains('.') && !w.contains('/') && !w.contains("::"))
        .collect::<Vec<_>>();
    assert_eq!(top.iter().cloned().collect::<BTreeSet<_>>(), keys(&value));
    // In serialization order: each key's first `"key":` comes after the last.
    let mut pos = 0;
    for k in &top {
        let at = text
            .find(&format!("\"{k}\":"))
            .unwrap_or_else(|| panic!("{k} not serialized"));
        assert!(at >= pos, "{k} is out of order");
        pos = at;
    }

    let nested: BTreeMap<String, BTreeSet<String>> = table(&lines[top_end..], 0)
        .into_iter()
        .map(|r| {
            let fields = r[1]
                .split(" (")
                .next()
                .unwrap()
                .split(", ")
                .map(str::to_owned)
                .collect();
            (r[0].clone(), fields)
        })
        .collect();
    let at = |path: &str| -> serde_json::Value {
        let mut v = value.clone();
        for part in path.split('.') {
            v = match part.strip_suffix("[]") {
                Some(name) => v[name][0].clone(),
                None => v[part].clone(),
            };
        }
        v
    };
    assert_eq!(nested.len(), 7);
    for (path, fields) in &nested {
        assert_eq!(*fields, keys(&at(path)), "{path}");
    }

    // The user-facing field reference names the same top-level fields.
    let schema_doc = repo_file("docs/report-schema-v1.md");
    let listed: BTreeSet<String> = table(&section(&schema_doc, "Fields"), 0)
        .into_iter()
        .flat_map(|r| r[0].split(", ").map(str::to_owned).collect::<Vec<_>>())
        .collect();
    assert_eq!(listed, keys(&value), "docs/report-schema-v1.md");
}
