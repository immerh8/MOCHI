import { useCallback, useEffect, useState } from "react";

import {
  closeArchive,
  entryDetails,
  listChildren,
  openArchive,
  openSnapshot,
} from "../ipc/browse";
import type {
  ArchiveSummary,
  CommitView,
  EntryDetails,
  EntryRow,
  SnapshotView,
} from "../ipc/browse";
import { errorText, formatMode, formatSize, shortSize } from "./format";
import { Name } from "./Name";
import { Tree } from "./Tree";
import type { Crumb } from "./Tree";
import { VirtualList } from "./VirtualList";
import { Checker } from "../check/Checker";
import { EncryptionNotes, PassphraseForm } from "../crypt/PassphraseForm";
import { Rekey } from "../crypt/Rekey";
import { HIDDEN_WITH_KEY, NOT_SIGNED, VISIBLE_WITHOUT_KEY } from "../crypt/messages";
import { Search } from "../search/Search";
import { cancelUnlock, unlockArchive } from "../ipc/crypt";
import { Extractor } from "../extract/Extractor";
import { Writer } from "../write/Writer";

/** Row height of the file list, in pixels (must match `.vrow` in CSS). */
export const ROW_HEIGHT = 28;

function profileText(a: ArchiveSummary): string {
  const parts = ["Core"];
  if (a.profile.tar_compatible) parts.push("TAR-compatible");
  if (a.profile.encrypted) parts.push("Encrypted");
  if (a.profile.redundancy_percent !== null) {
    parts.push(`recovery record (${a.profile.redundancy_percent}% parity)`);
  }
  return parts.join(", ");
}

/** Retention wording for one commit. Unknown is said as unknown. */
function retentionText(c: CommitView): string {
  const notes: string[] = [];
  if (c.retained === null) notes.push("retention unknown");
  else if (c.expired) notes.push("expired");
  else if (!c.retained) notes.push("not retained");
  return notes.join(", ");
}

/** The snapshot timeline: every commit, newest first. */
function Timeline({
  commits,
  selected,
  onSelect,
}: {
  commits: CommitView[];
  selected: number;
  onSelect: (seq: number) => void;
}) {
  const head = commits.length - 1;
  return (
    <ol className="timeline" aria-label="Snapshots" data-testid="timeline" reversed>
      {[...commits].reverse().map((c) => (
        <li key={c.seq}>
          <button
            type="button"
            aria-current={c.seq === selected ? "true" : undefined}
            className={c.seq === selected ? "commit current" : "commit"}
            data-testid={`commit-${c.seq}`}
            onClick={() => onSelect(c.seq)}
          >
            <span className="seq">
              Commit {c.seq}
              {c.seq === head ? " (head)" : ""}
            </span>
            <span className="meta">
              {c.time ?? "no time recorded"} · {c.checkpoint ? "checkpoint" : "delta"}
            </span>
            {retentionText(c) && <span className="meta">{retentionText(c)}</span>}
            {c.holds.map((h) => (
              <span className="meta" key={h.text}>
                hold: <Name name={h} />
              </span>
            ))}
          </button>
        </li>
      ))}
    </ol>
  );
}

function Details({ details }: { details: EntryDetails }) {
  const a = details.attributes;
  return (
    <section aria-labelledby="details-heading" className="details" data-testid="details">
      <h3 id="details-heading">Details</h3>
      <dl>
        <dt>Path</dt>
        <dd data-testid="details-path">
          <Name name={details.path} />
        </dd>
        <dt>Kind</dt>
        <dd>{details.kind === "directory" ? "Folder" : "File"}</dd>
        {details.kind === "file" && (
          <>
            <dt>Size</dt>
            <dd>{formatSize(details.size)}</dd>
            <dt>Content hash (BLAKE3, as recorded)</dt>
            <dd className="hash">{details.content_hash}</dd>
          </>
        )}
        <dt>File version ID</dt>
        <dd className="hash">{details.file_version_id}</dd>
        {a.state === "recorded" ? (
          <>
            <dt>Permissions</dt>
            <dd>
              {a.posix
                ? `${formatMode(a.posix.mode)}, owner ${a.posix.uid}, group ${a.posix.gid}`
                : "not recorded"}
            </dd>
            <dt>Windows attributes</dt>
            <dd>{a.windows ? a.windows.join(", ") || "none set" : "not recorded"}</dd>
            <dt>Modified</dt>
            <dd>{a.mtime ?? "not recorded"}</dd>
          </>
        ) : (
          <>
            <dt>Attributes</dt>
            <dd role="note">
              Not available ({a.error.code}): {a.error.message}
            </dd>
          </>
        )}
      </dl>
      <p className="note">
        Browsing reads the archive's catalog, which was hash-checked when the snapshot was
        opened. It does not read or check file content.
      </p>
    </section>
  );
}

type Open = { archive: ArchiveSummary; snapshot: SnapshotView };

/** Plan D1: open an archive and browse its snapshots. Read-only. */
export function Browser() {
  const [open, setOpen] = useState<Open | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState<Crumb[]>([]);
  const [counted, setCounted] = useState<{ id: string; total: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [details, setDetails] = useState<EntryDetails | null>(null);
  const [waiting, setWaiting] = useState<{ pending: number; fileName: string } | null>(null);

  const handle = open?.archive.handle ?? null;
  const seq = open?.snapshot.seq ?? null;
  const dir = path.at(-1)?.key ?? null;
  const listingId = `${handle ?? ""}:${seq ?? ""}:${dir ?? ""}`;
  const total = counted?.id === listingId ? counted.total : null;

  const fail = useCallback((what: string) => (e: unknown) => setError(errorText(what, e)), []);
  const listError = useCallback((e: unknown) => setError(errorText("Could not list", e)), []);

  // The current directory's size, which the list needs before it pages.
  useEffect(() => {
    if (handle === null || seq === null) return;
    let live = true;
    listChildren(handle, seq, dir, false, 0, 1).then(
      (p) => {
        if (live) setCounted({ id: listingId, total: p.total });
      },
      (e: unknown) => {
        if (live) listError(e);
      },
    );
    return () => {
      live = false;
    };
  }, [handle, seq, dir, listingId, listError]);

  const loadPage = useCallback(
    (offset: number, limit: number) =>
      handle === null || seq === null
        ? Promise.resolve([])
        : listChildren(handle, seq, dir, false, offset, limit).then((p) => p.entries),
    [handle, seq, dir],
  );

  const navigate = useCallback((to: Crumb[]) => {
    setPath(to);
    setSelected(null);
    setDetails(null);
  }, []);

  const select = useCallback(
    (row: EntryRow) => {
      if (handle === null || seq === null) return;
      setSelected(row.key);
      entryDetails(handle, seq, row.key).then(setDetails, fail("Could not read details"));
    },
    [handle, seq, fail],
  );

  /** Show an archive that is open in Rust, replacing the one on screen. */
  const show = async (archive: ArchiveSummary) => {
    if (open) await closeArchive(open.archive.handle);
    const head = archive.commits[archive.commits.length - 1]?.seq ?? 0;
    const snapshot = await openSnapshot(archive.handle, head);
    setOpen({ archive, snapshot });
    navigate([]);
  };

  const doOpen = async () => {
    setError(null);
    setBusy(true);
    try {
      if (waiting) {
        await cancelUnlock(waiting.pending).catch(() => false);
        setWaiting(null);
      }
      const outcome = await openArchive();
      if (outcome === null) return;
      if (outcome.status === "needs_passphrase") {
        setWaiting({ pending: outcome.pending, fileName: outcome.file_name });
        return;
      }
      await show(outcome.archive);
    } catch (e) {
      setError(errorText("Could not open the archive", e));
    } finally {
      setBusy(false);
    }
  };

  /** The passphrase goes to Rust once; a wrong one leaves the prompt up. */
  const unlock = async (passphrase: string) => {
    if (!waiting) return;
    const archive = await unlockArchive(waiting.pending, passphrase);
    setWaiting(null);
    try {
      await show(archive);
    } catch (e) {
      setError(errorText("Could not open the archive", e));
    }
  };

  const giveUp = () => {
    if (waiting) void cancelUnlock(waiting.pending).catch(() => false);
    setWaiting(null);
  };

  /** A commit was published: show the archive as it now stands, at its head. */
  const adopt = useCallback(
    async (archive: ArchiveSummary | null) => {
      if (archive === null) return;
      try {
        const head = archive.commits[archive.commits.length - 1]?.seq ?? 0;
        const snapshot = await openSnapshot(archive.handle, head);
        if (open && open.archive.handle !== archive.handle) {
          await closeArchive(open.archive.handle).catch(() => false);
        }
        setOpen({ archive, snapshot });
        navigate([]);
      } catch (e) {
        setError(errorText("The commit was made, but the archive could not be shown", e));
      }
    },
    [open, navigate],
  );

  const doClose = async () => {
    if (!open) return;
    await closeArchive(open.archive.handle).catch(() => false);
    setOpen(null);
    setError(null);
    navigate([]);
  };

  const pickSnapshot = async (to: number) => {
    if (!open || to === open.snapshot.seq) return;
    setError(null);
    setBusy(true);
    try {
      const snapshot = await openSnapshot(open.archive.handle, to);
      setOpen({ ...open, snapshot });
      navigate([]);
    } catch (e) {
      setError(errorText(`Could not open commit ${to}`, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="browser-heading" className="browser">
      <h2 id="browser-heading">Archive</h2>
      <div className="actions">
        <button type="button" data-testid="open-archive" onClick={doOpen} disabled={busy}>
          Open archive…
        </button>
        <button type="button" data-testid="close-archive" onClick={doClose} disabled={!open || busy}>
          Close
        </button>
      </div>
      {error && (
        <p role="alert" className="error" data-testid="browse-error">
          {error}
        </p>
      )}
      {waiting && (
        <div className="panel" role="group" aria-label="Passphrase" data-testid="unlock-panel">
          <h3>
            <Name name={{ text: waiting.fileName, verbatim: true }} /> is encrypted
          </h3>
          <PassphraseForm
            testId="unlock"
            label="Passphrase"
            submitLabel="Open archive"
            onSubmit={unlock}
            onCancel={giveUp}
          >
            <EncryptionNotes creating={false} />
          </PassphraseForm>
        </div>
      )}
      <Writer
        archive={open?.archive ?? null}
        viewingHead={open !== null && open.snapshot.seq === (open.archive.commits.at(-1)?.seq ?? -1)}
        selected={details ? { key: details.key, name: details.path } : null}
        onCommitted={(a) => void adopt(a)}
      />
      <Extractor
        archive={open?.archive ?? null}
        seq={open?.snapshot.seq ?? null}
        selected={details ? { key: details.key, name: details.path } : null}
      />
      <Search archive={open?.archive ?? null} />
      <Rekey
        key={open?.archive.handle ?? "none"}
        archive={open?.archive ?? null}
        onChanged={(a) => {
          if (a === null) void doClose();
          else void adopt(a);
        }}
      />
      <Checker archive={open?.archive ?? null} />
      {!open && !error && <p data-testid="browse-empty">No archive is open.</p>}
      {open && (
        <>
          <p className="archive-meta" data-testid="archive-meta">
            <strong>{open.archive.file_name}</strong> · {profileText(open.archive)} ·{" "}
            {open.archive.commits.length} commit{open.archive.commits.length === 1 ? "" : "s"} ·
            archive ID <span className="hash">{open.archive.archive_id}</span>
          </p>
          {open.archive.profile.encrypted && (
            <details className="note" data-testid="encrypted-note">
              <summary>Encrypted archive: what is sealed and what stays visible</summary>
              <p>{HIDDEN_WITH_KEY}</p>
              <p>Visible to anyone who has the file, without the passphrase:</p>
              <ul>
                {VISIBLE_WITHOUT_KEY.map((v) => (
                  <li key={v}>{v}</li>
                ))}
              </ul>
              <p>{NOT_SIGNED}</p>
            </details>
          )}
          {open.archive.retention_error && (
            <p role="note" className="warning">
              Retention could not be determined ({open.archive.retention_error.code}):{" "}
              {open.archive.retention_error.message}
            </p>
          )}
          {open.snapshot.catalog_source.source === "snapshot_manifest" && (
            <p role="note" className="warning" data-testid="catalog-note">
              This commit's catalog image is damaged; the listing was rebuilt from the same
              commit's snapshot manifest ({open.snapshot.catalog_source.image_error.code}).
            </p>
          )}
          <div className="panes">
            <Timeline
              commits={open.archive.commits}
              selected={open.snapshot.seq}
              onSelect={(s) => void pickSnapshot(s)}
            />
            <Tree
              key={`${open.archive.handle}:${open.snapshot.seq}`}
              handle={open.archive.handle}
              seq={open.snapshot.seq}
              current={dir}
              onOpen={navigate}
              onError={listError}
            />
            <div className="listing">
              <nav aria-label="Current folder" className="crumbs" data-testid="crumbs">
                <button type="button" className="link" onClick={() => navigate([])}>
                  Commit {open.snapshot.seq}
                </button>
                {path.map((c, i) => (
                  <span key={c.key}>
                    {" / "}
                    <button type="button" className="link" onClick={() => navigate(path.slice(0, i + 1))}>
                      <Name name={c.name} />
                    </button>
                  </span>
                ))}
              </nav>
              <p className="count" data-testid="entry-count">
                {total === null
                  ? "Loading…"
                  : `${total.toLocaleString("en-US")} ${total === 1 ? "entry" : "entries"} in this folder; ${open.snapshot.entries.toLocaleString("en-US")} in the snapshot`}
              </p>
              {total !== null && (
                <VirtualList
                  key={listingId}
                  total={total}
                  rowHeight={ROW_HEIGHT}
                  loadPage={loadPage}
                  label="Folder contents"
                  testId="entries"
                  onError={listError}
                  renderRow={(row: EntryRow) => (
                    <button
                      type="button"
                      className={row.key === selected ? "entry selected" : "entry"}
                      data-testid="entry"
                      data-kind={row.kind}
                      aria-pressed={row.key === selected}
                      onClick={() => select(row)}
                      onDoubleClick={() => {
                        if (row.kind === "directory") navigate([...path, { key: row.key, name: row.name }]);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && row.kind === "directory") {
                          e.preventDefault();
                          navigate([...path, { key: row.key, name: row.name }]);
                        }
                      }}
                    >
                      <span className="kind" aria-label={row.kind === "directory" ? "Folder" : "File"}>
                        {row.kind === "directory" ? "▣" : "▢"}
                      </span>
                      <span className="entry-name">
                        <Name name={row.name} />
                      </span>
                      <span className="size">
                        {row.kind === "directory"
                          ? `${(row.child_dirs + row.child_files).toLocaleString("en-US")} items`
                          : shortSize(row.size)}
                      </span>
                    </button>
                  )}
                />
              )}
            </div>
            {details && <Details details={details} />}
          </div>
        </>
      )}
    </section>
  );
}
