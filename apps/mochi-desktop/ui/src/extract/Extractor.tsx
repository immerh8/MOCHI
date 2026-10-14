import { useCallback, useEffect, useRef, useState } from "react";

import { useJobFocus } from "../a11y/focus";
import { Live } from "../a11y/Live";
import { Panel } from "../a11y/Panel";
import { ProgressMeter } from "../a11y/ProgressMeter";
import { errorText } from "../browser/format";
import { t, tc } from "../i18n";
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
  /**
   * The shell asked to extract this archive (D6): when `token` changes, show
   * the plan for the whole snapshot into the folder Rust already chose. Nothing
   * is written until the user confirms it.
   */
  autoPlan?: { token: number; handle: number } | null;
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
export function Extractor({ archive, seq, selected, autoPlan = null }: ExtractorProps) {
  const [scope, setScope] = useState<Scope | null>(null);
  const [plan, setPlan] = useState<ExtractPlan | null>(null);
  const [job, setJob] = useState<JobView>({ state: "idle" });
  const [error, setError] = useState<string | null>(null);

  const busy = job.state === "starting" || job.state === "running";
  const rememberFocus = useJobFocus(busy);
  const handle = archive?.handle ?? null;

  // The panel takes focus when it opens (which scrolls it into view); the
  // result opens below the buttons, so bring it into view when it appears.
  const resultRef = useRef<HTMLDivElement>(null);
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
          setError(errorText(t("extract.folderFailed"), e));
        },
      );
    },
    [handle, seq],
  );

  // An extract asked for by the shell: plan the whole snapshot into the folder
  // Rust chose (no dialog), once per request and only for that archive.
  const plannedTokenRef = useRef(0);
  useEffect(() => {
    if (autoPlan === null || autoPlan.token === plannedTokenRef.current) return;
    if (handle !== autoPlan.handle || seq === null) return;
    plannedTokenRef.current = autoPlan.token;
    planExtract(handle, seq, [], false).then(
      (p) => {
        if (p === null) return;
        setScope({ kind: "all" });
        setPlan(p);
      },
      (e: unknown) => {
        setScope({ kind: "all" });
        setError(errorText(t("extract.folderFailed"), e));
      },
    );
  }, [autoPlan, handle, seq]);

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
    rememberFocus();
    setError(null);
    setJob({ state: "starting" });
    startJob({ kind: "extract_archive", handle, seq, keys: keysOf(scope), on_conflict }, onEvent).catch(
      (e: unknown) => {
        setJob({ state: "idle" });
        setError(errorText(t("extract.startFailed"), e));
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
      <h2 id="extract-heading" tabIndex={-1}>
        {t("extract.heading")}
      </h2>
      <div className="actions">
        <button
          type="button"
          data-testid="extract-all"
          onClick={() => planFor({ kind: "all" }, true)}
          disabled={busy || archive === null || seq === null}
          title={archive ? undefined : t("extract.openFirst")}
        >
          {t("extract.all")}
        </button>
        <button
          type="button"
          data-testid="extract-selected"
          onClick={() => selected && planFor({ kind: "selected", entry: selected }, true)}
          disabled={busy || archive === null || seq === null || selected === null}
          title={!archive ? t("extract.openFirst") : selected ? undefined : t("extract.selectFirst")}
        >
          {t("extract.selected")}
        </button>
      </div>
      {error && (
        <p role="alert" className="error" data-testid="extract-error">
          {error}
        </p>
      )}

      {scope !== null && plan !== null && (
        <Panel
          label={t("extract.group")}
          heading={t("extract.panelHeading")}
          testId="extract-panel"
          fallbackId="extract-heading"
        >
          <dl>
            <dt>{t("extract.folder")}</dt>
            <dd data-testid="extract-destination">{plan.destination}</dd>
            <dt>{t("extract.what")}</dt>
            <dd data-testid="extract-scope">
              {scope.kind === "all" ? (
                t("extract.wholeCommit", { seq: seq ?? "" })
              ) : (
                <>
                  <Name name={scope.entry.name} />
                  {t("extract.entryFromCommit", { seq: seq ?? "" })}
                </>
              )}
              {t("extract.entriesCount", {
                count: tc(plan.entries, "count.entryOne", "count.entryMany"),
              })}
            </dd>
          </dl>
          {scope.kind === "selected" && (
            <p className="note">{t("extract.parentsNote")}</p>
          )}
          <p className="note">{FOLDER_NOTE}</p>
          {plan.case_insensitive && (
            <p className="note">{t("extract.caseInsensitive")}</p>
          )}
          {hasConflicts ? (
            <div data-testid="extract-conflicts">
              <p role="note" className="warning">
                {t(plan.conflicts_total === 1 ? "extract.cannotOne" : "extract.cannotMany", {
                  n: plan.conflicts_total.toLocaleString("en-US"),
                })}
              </p>
              <ul className="staged" aria-label={t("extract.cannotList")}>
                {plan.conflicts.map((c) => (
                  <li key={`${c.code}:${c.path.text}`} data-testid="extract-conflict">
                    <Name name={c.path} /> <span className="meta">({c.code})</span> {c.reason}
                  </li>
                ))}
              </ul>
              {plan.conflicts_total > plan.conflicts.length && (
                <p className="note">
                  {t("common.andMore", { n: (plan.conflicts_total - plan.conflicts.length).toLocaleString("en-US") })}
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
              {t("extract.noConflicts")}
            </p>
          )}
          <div className="actions">
            <button
              type="button"
              data-testid="extract-confirm"
              onClick={() => start(hasConflicts ? "skip_conflicts" : "stop")}
              disabled={busy}
            >
              {hasConflicts ? t("extract.confirmSkip") : t("extract.confirm")}
            </button>
            <button
              type="button"
              data-testid="extract-change-folder"
              onClick={() => planFor(scope, true)}
              disabled={busy}
            >
              {t("extract.changeFolder")}
            </button>
            <button
              type="button"
              data-testid="extract-recheck"
              onClick={() => planFor(scope, false)}
              disabled={busy}
            >
              {t("extract.recheck")}
            </button>
            <button type="button" data-testid="extract-close" onClick={close} disabled={busy}>
              {t("common.close")}
            </button>
          </div>
        </Panel>
      )}

      {busy && (
        <div className="progress" data-testid="extract-running">
          {job.state === "running" && (
            <>
              <ProgressMeter
                completed={job.completed}
                total={job.total}
                text={
                  (job.phase ? progressText(job.phase, job.completed, job.total) : t("common.starting")) +
                  (job.cancelRequested ? t("common.cancelling") : "")
                }
                textTestId="extract-progress"
              />
            </>
          )}
          {job.state === "starting" && <span>{t("common.starting")}</span>}
          <button
            type="button"
            data-testid="extract-cancel"
            onClick={cancel}
            disabled={job.state !== "running" || job.cancelRequested}
          >
            {t("common.cancel")}
          </button>
        </div>
      )}

      <Live
        ref={resultRef}
        data-testid="extract-status"
        data-state={job.state === "done" ? job.outcome.status : undefined}
        data-complete={
          job.state === "done" ? described?.completed === true && (report?.not_extracted_total ?? 0) === 0 : undefined
        }
      >
        {described && job.state === "done" && (
          <>
          <p data-testid="extract-headline">{described.headline}</p>
          {report && report.not_extracted.length > 0 && (
            <>
              <p className="warning">{t("extract.notExtracted")}</p>
              <ul className="staged" data-testid="extract-not-extracted" aria-label={t("extract.notExtractedList")}>
                {report.not_extracted.map((e) => (
                  <li key={`${e.code}:${e.path.text}`} data-testid="extract-not-extracted-item">
                    <Name name={e.path} /> <span className="meta">({e.code})</span> {e.reason.text}
                    {e.reason.verbatim ? "" : t("common.escapedMarker")}
                  </li>
                ))}
              </ul>
              {report.not_extracted_total > report.not_extracted.length && (
                <p className="note">
                  {t("common.andMore", {
                    n: (report.not_extracted_total - report.not_extracted.length).toLocaleString("en-US"),
                  })}
                </p>
              )}
            </>
          )}
          {report && report.attribute_notes.length > 0 && (
            <ul className="staged" data-testid="extract-attributes" aria-label={t("extract.attributesList")}>
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
          </>
        )}
      </Live>
    </section>
  );
}
