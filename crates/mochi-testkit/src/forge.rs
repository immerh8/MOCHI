//! Forging commits on top of a real archive, for T11/T12 negative tests and
//! (later) golden reject vectors.
//!
//! Everything here appends: the bytes the real writer produced stay
//! untouched, and each forged commit is a well-formed frame sequence
//! (objects, commit record, footer) so that `locate_head` accepts it as the
//! head. What makes a forged archive *invalid* is only the field a test
//! changes, which keeps each reject case aimed at one rule.
//!
//! Test infrastructure: unwraps freely.

use mochi_core::commit::{CommitLink, CommitRecord, Metadata, ObjectRef};
use mochi_core::manifest::{Manifest, ManifestKind, ParentLink};
use mochi_core::publish::{commit_history, HistoryEntry, ReadOptions};
use mochi_format::cbor::{self, CborLimits, Value};
use mochi_format::digest::stored_object_hash;
use mochi_format::footer::{encode_footer_frame, FOOTER_FRAME_LEN};
use mochi_format::frame::encode_skippable_frame;
use mochi_format::registry::FrameKind;
use mochi_format::repr::StoredObject;

use crate::SimStorage;

/// An archive's bytes plus forged appends.
#[derive(Debug, Clone)]
pub struct Forge {
    pub bytes: Vec<u8>,
}

impl Forge {
    pub fn new(bytes: Vec<u8>) -> Self {
        Forge { bytes }
    }

    pub fn storage(&self) -> SimStorage {
        SimStorage::from_bytes(self.bytes.clone())
    }

    /// The published history, head last, as the reader's walk sees it.
    pub fn history(&self) -> Vec<HistoryEntry> {
        commit_history(&self.storage(), &ReadOptions::default()).unwrap()
    }

    /// Append one stored object and return a reference to it.
    pub fn append_object(&mut self, stored: &StoredObject) -> ObjectRef {
        let offset = self.bytes.len() as u64;
        self.bytes.extend_from_slice(stored.as_bytes());
        ObjectRef {
            offset,
            stored_len: stored.len(),
            stored_hash: stored_object_hash(stored.view()),
        }
    }

    /// Append a manifest through the real encoder (which refuses invalid
    /// structure, so use [`Forge::append_manifest_edited`] for those).
    pub fn append_manifest(&mut self, m: &Manifest) -> ObjectRef {
        self.append_object(&m.to_stored().unwrap())
    }

    /// Append a manifest whose canonical CBOR was edited after encoding:
    /// for faults the encoder refuses to write (unknown operation kind,
    /// unknown required feature). The result is still canonical CBOR in one
    /// recovery-manifest frame; only the edited field is wrong.
    pub fn append_manifest_edited(
        &mut self,
        m: &Manifest,
        edit: impl FnOnce(&mut Value),
    ) -> ObjectRef {
        let mut v = cbor::decode(&m.encode().unwrap(), &CborLimits::default()).unwrap();
        edit(&mut v);
        let payload = cbor::encode(&v).unwrap();
        let frame = encode_skippable_frame(FrameKind::RecoveryManifest, &payload).unwrap();
        self.append_object(&StoredObject::from_loaded(frame))
    }

    /// Append a commit record and its footer; return it as a history entry.
    pub fn append_commit(&mut self, record: &CommitRecord) -> HistoryEntry {
        let (frame, commit_id) = record.to_stored().unwrap();
        let commit_offset = self.bytes.len() as u64;
        self.bytes.extend_from_slice(frame.as_bytes());
        let footer_offset = self.bytes.len() as u64;
        self.bytes.extend_from_slice(&encode_footer_frame(
            commit_offset,
            record.seq,
            frame.as_bytes(),
        ));
        assert_eq!(self.bytes.len() as u64, footer_offset + FOOTER_FRAME_LEN);
        HistoryEntry {
            footer_offset,
            commit_offset,
            commit: record.clone(),
            commit_id,
        }
    }

    /// Forge delta commit `prev.seq + 1` on `base` with manifest `m` (whose
    /// reference this appends first), parent = `prev`.
    pub fn append_delta(
        &mut self,
        prev: &HistoryEntry,
        base: CommitLink,
        m: ObjectRef,
        txid: [u8; 16],
    ) -> HistoryEntry {
        let record = delta_record(prev, base, m, txid);
        self.append_commit(&record)
    }
}

/// The link a child uses to name `e` (parent or base).
pub fn link(e: &HistoryEntry) -> CommitLink {
    CommitLink {
        commit_id: e.commit_id,
        seq: e.commit.seq,
        footer_offset: e.footer_offset,
    }
}

/// The base a correct delta after `prev` names (D10.6 base rule).
pub fn rule_base(prev: &HistoryEntry) -> CommitLink {
    match prev.commit.metadata {
        Metadata::Checkpoint { .. } => link(prev),
        Metadata::Delta { base } => base,
    }
}

/// A forged transaction ID, distinct per `n`.
pub fn txid(n: u8) -> [u8; 16] {
    mochi_core::commit::uuid_v4([n; 16])
}

/// A delta commit record following `prev`: same archive and descriptor.
pub fn delta_record(
    prev: &HistoryEntry,
    base: CommitLink,
    m: ObjectRef,
    txid: [u8; 16],
) -> CommitRecord {
    CommitRecord {
        seq: prev.commit.seq + 1,
        transaction_id: txid,
        parent: Some(link(prev)),
        metadata: Metadata::Delta { base },
        delta_manifest: m,
        required_features: Vec::new(),
        time: None,
        ..prev.commit.clone()
    }
}

/// An empty, correct delta manifest for commit `prev.seq + 1`: parent link
/// to `prev`'s key 6 (checklist Q22). Tests change one field.
pub fn empty_delta(prev: &HistoryEntry, txid: [u8; 16]) -> Manifest {
    Manifest {
        archive_id: prev.commit.archive_id,
        commit_seq: prev.commit.seq + 1,
        transaction_id: txid,
        parent: Some(ParentLink {
            seq: prev.commit.seq,
            delta_manifest_hash: prev.commit.delta_manifest.stored_hash,
        }),
        kind: ManifestKind::Delta,
        chunks: Vec::new(),
        file_versions: Vec::new(),
        ops: Vec::new(),
        entries: Vec::new(),
        required_features: Vec::new(),
        retention_ops: Vec::new(),
        retention: Default::default(),
        provenance: None,
        keys: Default::default(),
    }
}

/// Mutable access to field `key` of a CBOR map.
pub fn field(v: &mut Value, key: u64) -> &mut Value {
    let Value::Map(entries) = v else {
        panic!("not a map")
    };
    &mut entries.iter_mut().find(|(k, _)| *k == key).unwrap().1
}

/// What [`put_with_dependency`] makes the forged chunk depend on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DictionaryDependency {
    /// No dependency: an ordinary chunk (the control).
    None,
    /// A dictionary that is an intact object of the same commit. Nothing in
    /// 1.0 can use it as one, so the chunk is undecodable (plan K17).
    Present,
    /// A dictionary ID the catalog does not hold: a dangling reference
    /// (§5.2).
    Missing,
}

/// Forge one delta commit after the head of `bytes` that puts `name` with
/// one intact chunk depending on `dep`. Returns the archive bytes and the
/// forged file version.
pub fn put_with_dependency(
    bytes: Vec<u8>,
    name: &str,
    dep: DictionaryDependency,
) -> (Vec<u8>, mochi_core::catalog::namespace::FileVersionId) {
    use mochi_core::catalog::extent::{Extent, ExtentSource};
    use mochi_core::catalog::namespace::{EntryKind, FileVersionId, NamespaceOp};
    use mochi_core::catalog::FileVersion;
    use mochi_core::manifest::{ChunkEntry, FileVersionEntry};
    use mochi_core::object::{build_object, Dependency, ObjectId};
    use mochi_format::codec::{EncodeParams, Protection};
    use mochi_format::digest::file_content_hash;
    use mochi_format::repr::{DecodedBytes, DecodedSlice};
    use mochi_format::Limits;

    let object = |seed: u64, ids: u64| {
        build_object(
            &DecodedBytes::new(crate::deterministic_bytes(seed, 150)),
            &EncodeParams::default(),
            Protection::None,
            &mut crate::SeqIds::new(ids),
            &Limits::default(),
        )
        .unwrap()
    };
    let content = crate::deterministic_bytes(77, 150);
    let mut f = Forge::new(bytes);
    let head = f.history().pop().unwrap();
    let mut obj = object(77, 0x5000);
    let dictionary = object(78, 0x6000);
    let mut m = empty_delta(&head, txid(0x31));
    match dep {
        DictionaryDependency::None => {}
        DictionaryDependency::Present => {
            obj.record
                .dependencies
                .push(Dependency::Dictionary(dictionary.record.id));
            let at = f.append_object(&dictionary.stored).offset;
            m.chunks.push(ChunkEntry {
                record: dictionary.record.clone(),
                location: Some(at),
            });
        }
        DictionaryDependency::Missing => obj
            .record
            .dependencies
            .push(Dependency::Dictionary(ObjectId::from_bytes([9; 32]))),
    }
    let at = f.append_object(&obj.stored).offset;
    let id = FileVersionId::from_bytes([0xD7; 32]);
    m.chunks.push(ChunkEntry {
        record: obj.record.clone(),
        location: Some(at),
    });
    m.file_versions.push(FileVersionEntry {
        version: FileVersion {
            id,
            kind: EntryKind::File,
            logical_len: content.len() as u64,
            content_hash: Some(file_content_hash(DecodedSlice::from_logical(&content))),
        },
        extents: vec![Extent {
            ordinal: 0,
            logical_offset: 0,
            length: content.len() as u64,
            source: ExtentSource::Chunk {
                chunk: obj.record.id,
                chunk_offset: 0,
            },
        }],
        attributes: crate::replay::attrs(0o644, 8),
    });
    m.ops.push(NamespaceOp::Put {
        path: crate::archive::path(name),
        version: id,
    });
    m.canonicalize();
    let r = f.append_manifest(&m);
    f.append_delta(&head, rule_base(&head), r, txid(0x31));
    (f.bytes, id)
}
