import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { Live } from "../a11y/Live";
import { ProgressMeter } from "../a11y/ProgressMeter";
import { errorText, shortSize } from "../browser/format";
import { iconKindOf } from "../browser/fileKind";
import { Name } from "../browser/Name";
import { CloseIcon, FileTypeIcon, FolderIcon, PlusIcon, SearchIcon } from "../icons";
import { getLocale, t } from "../i18n";
import {
  findCancel,
  findChooseFolders,
  findQuery,
  findRemoveScope,
  findScopes,
  findShowFolder,
  findStart,
} from "../ipc/find";
import type { FindEvent, FindHit, FindResultView, FindScopeView } from "../ipc/find";
import { ContextMenu, copyNames, useContextMenu } from "../list/ContextMenu";
import type { MenuItem } from "../list/ContextMenu";
import { splitPath } from "../list/keys";
import { incomplete, progressText, skipText, statusText } from "./messages";

/** How long typing pauses before the search runs, in milliseconds (a query is answered from memory). */
export const FIND_DELAY = 150;
/** Fewest milliseconds between two refreshes of the results while a scan runs. */
export const REFRESH_EVERY = 300;

const hitId = (h: FindHit) => `${h.run}:${h.archive}:${h.key}`;

/** The last component of a path as the file manager shows it (either separator). */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** The archive's modified time in the current language, or "unknown". */
export function formatWhen(ms: number | null): string {
  if (ms === null) return t("find.noTime");
  try {
    return new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" }).format(ms);
  } catch {
    return t("find.noTime");
  }
}

/**
 * MOCHI Find: search the file names inside every `.mochi` archive under some
 * folders. Rust holds the folders and the names; this draws them. Archive
 * names, entry names and the core's error sentences are archive- or
 * disk-supplied text and are rendered as text only. "No matches" is said only
 * when every archive was searched (spec §23.3 #8); anything not searched is
 * listed under "Search incomplete".
 */
export function Finder({
  active,
  launchToken,
  onOpen,
}: {
  /** Whether the Find tool is on screen. Nothing is asked of Rust until it first is. */
  active: boolean;
  /** Changes when the shell asked for Find (`--find`): the folders were set in Rust, so scan them. */
  launchToken: number;
  /** Open the hit's archive in the browser, at the entry's folder. */
  onOpen: (hit: FindHit) => void;
}) {
  const [scopes, setScopes] = useState<FindScopeView[]>([]);
  const [result, setResult] = useState<FindResultView | null>(null);
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [scanning, setScanning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; total: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [menuHit, setMenuHit] = useState<FindHit | null>(null);
  const menu = useContextMenu();
  const listRef = useRef<HTMLUListElement>(null);

  // ---- asking Rust for the results --------------------------------------
  const queryRef = useRef("");
  const seqRef = useRef(0);
  const lastRefreshRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    const id = ++seqRef.current;
    lastRefreshRef.current = Date.now();
    findQuery(queryRef.current).then(
      (r) => {
        if (id === seqRef.current) setResult(r);
      },
      (e: unknown) => {
        if (id === seqRef.current) setError(errorText(t("find.queryFailed"), e));
      },
    );
  }, []);
  useEffect(() => {
    queryRef.current = query;
    if (active) refresh();
  }, [query, active, refresh]);
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  // Typing waits a moment, then asks.
  useEffect(() => {
    const id = setTimeout(() => setQuery(input.trim()), FIND_DELAY);
    return () => clearTimeout(id);
  }, [input]);

  // ---- the scan ------------------------------------------------------------
  const newestRunRef = useRef(0);
  const onEvent = useCallback(
    (e: FindEvent) => {
      if (e.run < newestRunRef.current) return;
      newestRunRef.current = e.run;
      if (e.event === "started") {
        setScanning(true);
        setStopping(false);
      } else if (e.event === "progress") {
        setProgress({ completed: e.completed, total: e.total });
        // At most one refresh per REFRESH_EVERY: the last one is the `finished` event's.
        if (timerRef.current === null) {
          const wait = Math.max(0, REFRESH_EVERY - (Date.now() - lastRefreshRef.current));
          timerRef.current = setTimeout(() => {
            timerRef.current = null;
            refresh();
          }, wait);
        }
      } else {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
        setScanning(false);
        setStopping(false);
        refresh();
      }
    },
    [refresh],
  );
  const scan = useCallback(async () => {
    setError(null);
    setProgress(null);
    setScanning(true);
    try {
      await findStart(false, onEvent);
    } catch (e) {
      setScanning(false);
      setError(errorText(t("find.scanFailed"), e));
    }
  }, [onEvent]);
  const scanRef = useRef(scan);
  useEffect(() => {
    scanRef.current = scan;
  });

  const stop = () => {
    setStopping(true);
    void findCancel().catch(() => false);
  };

  // The folders: read whenever Find is shown; scanned too when the shell asked for it.
  const handledLaunchRef = useRef(0);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const fromShell = launchToken > handledLaunchRef.current;
    handledLaunchRef.current = launchToken;
    findScopes().then(
      (s) => {
        if (!live) return;
        setScopes(s);
        if (fromShell && s.length > 0) void scanRef.current();
      },
      (e: unknown) => {
        if (live) setError(errorText(t("find.chooseFailed"), e));
      },
    );
    return () => {
      live = false;
    };
  }, [active, launchToken]);

  const addFolders = async () => {
    setError(null);
    setChoosing(true);
    try {
      const added = await findChooseFolders();
      if (added === null) return;
      setScopes(added);
      if (added.length > 0) void scan();
    } catch (e) {
      setError(errorText(t("find.chooseFailed"), e));
    } finally {
      setChoosing(false);
    }
  };
  const removeFolder = async (index: number) => {
    setError(null);
    try {
      setScopes(await findRemoveScope(index));
    } catch (e) {
      setError(errorText(t("find.removeFailed"), e));
    }
  };

  // ---- the matches -------------------------------------------------------
  const hits = result?.hits ?? [];
  const selected = hits.find((h) => hitId(h) === picked) ?? null;
  const coverage = result?.coverage ?? null;
  const inc = coverage === null ? null : incomplete(coverage);
  const walking = coverage !== null && progress !== null && progress.total === null;

  const openHit = (h: FindHit) => onOpen(h);
  const failWith = (what: string) => (e: unknown) => setError(errorText(what, e));
  const menuItems = (h: FindHit): MenuItem[] => [
    { id: "find-open", label: t("find.menuOpen"), run: () => openHit(h) },
    {
      id: "find-folder",
      label: t("find.menuFolder"),
      run: () => void findShowFolder(h.run, h.archive).catch(failWith(t("find.folderFailed"))),
    },
    {
      id: "find-copy-archive",
      label: t("find.menuCopyArchive"),
      separator: true,
      run: () => void copyNames([h.archive_path]).catch(failWith(t("find.copyFailed"))),
    },
    {
      id: "find-copy-entry",
      label: t("find.menuCopyEntry"),
      run: () => void copyNames([h.path.text]).catch(failWith(t("find.copyFailed"))),
    },
  ];

  // Arrow keys move between rows; Enter opens the focused one.
  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-testid=find-hit]") ?? []);
    const at = rows.findIndex((r) => r === document.activeElement);
    if (at < 0) return;
    const to =
      e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const row = rows[Math.min(Math.max(0, to), rows.length - 1)];
    row?.focus();
  };

  const stopWord = stopping ? t("find.stopping") : t("find.stop");
  return (
    <section className="finder" data-testid="finder" aria-labelledby="finder-heading">
      <h2 id="finder-heading" tabIndex={-1}>
        {t("find.heading")}
      </h2>
      <p className="find-intro">{t("find.intro")}</p>

      <div className="find-folders" role="group" aria-label={t("find.foldersLabel")}>
        {scopes.length === 0 ? (
          <p className="find-none" data-testid="find-no-folders">
            {t("find.noFolders")}
          </p>
        ) : (
          <ul className="find-scopes" data-testid="find-scopes">
            {scopes.map((s) => (
              <li key={s.index} data-testid="find-scope">
                <FolderIcon />
                <span className="find-path" title={s.path}>
                  {s.path}
                </span>
                <button
                  type="button"
                  className="icon-button"
                  data-testid="find-remove-scope"
                  aria-label={t("find.removeFolder", { folder: s.path })}
                  title={t("find.removeFolder", { folder: s.path })}
                  disabled={scanning}
                  onClick={() => void removeFolder(s.index)}
                >
                  <CloseIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="find-actions">
          <button type="button" data-testid="find-add-folders" disabled={choosing || scanning} onClick={() => void addFolders()}>
            <PlusIcon />
            {t("find.addFolders")}
          </button>
          {scanning ? (
            <button type="button" data-testid="find-stop" disabled={stopping} onClick={stop}>
              {stopWord}
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              data-testid="find-scan"
              disabled={scopes.length === 0}
              onClick={() => void scan()}
            >
              {coverage !== null && coverage.state !== "idle" ? t("find.scanAgain") : t("find.scan")}
            </button>
          )}
        </div>
      </div>

      <search className="searchbox find-search">
        <SearchIcon />
        <input
          type="search"
          data-testid="find-query"
          aria-label={t("find.queryLabel")}
          placeholder={t("find.queryPlaceholder")}
          value={input}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && input !== "") {
              e.preventDefault();
              e.stopPropagation();
              setInput("");
              setQuery("");
            }
          }}
        />
        {input !== "" && (
          <button
            type="button"
            className="searchbox-clear"
            data-testid="find-clear"
            aria-label={t("find.clearQuery")}
            title={t("find.clearQuery")}
            onClick={() => {
              setInput("");
              setQuery("");
            }}
          >
            <CloseIcon />
          </button>
        )}
      </search>

      <Live className="find-status" data-testid="find-status">
        {statusText(result, query)}
      </Live>
      {scanning && coverage !== null && (
        <p className="find-progress" data-testid="find-progress">
          <ProgressMeter
            completed={progress?.completed ?? 0}
            total={progress?.total ?? null}
            text={progressText(coverage, walking)}
            textTestId="find-progress-text"
          />
        </p>
      )}
      {error && (
        <p role="alert" className="error" data-testid="find-error">
          {error}
        </p>
      )}

      {inc && coverage && (
        <div className="find-incomplete" role="note" data-testid="find-incomplete">
          <p className="find-incomplete-head" data-testid="find-incomplete-head">
            {inc.headline}
          </p>
          {inc.notes.length > 0 && (
            <ul>
              {inc.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          {coverage.skipped.length > 0 && (
            <details data-testid="find-skipped-details">
              <summary>{t("find.whichArchives")}</summary>
              <ul data-testid="find-skipped">
                {coverage.skipped.map((s) => (
                  <li key={s.archive} data-testid="find-skipped-item" data-reason={s.reason}>
                    <span className="find-path" title={s.path}>
                      {s.path}
                    </span>
                    <span className="find-reason">{skipText(s)}</span>
                  </li>
                ))}
              </ul>
              {coverage.archives_skipped > coverage.skipped.length && (
                <p>{t("find.skippedMore", { n: coverage.archives_skipped - coverage.skipped.length })}</p>
              )}
            </details>
          )}
        </div>
      )}

      {hits.length > 0 && (
        <div className="find-results" data-testid="find-results">
          <div className="find-head" aria-hidden="true">
            <span className="col-name">{t("find.colName")}</span>
            <span>{t("find.colInArchive")}</span>
            <span>{t("find.colArchive")}</span>
            <span className="col-size">{t("find.colSize")}</span>
            <span>{t("find.colModified")}</span>
          </div>
          <ul ref={listRef} aria-label={t("find.results")} data-testid="find-hits" onKeyDown={onListKey}>
            {hits.map((h, i) => {
              const { name, folder } = splitPath(h.path);
              const id = hitId(h);
              const tab = picked === null ? i === 0 : picked === id;
              return (
                <li key={id}>
                  <button
                    type="button"
                    className={picked === id ? "find-hit selected" : "find-hit"}
                    data-testid="find-hit"
                    data-kind={h.kind}
                    aria-pressed={picked === id}
                    tabIndex={tab ? 0 : -1}
                    onClick={() => setPicked(id)}
                    onDoubleClick={() => openHit(h)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        openHit(h);
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setPicked(id);
                      setMenuHit(h);
                      menu.openAt({ x: e.clientX, y: e.clientY });
                    }}
                  >
                    <span className="kind" aria-label={h.kind === "directory" ? t("common.folder") : t("common.file")}>
                      <FileTypeIcon kind={iconKindOf(h.kind, name.text)} />
                    </span>
                    <span className="entry-name">
                      <Name name={name} />
                    </span>
                    <span className="folder" title={folder}>
                      {folder === "" ? "/" : folder}
                    </span>
                    <span className="find-archive" title={h.archive_path}>
                      {baseName(h.archive_path)}
                    </span>
                    <span className="size">{h.kind === "directory" ? "" : shortSize(h.size)}</span>
                    <span className="when">{formatWhen(h.archive_modified_ms)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {selected && (
        <div className="find-selected" data-testid="find-selected">
          <p>
            {t("find.detailEntry", { path: selected.path.text })}
            {!selected.path.verbatim && (
              <span className="escaped" title={t("common.escapedHint")}>
                {t("common.escapedMarker")}
              </span>
            )}
          </p>
          <p>{t("find.detailArchive", { path: selected.archive_path })}</p>
        </div>
      )}
      {menu.at !== null && menuHit !== null && (
        <ContextMenu
          at={menu.at}
          items={menuItems(menuHit)}
          label={t("find.menuLabel")}
          onClose={() => {
            menu.close();
            setMenuHit(null);
          }}
        />
      )}
    </section>
  );
}
