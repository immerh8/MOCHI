import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Panel } from "../a11y/Panel";
import {
  ActivityIcon,
  BackIcon,
  CaretDownIcon,
  CheckIcon,
  CloseIcon,
  ExtractIcon,
  FoldersIcon,
  GearIcon,
  HelpIcon,
  InfoIcon,
  KeyIcon,
  MoreIcon,
  OpenIcon,
  PlusIcon,
  TrashIcon,
  WrenchIcon,
} from "../icons";
import { t, tc, tn } from "../i18n";

import { closeArchive, entryDetails, listChildren, openArchive, openSnapshot } from "../ipc/browse";
import type {
  ArchiveSummary,
  OpenOutcome,
  CommitView,
  EntryDetails,
  EntryRow,
  NameText,
  SnapshotView,
} from "../ipc/browse";
import { dragOut } from "../ipc/dragout";
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
import { useDragOut } from "../list/dragOut";
import { ancestorsOf } from "../list/keys";
import { useSelection } from "../list/selection";
import type { Selection } from "../list/selection";
import { listKeys, rowHandlers } from "../list/rows";
import { SearchBox } from "../search/SearchBox";
import { SearchResults } from "../search/SearchResults";
import type { HitRow } from "../search/SearchResults";
import { useArchiveSearch } from "../search/useArchiveSearch";
import { cancelUnlock, unlockArchive } from "../ipc/crypt";
import { Extractor } from "../extract/Extractor";
import { Writer } from "../write/Writer";
import { SlotHost, ShellContext, ToolButton, ToolSlot } from "../shell/Shell";
import type { Shell, SlotName } from "../shell/Shell";
import { ToolSheet } from "../shell/ToolSheet";
import type { ToolId } from "../shell/ToolSheet";

/** Row height of the file list, in pixels. */
export const ROW_HEIGHT = 26;

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
      <h3 id="details-heading">
        <Name name={details.path} />
      </h3>
      <dl>
        <dt className="sr-only">{t("browser.detailPath")}</dt>
        <dd className="sr-only" data-testid="details-path">
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
            <dt>{t("browser.detailModified")}</dt>
            <dd>{a.mtime ?? t("browser.detailNotRecorded")}</dd>
            {a.posix && (
              <>
                <dt>{t("browser.detailPermissions")}</dt>
                <dd>
                  {t("browser.detailPosix", {
                    mode: formatMode(a.posix.mode),
                    uid: a.posix.uid,
                    gid: a.posix.gid,
                  })}
                </dd>
              </>
            )}
            {a.windows && (
              <>
                <dt>{t("browser.detailWindows")}</dt>
                <dd>{a.windows.join(", ") || t("browser.detailNoneSet")}</dd>
              </>
            )}
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
    </section>
  );
}

type Open = { archive: ArchiveSummary; snapshot: SnapshotView };

/** An entry the list can select: a folder row or a search hit. */
export type Picked = { key: string; name: NameText };

/** Plan D1: open an archive and browse its snapshots. Read-only. */
export function Browser({
  foreign,
  tools,
  help,
}: {
  /** The foreign-archive browser (D8); it draws into the stage slot. */
  foreign?: ReactNode;
  /** The tools the More menu opens, by id ("settings", "selfTest"). */
  tools?: Partial<Record<ToolId, ReactNode>>;
  help?: ReactNode;
}) {
  const [open, setOpen] = useState<Open | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState<Crumb[]>([]);
  const [counted, setCounted] = useState<{ id: string; total: number } | null>(null);
  const [shownDetails, setShownDetails] = useState<{ id: string; details: EntryDetails } | null>(null);
  const [waiting, setWaiting] = useState<{ pending: number; fileName: string } | null>(null);
  // Set when a folder was opened from the list by key or double click, so the
  // new listing takes keyboard focus instead of dropping it on the page.
  const [focusList, setFocusList] = useState(false);
  // Set when the shell asked to extract (D6): the Extractor then shows its plan.
  const [autoExtract, setAutoExtract] = useState<{
    token: number;
    handle: number;
    defaultFolder?: boolean;
  } | null>(null);
  const [recents, setRecents] = useState<RecentView[]>([]);
  const [createRequest, setCreateRequest] = useState(0);
  const [removeRequest, setRemoveRequest] = useState(0);
  const [creating, setCreating] = useState(false);
  const [extractAfterUnlock, setExtractAfterUnlock] = useState(false);
  // The window around the list (toolbar, panels that open and close).
  const [infoOpen, setInfoOpen] = useState(false);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [foldersShown, setFoldersShown] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [tool, setTool] = useState<ToolId | null>(null);
  const [foreignOpen, setForeignOpen] = useState(false);
  const [closeForeignToken, setCloseForeignToken] = useState(0);
  const [openForeignToken, setOpenForeignToken] = useState(0);
  const [testRequest, setTestRequest] = useState(0);
  const [query, setQuery] = useState("");
  const [clearSearch, setClearSearch] = useState(0);
  const [slots, setSlots] = useState<Partial<Record<SlotName, HTMLElement>>>({});
  const register = useCallback((name: SlotName, el: HTMLElement | null) => {
    setSlots((prev) => {
      // A slot element lives as long as the window; an unmount needs no undo.
      if (el === null || prev[name] === el) return prev;
      return { ...prev, [name]: el };
    });
  }, []);
  const clearQuery = useCallback(() => setClearSearch((n) => n + 1), []);

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

  // What the toolbar's search found in the snapshot on screen.
  const searching = open !== null && !foreignOpen && query !== "";
  const search = useArchiveSearch(searching ? handle : null, seq, query);
  const hits = useMemo(() => (search.state === "done" ? search.hits : []), [search]);
  const loadHits = useCallback(
    (offset: number, limit: number) => Promise.resolve(hits.slice(offset, offset + limit)),
    [hits],
  );

  const folderSel = useSelection<EntryRow>(loadPage, listError);
  const hitSel = useSelection<HitRow>(loadHits, listError);
  const selected: Picked[] = (searching ? hitSel.rows : folderSel.rows).flatMap((r) =>
    r.key === null ? [] : [{ key: r.key, name: r.name }],
  );
  const focusKey = (searching ? hitSel.focus : folderSel.focus)?.key ?? null;
  const clearFolderSel = folderSel.clear;
  const clearHitSel = hitSel.clear;

  const navigate = useCallback(
    (to: Crumb[], fromList = false) => {
      setFocusList(fromList);
      setPath(to);
      clearFolderSel();
    },
    [clearFolderSel],
  );

  // A new search, or none, starts with nothing selected among the hits.
  useEffect(() => {
    clearHitSel();
  }, [search, clearHitSel]);

  // The Info panel shows the entry clicked last.
  const detailsId = `${handle ?? ""}:${seq ?? ""}:${focusKey ?? ""}`;
  const details = shownDetails?.id === detailsId ? shownDetails.details : null;
  useEffect(() => {
    if (handle === null || seq === null || focusKey === null) return;
    let live = true;
    entryDetails(handle, seq, focusKey).then(
      (d) => {
        if (live) setShownDetails({ id: `${handle}:${seq}:${focusKey}`, details: d });
      },
      (e: unknown) => {
        if (live) fail(t("browser.detailsFailed"))(e);
      },
    );
    return () => {
      live = false;
    };
  }, [handle, seq, focusKey, fail]);

  /** Show an archive that is open in Rust, replacing the one on screen. */
  const show = async (archive: ArchiveSummary) => {
    setCloseForeignToken((n) => n + 1);
    if (open) await closeArchive(open.archive.handle);
    const head = archive.commits[archive.commits.length - 1]?.seq ?? 0;
    const snapshot = await openSnapshot(archive.handle, head);
    setOpen({ archive, snapshot });
    clearQuery();
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
    clearQuery();
    navigate([]);
  };

  const pickSnapshot = async (to: number) => {
    if (!open || to === open.snapshot.seq) return;
    setError(null);
    setBusy(true);
    try {
      const snapshot = await openSnapshot(open.archive.handle, to);
      setOpen({ ...open, snapshot });
      clearQuery();
      navigate([]);
    } catch (e) {
      setError(errorText(t("browser.openCommitFailed", { seq: to }), e));
    } finally {
      setBusy(false);
    }
  };

  // The More menu's tools open in a window over the list, one at a time.
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const showTool = (id: ToolId) => {
    setMoreOpen(false);
    setTool(id);
  };
  const doTest = () => {
    showTool("check");
    setTestRequest((n) => n + 1);
  };

  const showStart = open === null && !creating && waiting === null && !foreignOpen;
  const active = foreignOpen ? "foreign" : "mochi";
  const canInspect = open !== null || foreignOpen;

  // The start screen steps aside while the create panel is open; when the
  // panel closes without an archive, keyboard focus goes back to its button.
  const wasCreatingRef = useRef(false);
  useEffect(() => {
    if (wasCreatingRef.current && !creating && open === null) {
      document.querySelector<HTMLElement>('[data-testid="start-create"]')?.focus();
    }
    wasCreatingRef.current = creating;
  }, [creating, open]);

  // The version list and the More menu close on Escape and when the pointer
  // goes down outside them.
  const moreRef = useRef<HTMLDivElement>(null);
  const versionsRef = useRef<HTMLDivElement>(null);
  const versionsButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // A choice closes the menu. Some items are drawn into it from other components
  // (a portal), whose clicks do not bubble through this element in React's tree, so
  // this listens on the element itself.
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const onChoice = (e: Event) => {
      if (e.target instanceof Element && e.target.closest("button")) {
        moreButtonRef.current?.focus();
        setMoreOpen(false);
      }
    };
    menu.addEventListener("click", onChoice, true);
    return () => menu.removeEventListener("click", onChoice, true);
  }, []);
  useEffect(() => {
    if (!moreOpen && !versionsOpen) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target instanceof Node ? e.target : null;
      if (moreOpen && !moreRef.current?.contains(target)) setMoreOpen(false);
      // The versions button is outside the list; its own press toggles it.
      if (versionsOpen && !versionsRef.current?.contains(target) && !versionsButtonRef.current?.contains(target)) {
        setVersionsOpen(false);
      }
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (moreOpen) moreButtonRef.current?.focus();
      setMoreOpen(false);
      setVersionsOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen, versionsOpen]);

  // Desktop keys: Ctrl+F finds, Ctrl+O opens.
  const openRef = useRef(doOpen);
  useEffect(() => {
    openRef.current = doOpen;
  });
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key === "f" || e.key === "F") {
        const field = document.querySelector<HTMLInputElement>('[data-testid="search-query"]');
        if (field && !field.disabled) {
          e.preventDefault();
          field.focus();
          field.select();
        }
      } else if (e.key === "o" || e.key === "O") {
        e.preventDefault();
        void openRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const shell: Shell = {
    active,
    register,
    slots,
    setForeignOpen,
    closeForeignToken,
    openForeignToken,
    infoOpen,
    query,
    clearQuery,
  };

  // Drag entries out of the list into a folder on the computer.
  const dragFrom =
    <T extends { key: string | null }>(sel: Selection<T>) =>
    (row: T) => {
      if (handle === null || seq === null || row.key === null) return null;
      const inSel = sel.rows.some((x) => x.key === row.key);
      const keys = inSel ? sel.rows.flatMap((x) => (x.key === null ? [] : [x.key])) : [row.key];
      return dragOut(handle, seq, keys).catch((e: unknown) => setError(errorText(t("browser.dragFailed"), e)));
    };
  const folderDrag = useDragOut(dragFrom(folderSel));
  const hitDrag = useDragOut(dragFrom(hitSel));

  const viewingHead = open !== null && open.snapshot.seq === (open.archive.commits.at(-1)?.seq ?? -1);
  const listKeyHandlers = {
    all: () => (searching ? hitSel.all(hits.length) : total !== null && folderSel.all(total)),
    up: () => {
      if (!searching && path.length > 0) navigate(path.slice(0, -1), true);
    },
    remove: () => {
      if (viewingHead && selected.length > 0) setRemoveRequest((n) => n + 1);
    },
  };

  const openHit = (hit: HitRow) => {
    if (hit.key === null) return;
    const above = ancestorsOf(hit.key, hit.path);
    clearQuery();
    if (hit.kind === "directory") navigate([...above, { key: hit.key, name: hit.name }], true);
    else navigate(above, true);
  };

  const statusText =
    total === null
      ? t("common.loading")
      : tc(total, "common.itemOne", "common.itemMany") +
        (selected.length > 0 ? t("common.statusSeparator") + t("common.selectedCount", { n: selected.length }) : "");

  return (
    <ShellContext value={shell}>
      <section aria-labelledby="browser-heading" className="browser">
        <div className="toolbar" role="group" aria-label={t("toolbar.label")}>
          <h1 className="brand" title={t("app.title")}>
            <span className="mascot-face" aria-hidden="true" />
            <span className="sr-only">{t("app.title")}</span>
          </h1>
          <span className="tool-cell">
            <ToolButton
              icon={<OpenIcon />}
              label={t("browser.open")}
              testId="toolbar-open"
              title={t("toolbar.openTip")}
              disabled={busy}
              onClick={() => void doOpen()}
            />
          </span>
          <SlotHost name="new" />
          <span className="toolbar-sep" aria-hidden="true" />
          <SlotHost name="add" />
          <SlotHost name="extract" />
          <SlotHost name="test" />
          <SlotHost name="remove" />
          <span className="toolbar-spacer" />
          <SearchBox disabled={!canInspect} onQuery={setQuery} clearToken={clearSearch} />
          <span className="tool-cell">
            <ToolButton
              icon={<InfoIcon />}
              label={t("toolbar.info")}
              testId="toolbar-info"
              title={canInspect ? t("toolbar.infoTip") : t("toolbar.openFirst")}
              disabled={!canInspect}
              expanded={infoOpen}
              onClick={() => setInfoOpen((v) => !v)}
            />
          </span>
          <div className="more" ref={moreRef}>
            <button
              ref={moreButtonRef}
              type="button"
              className="tool"
              data-testid="toolbar-more"
              title={t("toolbar.more")}
              aria-expanded={moreOpen}
              aria-controls="more-menu"
              onClick={() => setMoreOpen((v) => !v)}
            >
              <MoreIcon />
              <span className="sr-only">{t("toolbar.more")}</span>
            </button>
            <div id="more-menu" className="menu" ref={menuRef} hidden={!moreOpen}>
              <button type="button" className="menu-item" data-testid="start-extract" onClick={() => void doOpen(true)} disabled={busy}>
                <ExtractIcon />
                {t("start.extractOpen")}
              </button>
              <button type="button" className="menu-item" data-testid="menu-foreign" onClick={() => setOpenForeignToken((n) => n + 1)}>
                <OpenIcon />
                {t("toolbar.foreign")}
              </button>
              <hr />
              <button type="button" className="menu-item" data-testid="menu-passphrases" onClick={() => showTool("passphrases")}>
                <KeyIcon />
                {t("app.sectionPassphrases")}
              </button>
              <button type="button" className="menu-item" data-testid="menu-repair" onClick={() => showTool("check")}>
                <WrenchIcon />
                {t("toolbar.repair")}
              </button>
              <hr />
              <button type="button" className="menu-item" data-testid="start-settings" onClick={() => showTool("settings")}>
                <GearIcon />
                {t("start.settings")}
              </button>
              <button type="button" className="menu-item" data-testid="menu-self-test" onClick={() => showTool("selfTest")}>
                <ActivityIcon />
                {t("toolbar.selfTest")}
              </button>
            </div>
          </div>
          <span className="tool-cell">
            <ToolButton
              icon={<HelpIcon />}
              label={t("help.toolbar")}
              testId="toolbar-help"
              title={t("toolbar.helpTip")}
              expanded={tool === "help"}
              onClick={() => setTool((v) => (v === "help" ? null : "help"))}
            />
          </span>
        </div>
        <h2 id="browser-heading" tabIndex={-1} className="sr-only">
          {open || foreignOpen ? t("browser.heading") : t("start.heading")}
        </h2>
        {/* What the toolbar's other buttons are while their owner has nothing
            to offer: the MOCHI ones when no MOCHI archive is open are drawn by
            their components; while a foreign archive is open, Add and Remove
            are off. */}
        <ToolSlot name="test" owner="mochi">
          <ToolButton
            icon={<CheckIcon />}
            label={t("toolbar.test")}
            testId="toolbar-test"
            title={open ? t("toolbar.testTip") : t("toolbar.openFirst")}
            disabled={open === null}
            onClick={doTest}
          />
        </ToolSlot>
        <ToolSlot name="add" owner="foreign">
          <ToolButton icon={<PlusIcon />} label={t("write.add")} testId="add-to-archive" title={t("toolbar.readOnly")} disabled onClick={doTest} />
        </ToolSlot>
        <ToolSlot name="remove" owner="foreign">
          <ToolButton icon={<TrashIcon />} label={t("write.remove")} testId="remove-entry" title={t("toolbar.readOnly")} disabled onClick={doTest} />
        </ToolSlot>
        <ToolSlot name="extract" owner="mochi">
          {open === null && (
            <ToolButton
              icon={<ExtractIcon />}
              label={t("extract.toolbar")}
              testId="extract-all"
              title={t("extract.openFirst")}
              disabled
              onClick={doTest}
            />
          )}
        </ToolSlot>

        {open && !foreignOpen && (
          <div className="pathbar">
            <button
              type="button"
              className="icon-button"
              data-testid="close-archive"
              aria-label={t("browser.close")}
              title={t("browser.close")}
              onClick={doClose}
              disabled={busy}
            >
              <BackIcon />
            </button>
            <button
              type="button"
              className="icon-button"
              data-testid="toggle-folders"
              aria-label={t("browser.paneFolders")}
              title={t("browser.paneFolders")}
              aria-expanded={foldersOpen}
              onClick={() => {
                setFoldersOpen((v) => !v);
                setFoldersShown(true);
              }}
            >
              <FoldersIcon />
            </button>
            <div className="path-meta" data-testid="archive-meta">
              <strong className="path-title" title={open.archive.file_name}>
                {open.archive.file_name}
              </strong>
              {open.archive.profile.encrypted && (
                <span
                  className="badge"
                  data-testid="encrypted-note"
                  title={[t("browser.profileEncrypted"), HIDDEN_WITH_KEY, ...VISIBLE_WITHOUT_KEY, NOT_SIGNED].join("\n")}
                >
                  <KeyIcon />
                  <span className="sr-only">{t("browser.profileEncrypted")}</span>
                </span>
              )}
            </div>
            <div className="versions" ref={versionsRef}>
              <button
                type="button"
                className="version-button"
                ref={versionsButtonRef}
                data-testid="toggle-versions"
                aria-expanded={versionsOpen}
                aria-controls="versions-pop"
                disabled={open.archive.commits.length < 2}
                title={tn(open.archive.commits.length, "browser.metaCommitOne", "browser.metaCommitMany", {
                  n: open.archive.commits.length,
                })}
                onClick={() => setVersionsOpen((v) => !v)}
              >
                {t("browser.versionShort", { seq: open.snapshot.seq })}
                {open.archive.commits.length > 1 && <CaretDownIcon />}
              </button>
              <div id="versions-pop" className="popover" hidden={!versionsOpen}>
                <Timeline
                  commits={open.archive.commits}
                  selected={open.snapshot.seq}
                  onSelect={(s) => {
                    setVersionsOpen(false);
                    void pickSnapshot(s);
                  }}
                />
              </div>
            </div>
            <nav aria-label={t("browser.currentFolder")} className="crumbs" data-testid="crumbs">
              <button type="button" className="crumb" onClick={() => navigate([])} title={t("browser.archiveRoot")}>
                <span aria-hidden="true">/</span>
                <span className="sr-only">{t("browser.archiveRoot")}</span>
              </button>
              {path.map((c, i) => (
                <span key={c.key} className="crumb-part">
                  {i > 0 && <span aria-hidden="true">/</span>}
                  <button type="button" className="crumb" onClick={() => navigate(path.slice(0, i + 1))}>
                    <Name name={c.name} />
                  </button>
                </span>
              ))}
            </nav>
            {open.archive.retention_error && (
              <span role="note" className="path-warn" title={t("browser.retentionError", {
                code: open.archive.retention_error.code,
                message: open.archive.retention_error.message,
              })}>
                !
                <span className="sr-only">
                  {t("browser.retentionError", {
                    code: open.archive.retention_error.code,
                    message: open.archive.retention_error.message,
                  })}
                </span>
              </span>
            )}
            {open.snapshot.catalog_source.source === "snapshot_manifest" && (
              <span role="note" className="path-warn" data-testid="catalog-note" title={t("browser.catalogRebuilt", { code: open.snapshot.catalog_source.image_error.code })}>
                !
                <span className="sr-only">
                  {t("browser.catalogRebuilt", { code: open.snapshot.catalog_source.image_error.code })}
                </span>
              </span>
            )}
          </div>
        )}

        <div className="stage">
          <SlotHost name="stage" className="stage-foreign" />
          <div className="stage-mochi" hidden={foreignOpen}>
            {waiting && (
              <Panel
                label={t("browser.passphraseGroup")}
                testId="unlock-panel"
                fallbackId="browser-heading"
                heading={t("browser.isEncrypted", { name: waiting.fileName })}
                onClose={giveUp}
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
                onOpenRecent={(i) => void doOpenRecent(i)}
                onForgetRecent={() => {
                  forgetRecentArchives().then(refreshRecents, refreshRecents);
                }}
              />
            )}
            <Writer
              archive={open?.archive ?? null}
              viewingHead={viewingHead}
              selected={selected}
              onCommitted={(a) => void adopt(a)}
              showToolbar
              createRequest={createRequest}
              removeRequest={removeRequest}
              onCreating={setCreating}
              onArchiveDropped={() => void doOpenDropped()}
            />
            {open && (
              <>
                <Extractor
                  archive={open.archive}
                  seq={open.snapshot.seq}
                  selected={selected}
                  autoPlan={autoExtract}
                />
                <div className="workspace">
                  {foldersShown && (
                    <nav className="folders" aria-label={t("browser.paneFolders")} hidden={!foldersOpen}>
                      <Tree
                        key={`${open.archive.handle}:${open.snapshot.seq}`}
                        handle={open.archive.handle}
                        seq={open.snapshot.seq}
                        current={dir}
                        onOpen={navigate}
                        onError={listError}
                      />
                    </nav>
                  )}
                  <div className="listing" onKeyDown={(e) => listKeys(e, listKeyHandlers)}>
                    <p id="entry-hint" className="sr-only">
                      {t("help.keys")}
                    </p>
                    {searching ? (
                      <SearchResults
                        search={search}
                        rowHeight={ROW_HEIGHT}
                        hintId="entry-hint"
                        testId="search-hits"
                        renderRow={(hit, index, tabIndex) => (
                          <button
                            type="button"
                            className={hitSel.has(hit) ? "entry selected" : "entry"}
                            data-testid="search-hit"
                            data-kind={hit.kind}
                            aria-pressed={hitSel.has(hit)}
                            tabIndex={tabIndex}
                            {...rowHandlers(hitSel, hit, index, () => openHit(hit), hitDrag)}
                          >
                            <EntryCells
                              kind={hit.kind}
                              name={hit.name}
                              kindLabel={hit.kind === "directory" ? t("common.folder") : t("common.file")}
                              size={hit.size}
                              folder={hit.folder}
                            />
                          </button>
                        )}
                      />
                    ) : (
                      total !== null && (
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
                          renderRow={(row: EntryRow, index: number, tabIndex: 0 | -1) => (
                            <button
                              type="button"
                              className={folderSel.has(row) ? "entry selected" : "entry"}
                              data-testid="entry"
                              data-kind={row.kind}
                              aria-pressed={folderSel.has(row)}
                              tabIndex={tabIndex}
                              {...rowHandlers(
                                folderSel,
                                row,
                                index,
                                () => {
                                  if (row.kind === "directory") navigate([...path, { key: row.key, name: row.name }], true);
                                },
                                folderDrag,
                              )}
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
                      )
                    )}
                  </div>
                  <aside className="info" aria-label={t("toolbar.info")} hidden={!infoOpen} data-testid="info-panel">
                    {details && <Details details={details} />}
                    <details className="technical" data-testid="archive-technical">
                      <summary>{t("browser.aboutArchive")}</summary>
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
                  </aside>
                </div>
                <ToolSlot name="count" owner="mochi">
                  <span
                    className="statusbar-text"
                    data-testid="entry-count"
                    title={
                      searching && search.state === "done" && search.detail !== undefined
                        ? search.detail
                        : t("browser.entriesInVersion", { n: open.snapshot.entries.toLocaleString("en-US") })
                    }
                  >
                    {searching ? search.statusText : statusText}
                  </span>
                </ToolSlot>
              </>
            )}
          </div>
        </div>
        <div className="statusbar">
          <SlotHost name="count" className="statusbar-count" />
          <SlotHost name="status" className="statusbar-status" />
          {error && (
            <div className="statusbar-error">
              <p role="alert" className="statusbar-error-text" data-testid="browse-error" title={error}>
                {error}
              </p>
              <button
                type="button"
                className="icon-button"
                aria-label={t("result.dismiss")}
                title={t("result.dismiss")}
                onClick={() => setError(null)}
              >
                <CloseIcon />
              </button>
            </div>
          )}
        </div>
        {foreign}
        <ToolSheet tool={tool} onClose={() => setTool(null)} returnFocus={moreButtonRef}>
          {{
            help,
            passphrases: (
              <Rekey
                key={open?.archive.handle ?? "none"}
                archive={open?.archive ?? null}
                onChanged={(a) => {
                  if (a === null) void doClose();
                  else void adopt(a);
                }}
              />
            ),
            check: <Checker archive={open?.archive ?? null} testRequest={testRequest} />,
            ...tools,
          }}
        </ToolSheet>
      </section>
    </ShellContext>
  );
}
