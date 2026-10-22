import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useJobFocus } from "../a11y/focus";
import { Hint } from "../a11y/Hint";
import { Panel } from "../a11y/Panel";
import { ProgressMeter } from "../a11y/ProgressMeter";
import { errorText } from "../browser/format";
import { CloseIcon, ExtractIcon, ExtractToIcon, RefreshIcon } from "../icons";
import { availableActions, tipFor } from "../shell/availability";
import { ToolButton, ToolSlot } from "../shell/Shell";
import { formatNumber, t, tc } from "../i18n";
import { logRecord } from "../result/details";
import { ResultBar } from "../result/Result";
import { Name } from "../browser/Name";
import { ExtractToDialog } from "./ExtractToDialog";
import { useNewFolderRun } from "./useNewFolderRun";
import { planExtract } from "../ipc/extract";
import { discardExtractFolder, planExtractDefault, planExtractTo, showInFolder } from "../ipc/start";
import type { ConflictChoice, ExtractPlan } from "../ipc/extract";
import type { ArchiveSummary, NameText } from "../ipc/browse";
import { cancelJob, startJob } from "../ipc/jobs";
import type { JobEvent, JobOutcome } from "../ipc/jobs";
import {
  conflictNote,
  describe,
  folderNote,
  notOfferedNote,
  progressText,
} from "./messages";

/** An entry the list has selected: Extract extracts the selection. */
export type SelectedEntry = { key: string; name: NameText };

export interface ExtractorProps {
  /** The open archive, if any. */
  archive: ArchiveSummary | null;
  /** The snapshot on screen: the one extracted from. */
  seq: number | null;
  /** What the list has selected; with nothing selected, Extract takes everything. */
  selected: readonly SelectedEntry[];
  /**
   * The shell asked to extract this archive (D6): when `token` changes, show
   * the plan for the whole snapshot into the folder Rust already chose. Nothing
   * is written until the user confirms it.
   */
  autoPlan?: { token: number; handle: number; defaultFolder?: boolean } | null;
  /**
   * The list's menu asked for Extract to...: when this changes, open the
   * window (the selection, or everything when nothing is selected).
   */
  toRequest?: number;
}

/** Where the folder comes from: made next to the archive, picked, or the one already chosen. */
type FolderMode = "default" | "pick" | "again";

type Scope = { kind: "all" } | { kind: "selected"; entries: readonly SelectedEntry[] };

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
export function Extractor({
  archive,
  seq,
  selected,
  autoPlan = null,
  toRequest = 0,
}: ExtractorProps) {
  const [scope, setScope] = useState<Scope | null>(null);
  const [plan, setPlan] = useState<ExtractPlan | null>(null);
  // The plan's folder is the new one made next to the archive (it is removed
  // again if the plan is closed unused).
  const [madeFolder, setMadeFolder] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [job, setJob] = useState<JobView>({ state: "idle" });
  const [error, setError] = useState<string | null>(null);

  const busy = job.state === "starting" || job.state === "running";
  // The "Extract to..." window is open for this scope.
  const [wizard, setWizard] = useState<Scope | null>(null);
  // Set while the running job extracts into a folder Rust just made for it.
  const newFolderRun = useNewFolderRun();
  const startForRef = useRef<((s: Scope, c: ConflictChoice) => void) | null>(null);
  const rememberFocus = useJobFocus(busy);
  const handle = archive?.handle ?? null;
  const avail = availableActions(
    { kind: archive === null ? "none" : "mochi", viewingHead: true, busy },
    { selected: selected.length, total: 0 },
  );

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
    setWizard(null);
    setMadeFolder(false);
    setError(null);
    setJob((j) => (j.state === "done" ? { state: "idle" } : j));
  }, [identity]);

  const keysOf = (s: Scope): string[] => (s.kind === "all" ? [] : s.entries.map((e) => e.key));

  /**
   * Plan into a new folder next to the archive (the default), after the
   * folder dialog, or into the folder chosen earlier. Nothing is written but
   * the new folder.
   */
  const planFor = useCallback(
    (s: Scope, mode: FolderMode) => {
      if (handle === null || seq === null) return;
      setError(null);
      setJob({ state: "idle" });
      const planned =
        mode === "default"
          ? planExtractDefault(handle, seq, keysOf(s))
          : planExtract(handle, seq, keysOf(s), mode === "pick");
      planned.then(
        (p) => {
          if (p === null) return; // the user cancelled the folder dialog
          setScope(s);
          setPlan(p);
          setMadeFolder((was) => (mode === "default" ? true : mode === "again" ? was : false));
        },
        (e: unknown) => {
          setScope(s);
          setError(errorText(t("extract.folderFailed"), e));
        },
      );
    },
    [handle, seq],
  );

  // An extract asked for from the start screen or by the shell: plan the
  // whole snapshot, once per request and only for that archive. The shell's
  // folder is the one Rust already chose; the start screen's is the default.
  const plannedTokenRef = useRef(0);
  useEffect(() => {
    if (autoPlan === null || autoPlan.token === plannedTokenRef.current) return;
    if (handle !== autoPlan.handle || seq === null) return;
    plannedTokenRef.current = autoPlan.token;
    const made = autoPlan.defaultFolder === true;
    (made ? planExtractDefault(handle, seq, []) : planExtract(handle, seq, [], false)).then(
      (p) => {
        if (p === null) return;
        setScope({ kind: "all" });
        setPlan(p);
        setMadeFolder(made);
      },
      (e: unknown) => {
        setScope({ kind: "all" });
        setError(errorText(t("extract.folderFailed"), e));
      },
    );
  }, [autoPlan, handle, seq]);

  // The list's menu: Extract to... (the selection, or everything).
  const seenRequestRef = useRef(toRequest);
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  });
  useEffect(() => {
    if (toRequest === seenRequestRef.current) return;
    seenRequestRef.current = toRequest;
    if (busy) return;
    const entries = [...selectedRef.current];
    queueMicrotask(() => setWizard(entries.length > 0 ? { kind: "selected", entries } : { kind: "all" }));
  }, [toRequest, busy]);

  const onEvent = useCallback((event: JobEvent) => {
    if (event.event === "finished" && newFolderRun.take()) {
      // Nothing was extracted: do not leave an empty new folder behind.
      if (event.outcome.status !== "completed") void discardExtractFolder().catch(() => undefined);
    }
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
      // The technical record goes to the console, once per result.
      const record = describe(event.outcome).record;
      if (record) logRecord(record);
      setScope(null);
      setPlan(null);
      setMadeFolder(false);
    }
  }, [newFolderRun]);

  const startFor = (s: Scope, on_conflict: ConflictChoice) => {
    if (handle === null || seq === null) return;
    rememberFocus();
    setError(null);
    setJob({ state: "starting" });
    startJob({ kind: "extract_archive", handle, seq, keys: keysOf(s), on_conflict }, onEvent).catch(
      (e: unknown) => {
        setJob({ state: "idle" });
        setError(errorText(t("extract.startFailed"), e));
        if (newFolderRun.take()) void discardExtractFolder().catch(() => undefined);
      },
    );
  };
  const start = (on_conflict: ConflictChoice) => {
    if (scope !== null) startFor(scope, on_conflict);
  };

  useEffect(() => {
    startForRef.current = startFor;
  });

  /**
   * OK in the "Extract to..." window: Rust checks the folder and, with
   * `newFolder`, makes a new one named after the archive inside it. With
   * nothing in the way the extraction starts at once; if some entries collide
   * the plan panel lists them first, and nothing is ever overwritten. A folder
   * Rust cannot use rejects, and the window shows why.
   */
  const submitTo = useCallback(
    async (s: Scope, folder: string, newFolder: boolean) => {
      if (handle === null || seq === null) return;
      const p = await planExtractTo(handle, seq, keysOf(s), folder, newFolder);
      setError(null);
      setJob({ state: "idle" });
      setWizard(null);
      if (p.conflicts_total > 0) {
        setScope(s);
        setPlan(p);
        setMadeFolder(newFolder);
        return;
      }
      if (newFolder) newFolderRun.set();
      startForRef.current?.(s, "stop");
    },
    [handle, seq, newFolderRun],
  );

  const cancel = () => {
    if (job.state !== "running") return;
    const { jobId } = job;
    setJob({ ...job, cancelRequested: true });
    cancelJob(jobId).catch(() => undefined);
  };

  const close = () => {
    // A new folder nobody extracted into is tidied up (Rust only removes an empty one).
    if (madeFolder) void discardExtractFolder().catch(() => undefined);
    setScope(null);
    setPlan(null);
    setMadeFolder(false);
    setError(null);
    setJob({ state: "idle" });
  };

  const showFolder = () => {
    setFolderError(null);
    showInFolder({ kind: "extract_destination" }).then(
      () => undefined,
      (e: unknown) => setFolderError(errorText(t("start.showInFolderFailed"), e)),
    );
  };

  // Memoised: the Details panel belongs to one result and is told apart by identity.
  const described = useMemo(() => (job.state === "done" ? describe(job.outcome) : null), [job]);
  const report = job.state === "done" && job.outcome.status === "completed" ? job.outcome.extract : undefined;
  const hasConflicts = plan !== null && plan.conflicts_total > 0;

  // What a running job is doing: in the open dialog (which covers the window), else in the status bar.
  const progressLine = busy && (
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
        className="icon-button"
        data-testid="extract-cancel"
        aria-label={t("common.cancel")}
        title={t("common.cancel")}
        onClick={cancel}
        disabled={job.state !== "running" || job.cancelRequested}
      >
        <CloseIcon />
      </button>
    </div>
  );

  return (
    <section aria-labelledby="extract-heading" className="extractor" data-testid="extractor">
      <h2 id="extract-heading" tabIndex={-1} className="sr-only">
        {t("extract.heading")}
      </h2>
      <ToolSlot name="extract">
        <ToolButton
          icon={<ExtractIcon />}
          label={t("extract.toolbar")}
          testId="extract-all"
          onClick={() =>
            planFor(selected.length > 0 ? { kind: "selected", entries: [...selected] } : { kind: "all" }, "default")
          }
          disabled={!avail.extract.enabled || seq === null}
          title={tipFor(
            avail.extract,
            selected.length > 0
              ? t("extract.selectedTip", { n: formatNumber(selected.length) })
              : t("extract.allTip"),
          )}
        />
      </ToolSlot>
      <ToolSlot name="extractTo">
        <ToolButton
          icon={<ExtractToIcon />}
          label={t("extract.to")}
          testId="extract-to"
          onClick={() =>
            setWizard(selected.length > 0 ? { kind: "selected", entries: [...selected] } : { kind: "all" })
          }
          disabled={!avail.extractTo.enabled || seq === null}
          title={tipFor(
            avail.extractTo,
            selected.length > 0
              ? t("extract.toSelectedTip", { n: formatNumber(selected.length) })
              : t("extract.toTip"),
          )}
        />
      </ToolSlot>

      {wizard !== null && plan === null && (
        <ExtractToDialog
          count={wizard.kind === "all" ? 0 : wizard.entries.length}
          onSubmit={(folder, newFolder) => submitTo(wizard, folder, newFolder)}
          onClose={() => setWizard(null)}
        />
      )}

      {scope !== null && plan !== null && (
        <Panel
          label={t("extract.group")}
          heading={t("extract.panelHeading")}
          testId="extract-panel"
          fallbackId="extract-heading"
          onClose={busy ? undefined : close}
        >
          <dl>
            <dt>{t("extract.folder")}</dt>
            <dd data-testid="extract-destination" title={plan.destination}>
              {plan.destination}
            </dd>
            <dt>{t("extract.what")}</dt>
            <dd data-testid="extract-scope">
              {scope.kind === "all" ? (
                t("extract.wholeCommit", { seq: seq ?? "" })
              ) : scope.entries.length === 1 && scope.entries[0] ? (
                <Name name={scope.entries[0].name} />
              ) : (
                tc(scope.entries.length, "common.itemOne", "common.itemMany")
              )}
              {t("extract.entriesCount", {
                count: tc(plan.entries, "count.entryOne", "count.entryMany"),
              })}
            </dd>
          </dl>
          {hasConflicts ? (
            <div data-testid="extract-conflicts">
              <p role="note" className="warning">
                {t(plan.conflicts_total === 1 ? "extract.cannotOne" : "extract.cannotMany", {
                  n: formatNumber(plan.conflicts_total),
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
                  {t("common.andMore", { n: formatNumber(plan.conflicts_total - plan.conflicts.length) })}
                </p>
              )}
              <Hint testId="extract-conflict-note" text={[conflictNote(), notOfferedNote()]} />
            </div>
          ) : (
            <span className="sr-only" data-testid="extract-no-conflicts">
              {t("extract.noConflicts")}
            </span>
          )}
          {error && (
            <p role="alert" className="error" data-testid="extract-error">
              {error}
            </p>
          )}
          {progressLine}
          <div className="actions dialog-actions">
            <Hint
              testId="extract-notes"
              text={[
                ...(scope.kind === "selected" ? [t("extract.parentsNote")] : []),
                ...(madeFolder ? [t("extract.newFolderNote")] : []),
                folderNote(),
                ...(plan.case_insensitive ? [t("extract.caseInsensitive")] : []),
              ]}
            />
            <button
              type="button"
              className="primary"
              data-testid="extract-confirm"
              onClick={() => start(hasConflicts ? "skip_conflicts" : "stop")}
              disabled={busy}
            >
              {hasConflicts ? t("extract.confirmSkip") : t("extract.confirm")}
            </button>
            <button
              type="button"
              data-testid="extract-change-folder"
              onClick={() => planFor(scope, "pick")}
              disabled={busy}
            >
              {t("extract.changeFolder")}
            </button>
            <button
              type="button"
              className="icon-button"
              data-testid="extract-recheck"
              aria-label={t("extract.recheck")}
              title={t("extract.recheck")}
              onClick={() => planFor(scope, "again")}
              disabled={busy}
            >
              <RefreshIcon />
            </button>
            <button type="button" data-testid="extract-close" onClick={close} disabled={busy}>
              {t("common.cancel")}
            </button>
          </div>
        </Panel>
      )}

      <ToolSlot name="status" owner="any">
      {error && plan === null && (
        <p role="alert" className="error status-line" data-testid="extract-error">
          {error}
        </p>
      )}
      {plan === null && progressLine}

      <ResultBar
        prefix="extract"
        statusTestId="extract-status"
        statusRef={resultRef}
        statusAttrs={{
          "data-state": job.state === "done" ? job.outcome.status : undefined,
          "data-complete":
            job.state === "done"
              ? String(described?.completed === true && (report?.not_extracted_total ?? 0) === 0)
              : undefined,
        }}
        lines={described ? [described.headline, ...described.notes] : []}
        headlineTestId="extract-headline"
        warn={described?.warn ?? false}
        details={described?.details ?? null}
        onShowFolder={job.state === "done" && job.outcome.status === "completed" && report ? showFolder : undefined}
        onDismiss={() => {
          setJob({ state: "idle" });
          setFolderError(null);
        }}
        fallbackId="extract-heading"
      />
      {folderError && (
        <p role="alert" className="error status-line" data-testid="extract-folder-error">
          {folderError}
        </p>
      )}
      </ToolSlot>
    </section>
  );
}
