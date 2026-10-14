import { useState } from "react";

import { errorText, shortSize } from "../browser/format";
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

const SCOPES: { id: ScopeId; label: string }[] = [
  { id: "head", label: "Latest snapshot only" },
  { id: "retained", label: "Every retained snapshot" },
  { id: "all", label: "Every snapshot, including expired ones" },
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

  const go = () => {
    if (!archive) return;
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
          setView({ state: "failed", lines: ["Cancelled. The search stopped before it finished."] });
        } else if (o.status === "failed") {
          setView({
            state: "failed",
            lines: [
              `The search did not run (${o.code}): ${o.message}`,
              ...(o.code === "RETENTION_UNRESOLVED"
                ? ["Retention could not be rebuilt, so the retained snapshots cannot be listed. Search every snapshot instead."]
                : []),
            ],
          });
        } else {
          setView({
            state: "failed",
            lines: [o.status === "aborted" ? `Stopped unexpectedly: ${o.message}` : "The search did not finish."],
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
      setView({ state: "failed", lines: [errorText("Could not start the search", err)] }),
    );
  };

  const cancel = () => {
    if (view.state === "running" && view.jobId !== null) void cancelJob(view.jobId).catch(() => false);
  };

  return (
    <section aria-labelledby="search-heading" className="search" data-testid="search">
      <h2 id="search-heading">Search names</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!running) go();
        }}
      >
        <label>
          Part of a path{" "}
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
          Ignore case (ASCII letters only)
        </label>
        <label>
          Snapshots{" "}
          <select value={scope} onChange={(e) => setScope(e.target.value as ScopeId)} data-testid="search-scope">
            {SCOPES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Kind{" "}
          <select value={kind} onChange={(e) => setKind(e.target.value as KindId)} data-testid="search-kind">
            <option value="any">Files and folders</option>
            <option value="file">Files</option>
            <option value="directory">Folders</option>
          </select>
        </label>
        <div className="actions">
          <button type="submit" data-testid="search-go" disabled={!archive || running}>
            Search
          </button>
          <button type="button" data-testid="search-cancel" onClick={cancel} disabled={!running}>
            Cancel
          </button>
        </div>
      </form>
      <p className="note">
        Searches the names of entries in the archive. File contents are not searched.
      </p>
      {view.state === "running" && (
        <p data-testid="search-running">
          Searching… {view.completed}
          {view.total !== null ? ` of ${view.total}` : ""} snapshots
        </p>
      )}
      {view.state === "failed" && (
        <div role="alert" className="error" data-testid="search-failed">
          {view.lines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
      )}
      {view.state === "done" && (
        <div data-testid="search-result">
          <div
            role="status"
            data-testid="search-coverage"
            data-complete={view.result.coverage.complete}
            className={view.result.coverage.complete ? "coverage" : "coverage partial"}
          >
            <p>
              <strong>{view.result.coverage.complete ? "Coverage complete" : "Coverage PARTIAL"}</strong>
            </p>
            {coverageLines(view.result.coverage).map((l) => (
              <p key={l}>{l}</p>
            ))}
          </div>
          <p data-testid="search-count">
            {view.result.total_hits.toLocaleString("en-US")}{" "}
            {view.result.total_hits === 1 ? "match" : "matches"}
            {view.result.total_hits > view.result.hits.length
              ? `; the first ${view.result.hits.length.toLocaleString("en-US")} are shown`
              : ""}
            .
          </p>
          <ul aria-label="Matches" data-testid="search-hits">
            {view.result.hits.map((h) => (
              <li key={`${h.seq}:${h.path.text}`} data-testid="search-hit">
                commit {h.seq} · {h.kind === "directory" ? "folder" : "file"} · <Name name={h.path} />
                {h.kind === "file" ? ` · ${shortSize(h.size)}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
