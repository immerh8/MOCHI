import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";

import { Live } from "../a11y/Live";
import { ProgressMeter } from "../a11y/ProgressMeter";
import { errorText, shortSize } from "../browser/format";
import { iconKindOf } from "../browser/fileKind";
import { Name } from "../browser/Name";
import { CloseIcon, ExtractIcon, FileTypeIcon, FolderIcon, PlusIcon, SearchIcon } from "../icons";
import { formatNumber, t, tc, tn } from "../i18n";
import {
  findCancel,
  findChooseFolders,
  findQuery,
  findQueryMany,
  findRemoveScope,
  findScopes,
  findShowFolder,
  findStart,
} from "../ipc/find";
import type { FindEntryFilter, FindEvent, FindHit, FindResultView, FindScopeView } from "../ipc/find";
import { ContextMenu, copyNames, useContextMenu } from "../list/ContextMenu";
import type { MenuItem } from "../list/ContextMenu";
import { splitPath } from "../list/keys";
import { incomplete, progressText, skipText, statusText } from "./messages";
import { baseName, formatWhen } from "./paths";
import { RetrieveDialog, archivesOf } from "./Retrieve";
import { looksLikeList, parseTerms, SEPARATORS } from "./terms";
import type { Separator } from "./terms";

export { baseName, formatWhen };

/** How long typing pauses before the search runs, in milliseconds (a query is answered from memory). */
export const FIND_DELAY = 150;
/** Fewest milliseconds between two refreshes of the results while a scan runs. */
export const REFRESH_EVERY = 300;
/** Names shown as chips under the list; the rest are counted. */
export const CHIPS_SHOWN = 40;

const hitId = (h: FindHit) => `${h.run}:${h.archive}:${h.key}`;

type Mode = "one" | "list";

/** What the user chose, kept between sessions in this webview only (a convenience, never needed). */
interface Choices {
  mode: Mode;
  matchCase: boolean;
  wholeName: boolean;
  subfolders: boolean;
  entries: FindEntryFilter;
  separator: Separator;
  namesOnly: boolean;
}

const DEFAULT_CHOICES: Choices = {
  mode: "one",
  matchCase: false,
  wholeName: false,
  subfolders: true,
  entries: "all",
  separator: "auto",
  namesOnly: false,
};
const CHOICES_KEY = "mochi.find.choices";

function loadChoices(): Choices {
  try {
    const raw = localStorage.getItem(CHOICES_KEY);
    if (raw === null) return DEFAULT_CHOICES;
    const v = JSON.parse(raw) as Partial<Choices>;
    return {
      mode: v.mode === "list" ? "list" : "one",
      matchCase: v.matchCase === true,
      wholeName: v.wholeName === true,
      subfolders: v.subfolders !== false,
      entries: v.entries === "files" || v.entries === "folders" ? v.entries : "all",
      separator: SEPARATORS.includes(v.separator as Separator) ? (v.separator as Separator) : "auto",
      namesOnly: v.namesOnly === true,
    };
  } catch {
    return DEFAULT_CHOICES;
  }
}

function saveChoices(c: Choices) {
  try {
    localStorage.setItem(CHOICES_KEY, JSON.stringify(c));
  } catch {
    // Not remembered: the next session starts from the defaults.
  }
}

/** What to ask Rust: one name with `mochi find`'s rules, or a list (or options) through the many-name query. */
interface Ask {
  terms: string[];
  matchCase: boolean;
  wholeName: boolean;
  entries: FindEntryFilter;
  /** One name with the default options: the single query, exactly as `mochi find` matches. */
  plain: boolean;
}

function ask(a: Ask): Promise<FindResultView> {
  if (a.plain) return findQuery(a.terms[0] ?? "");
  return findQueryMany({ terms: a.terms, match_case: a.matchCase, whole_name: a.wholeName, entries: a.entries });
}

/** The sum of the sizes of `hits` (decimal strings), as a decimal string. */
function totalSize(hits: readonly FindHit[]): string {
  let sum = 0n;
  for (const h of hits) {
    try {
      sum += BigInt(h.size);
    } catch {
      // A size that is not a number adds nothing.
    }
  }
  return sum.toString();
}

/**
 * MOCHI Find: search the file names inside every `.mochi` archive under some
 * folders, for one name or a pasted list of them (spec Annex B.2.21), then
 * retrieve the matches ticked. Rust holds the folders and the names; this
 * draws them. Archive names, entry names and the core's error sentences are
 * archive- or disk-supplied text and are rendered as text only. "No matches"
 * is said only when every archive was searched (spec §23.3 #8); anything not
 * searched is listed under "Search incomplete", and a name not found is "not
 * found in what was searched" while the search is incomplete.
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
  const [choices, setChoices] = useState<Choices>(loadChoices);
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [listText, setListText] = useState("");
  const [listTerms, setListTerms] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; total: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  // The name whose matches alone are shown, for the list of names it was picked in.
  const [filterPick, setFilterPick] = useState<{ list: string; index: number } | null>(null);
  const [retrieving, setRetrieving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [menuHit, setMenuHit] = useState<FindHit | null>(null);
  const menu = useContextMenu();
  const listRef = useRef<HTMLUListElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const updateChoices = (patch: Partial<Choices>) =>
    setChoices((c) => {
      const next = { ...c, ...patch };
      saveChoices(next);
      return next;
    });

  const list = choices.mode === "list";
  const parsed = useMemo(
    () => parseTerms(listText, { separator: choices.separator, ignoreCase: !choices.matchCase, namesOnly: choices.namesOnly }),
    [listText, choices.separator, choices.matchCase, choices.namesOnly],
  );

  // What is asked: the typed name, or the list (each waits for a pause in typing).
  const current: Ask = useMemo(() => {
    const terms = list ? listTerms : query === "" ? [] : [query];
    const plain = !list && !choices.matchCase && !choices.wholeName && choices.entries === "all";
    return { terms, matchCase: choices.matchCase, wholeName: choices.wholeName, entries: choices.entries, plain };
  }, [list, listTerms, query, choices.matchCase, choices.wholeName, choices.entries]);
  const asked = current.terms.length > 0;
  const askedKey = current.terms.join("\u0000");
  const termFilter = filterPick !== null && filterPick.list === askedKey ? filterPick.index : null;
  const setTermFilter = (index: number | null) =>
    setFilterPick(index === null ? null : { list: askedKey, index });

  // ---- asking Rust for the results --------------------------------------
  const askRef = useRef<Ask>(current);
  const seqRef = useRef(0);
  const lastRefreshRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    const id = ++seqRef.current;
    lastRefreshRef.current = Date.now();
    ask(askRef.current).then(
      (r) => {
        if (id === seqRef.current) setResult(r);
      },
      (e: unknown) => {
        if (id === seqRef.current) setError(errorText(t("find.queryFailed"), e));
      },
    );
  }, []);
  useEffect(() => {
    askRef.current = current;
    if (active) refresh();
  }, [current, active, refresh]);
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
  const parsedKey = parsed.terms.join("\u0000");
  useEffect(() => {
    const id = setTimeout(() => setListTerms(parsedKey === "" ? [] : parsedKey.split("\u0000")), FIND_DELAY);
    return () => clearTimeout(id);
  }, [parsedKey]);

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
  const subfoldersRef = useRef(choices.subfolders);
  useEffect(() => {
    subfoldersRef.current = choices.subfolders;
  }, [choices.subfolders]);
  const scan = useCallback(async () => {
    setError(null);
    setProgress(null);
    setScanning(true);
    setChecked(new Set());
    try {
      await findStart(false, onEvent, subfoldersRef.current);
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
  const hits = useMemo(() => result?.hits ?? [], [result]);
  const coverage = result?.coverage ?? null;
  const scanned = coverage !== null && coverage.state !== "idle";

  const toggleSubfolders = (on: boolean) => {
    updateChoices({ subfolders: on });
    subfoldersRef.current = on;
    // A different walk: the folders are scanned again (cheap: unchanged archives come from memory).
    if (scanned && scopes.length > 0 && !scanning) void scan();
  };

  const terms = useMemo(() => (list ? (result?.terms ?? []) : []), [list, result]);
  const shown = useMemo(
    () => (termFilter === null ? hits : hits.filter((h) => h.terms.includes(termFilter))),
    [hits, termFilter],
  );
  const selected = hits.find((h) => hitId(h) === picked) ?? null;
  const chosen = useMemo(() => hits.filter((h) => checked.has(hitId(h))), [hits, checked]);
  const inc = coverage === null ? null : incomplete(coverage);
  const walking = coverage !== null && progress !== null && progress.total === null;
  const allShownChecked = shown.length > 0 && shown.every((h) => checked.has(hitId(h)));
  const someShownChecked = shown.some((h) => checked.has(hitId(h)));

  const toggle = (h: FindHit) =>
    setChecked((prev) => {
      const next = new Set(prev);
      const id = hitId(h);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAllShown = () =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (allShownChecked) for (const h of shown) next.delete(hitId(h));
      else for (const h of shown) next.add(hitId(h));
      return next;
    });

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

  const missing = terms.filter((x) => x.hits === 0);
  const copyMissing = () =>
    void copyNames(missing.map((m) => m.text)).then(
      () => setNotice(t("find.copiedMissing")),
      failWith(t("find.copyFailed")),
    );

  // Arrow keys move between rows; Enter opens the focused one; Space ticks it; Ctrl+A ticks all shown.
  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setChecked((prev) => new Set([...prev, ...shown.map(hitId)]));
      return;
    }
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

  // A pasted list in the one-name box opens the list of names with it.
  const onPasteOne = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (!looksLikeList(text)) return;
    e.preventDefault();
    const n = parseTerms(text, { separator: choices.separator, ignoreCase: !choices.matchCase, namesOnly: choices.namesOnly }).terms.length;
    setListText((old) => (old.trim() === "" ? text : `${old.replace(/\s+$/, "")}\n${text}`));
    updateChoices({ mode: "list" });
    setNotice(t("find.pastedList", { n: formatNumber(n) }));
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const clearList = () => {
    setListText("");
    setListTerms([]);
    textareaRef.current?.focus();
  };

  const termName = (i: number) => terms.find((x) => x.index === i)?.text ?? "";
  const stopWord = stopping ? t("find.stopping") : t("find.stop");
  const foundCount = terms.length - missing.length;
  const complete = coverage?.complete === true && coverage.state !== "running";
  const leftOut = [
    parsed.duplicates > 0 ? tc(parsed.duplicates, "find.listDuplicatesOne", "find.listDuplicatesMany") : null,
    parsed.tooLong > 0 ? tc(parsed.tooLong, "find.listTooLongOne", "find.listTooLongMany") : null,
    parsed.overLimit > 0 ? tc(parsed.overLimit, "find.listOverLimitOne", "find.listOverLimitMany") : null,
  ].filter((x): x is string => x !== null);

  return (
    <section className="finder" data-testid="finder" data-mode={choices.mode} aria-labelledby="finder-heading">
      <header className="find-header">
        <h2 id="finder-heading" tabIndex={-1}>
          {t("find.heading")}
        </h2>
        <p className="find-intro">{t("find.intro")}</p>
      </header>

      {/* 1. Where to look */}
      <div className="find-card find-where" role="group" aria-labelledby="find-where-title">
        <div className="find-card-head">
          <span className="find-step" aria-hidden="true">
            {formatNumber(1)}
          </span>
          <h3 id="find-where-title">{t("find.stepWhere")}</h3>
          <label className="find-toggle" title={t("find.subfoldersNote")}>
            <input
              type="checkbox"
              data-testid="find-subfolders"
              checked={choices.subfolders}
              disabled={scanning}
              onChange={(e) => toggleSubfolders(e.target.checked)}
            />
            <span>{t("find.subfolders")}</span>
          </label>
        </div>
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
                {scanned ? t("find.scanAgain") : t("find.scan")}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 2. What to find */}
      <div className="find-card find-what" role="group" aria-labelledby="find-what-title">
        <div className="find-card-head">
          <span className="find-step" aria-hidden="true">
            {formatNumber(2)}
          </span>
          <h3 id="find-what-title">{t("find.stepWhat")}</h3>
          <div className="find-segmented" role="group" aria-label={t("find.modeLabel")} data-testid="find-mode">
            {(["one", "list"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={choices.mode === m}
                data-testid={`find-mode-${m}`}
                className={choices.mode === m ? "on" : undefined}
                onClick={() => updateChoices({ mode: m })}
              >
                {m === "one" ? t("find.modeOne") : t("find.modeList")}
              </button>
            ))}
          </div>
        </div>

        {list ? (
          <div className="find-list" data-testid="find-list">
            <label htmlFor="find-list-text" className="sr-only">
              {t("find.listLabel")}
            </label>
            <textarea
              id="find-list-text"
              ref={textareaRef}
              data-testid="find-list-text"
              className="find-list-text"
              rows={5}
              spellCheck={false}
              autoComplete="off"
              placeholder={t("find.listPlaceholder")}
              value={listText}
              onChange={(e) => setListText(e.target.value)}
            />
            <div className="find-list-bar">
              <span className="find-list-count" data-testid="find-list-count">
                {parsed.terms.length === 0
                  ? t("find.listEmpty")
                  : tc(parsed.terms.length, "find.listCountOne", "find.listCountMany")}
              </span>
              {leftOut.length > 0 && (
                <span className="find-list-left" data-testid="find-list-left">
                  {leftOut.join(" · ")}
                </span>
              )}
              <span className="find-list-tools">
                <label className="find-inline">
                  <span>{t("find.splitLabel")}</span>
                  <select
                    data-testid="find-split"
                    value={choices.separator}
                    onChange={(e) => updateChoices({ separator: e.target.value as Separator })}
                  >
                    {SEPARATORS.map((s) => (
                      <option key={s} value={s}>
                        {t(`find.split.${s}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="find-check-label" title={t("find.namesOnlyNote")}>
                  <input
                    type="checkbox"
                    data-testid="find-names-only"
                    checked={choices.namesOnly}
                    onChange={(e) => updateChoices({ namesOnly: e.target.checked })}
                  />
                  <span>{t("find.namesOnly")}</span>
                </label>
                {listText !== "" && (
                  <button type="button" className="link" data-testid="find-list-clear" onClick={clearList}>
                    {t("find.listClear")}
                  </button>
                )}
              </span>
            </div>
            {parsed.terms.length > 0 && (
              <ul className="find-chips" aria-label={t("find.listLabel")} data-testid="find-chips">
                {parsed.terms.slice(0, CHIPS_SHOWN).map((x) => (
                  <li key={x} className="find-chip" title={x}>
                    {x}
                  </li>
                ))}
                {parsed.terms.length > CHIPS_SHOWN && (
                  <li className="find-chip more">{t("find.listMore", { n: formatNumber(parsed.terms.length - CHIPS_SHOWN) })}</li>
                )}
              </ul>
            )}
          </div>
        ) : (
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
              onPaste={onPasteOne}
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
        )}

        <div className="find-options" role="group" aria-label={t("find.optionsLabel")}>
          <label className="find-check-label" title={t("find.matchCaseNote")}>
            <input
              type="checkbox"
              data-testid="find-match-case"
              checked={choices.matchCase}
              onChange={(e) => updateChoices({ matchCase: e.target.checked })}
            />
            <span>{t("find.matchCase")}</span>
          </label>
          <label className="find-check-label" title={t("find.wholeNameNote")}>
            <input
              type="checkbox"
              data-testid="find-whole-name"
              checked={choices.wholeName}
              onChange={(e) => updateChoices({ wholeName: e.target.checked })}
            />
            <span>{t("find.wholeName")}</span>
          </label>
          <label className="find-inline find-show">
            <span>{t("find.showLabel")}</span>
            <select
              data-testid="find-entries"
              value={choices.entries}
              onChange={(e) => updateChoices({ entries: e.target.value as FindEntryFilter })}
            >
              <option value="all">{t("find.showAll")}</option>
              <option value="files">{t("find.showFiles")}</option>
              <option value="folders">{t("find.showFolders")}</option>
            </select>
          </label>
        </div>
      </div>

      <Live className="find-status" data-testid="find-status">
        {statusText(result, asked ? "x" : "")}
      </Live>
      <Live className="sr-only" data-testid="find-notice">
        {notice}
      </Live>
      {coverage !== null && coverage.state !== "idle" && !coverage.subfolders && (
        <p className="find-note" data-testid="find-subfolders-off">
          {t("find.subfoldersOff")}
        </p>
      )}
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

      {list && terms.length > 0 && (
        <div className="find-terms" role="group" aria-labelledby="find-terms-title" data-testid="find-terms">
          <div className="find-terms-head">
            <h3 id="find-terms-title">{t("find.termsLabel")}</h3>
            <span className="find-terms-score" data-testid="find-terms-score">
              {t("find.termsFound", { found: formatNumber(foundCount), n: formatNumber(terms.length) })}
            </span>
            {missing.length > 0 && (
              <span className="find-terms-missing" data-testid="find-terms-missing">
                {complete
                  ? tc(missing.length, "find.termsMissingOne", "find.termsMissingMany")
                  : tc(missing.length, "find.termsMissingIncompleteOne", "find.termsMissingIncompleteMany")}
              </span>
            )}
            {missing.length > 0 && (
              <button type="button" className="link" data-testid="find-copy-missing" onClick={copyMissing}>
                {t("find.copyMissing")}
              </button>
            )}
          </div>
          <ul className="find-term-list" data-testid="find-term-list">
            <li>
              <button
                type="button"
                className={termFilter === null ? "find-term all on" : "find-term all"}
                aria-pressed={termFilter === null}
                data-testid="find-term-all"
                onClick={() => setTermFilter(null)}
              >
                {t("find.termAll")}
              </button>
            </li>
            {terms.map((x) => (
              <li key={x.index}>
                <button
                  type="button"
                  className={termFilter === x.index ? "find-term on" : "find-term"}
                  data-testid="find-term"
                  data-found={x.hits > 0}
                  aria-pressed={termFilter === x.index}
                  disabled={x.hits === 0}
                  title={
                    x.hits === 0
                      ? t("find.termChipNone", { name: x.text })
                      : tn(x.hits, "find.termChipOne", "find.termChipMany", { name: x.text, n: formatNumber(x.hits) })
                  }
                  onClick={() => setTermFilter(termFilter === x.index ? null : x.index)}
                >
                  <span className="find-term-text">{x.text}</span>
                  <span className="find-term-count">{x.hits === 0 ? t("find.termNotFound") : formatNumber(x.hits)}</span>
                </button>
              </li>
            ))}
          </ul>
          {termFilter !== null && (
            <p className="find-note" data-testid="find-term-showing">
              {t("find.termShowing", { name: termName(termFilter) })}
            </p>
          )}
        </div>
      )}

      {shown.length > 0 && (
        <div className="find-results" data-testid="find-results">
          <div className="find-head">
            <span className="find-check-cell">
              <input
                type="checkbox"
                data-testid="find-select-all"
                aria-label={t("find.selectAll")}
                title={t("find.selectAll")}
                checked={allShownChecked}
                ref={(el) => {
                  if (el) el.indeterminate = someShownChecked && !allShownChecked;
                }}
                onChange={toggleAllShown}
              />
            </span>
            <span className="find-head-cols" aria-hidden="true">
              <span />
              <span className="col-name">{t("find.colName")}</span>
              <span>{t("find.colInArchive")}</span>
              <span>{t("find.colArchive")}</span>
              <span className="col-size">{t("find.colSize")}</span>
              <span>{t("find.colModified")}</span>
            </span>
          </div>
          <ul ref={listRef} aria-label={t("find.results")} data-testid="find-hits" onKeyDown={onListKey}>
            {shown.map((h, i) => {
              const { name, folder } = splitPath(h.path);
              const id = hitId(h);
              const tab = picked === null ? i === 0 : picked === id;
              const isChecked = checked.has(id);
              return (
                <li key={id} className={isChecked ? "find-row checked" : "find-row"}>
                  <span className="find-check-cell">
                    <input
                      type="checkbox"
                      data-testid="find-hit-check"
                      tabIndex={-1}
                      aria-label={t("find.selectRow", { name: h.path.text })}
                      checked={isChecked}
                      onChange={() => toggle(h)}
                    />
                  </span>
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
                      } else if (e.key === " ") {
                        e.preventDefault();
                        setPicked(id);
                        toggle(h);
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
                      {list &&
                        h.terms
                          .map(termName)
                          .filter((x) => x.toLowerCase() !== name.text.toLowerCase())
                          .map((x) => (
                            <span key={x} className="find-term-tag" data-testid="find-term-tag" title={t("find.matchedTerm", { name: x })}>
                              {x}
                            </span>
                          ))}
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
      {result !== null && result.total_hits > hits.length && hits.length > 0 && (
        <p className="find-note" data-testid="find-shown-of-total">
          {t("find.shownOfTotal", { shown: formatNumber(hits.length), total: formatNumber(result.total_hits) })}
        </p>
      )}

      {hits.length > 0 && (
        <div className="find-actionbar" data-testid="find-actionbar" data-active={chosen.length > 0}>
          <span className="find-actionbar-text" data-testid="find-selection">
            {chosen.length === 0 ? (
              t("find.selectionNone")
            ) : (
              <>
                <strong>
                  {tn(chosen.length, "find.selectionOne", "find.selectionMany", {
                    n: formatNumber(chosen.length),
                    size: shortSize(totalSize(chosen)),
                  })}
                </strong>{" "}
                <span className="find-actionbar-from">
                  {tc(archivesOf(chosen), "find.selectionArchivesOne", "find.selectionArchivesMany")}
                </span>
              </>
            )}
          </span>
          {chosen.length > 0 && (
            <button type="button" className="link" data-testid="find-clear-selection" onClick={() => setChecked(new Set())}>
              {t("find.clearSelection")}
            </button>
          )}
          <button
            type="button"
            className="primary"
            data-testid="find-retrieve"
            disabled={chosen.length === 0 || scanning}
            onClick={() => setRetrieving(true)}
          >
            <ExtractIcon />
            {t("find.retrieve")}
          </button>
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
      {retrieving && chosen.length > 0 && <RetrieveDialog hits={chosen} onClose={() => setRetrieving(false)} />}
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
