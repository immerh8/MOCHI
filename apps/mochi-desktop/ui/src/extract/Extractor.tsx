import { useCallback, useEffect, useRef, useState } from "react";

import { errorText } from "../browser/format";
import { Name } from "../browser/Name";
import { planExtract } from "../ipc/extract";
import type { ConflictChoice, ExtractPlan } from "../ipc/extract";
import type { ArchiveSummary, NameText } from "../ipc/browse";
import { cancelJob, startJob } from "../ipc/jobs";
import type { JobEvent, JobOutcome } from "../ipc/jobs";
import {
  attributeLine,
  CONFLICT_NOTE,
  describe,
  FOLDER_NOTE,
  NOT_OFFERED_NOTE,
  progressText,
} from "./messages";

/** The entry the list has selected: "Extract selected" extracts it. */
export type SelectedEntry = { key: string; name: NameText };

export interface ExtractorProps {
  /** The open archive, if any. */
  archive: ArchiveSummary | null;
  /** The snapshot on screen: the one extracted from. */
  seq: number | null;
  selected: SelectedEntry | null;
}

type Scope = { kind: "all" } | { kind: "selected"; entry: SelectedEntry };

type JobView =
  | { state: "idle" }
  | { state: "starting" }
  | {
      state: "running";
      jobId: number;
      phase: string;
      completed: number;
      total: number | null;
      cancelRequested: boolean;
    }
  | { state: "done"; outcome: JobOutcome };

/**
 * Plan D3: extract a whole snapshot or the selected entry into a folder. The
 * folder is chosen in a native dialog shown by Rust; this component never
 * holds a path the user did not see, and the job runs in Rust over the shared
 * job channel. What was not extracted, and why, is listed as text.
 */
export function Extractor({ archive, seq, selected }: ExtractorProps) {
  const [scope, setScope] = useState<Scope | null>(null);
  const [plan, setPlan] = useState<ExtractPlan | null>(null);
  const [job, setJob] = useState<JobView>({ state: "idle" });
  const [error, setError] = useState<string | null>(null);

  const busy = job.state === "starting" || job.state === "running";
  const handle = archive?.handle ?? null;

  // The panel and the result open below the buttons, which can be below the
  // fold of a small window: bring each into view when it appears.
  const panelRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (plan !== null) panelRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [plan]);
  useEffect(() => {
    if (job.state === "done") resultRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [job.state]);

  // A different archive or snapshot makes the plan and the last result stale.
  const identity = `${handle ?? ""}:${seq ?? ""}`;
  const identityRef = useRef(identity);
  useEffect(() => {
    if (identityRef.current === identity) return;
    identityRef.current = identity;
    setScope(null);
    setPlan(null);
    setError(null);
    setJob((j) => (j.state === "done" ? { state: "idle" } : j));
  }, [identity]);

  const keysOf = (s: Scope): string[] => (s.kind === "all" ? [] : [s.entry.key]);

  /** Show the folder dialog (or check the chosen folder again) and plan. */
  const planFor = useCallback(
    (s: Scope, pick: boolean) => {
      if (handle === null || seq === null) return;
      setError(null);
      setJob({ state: "idle" });
      planExtract(handle, seq, keysOf(s), pick).then(
        (p) => {
          if (p === null) return; // the user cancelled the folder dialog
          setScope(s);
          setPlan(p);
        },
        (e: unknown) => {
          setScope(s);
          setError(errorText("Could not check the folder", e));
        },
      );
    },
    [handle, seq],
  );

  const onEvent = useCallback((event: JobEvent) => {
    setJob((prev) => {
      switch (event.event) {
        case "started":
          return prev.state === "running"
            ? prev
            : { state: "running", jobId: event.job_id, phase: "", completed: 0, total: null, cancelRequested: false };
        case "progress":
          if (prev.state === "done") return prev;
          return {
            state: "running",
            jobId: event.job_id,
            phase: event.phase,
            completed: event.completed,
            total: event.total,
            cancelRequested: prev.state === "running" && prev.cancelRequested,
          };
        case "finished":
          return { state: "done", outcome: event.outcome };
      }
    });
    // A completed extraction makes its plan stale (what it wrote now
    // collides); a cancelled or failed one keeps the panel for another try.
    if (event.event === "finished" && event.outcome.status === "completed") {
      setScope(null);
      setPlan(null);
    }
  }, []);

  const start = (on_conflict: ConflictChoice) => {
    if (handle === null || seq === null || scope === null) return;
    setError(null);
    setJob({ state: "starting" });
    startJob({ kind: "extract_archive", handle, seq, keys: keysOf(scope), on_conflict }, onEvent).catch(
      (e: unknown) => {
        setJob({ state: "idle" });
        setError(errorText("Could not start", e));
      },
    );
  };

  const cancel = () => {
    if (job.state !== "running") return;
    const { jobId } = job;
    setJob({ ...job, cancelRequested: true });
    cancelJob(jobId).catch(() => undefined);
  };

  const close = () => {
    setScope(null);
    setPlan(null);
    setError(null);
    setJob({ state: "idle" });
  };

  const described = job.state === "done" ? describe(job.outcome) : null;
  const report = job.state === "done" && job.outcome.status === "completed" ? job.outcome.extract : undefined;
  const hasConflicts = plan !== null && plan.conflicts_total > 0;

  return (
    <section aria-labelledby="extract-heading" className="extractor" data-testid="extractor">
      <h2 id="extract-heading">Extract</h2>
      <div className="actions">
        <button
          type="button"
          data-testid="extract-all"
          onClick={() => planFor({ kind: "all" }, true)}
          disabled={busy || archive === null || seq === null}
          title={archive ? undefined : "Open an archive first"}
        >
          Extract all…
        </button>
        <button
          type="button"
          data-testid="extract-selected"
          onClick={() => selected && planFor({ kind: "selected", entry: selected }, true)}
          disabled={busy || archive === null || seq === null || selected === null}
          title={!archive ? "Open an archive first" : selected ? undefined : "Select an entry first"}
        >
          Extract selected…
        </button>
      </div>
      {error && (
        <p role="alert" className="error" data-testid="extract-error">
          {error}
        </p>
      )}

      {scope !== null && plan !== null && (
        <div ref={panelRef} className="panel" data-testid="extract-panel" role="group" aria-label="Extract to">
          <h3>Extract to…</h3>
          <dl>
            <dt>Folder</dt>
            <dd data-testid="extract-destination">{plan.destination}</dd>
            <dt>What</dt>
            <dd data-testid="extract-scope">
              {scope.kind === "all" ? (
                <>The whole of commit {seq}</>
              ) : (
                <>
                  <Name name={scope.entry.name} /> from commit {seq}
                </>
              )}{" "}
              ({plan.entries.toLocaleString("en-US")} {plan.entries === 1 ? "entry" : "entries"})
            </dd>
          </dl>
          {scope.kind === "selected" && (
            <p className="note">The folders above a selected entry are created too.</p>
          )}
          <p className="note">{FOLDER_NOTE}</p>
          {plan.case_insensitive && (
            <p className="note">This folder treats names that differ only in case as the same name.</p>
          )}
          {hasConflicts ? (
            <div data-testid="extract-conflicts">
              <p role="note" className="warning">
                {plan.conflicts_total.toLocaleString("en-US")}{" "}
                {plan.conflicts_total === 1 ? "entry cannot" : "entries cannot"} be extracted into this
                folder:
              </p>
              <ul className="staged" aria-label="Entries that cannot be extracted">
                {plan.conflicts.map((c) => (
                  <li key={`${c.code}:${c.path.text}`} data-testid="extract-conflict">
                    <Name name={c.path} /> <span className="meta">({c.code})</span> {c.reason}
                  </li>
                ))}
              </ul>
              {plan.conflicts_total > plan.conflicts.length && (
                <p className="note">
                  …and {(plan.conflicts_total - plan.conflicts.length).toLocaleString("en-US")} more.
                </p>
              )}
              <p className="note" data-testid="extract-conflict-note">
                {CONFLICT_NOTE}
              </p>
              <p className="note" data-testid="extract-not-offered">
                {NOT_OFFERED_NOTE}
              </p>
            </div>
          ) : (
            <p className="note" data-testid="extract-no-conflicts">
              Nothing in this folder conflicts with the entries to extract. Nothing is overwritten
              either way.
            </p>
          )}
          <div className="actions">
            <button
              type="button"
              data-testid="extract-confirm"
              onClick={() => start(hasConflicts ? "skip_conflicts" : "stop")}
              disabled={busy}
            >
              {hasConflicts ? "Extract the rest, skipping these" : "Extract"}
            </button>
            <button
              type="button"
              data-testid="extract-change-folder"
              onClick={() => planFor(scope, true)}
              disabled={busy}
            >
              Choose a different folder…
            </button>
            <button
              type="button"
              data-testid="extract-recheck"
              onClick={() => planFor(scope, false)}
              disabled={busy}
            >
              Check again
            </button>
            <button type="button" data-testid="extract-close" onClick={close} disabled={busy}>
              Close
            </button>
          </div>
        </div>
      )}

      {busy && (
        <div className="progress" data-testid="extract-running">
          {job.state === "running" && (
            <>
              <progress
                value={job.total === null ? undefined : job.completed}
                max={job.total ?? undefined}
              />
              <span data-testid="extract-progress">
                {job.phase ? progressText(job.phase, job.completed, job.total) : "Starting…"}
                {job.cancelRequested ? " (cancelling…)" : ""}
              </span>
            </>
          )}
          {job.state === "starting" && <span>Starting…</span>}
          <button
            type="button"
            data-testid="extract-cancel"
            onClick={cancel}
            disabled={job.state !== "running" || job.cancelRequested}
          >
            Cancel
          </button>
        </div>
      )}

      {described && job.state === "done" && (
        <div
          ref={resultRef}
          role="status"
          data-testid="extract-status"
          data-state={job.outcome.status}
          data-complete={described.completed && (report?.not_extracted_total ?? 0) === 0}
        >
          <p data-testid="extract-headline">{described.headline}</p>
          {report && report.not_extracted.length > 0 && (
            <>
              <p className="warning">Not extracted:</p>
              <ul className="staged" data-testid="extract-not-extracted" aria-label="Entries not extracted">
                {report.not_extracted.map((e) => (
                  <li key={`${e.code}:${e.path.text}`} data-testid="extract-not-extracted-item">
                    <Name name={e.path} /> <span className="meta">({e.code})</span> {e.reason.text}
                    {e.reason.verbatim ? "" : " (escaped)"}
                  </li>
                ))}
              </ul>
              {report.not_extracted_total > report.not_extracted.length && (
                <p className="note">
                  …and {(report.not_extracted_total - report.not_extracted.length).toLocaleString("en-US")} more.
                </p>
              )}
            </>
          )}
          {report && report.attribute_notes.length > 0 && (
            <ul className="staged" data-testid="extract-attributes" aria-label="Attributes not applied">
              {report.attribute_notes.map((n) => (
                <li key={n.attribute} data-testid="extract-attribute-note">
                  {attributeLine(n)}
                </li>
              ))}
            </ul>
          )}
          {described.notes.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
      )}
    </section>
  );
}
