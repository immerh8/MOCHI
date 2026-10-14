import { useCallback, useEffect, useRef, useState } from "react";

import { errorText } from "../browser/format";
import { Name } from "../browser/Name";
import type { ArchiveSummary } from "../ipc/browse";
import { chooseCheckSubject, exportReport, healthReport, repairSetup } from "../ipc/check";
import type {
  CheckLevel,
  HealthView,
  RepairPlanView,
  RepairResultView,
  RepairSetupAction,
  RepairSetupView,
  ReportView,
  SubjectSource,
  SubjectView,
} from "../ipc/check";
import { unlockCheckSubject } from "../ipc/crypt";
import { PassphraseForm } from "../crypt/PassphraseForm";
import { cancelJob, startJob } from "../ipc/jobs";
import type { JobEvent, JobOutcome, JobRequest } from "../ipc/jobs";
import {
  APPROVAL_NOTE,
  failedLine,
  HEALTH_NOTE,
  keyed,
  LEVELS,
  OUTCOME_LABEL,
  PLAN_NOTE,
  planLine,
  progressText,
  resultLine,
  reverificationLine,
  SOURCE_KEPT_NOTE,
  TEST_NOTE,
} from "./messages";
import { Prose, Report, StatusBadge } from "./Report";

export interface CheckerProps {
  /** The archive open in the browser, if any ("Use the open archive"). */
  archive: ArchiveSummary | null;
}

type Kind = "test" | "plan" | "apply";

type JobView =
  | { state: "idle" }
  | { state: "starting"; kind: Kind }
  | {
      state: "running";
      kind: Kind;
      jobId: number;
      phase: string;
      completed: number;
      total: number | null;
      cancelRequested: boolean;
    };

const WHAT: Record<Kind, string> = { test: "The test was", plan: "Planning was", apply: "Writing the new archive was" };
const FAILED_WHAT: Record<Kind, string> = { test: "The test", plan: "Planning", apply: "Writing the new archive" };

/**
 * Plan D4: test an archive (the core library's verification, read-only), see
 * its health per dimension, export either report's JSON, and repair it
 * through a reviewed plan into a new file, re-verified. Every file is chosen
 * in a native dialog that Rust shows; this component never holds a path.
 */
export function Checker({ archive }: CheckerProps) {
  const [subject, setSubject] = useState<SubjectView | null>(null);
  const [level, setLevel] = useState<CheckLevel>("restoration");
  const [deep, setDeep] = useState(false);
  const [job, setJob] = useState<JobView>({ state: "idle" });
  const [jobNote, setJobNote] = useState<string | null>(null);
  const [report, setReport] = useState<ReportView | null>(null);
  const [health, setHealth] = useState<HealthView | null>(null);
  const [setup, setSetup] = useState<RepairSetupView>({ copies: [], output: null });
  const [salvage, setSalvage] = useState(false);
  const [archiveId, setArchiveId] = useState("");
  const [plan, setPlan] = useState<RepairPlanView | null>(null);
  const [approved, setApproved] = useState(false);
  const [acceptRetentionLoss, setAcceptRetentionLoss] = useState(false);
  const [result, setResult] = useState<RepairResultView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const busy = job.state !== "idle";

  // Results open below the controls: bring each into view when it appears.
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    resultRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [report, health, plan, result]);

  /** A new archive: everything shown belonged to the old one. */
  const adopt = (s: SubjectView) => {
    setSubject(s);
    setReport(null);
    setHealth(null);
    setSetup({ copies: [], output: null });
    setPlan(null);
    setApproved(false);
    setAcceptRetentionLoss(false);
    setResult(null);
    setJobNote(null);
    setExported(null);
  };

  const choose = async (from: SubjectSource): Promise<SubjectView | null> => {
    setError(null);
    try {
      const s = await chooseCheckSubject(from);
      if (s !== null) adopt(s);
      return s;
    } catch (e) {
      setError(errorText("Could not choose that archive", e));
      return null;
    }
  };

  /** Show what a job produced; a job without a result says why. */
  const finished = useCallback((kind: Kind, outcome: JobOutcome) => {
    const note = failedLine(FAILED_WHAT[kind], outcome);
    if (outcome.status === "cancelled") {
      setJobNote(`${WHAT[kind]} cancelled before it finished. Nothing was written.`);
      return;
    }
    setJobNote(note);
    if (outcome.status !== "completed" || !outcome.check) return;
    const c = outcome.check;
    switch (c.kind) {
      case "test":
        setReport(c.report);
        break;
      case "plan":
        setPlan(c.plan);
        setApproved(false);
        setAcceptRetentionLoss(false);
        setResult(null);
        break;
      case "repair":
        setResult(c.result);
        setPlan(null);
        setApproved(false);
        setSetup((s) => ({ ...s, output: null }));
        break;
    }
  }, []);

  const onEvent = useCallback((kind: Kind) => (event: JobEvent) => {
    switch (event.event) {
      case "started":
        setJob((prev) =>
          prev.state === "running"
            ? prev
            : { state: "running", kind, jobId: event.job_id, phase: "", completed: 0, total: null, cancelRequested: false },
        );
        return;
      case "progress":
        setJob((prev) =>
          prev.state === "idle"
            ? prev
            : {
                state: "running",
                kind,
                jobId: event.job_id,
                phase: event.phase,
                completed: event.completed,
                total: event.total,
                cancelRequested: prev.state === "running" && prev.cancelRequested,
              },
        );
        return;
      case "finished":
        setJob({ state: "idle" });
        finished(kind, event.outcome);
        return;
    }
  }, [finished]);

  const run = (kind: Kind, request: JobRequest) => {
    setError(null);
    setJobNote(null);
    setExported(null);
    setJob({ state: "starting", kind });
    startJob(request, onEvent(kind)).catch((e: unknown) => {
      setJob({ state: "idle" });
      setError(errorText("Could not start", e));
    });
  };

  const test = (id: number) => run("test", { kind: "test_archive", subject: id, level, deep });

  const showHealth = async () => {
    if (!subject) return;
    setError(null);
    setExported(null);
    try {
      setHealth(await healthReport(subject.id));
    } catch (e) {
      setHealth(null);
      setError(errorText("Could not summarise the health of this archive", e));
    }
  };

  const doExport = async (r: ReportView) => {
    setError(null);
    setExporting(true);
    try {
      const name = await exportReport(r.report_id);
      if (name !== null) setExported(`Exported the ${r.kind} report to ${name}, exactly as produced.`);
    } catch (e) {
      setError(errorText("Could not export the report", e));
    } finally {
      setExporting(false);
    }
  };

  const changeSetup = async (action: RepairSetupAction) => {
    setError(null);
    try {
      const next = await repairSetup(action);
      // Different copies make the plan stale (Rust drops it too).
      if (next.copies.join("\n") !== setup.copies.join("\n")) {
        setPlan(null);
        setApproved(false);
      }
      setSetup(next);
    } catch (e) {
      setError(errorText("Could not change the repair", e));
    }
  };

  const planRepair = () => {
    if (!subject) return;
    setResult(null);
    run("plan", {
      kind: "plan_repair",
      subject: subject.id,
      salvage,
      archive_id: salvage && archiveId.trim() !== "" ? archiveId.trim() : null,
    });
  };

  const apply = () => {
    if (!subject || !plan) return;
    run("apply", {
      kind: "apply_repair",
      subject: subject.id,
      plan: plan.plan_id,
      accept_retention_loss: acceptRetentionLoss,
    });
  };

  const testNewArchive = async () => {
    const s = await choose({ from: "repair_output" });
    if (s) test(s.id);
  };

  const cancel = () => {
    if (job.state !== "running") return;
    setJob({ ...job, cancelRequested: true });
    cancelJob(job.jobId).catch(() => undefined);
  };

  const retentionUnresolved = plan?.retention?.state === "unresolved";
  const canApply =
    plan !== null &&
    plan.outcome !== "nothing_recoverable" &&
    setup.output !== null &&
    approved &&
    (!retentionUnresolved || acceptRetentionLoss);

  return (
    <section aria-labelledby="check-heading" className="checker" data-testid="checker">
      <h2 id="check-heading">Test, health, and repair</h2>
      <div className="actions">
        <button type="button" data-testid="check-choose" onClick={() => void choose({ from: "dialog" })} disabled={busy}>
          Choose archive…
        </button>
        <button
          type="button"
          data-testid="check-use-open"
          onClick={() => archive && void choose({ from: "open_archive", handle: archive.handle })}
          disabled={busy || archive === null}
          title={archive ? undefined : "Open an archive first"}
        >
          Use the open archive
        </button>
      </div>
      <p data-testid="check-subject">
        {subject ? (
          <>
            Archive: <strong>{subject.file_name}</strong>
          </>
        ) : (
          "No archive chosen. Any archive can be chosen, including one too damaged to open."
        )}
      </p>
      {subject?.encrypted && !subject.unlocked && (
        <div className="panel" role="group" aria-label="Passphrase" data-testid="check-unlock">
          <p>
            This archive is encrypted. Without its passphrase a test checks stored bytes only and is never
            PASS overall, and a repair cannot run.
          </p>
          <PassphraseForm
            testId="check-unlock-form"
            label="Passphrase"
            submitLabel="Use this passphrase"
            onSubmit={async (p) => {
              setError(null);
              setSubject(await unlockCheckSubject(subject.id, p));
            }}
          />
        </div>
      )}
      {subject?.encrypted && subject.unlocked && (
        <p className="note" data-testid="check-unlocked">
          The passphrase is held in the app for this archive until you choose another one or close the app.
        </p>
      )}
      {error && (
        <p role="alert" className="error" data-testid="check-error">
          {error}
        </p>
      )}

      <fieldset disabled={busy || subject === null}>
        <legend>Test archive</legend>
        <p className="note">{TEST_NOTE}</p>
        <label>
          Level{" "}
          <select data-testid="check-level" value={level} onChange={(e) => setLevel(e.target.value as CheckLevel)}>
            {LEVELS.map((l) => (
              <option key={l.level} value={l.level}>
                {l.label}
              </option>
            ))}
          </select>
        </label>{" "}
        <span className="meta">{LEVELS.find((l) => l.level === level)?.detail}</span>
        <div>
          <label>
            <input type="checkbox" data-testid="check-deep" checked={deep} onChange={(e) => setDeep(e.target.checked)} />{" "}
            Deep check (fsck): also open every commit at its own footer and rebuild every segment
          </label>
        </div>
        <div className="actions">
          <button type="button" data-testid="check-test" onClick={() => subject && test(subject.id)}>
            Test archive
          </button>
          <button type="button" data-testid="check-health" onClick={() => void showHealth()}>
            Show health
          </button>
        </div>
      </fieldset>

      {busy && (
        <div className="progress" data-testid="check-running" data-kind={job.kind}>
          {job.state === "running" && (
            <>
              <progress value={job.total === null ? undefined : job.completed} max={job.total ?? undefined} />
              <span data-testid="check-progress">
                {job.phase ? progressText(job.phase, job.completed, job.total) : "Starting…"}
                {job.cancelRequested ? " (cancelling…)" : ""}
              </span>
            </>
          )}
          {job.state === "starting" && <span>Starting…</span>}
          <button
            type="button"
            data-testid="check-cancel"
            onClick={cancel}
            disabled={job.state !== "running" || job.cancelRequested}
          >
            Cancel
          </button>
        </div>
      )}
      {jobNote && (
        <p role="status" data-testid="check-status">
          {jobNote}
        </p>
      )}
      {exported && (
        <p role="status" data-testid="report-exported">
          {exported}
        </p>
      )}

      <div ref={resultRef}>
        {report && (
          <Report report={report} onExport={() => void doExport(report)} exporting={exporting} />
        )}
        {health && (
          <div data-testid="health">
            <h3>Health</h3>
            <p className="note" data-testid="health-note">
              {HEALTH_NOTE} Records used: {health.records}.
            </p>
            <Report report={health.report} onExport={() => void doExport(health.report)} exporting={exporting} />
          </div>
        )}
      </div>

      <fieldset disabled={busy || subject === null} data-testid="repair">
        <legend>Repair</legend>
        <p className="note">
          A repair is planned first and changes nothing. You review the plan, approve it, and choose a new file; the
          archive itself is never written.
        </p>
        <p>Independent copies of the same archive (optional; used only where they match it byte for byte):</p>
        {setup.copies.length > 0 && (
          <ul className="staged" aria-label="Copies">
            {keyed(setup.copies, (c) => c).map(({ key, item: c, index }) => (
              <li key={key} data-testid="repair-copy">
                {c}{" "}
                <button
                  type="button"
                  data-testid="repair-remove-copy"
                  onClick={() => void changeSetup({ action: "remove_copy", index })}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="actions">
          <button type="button" data-testid="repair-add-copy" onClick={() => void changeSetup({ action: "add_copy" })}>
            Add a copy…
          </button>
        </div>
        <label>
          <input
            type="checkbox"
            data-testid="repair-salvage"
            checked={salvage}
            onChange={(e) => {
              setSalvage(e.target.checked);
              setPlan(null);
            }}
          />{" "}
          Allow the bounded salvage scan (step 7). Anything it is used for makes the repair partial.
        </label>
        {salvage && (
          <div>
            <label>
              Archive ID, if the scan finds several archives (optional, 64 hexadecimal digits){" "}
              <input
                type="text"
                data-testid="repair-archive-id"
                value={archiveId}
                spellCheck={false}
                onChange={(e) => setArchiveId(e.target.value)}
              />
            </label>
          </div>
        )}
        <div className="actions">
          <button type="button" data-testid="repair-plan" onClick={planRepair}>
            Plan repair
          </button>
        </div>
      </fieldset>

      {plan && <PlanReview plan={plan} />}

      {plan && plan.outcome !== "nothing_recoverable" && (
        <div className="panel" data-testid="repair-approve-panel" role="group" aria-label="Approve the repair">
          <h3>Approve and write</h3>
          <p className="note">{APPROVAL_NOTE}</p>
          <div className="actions">
            <button
              type="button"
              data-testid="repair-choose-output"
              onClick={() => void changeSetup({ action: "choose_output" })}
              disabled={busy}
            >
              Choose the new file…
            </button>
          </div>
          <p data-testid="repair-output">
            {setup.output ? <>New file: {setup.output}</> : "No new file chosen yet. Nothing is ever written in place."}
          </p>
          {retentionUnresolved && (
            <label>
              <input
                type="checkbox"
                data-testid="repair-accept-retention"
                checked={acceptRetentionLoss}
                onChange={(e) => setAcceptRetentionLoss(e.target.checked)}
                disabled={busy}
              />{" "}
              Write the new archive without the legal holds and expiries that cannot be carried over
            </label>
          )}
          <div>
            <label>
              <input
                type="checkbox"
                data-testid="repair-approve"
                checked={approved}
                onChange={(e) => setApproved(e.target.checked)}
                disabled={busy}
              />{" "}
              I have reviewed this plan
              {plan.outcome === "partial" ? ", including everything it leaves out" : ""}. Write it.
            </label>
          </div>
          <div className="actions">
            <button type="button" data-testid="repair-apply" onClick={apply} disabled={busy || !canApply}>
              Write the new archive
            </button>
          </div>
        </div>
      )}

      {result && (
        <div
          className="panel"
          data-testid="repair-result"
          data-outcome={result.outcome}
          data-exit={result.exit_code}
          role="status"
        >
          <h3>Repair result: {OUTCOME_LABEL[result.outcome]}</h3>
          <p data-testid="repair-result-line">{resultLine(result)}</p>
          <p data-testid="repair-reverification" data-status={result.reverification.overall_status}>
            <StatusBadge status={result.reverification.overall_status} /> {reverificationLine(result)}
          </p>
          {result.lost.length > 0 && (
            <ul className="staged" aria-label="Snapshots not written">
              {result.lost.map((l) => (
                <li key={l.seq} data-testid="repair-result-lost">
                  Snapshot {l.seq} not written <span className="meta">({l.code})</span> <Prose text={l.reason} />
                </li>
              ))}
            </ul>
          )}
          {result.omitted.length > 0 && <OmittedList items={result.omitted} total={result.omitted_total} />}
          {result.profile_constraints_lost.map((c) => (
            <p key={c} className="warning">
              Not carried into the new archive: {c}
            </p>
          ))}
          {result.retention_loss_accepted && (
            <p className="warning">Retention was not carried over: the new archive has no legal holds and nothing expired.</p>
          )}
          {result.durability_note && (
            <p className="warning">Degraded: the new file's directory entry is not confirmed durable ({result.durability_note}).</p>
          )}
          <p className="note">{SOURCE_KEPT_NOTE}</p>
          <div className="actions">
            <button type="button" data-testid="repair-test-new" onClick={() => void testNewArchive()} disabled={busy}>
              Test the new archive
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function OmittedList({ items, total }: { items: RepairPlanView["omitted"]; total: string }) {
  return (
    <>
      <p className="warning">
        Left out ({total}) — every snapshot that held these is written without them:
      </p>
      <ul className="staged" aria-label="Entries left out">
        {keyed(items, (o) => `${o.path.text}:${o.code}`).map(({ key, item: o }) => (
          <li key={key} data-testid="repair-omitted">
            <Name name={o.path} /> <span className="meta">({o.kind}, {o.code}, snapshots {o.snapshots.join(", ")})</span>{" "}
            <Prose text={o.reason} />
          </li>
        ))}
      </ul>
      {BigInt(total) > BigInt(items.length) && (
        <p className="note">…and {(BigInt(total) - BigInt(items.length)).toString()} more.</p>
      )}
    </>
  );
}

/** The plan as the core library made it, for review before any approval. */
function PlanReview({ plan: p }: { plan: RepairPlanView }) {
  return (
    <div className="panel" data-testid="repair-plan-view" data-outcome={p.outcome} data-exit={p.exit_code} role="group" aria-label="Repair plan">
      <h3>Repair plan for {p.file_name}</h3>
      <p data-testid="repair-plan-line">
        <strong>{planLine(p)}</strong>
      </p>
      <p className="note">{PLAN_NOTE}</p>
      <dl className="report-facts">
        <dt>Head</dt>
        <dd>{p.head_seq === null ? "no valid head found" : `commit ${p.head_seq}, found by ${p.head_found_by ?? "?"}`}</dd>
        {p.tail_state && (
          <>
            <dt>After the head</dt>
            <dd>
              {p.tail_state} ({p.tail_len} bytes)
            </dd>
          </>
        )}
        {p.chain_break_at !== null && (
          <>
            <dt>Chain break</dt>
            <dd>
              before commit {p.chain_break_at}
              {p.chain_break_reason && (
                <>
                  : <Prose text={p.chain_break_reason} />
                </>
              )}
            </dd>
          </>
        )}
        <dt>Damage found while planning</dt>
        <dd>{p.damage_found ? "yes" : "none in what the plan read (planning is not a verification)"}</dd>
      </dl>
      <p>The §22 ladder:</p>
      <ol className="ladder">
        {p.ladder.map((l) => (
          <li key={l.step} data-testid="ladder-step" data-step={l.step} data-status={l.status}>
            {l.name}: <strong>{l.status.replaceAll("_", " ").toUpperCase()}</strong> — <Prose text={l.detail} />
          </li>
        ))}
      </ol>
      <p>
        Snapshots the new archive would hold ({p.snapshots.length}):{" "}
        {p.snapshots
          .map((s) => `${s.seq}${s.trust === "chain" ? "" : ` (${s.trust.replaceAll("_", " ")})`}`)
          .join(", ") || "none"}
      </p>
      {p.lost.length > 0 && (
        <ul className="staged" aria-label="Snapshots not written">
          {p.lost.map((l) => (
            <li key={l.seq} data-testid="repair-lost">
              Snapshot {l.seq} would not be written <span className="meta">({l.code})</span> <Prose text={l.reason} />
            </li>
          ))}
        </ul>
      )}
      {p.omitted.length > 0 && <OmittedList items={p.omitted} total={p.omitted_total} />}
      {p.manifest_failures > 0 && (
        <p className="warning">{p.manifest_failures} recovery manifest(s) failed their checks; the plan works around them.</p>
      )}
      {p.retention?.state === "carried" && (
        <p data-testid="repair-retention">
          Retention carried over: {p.retention.holds} hold(s){p.retention.holds_lost > 0 ? `, ${p.retention.holds_lost} lost with their snapshots` : ""},{" "}
          {p.retention.expired} expired snapshot(s).
        </p>
      )}
      {p.retention?.state === "unresolved" && (
        <p className="warning" data-testid="repair-retention">
          Retention cannot be carried over ({p.retention.code}): <Prose text={p.retention.reason} />
        </p>
      )}
      {p.parity && (
        <p>
          Recovery record ({p.parity.declared_percent ?? "?"} %): {p.parity.shards_rebuilt} shard(s) rebuilt of{" "}
          {p.parity.shards_damaged} damaged; {p.parity.groups_beyond_capacity} group(s) beyond its capacity.
        </p>
      )}
      {p.copies.length > 0 && (
        <ul className="staged" aria-label="Copies used">
          {keyed(p.copies, (c) => c.file_name).map(({ key, item: c }) => (
            <li key={key} data-testid="repair-copy-status" data-status={c.status}>
              {c.file_name}: {c.status.replaceAll("_", " ")}, {c.frames_donated} frame(s) supplied — <Prose text={c.detail} />
            </li>
          ))}
        </ul>
      )}
      {p.salvage && (
        <p className={p.salvage.limit_reached ? "warning" : undefined}>
          Salvage scan: {p.salvage.confirmed_commits} confirmed commit(s), {p.salvage.unconfirmed_commits} unconfirmed
          (never written), {p.salvage.orphan_data_objects} data object(s) no commit references
          {p.salvage.limit_reached ? "; it stopped at its limit, so it is incomplete" : ""}.
        </p>
      )}
    </div>
  );
}
