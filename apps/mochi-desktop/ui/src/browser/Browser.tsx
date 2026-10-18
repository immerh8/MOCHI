import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Panel } from "../a11y/Panel";
import { BackIcon, FolderIcon, SearchIcon } from "../icons";
import { t, tc, tn } from "../i18n";

import {
  closeArchive,
  entryDetails,
  listChildren,
  openArchive,
  openSnapshot,
} from "../ipc/browse";
import type {
  ArchiveSummary,
  OpenOutcome,
  CommitView,
  EntryDetails,
  EntryRow,
  SnapshotView,
} from "../ipc/browse";
import { subscribeLaunches } from "../ipc/launch";
import { forgetRecentArchives, openDroppedArchive, openRecent, recentArchives } from "../ipc/start";
import type { RecentView } from "../ipc/start";
import { Start } from "../start/Start";
import { errorText, formatMode, formatSize, shortSize } from "./format";
import { ListHead, EntryCells } from "./ListHead";
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

/** Row height of the file list, in pixels. */
export const ROW_HEIGHT = 40;

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
            <span className="meta">{c.time ?? t("browser.noTime")}</span>
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
          </>
        )}
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
      <details className="technical" data-testid="details-technical">
        <summary>{t("start.technical")}</summary>
        <dl>
          {details.kind === "file" && (
            <>
              <dt>{t("browser.detailHash")}</dt>
              <dd className="hash">{details.content_hash}</dd>
            </>
          )}
          <dt>{t("browser.detailVersionId")}</dt>
          <dd className="hash">{details.file_version_id}</dd>
        </dl>
      </details>
      <p className="note">{t("browser.detailsNote")}</p>
    </section>
  );
}

type Open = { archive: ArchiveSummary; snapshot: SnapshotView };

/** Plan D1: open an archive and browse its snapshots. Read-only. */
export function Browser({ toolsNav, tools }: { toolsNav?: ReactNode; tools?: ReactNode }) {
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
  const [autoExtract, setAutoExtract] = useState<{
    token: number;
    handle: number;
    defaultFolder?: boolean;
  } | null>(null);
  const [recents, setRecents] = useState<RecentView[]>([]);
  const [createRequest, setCreateRequest] = useState(0);
  const [creating, setCreating] = useState(false);
  const [extractAfterUnlock, setExtractAfterUnlock] = useState(false);

  const refreshRecents = useCallback(() => {
    recentArchives().then(setRecents, () => setRecents([]));
  }, []);
  useEffect(() => {
    if (open === null) refreshRecents();
  }, [open, refreshRecents]);

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

  /** Wait for the user's choice of archive, then show it (and plan an extract if asked). */
  const openWith = async (get: () => Promise<OpenOutcome | null>, extract: boolean, what: string) => {
    setError(null);
    setBusy(true);
    try {
      if (waiting) {
        await cancelUnlock(waiting.pending).catch(() => false);
        setWaiting(null);
      }
      const outcome = await get();
      if (outcome === null) return;
      if (outcome.status === "needs_passphrase") {
        setWaiting({ pending: outcome.pending, fileName: outcome.file_name });
        setExtractAfterUnlock(extract);
        return;
      }
      await show(outcome.archive);
      if (extract) {
        setAutoExtract((a) => ({
          token: (a?.token ?? 0) + 1,
          handle: outcome.archive.handle,
          defaultFolder: true,
        }));
      }
    } catch (e) {
      setError(errorText(what, e));
    } finally {
      setBusy(false);
    }
  };

  const doOpen = (extract = false) => openWith(openArchive, extract, t("browser.openFailed"));
  const doOpenRecent = (index: number) =>
    openWith(() => openRecent(index), false, t("start.openRecentFailed"));
  const doOpenDropped = () => openWith(openDroppedArchive, false, t("start.openDroppedFailed"));
  /** The passphrase goes to Rust once; a wrong one leaves the prompt up. */
  const unlock = async (passphrase: string) => {
    if (!waiting) return;
    const archive = await unlockArchive(waiting.pending, passphrase);
    setWaiting(null);
    try {
      await show(archive);
      if (extractAfterUnlock) {
        setAutoExtract((a) => ({ token: (a?.token ?? 0) + 1, handle: archive.handle, defaultFolder: true }));
      }
    } catch (e) {
      setError(errorText(t("browser.openFailed"), e));
    }
  };

  const giveUp = () => {
    if (waiting) void cancelUnlock(waiting.pending).catch(() => false);
    setWaiting(null);
    setExtractAfterUnlock(false);
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
  useEffect(
    () =>
      subscribeLaunches((event) => {
        if (event.event === "problem") setError(event.message);
        else if (event.event === "opened") void launchedRef.current?.(event.archive, event.extract);
        // Foreign archives are the foreign browser's to show.
      }),
    [],
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
      setError(errorText(t("browser.openCommitFailed", { seq: to }), e));
    } finally {
      setBusy(false);
    }
  };

  // The gear on the start screen and the search button in the archive's top
  // bar: open the Advanced area and land on that section's heading, as the
  // section buttons do (a closed disclosure cannot take focus).
  const advancedRef = useRef<HTMLDetailsElement>(null);
  const showAdvanced = (headingId: string) => {
    if (advancedRef.current) advancedRef.current.open = true;
    const heading = document.getElementById(headingId);
    heading?.focus();
    heading?.scrollIntoView?.({ block: "start" });
  };
  const showSettings = () => showAdvanced("settings-heading");
  const showSearch = () => showAdvanced("search-heading");

  const showStart = open === null && !creating && waiting === null;

  // The start screen steps aside while the create panel is open; when the
  // panel closes without an archive, keyboard focus goes back to its button.
  const wasCreatingRef = useRef(false);
  useEffect(() => {
    if (wasCreatingRef.current && !creating && open === null) {
      document.querySelector<HTMLElement>('[data-testid="start-create"]')?.focus();
    }
    wasCreatingRef.current = creating;
  }, [creating, open]);

  return (
    <section aria-labelledby="browser-heading" className="browser">
      <h2 id="browser-heading" tabIndex={-1} className={showStart || open ? "sr-only" : undefined}>
        {open ? t("browser.heading") : t("start.heading")}
      </h2>
      {open && (
        <div className="browser-bar">
          <button
            type="button"
            className="icon-button"
            data-testid="close-archive"
            aria-label={t("browser.close")}
            title={t("browser.back")}
            onClick={doClose}
            disabled={busy}
          >
            <BackIcon />
          </button>
          <div className="bar-text" data-testid="archive-meta">
            <strong className="bar-title">{open.archive.file_name}</strong>
            <span className="sr-only">{t("browser.metaSeparator")}</span>
            <span className="bar-sub">
              {tn(open.archive.commits.length, "browser.metaCommitOne", "browser.metaCommitMany", {
                n: open.archive.commits.length,
              })}
              {t("browser.metaSeparator")}
              {tc(open.snapshot.entries, "count.entryOne", "count.entryMany")}
              {open.archive.profile.encrypted && (
                <>
                  {t("browser.metaSeparator")}
                  {t("browser.profileEncrypted")}
                </>
              )}
            </span>
          </div>
          <div className="bar-actions">
            <button
              type="button"
              className="icon-button"
              data-testid="search-archive"
              aria-label={t("browser.search")}
              title={t("browser.search")}
              onClick={showSearch}
            >
              <SearchIcon />
            </button>
            <button
              type="button"
              className="icon-button"
              data-testid="open-archive"
              aria-label={t("browser.open")}
              title={t("browser.open")}
              onClick={() => void doOpen()}
              disabled={busy}
            >
              <FolderIcon />
            </button>
          </div>
        </div>
      )}
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
      {showStart && (
        <Start
          busy={busy}
          recents={recents}
          onCreate={() => setCreateRequest((n) => n + 1)}
          onOpen={() => void doOpen()}
          onExtract={() => void doOpen(true)}
          onOpenRecent={(i) => void doOpenRecent(i)}
          onForgetRecent={() => {
            forgetRecentArchives().then(refreshRecents, refreshRecents);
          }}
          onSettings={showSettings}
        />
      )}
      <Writer
        archive={open?.archive ?? null}
        viewingHead={open !== null && open.snapshot.seq === (open.archive.commits.at(-1)?.seq ?? -1)}
        selected={details ? { key: details.key, name: details.path } : null}
        onCommitted={(a) => void adopt(a)}
        showToolbar={open !== null}
        createRequest={createRequest}
        onCreating={setCreating}
        onArchiveDropped={() => void doOpenDropped()}
      />
      {open && (
        <>
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
            <div className="listing">
              <div className="listing-head">
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
              </div>
              {total !== null && (
                <VirtualList
                  key={listingId}
                  total={total}
                  rowHeight={ROW_HEIGHT}
                  loadPage={loadPage}
                  label={t("browser.folderContents")}
                  head={<ListHead />}
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
                      <EntryCells
                        kind={row.kind}
                        name={row.name}
                        kindLabel={row.kind === "directory" ? t("common.folder") : t("common.file")}
                        size={
                          row.kind === "directory"
                            ? t("browser.itemsCount", {
                                n: (row.child_dirs + row.child_files).toLocaleString("en-US"),
                              })
                            : shortSize(row.size)
                        }
                      />
                    </button>
                  )}
                />
              )}
              <p className="note" id="entry-hint">
                {t("browser.listHint")}
              </p>
            </div>
            <Extractor
              archive={open.archive}
              seq={open.snapshot.seq}
              selected={details ? { key: details.key, name: details.path } : null}
              autoPlan={autoExtract}
            />
            <div className="side">
              <div className="pane">
                <p className="pane-title" aria-hidden="true">
                  {t("browser.paneFolders")}
                </p>
                <Tree
                  key={`${open.archive.handle}:${open.snapshot.seq}`}
                  handle={open.archive.handle}
                  seq={open.snapshot.seq}
                  current={dir}
                  onOpen={navigate}
                  onError={listError}
                />
              </div>
              <div className="pane">
                <p className="pane-title" aria-hidden="true">
                  {t("browser.paneVersions")}
                </p>
                <Timeline
                  commits={open.archive.commits}
                  selected={open.snapshot.seq}
                  onSelect={(s) => void pickSnapshot(s)}
                />
              </div>
              {details && <Details details={details} />}
            </div>
          </div>
          <details className="technical" data-testid="archive-technical">
            <summary>{t("start.technical")}</summary>
            <p data-testid="archive-technical-text">
              {profileText(open.archive)}
              {t("browser.metaSeparator")}
              {t("browser.metaArchiveId")} <span className="hash">{open.archive.archive_id}</span>
            </p>
            <ul>
              {open.archive.commits.map((c) => (
                <li key={c.seq}>
                  {t("browser.commitTechnical", { seq: c.seq })}
                  {t("browser.metaSeparator")}
                  {c.checkpoint ? t("browser.checkpoint") : t("browser.delta")}
                </li>
              ))}
            </ul>
          </details>
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
        </>
      )}
      <details className="advanced" data-testid="advanced" ref={advancedRef}>
        <summary>{t("start.advanced")}</summary>
        <p className="note">{t("start.advancedHint")}</p>
        {toolsNav}
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
        {tools}
      </details>
    </section>
  );
}
