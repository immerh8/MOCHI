import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Panel } from "../a11y/Panel";
import {
  BackIcon,
  CaretDownIcon,
  CheckIcon,
  ExtractIcon,
  FolderIcon,
  FoldersIcon,
  MinusIcon,
  PlusIcon,
  HelpIcon,
  InfoIcon,
  MoreIcon,
  SearchIcon,
} from "../icons";
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
import { SlotHost, ShellContext, ToolButton, ToolSlot } from "../shell/Shell";
import type { Shell, SlotName } from "../shell/Shell";
import { StatusBar } from "./StatusBar";

/** Row height of the file list, in pixels. */
export const ROW_HEIGHT = 30;

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
export function Browser({
  toolsNav,
  tools,
  help,
}: {
  toolsNav?: ReactNode;
  tools?: ReactNode;
  help?: ReactNode;
}) {
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
  // The window around the list (toolbar, panels that open and close).
  const [infoOpen, setInfoOpen] = useState(false);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [foldersShown, setFoldersShown] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [foreignOpen, setForeignOpen] = useState(false);
  const [closeForeignToken, setCloseForeignToken] = useState(0);
  const [openForeignToken, setOpenForeignToken] = useState(0);
  const [testRequest, setTestRequest] = useState(0);
  const [slots, setSlots] = useState<Partial<Record<SlotName, HTMLElement>>>({});
  const register = useCallback((name: SlotName, el: HTMLElement | null) => {
    setSlots((prev) => {
      // A slot element lives as long as the window; an unmount needs no undo.
      if (el === null || prev[name] === el) return prev;
      return { ...prev, [name]: el };
    });
  }, []);

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
    setCloseForeignToken((n) => n + 1);
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

  // Toolbar items that live in the Advanced area (Find, Test, Passphrases,
  // Settings…) open it and land on that section's heading, as the section
  // buttons do (a closed disclosure cannot take focus).
  const advancedRef = useRef<HTMLDetailsElement>(null);
  const showAdvanced = (headingId: string) => {
    if (advancedRef.current) advancedRef.current.open = true;
    const heading = document.getElementById(headingId);
    heading?.focus();
    heading?.scrollIntoView?.({ block: "start" });
  };
  const showSettings = () => showAdvanced("settings-heading");
  const showSearch = () => showAdvanced("search-heading");
  const doTest = () => {
    showAdvanced("check-heading");
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

  // The version list, the More menu and the folder tree close on Escape and
  // when the pointer goes down outside them.
  const moreRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const versionsRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // A choice closes the menu. Some items are drawn into it from other components
  // (a portal), whose clicks do not bubble through this element in React's tree, so
  // this listens on the element itself. Focus goes to the More button first: a panel
  // the choice opens gives focus back there when it closes (a hidden item cannot take it).
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
      if (versionsOpen && !versionsRef.current?.contains(target)) setVersionsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
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

  const toggleHelp = () => {
    const next = !helpOpen;
    setHelpOpen(next);
    if (next) {
      // The panel is hidden until this render commits; focus it after.
      setTimeout(() => document.getElementById("help-heading")?.focus(), 0);
    }
  };
  const fromMenu = (run: () => void) => {
    setMoreOpen(false);
    run();
  };

  const shell: Shell = {
    active,
    register,
    slots,
    setForeignOpen,
    closeForeignToken,
    openForeignToken,
    infoOpen,
  };

  const count = total === null ? null : total;
  const statusText =
    count === null
      ? t("common.loading")
      : tc(count, "common.itemOne", "common.itemMany") +
        (selected !== null ? t("common.statusSeparator") + t("common.selectedCount", { n: 1 }) : "");

  return (
    <ShellContext value={shell}>
      <section aria-labelledby="browser-heading" className="browser">
        <div className="toolbar" role="group" aria-label={t("toolbar.label")}>
          <h1 className="brand">
            <span className="mascot-face" aria-hidden="true" />
            {t("app.title")}
          </h1>
          <SlotHost name="add" />
          <SlotHost name="extract" />
          <SlotHost name="test" />
          <SlotHost name="remove" />
          <SlotHost name="find" />
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
          <span className="toolbar-spacer" />
          <div className="more" ref={moreRef}>
            <button
              ref={moreButtonRef}
              type="button"
              className="tool"
              data-testid="toolbar-more"
              title={t("toolbar.moreTip")}
              aria-expanded={moreOpen}
              aria-controls="more-menu"
              onClick={() => setMoreOpen((v) => !v)}
            >
              <MoreIcon />
              <span className="tool-label">{t("toolbar.more")}</span>
            </button>
            <div
              id="more-menu"
              className="menu"
              ref={menuRef}
              hidden={!moreOpen}
            >
              <SlotHost name="new" className="menu-cell" />
              <button type="button" className="menu-item" data-testid="start-extract" onClick={() => void doOpen(true)} disabled={busy}>
                {t("start.extractOpen")}
              </button>
              <button type="button" className="menu-item" data-testid="menu-passphrases" onClick={() => fromMenu(() => showAdvanced("rekey-heading"))}>
                {t("app.sectionPassphrases")}
              </button>
              <button type="button" className="menu-item" data-testid="menu-repair" onClick={() => fromMenu(() => showAdvanced("check-heading"))}>
                {t("toolbar.repair")}
              </button>
              <button type="button" className="menu-item" data-testid="menu-foreign" onClick={() => fromMenu(() => setOpenForeignToken((n) => n + 1))}>
                {t("toolbar.foreign")}
              </button>
              <button type="button" className="menu-item" data-testid="start-settings" onClick={() => fromMenu(showSettings)}>
                {t("start.settings")}
              </button>
              <button type="button" className="menu-item" data-testid="menu-self-test" onClick={() => fromMenu(() => showAdvanced("self-test-heading"))}>
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
              expanded={helpOpen}
              onClick={toggleHelp}
            />
          </span>
        </div>
        <h2 id="browser-heading" tabIndex={-1} className={showStart || open || foreignOpen ? "sr-only" : undefined}>
          {open || foreignOpen ? t("browser.heading") : t("start.heading")}
        </h2>
        {/* What the toolbar's other buttons are while their owner has nothing
            to offer: the MOCHI ones when no MOCHI archive is open are drawn by
            their components; while a foreign archive is open, Add, Remove and
            Find are off. */}
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
        <ToolSlot name="find" owner="mochi">
          <ToolButton
            icon={<SearchIcon />}
            label={t("toolbar.find")}
            testId="search-archive"
            title={open ? t("browser.search") : t("toolbar.openFirst")}
            disabled={open === null}
            onClick={showSearch}
          />
        </ToolSlot>
        <ToolSlot name="add" owner="foreign">
          <ToolButton icon={<PlusIcon />} label={t("write.add")} testId="add-to-archive" title={t("toolbar.readOnly")} disabled onClick={showSearch} />
        </ToolSlot>
        <ToolSlot name="remove" owner="foreign">
          <ToolButton icon={<MinusIcon />} label={t("write.remove")} testId="remove-entry" title={t("toolbar.readOnly")} disabled onClick={showSearch} />
        </ToolSlot>
        <ToolSlot name="extract" owner="mochi">
          {open === null && (
            <ToolButton
              icon={<ExtractIcon />}
              label={t("extract.toolbar")}
              testId="extract-all"
              title={t("extract.openFirst")}
              disabled
              onClick={showSearch}
            />
          )}
        </ToolSlot>
        <ToolSlot name="find" owner="foreign">
          <ToolButton icon={<SearchIcon />} label={t("toolbar.find")} testId="search-archive" title={t("toolbar.noSearch")} disabled onClick={showSearch} />
        </ToolSlot>

        {open && !foreignOpen && (
          <div className="pathbar">
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
              <strong className="path-title">{open.archive.file_name}</strong>
              <span className="path-sub">
                {t("browser.metaSeparator")}
                {open.archive.commits.length > 1 ? (
                  <>
                    <button
                      type="button"
                      className="link version-button"
                      data-testid="toggle-versions"
                      aria-expanded={versionsOpen}
                      aria-controls="versions-pop"
                      onClick={() => setVersionsOpen((v) => !v)}
                    >
                      {tn(open.archive.commits.length, "browser.metaCommitOne", "browser.metaCommitMany", {
                        n: open.archive.commits.length,
                      })}
                      <CaretDownIcon />
                    </button>
                  </>
                ) : (
                  tn(open.archive.commits.length, "browser.metaCommitOne", "browser.metaCommitMany", {
                    n: open.archive.commits.length,
                  })
                )}
                {open.archive.profile.encrypted && (
                  <>
                    {t("browser.metaSeparator")}
                    {t("browser.profileEncrypted")}
                  </>
                )}
              </span>
            </div>
            <div className="versions" ref={versionsRef}>
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
        )}

        <div className="stage">
          <div className="sheet" hidden={!helpOpen} data-testid="help-sheet">
            {help}
          </div>
          {/* Outside the MOCHI stage: a launch can open a foreign archive and
              then say why it did nothing more, so this must show in either. */}
          {error && (
            <p role="alert" className="error" data-testid="browse-error">
              {error}
            </p>
          )}
          <SlotHost name="stage" className="stage-foreign" />
          <div className="stage-mochi" hidden={foreignOpen}>
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
                onOpenRecent={(i) => void doOpenRecent(i)}
                onForgetRecent={() => {
                  forgetRecentArchives().then(refreshRecents, refreshRecents);
                }}
              />
            )}
            <Writer
              archive={open?.archive ?? null}
              viewingHead={open !== null && open.snapshot.seq === (open.archive.commits.at(-1)?.seq ?? -1)}
              selected={details ? { key: details.key, name: details.path } : null}
              onCommitted={(a) => void adopt(a)}
              showToolbar
              createRequest={createRequest}
              onCreating={setCreating}
              onArchiveDropped={() => void doOpenDropped()}
            />
            {open && (
              <>
                <Extractor
                  archive={open.archive}
                  seq={open.snapshot.seq}
                  selected={details ? { key: details.key, name: details.path } : null}
                  autoPlan={autoExtract}
                />
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
                  <div className="listing">
                    <p id="entry-hint" className="sr-only">
                      {t("help.keys")}
                    </p>
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
                  </div>
                  <aside className="info" aria-label={t("toolbar.info")} hidden={!infoOpen} data-testid="info-panel">
                    {details && <Details details={details} />}
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
                  </aside>
                </div>
                <StatusBar
                  testId="entry-count"
                  text={statusText}
                  title={t("browser.entriesInVersion", { n: open.snapshot.entries.toLocaleString("en-US") })}
                >
                  <SlotHost name="primary" className="statusbar-slot" />
                </StatusBar>
              </>
            )}
          </div>
        </div>
        <details className="advanced" data-testid="advanced" ref={advancedRef}>
          <summary>{t("start.advanced")}</summary>
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
          <Checker archive={open?.archive ?? null} testRequest={testRequest} />
          {tools}
        </details>
      </section>
    </ShellContext>
  );
}
