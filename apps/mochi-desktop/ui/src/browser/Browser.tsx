import { useCallback, useEffect, useRef, useState } from "react";

import { Panel } from "../a11y/Panel";
import { t, tn } from "../i18n";

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
import { watchLaunches } from "../ipc/launch";
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
  const parts = [t("browser.profileCore")];
  if (a.profile.tar_compatible) parts.push(t("browser.profileTar"));
  if (a.profile.encrypted) parts.push(t("browser.profileEncrypted"));
  if (a.profile.redundancy_percent !== null) {
    parts.push(t("browser.profileRecovery", { percent: a.profile.redundancy_percent }));
  }
  return parts.join(", ");
}

/** Retention wording for one commit. Unknown is said as unknown. */
function retentionText(c: CommitView): string {
  const notes: string[] = [];
  if (c.retained === null) notes.push(t("browser.retentionUnknown"));
  else if (c.expired) notes.push(t("browser.retentionExpired"));
  else if (!c.retained) notes.push(t("browser.retentionNotRetained"));
  return notes.join(t("browser.retentionSeparator"));
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
    <ol className="timeline" aria-label={t("browser.timeline")} data-testid="timeline" reversed>
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
              {t(c.seq === head ? "browser.commitHead" : "browser.commit", { seq: c.seq })}
            </span>
            <span className="meta">
              {c.time ?? t("browser.noTime")}
              {t("browser.metaSeparator")}
              {c.checkpoint ? t("browser.checkpoint") : t("browser.delta")}
            </span>
            {retentionText(c) && <span className="meta">{retentionText(c)}</span>}
            {c.holds.map((h) => (
              <span className="meta" key={h.text}>
                {t("browser.hold")}
                <Name name={h} />
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
      <h3 id="details-heading">{t("browser.details")}</h3>
      <dl>
        <dt>{t("browser.detailPath")}</dt>
        <dd data-testid="details-path">
          <Name name={details.path} />
        </dd>
        <dt>{t("browser.detailKind")}</dt>
        <dd>{details.kind === "directory" ? t("common.folder") : t("common.file")}</dd>
        {details.kind === "file" && (
          <>
            <dt>{t("browser.detailSize")}</dt>
            <dd>{formatSize(details.size)}</dd>
            <dt>{t("browser.detailHash")}</dt>
            <dd className="hash">{details.content_hash}</dd>
          </>
        )}
        <dt>{t("browser.detailVersionId")}</dt>
        <dd className="hash">{details.file_version_id}</dd>
        {a.state === "recorded" ? (
          <>
            <dt>{t("browser.detailPermissions")}</dt>
            <dd>
              {a.posix
                ? t("browser.detailPosix", {
                    mode: formatMode(a.posix.mode),
                    uid: a.posix.uid,
                    gid: a.posix.gid,
                  })
                : t("browser.detailNotRecorded")}
            </dd>
            <dt>{t("browser.detailWindows")}</dt>
            <dd>{a.windows ? a.windows.join(", ") || t("browser.detailNoneSet") : t("browser.detailNotRecorded")}</dd>
            <dt>{t("browser.detailModified")}</dt>
            <dd>{a.mtime ?? t("browser.detailNotRecorded")}</dd>
          </>
        ) : (
          <>
            <dt>{t("browser.detailAttributes")}</dt>
            <dd role="note">
              {t("browser.detailAttributesError", { code: a.error.code, message: a.error.message })}
            </dd>
          </>
        )}
      </dl>
      <p className="note">{t("browser.detailsNote")}</p>
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
  // Set when the shell asked to extract (D6): the Extractor then shows its plan.
  // Set when a folder was opened from the list by key or double click, so the
  // new listing takes keyboard focus instead of dropping it on the page.
  const [focusList, setFocusList] = useState(false);
  const [autoExtract, setAutoExtract] = useState<{ token: number; handle: number } | null>(null);

  const handle = open?.archive.handle ?? null;
  const seq = open?.snapshot.seq ?? null;
  const dir = path.at(-1)?.key ?? null;
  const listingId = `${handle ?? ""}:${seq ?? ""}:${dir ?? ""}`;
  const total = counted?.id === listingId ? counted.total : null;

  const fail = useCallback((what: string) => (e: unknown) => setError(errorText(what, e)), []);
  const listError = useCallback((e: unknown) => setError(errorText(t("browser.listFailed"), e)), []);

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

  const navigate = useCallback((to: Crumb[], fromList = false) => {
    setFocusList(fromList);
    setPath(to);
    setSelected(null);
    setDetails(null);
  }, []);

  const select = useCallback(
    (row: EntryRow) => {
      if (handle === null || seq === null) return;
      setSelected(row.key);
      entryDetails(handle, seq, row.key).then(setDetails, fail(t("browser.detailsFailed")));
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
      setError(errorText(t("browser.openFailed"), e));
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
      setError(errorText(t("browser.openFailed"), e));
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
        setError(errorText(t("browser.adoptFailed"), e));
      }
    },
    [open, navigate],
  );

  // The shell opened an archive, or could not (D6). Rust has done the opening
  // and chosen any extract folder; this only shows the result. The listener is
  // registered once and reads the latest handlers through a ref.
  type Launched = (archive: ArchiveSummary, extract: boolean) => Promise<void>;
  const launchedRef = useRef<Launched | null>(null);
  // The handle on screen, kept current between renders: two launches in quick
  // succession must each close the archive the one before opened.
  const shownRef = useRef<number | null>(null);
  const showLaunched: Launched = async (archive, extract) => {
    setError(null);
    try {
      const head = archive.commits[archive.commits.length - 1]?.seq ?? 0;
      const snapshot = await openSnapshot(archive.handle, head);
      const previous = shownRef.current;
      shownRef.current = archive.handle;
      if (previous !== null && previous !== archive.handle) {
        await closeArchive(previous).catch(() => false);
      }
      setOpen({ archive, snapshot });
      navigate([]);
      if (extract) setAutoExtract((a) => ({ token: (a?.token ?? 0) + 1, handle: archive.handle }));
    } catch (e) {
      setError(errorText(t("browser.openFailed"), e));
    }
  };
  useEffect(() => {
    launchedRef.current = showLaunched;
    shownRef.current = open?.archive.handle ?? null;
  });
  useEffect(() => {
    watchLaunches((event) => {
      if (event.event === "problem") setError(event.message);
      else void launchedRef.current?.(event.archive, event.extract);
    }).catch(() => undefined);
  }, []);

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
      setError(errorText(t("browser.openCommitFailed", { seq: to }), e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="browser-heading" className="browser">
      <h2 id="browser-heading" tabIndex={-1}>
        {t("browser.heading")}
      </h2>
      <div className="actions">
        <button type="button" data-testid="open-archive" onClick={doOpen} disabled={busy}>
          {t("browser.open")}
        </button>
        <button type="button" data-testid="close-archive" onClick={doClose} disabled={!open || busy}>
          {t("browser.close")}
        </button>
      </div>
      {error && (
        <p role="alert" className="error" data-testid="browse-error">
          {error}
        </p>
      )}
      {waiting && (
        <Panel
          label={t("browser.passphraseGroup")}
          testId="unlock-panel"
          fallbackId="browser-heading"
          heading={t("browser.isEncrypted", { name: waiting.fileName })}
        >
          <PassphraseForm
            testId="unlock"
            label={t("browser.unlockLabel")}
            submitLabel={t("browser.unlockSubmit")}
            onSubmit={unlock}
            onCancel={giveUp}
          >
            <EncryptionNotes creating={false} />
          </PassphraseForm>
        </Panel>
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
        autoPlan={autoExtract}
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
      {!open && !error && <p data-testid="browse-empty">{t("browser.empty")}</p>}
      {open && (
        <>
          <p className="archive-meta" data-testid="archive-meta">
            <strong>{open.archive.file_name}</strong>
            {t("browser.metaSeparator")}
            {profileText(open.archive)}
            {t("browser.metaSeparator")}
            {tn(open.archive.commits.length, "browser.metaCommitOne", "browser.metaCommitMany", {
              n: open.archive.commits.length,
            })}
            {t("browser.metaSeparator")}
            {t("browser.metaArchiveId")} <span className="hash">{open.archive.archive_id}</span>
          </p>
          {open.archive.profile.encrypted && (
            <details className="note" data-testid="encrypted-note">
              <summary>{t("browser.encryptedSummary")}</summary>
              <p>{HIDDEN_WITH_KEY}</p>
              <p>{t("browser.visibleWithoutKeyIntro")}</p>
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
              {t("browser.retentionError", {
                code: open.archive.retention_error.code,
                message: open.archive.retention_error.message,
              })}
            </p>
          )}
          {open.snapshot.catalog_source.source === "snapshot_manifest" && (
            <p role="note" className="warning" data-testid="catalog-note">
              {t("browser.catalogRebuilt", { code: open.snapshot.catalog_source.image_error.code })}
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
              <nav aria-label={t("browser.currentFolder")} className="crumbs" data-testid="crumbs">
                <button type="button" className="link" onClick={() => navigate([])}>
                  {t("browser.commit", { seq: open.snapshot.seq })}
                </button>
                {path.map((c, i) => (
                  <span key={c.key}>
                    {t("common.nameSeparator")}
                    <button type="button" className="link" onClick={() => navigate(path.slice(0, i + 1))}>
                      <Name name={c.name} />
                    </button>
                  </span>
                ))}
              </nav>
              <p className="count" data-testid="entry-count" id="entry-count">
                {total === null
                  ? t("common.loading")
                  : t("browser.entryCount", {
                      total: total.toLocaleString("en-US"),
                      noun: t(total === 1 ? "common.entryOne" : "common.entryMany"),
                      snapshot: open.snapshot.entries.toLocaleString("en-US"),
                    })}
              </p>
              {total !== null && (
                <VirtualList
                  key={listingId}
                  total={total}
                  rowHeight={ROW_HEIGHT}
                  loadPage={loadPage}
                  label={t("browser.folderContents")}
                  hintId="entry-hint"
                  focusFirst={focusList}
                  testId="entries"
                  onError={listError}
                  renderRow={(row: EntryRow, _index: number, tabIndex: 0 | -1) => (
                    <button
                      type="button"
                      className={row.key === selected ? "entry selected" : "entry"}
                      data-testid="entry"
                      data-kind={row.kind}
                      aria-pressed={row.key === selected}
                      tabIndex={tabIndex}
                      onClick={() => select(row)}
                      onDoubleClick={() => {
                        if (row.kind === "directory") navigate([...path, { key: row.key, name: row.name }], true);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && row.kind === "directory") {
                          e.preventDefault();
                          navigate([...path, { key: row.key, name: row.name }], true);
                        }
                      }}
                    >
                      <span className="kind" aria-label={row.kind === "directory" ? t("common.folder") : t("common.file")}>
                        {row.kind === "directory" ? "▣" : "▢"}
                      </span>
                      <span className="entry-name">
                        <Name name={row.name} />
                      </span>
                      <span className="size">
                        {row.kind === "directory"
                          ? t("browser.itemsCount", { n: (row.child_dirs + row.child_files).toLocaleString("en-US") })
                          : shortSize(row.size)}
                      </span>
                    </button>
                  )}
                />
              )}
              <p className="note" id="entry-hint">
                {t("browser.listHint")}
              </p>
            </div>
            {details && <Details details={details} />}
          </div>
        </>
      )}
    </section>
  );
}
