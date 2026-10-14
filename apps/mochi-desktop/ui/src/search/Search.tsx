import { useState } from "react";

import { useJobFocus } from "../a11y/focus";
import { Live } from "../a11y/Live";
import { errorText, shortSize } from "../browser/format";
import { t, tn } from "../i18n";
import { Name } from "../browser/Name";
import type { ArchiveSummary } from "../ipc/browse";
import { coverageLines } from "../crypt/messages";
import type { SearchResultView, SearchScopeChoice } from "../ipc/crypt";
import { cancelJob, startJob } from "../ipc/jobs";
import type { JobEvent } from "../ipc/jobs";

type ScopeId = "head" | "retained" | "all";
type KindId = "any" | "file" | "directory";

type View =
  | { state: "idle" }
  | { state: "running"; jobId: number | null; completed: number; total: number | null }
  | { state: "done"; result: SearchResultView }
  | { state: "failed"; lines: string[] };

const SCOPES: { id: ScopeId; label: () => string }[] = [
  { id: "head", label: () => t("search.scopeHead") },
  { id: "retained", label: () => t("search.scopeRetained") },
  { id: "all", label: () => t("search.scopeAll") },
];

function scopeOf(id: ScopeId): SearchScopeChoice {
  return { scope: id };
}

/**
 * Plan D5 search: names in the open archive's snapshots, through
 * `mochi_core::search`. The coverage is always shown with the result: what was
 * searched, what was not, and that file contents are never searched. Hit
 * paths arrive escaped and are rendered as text only.
 */
export function Search({ archive }: { archive: ArchiveSummary | null }) {
  const [query, setQuery] = useState("");
  const [ignoreCase, setIgnoreCase] = useState(true);
  const [scope, setScope] = useState<ScopeId>("head");
  const [kind, setKind] = useState<KindId>("any");
  const [view, setView] = useState<View>({ state: "idle" });

  const running = view.state === "running";
  const rememberFocus = useJobFocus(running);

  const go = () => {
    if (!archive) return;
    rememberFocus();
    setView({ state: "running", jobId: null, completed: 0, total: null });
    const onEvent = (e: JobEvent) => {
      if (e.event === "started") {
        setView((v) => (v.state === "running" ? { ...v, jobId: e.job_id } : v));
      } else if (e.event === "progress") {
        setView((v) =>
          v.state === "running" ? { ...v, completed: e.completed, total: e.total } : v,
        );
      } else {
        const o = e.outcome;
        if (o.status === "completed" && o.search) {
          setView({ state: "done", result: o.search });
        } else if (o.status === "cancelled") {
          setView({ state: "failed", lines: [t("search.cancelled")] });
        } else if (o.status === "failed") {
          setView({
            state: "failed",
            lines: [
              t("search.didNotRun", { code: o.code, message: o.message }),
              ...(o.code === "RETENTION_UNRESOLVED" ? [t("search.retentionUnresolved")] : []),
            ],
          });
        } else {
          setView({
            state: "failed",
            lines: [
              o.status === "aborted"
                ? t("common.stoppedUnexpectedly", { message: o.message })
                : t("search.didNotFinish"),
            ],
          });
        }
      }
    };
    startJob(
      {
        kind: "search_archive",
        handle: archive.handle,
        query,
        ignore_case: ignoreCase,
        scope: scopeOf(scope),
        entry_kind: kind === "any" ? null : kind,
      },
      onEvent,
    ).catch((err: unknown) =>
      setView({ state: "failed", lines: [errorText(t("search.startFailed"), err)] }),
    );
  };

  const cancel = () => {
    if (view.state === "running" && view.jobId !== null) void cancelJob(view.jobId).catch(() => false);
  };

  return (
    <section aria-labelledby="search-heading" className="search" data-testid="search">
      <h2 id="search-heading" tabIndex={-1}>
        {t("search.heading")}
      </h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!running) go();
        }}
      >
        <label>
          {t("search.query")}{" "}
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="search-query"
            disabled={!archive}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={ignoreCase}
            onChange={(e) => setIgnoreCase(e.target.checked)}
            data-testid="search-ignore-case"
          />{" "}
          {t("search.ignoreCase")}
        </label>
        <label>
          {t("search.snapshots")}{" "}
          <select value={scope} onChange={(e) => setScope(e.target.value as ScopeId)} data-testid="search-scope">
            {SCOPES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label()}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("search.kind")}{" "}
          <select value={kind} onChange={(e) => setKind(e.target.value as KindId)} data-testid="search-kind">
            <option value="any">{t("search.kindAny")}</option>
            <option value="file">{t("search.kindFile")}</option>
            <option value="directory">{t("search.kindDirectory")}</option>
          </select>
        </label>
        <div className="actions">
          <button type="submit" data-testid="search-go" disabled={!archive || running}>
            {t("search.go")}
          </button>
          <button type="button" data-testid="search-cancel" onClick={cancel} disabled={!running}>
            {t("common.cancel")}
          </button>
        </div>
      </form>
      <p className="note">{t("search.note")}</p>
      {view.state === "running" && (
        <p data-testid="search-running">
          {view.total !== null
            ? t("search.runningOf", { completed: view.completed, total: view.total })
            : t("search.running", { completed: view.completed })}
        </p>
      )}
      {view.state === "failed" && (
        <div role="alert" className="error" data-testid="search-failed">
          {view.lines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
      )}
      <Live
        data-testid="search-coverage"
        data-complete={view.state === "done" ? view.result.coverage.complete : undefined}
        className={view.state === "done" && !view.result.coverage.complete ? "coverage partial" : "coverage"}
      >
        {view.state === "done" && (
          <>
            <p>
              <strong>
                {view.result.coverage.complete ? t("search.coverageComplete") : t("search.coveragePartial")}
              </strong>
            </p>
            {coverageLines(view.result.coverage).map((l) => (
              <p key={l}>{l}</p>
            ))}
          </>
        )}
      </Live>
      {view.state === "done" && (
        <div data-testid="search-result">
          <p data-testid="search-count">
            {t("search.count", {
              total: view.result.total_hits.toLocaleString("en-US"),
              noun: tn(view.result.total_hits, "search.matchOne", "search.matchMany"),
              shown:
                view.result.total_hits > view.result.hits.length
                  ? t("search.countShown", { n: view.result.hits.length.toLocaleString("en-US") })
                  : "",
            })}
          </p>
          <ul aria-label={t("search.matches")} data-testid="search-hits">
            {view.result.hits.map((h) => (
              <li key={`${h.seq}:${h.path.text}`} data-testid="search-hit">
                {t("search.hit", {
                  seq: h.seq,
                  kind: t(h.kind === "directory" ? "search.hitFolder" : "search.hitFile"),
                })}
                <Name name={h.path} />
                {h.kind === "file" ? t("search.hitSize", { size: shortSize(h.size) }) : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
