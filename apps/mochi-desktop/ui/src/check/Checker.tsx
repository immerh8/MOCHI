import { useCallback, useEffect, useRef, useState } from "react";

import { useJobFocus } from "../a11y/focus";
import { Live } from "../a11y/Live";
import { ProgressMeter } from "../a11y/ProgressMeter";
import { errorText } from "../browser/format";
import { t } from "../i18n";
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

const WHAT: Record<Kind, () => string> = {
  test: () => t("check.wasTest"),
  plan: () => t("check.wasPlan"),
  apply: () => t("check.wasApply"),
};
const FAILED_WHAT: Record<Kind, () => string> = {
  test: () => t("check.whatTest"),
  plan: () => t("check.whatPlan"),
  apply: () => t("check.whatApply"),
};

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
  const rememberFocus = useJobFocus(busy);

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
      setError(errorText(t("check.chooseFailed"), e));
      return null;
    }
  };

  /** Show what a job produced; a job without a result says why. */
  const finished = useCallback((kind: Kind, outcome: JobOutcome) => {
    const note = failedLine(FAILED_WHAT[kind](), outcome);
    if (outcome.status === "cancelled") {
      setJobNote(t("check.wasCancelled", { was: WHAT[kind]() }));
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
    rememberFocus();
    setError(null);
    setJobNote(null);
    setExported(null);
    setJob({ state: "starting", kind });
    startJob(request, onEvent(kind)).catch((e: unknown) => {
      setJob({ state: "idle" });
      setError(errorText(t("check.startFailed"), e));
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
      setError(errorText(t("check.healthFailed"), e));
    }
  };

  const doExport = async (r: ReportView) => {
    setError(null);
    setExporting(true);
    try {
      const name = await exportReport(r.report_id);
      if (name !== null) setExported(t("check.exported", { kind: r.kind, name }));
    } catch (e) {
      setError(errorText(t("check.exportFailed"), e));
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
      setError(errorText(t("check.setupFailed"), e));
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
      <h2 id="check-heading" tabIndex={-1}>
        {t("check.heading")}
      </h2>
      <div className="actions">
        <button type="button" data-testid="check-choose" onClick={() => void choose({ from: "dialog" })} disabled={busy}>
          {t("check.choose")}
        </button>
        <button
          type="button"
          data-testid="check-use-open"
          onClick={() => archive && void choose({ from: "open_archive", handle: archive.handle })}
          disabled={busy || archive === null}
          title={archive ? undefined : t("check.openFirst")}
        >
          {t("check.useOpen")}
        </button>
      </div>
      <p data-testid="check-subject">
        {subject ? (
          <>
            {t("check.subjectLabel")} <strong>{subject.file_name}</strong>
          </>
        ) : (
          t("check.noSubject")
        )}
      </p>
      {subject?.encrypted && !subject.unlocked && (
        <div className="panel" role="group" aria-label={t("check.unlockGroup")} data-testid="check-unlock">
          <p>{t("check.unlockIntro")}</p>
          <PassphraseForm
            testId="check-unlock-form"
            label={t("check.unlockLabel")}
            submitLabel={t("check.unlockSubmit")}
            onSubmit={async (p) => {
              setError(null);
              setSubject(await unlockCheckSubject(subject.id, p));
            }}
          />
        </div>
      )}
      {subject?.encrypted && subject.unlocked && (
        <p className="note" data-testid="check-unlocked">
          {t("check.unlocked")}
        </p>
      )}
      {error && (
        <p role="alert" className="error" data-testid="check-error">
          {error}
        </p>
      )}

      <fieldset disabled={busy || subject === null}>
        <legend>{t("check.testLegend")}</legend>
        <p className="note">{TEST_NOTE}</p>
        <label>
          {t("check.level")}{" "}
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
            {t("check.deep")}
          </label>
        </div>
        <div className="actions">
          <button type="button" data-testid="check-test" onClick={() => subject && test(subject.id)}>
            {t("check.test")}
          </button>
          <button type="button" data-testid="check-health" onClick={() => void showHealth()}>
            {t("check.health")}
          </button>
        </div>
      </fieldset>

      {busy && (
        <div className="progress" data-testid="check-running" data-kind={job.kind}>
          {job.state === "running" && (
            <>
              <ProgressMeter
                completed={job.completed}
                total={job.total}
                text={
                  (job.phase ? progressText(job.phase, job.completed, job.total) : t("common.starting")) +
                  (job.cancelRequested ? t("common.cancelling") : "")
                }
                textTestId="check-progress"
              />
            </>
          )}
          {job.state === "starting" && <span>{t("common.starting")}</span>}
          <button
            type="button"
            data-testid="check-cancel"
            onClick={cancel}
            disabled={job.state !== "running" || job.cancelRequested}
          >
            {t("common.cancel")}
          </button>
        </div>
      )}
      <Live data-testid="check-status">{jobNote}</Live>
      <Live data-testid="report-exported">{exported}</Live>

      <div ref={resultRef}>
        {report && (
          <Report report={report} onExport={() => void doExport(report)} exporting={exporting} />
        )}
        {health && (
          <div data-testid="health">
            <h3>{t("check.healthHeading")}</h3>
            <p className="note" data-testid="health-note">
              {HEALTH_NOTE}
              {t("check.recordsUsed", { n: health.records })}
            </p>
            <Report report={health.report} onExport={() => void doExport(health.report)} exporting={exporting} />
          </div>
        )}
      </div>

      <fieldset disabled={busy || subject === null} data-testid="repair">
        <legend>{t("check.repairLegend")}</legend>
        <p className="note">{t("check.repairIntro")}</p>
        <p>{t("check.copiesIntro")}</p>
        {setup.copies.length > 0 && (
          <ul className="staged" aria-label={t("check.copies")}>
            {keyed(setup.copies, (c) => c).map(({ key, item: c, index }) => (
              <li key={key} data-testid="repair-copy">
                {c}{" "}
                <button
                  type="button"
                  data-testid="repair-remove-copy"
                  aria-label={t("check.removeCopyNamed", { name: c })}
                  onClick={() => void changeSetup({ action: "remove_copy", index })}
                >
                  {t("check.removeCopy")}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="actions">
          <button type="button" data-testid="repair-add-copy" onClick={() => void changeSetup({ action: "add_copy" })}>
            {t("check.addCopy")}
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
          {t("check.salvage")}
        </label>
        {salvage && (
          <div>
            <label>
              {t("check.archiveId")}{" "}
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
            {t("check.plan")}
          </button>
        </div>
      </fieldset>

      {plan && <PlanReview plan={plan} />}

      {plan && plan.outcome !== "nothing_recoverable" && (
        <div className="panel" data-testid="repair-approve-panel" role="group" aria-label={t("check.approveGroup")}>
          <h3>{t("check.approveHeading")}</h3>
          <p className="note">{APPROVAL_NOTE}</p>
          <div className="actions">
            <button
              type="button"
              data-testid="repair-choose-output"
              onClick={() => void changeSetup({ action: "choose_output" })}
              disabled={busy}
            >
              {t("check.chooseOutput")}
            </button>
          </div>
          <p data-testid="repair-output">
            {setup.output ? t("check.output", { path: setup.output }) : t("check.noOutput")}
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
              {t("check.acceptRetention")}
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
              {t("check.approve", { extra: plan.outcome === "partial" ? t("check.approveExtra") : "" })}
            </label>
          </div>
          <div className="actions">
            <button type="button" data-testid="repair-apply" onClick={apply} disabled={busy || !canApply}>
              {t("check.apply")}
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
          <h3>{t("check.resultHeading", { outcome: OUTCOME_LABEL[result.outcome] })}</h3>
          <p data-testid="repair-result-line">{resultLine(result)}</p>
          <p data-testid="repair-reverification" data-status={result.reverification.overall_status}>
            <StatusBadge status={result.reverification.overall_status} /> {reverificationLine(result)}
          </p>
          {result.lost.length > 0 && (
            <ul className="staged" aria-label={t("check.snapshotsNotWritten")}>
              {result.lost.map((l) => (
                <li key={l.seq} data-testid="repair-result-lost">
                  {t("check.resultLost", { seq: l.seq })}
                  <span className="meta">({l.code})</span> <Prose text={l.reason} />
                </li>
              ))}
            </ul>
          )}
          {result.omitted.length > 0 && <OmittedList items={result.omitted} total={result.omitted_total} />}
          {result.profile_constraints_lost.map((c) => (
            <p key={c} className="warning">
              {t("check.notCarried", { what: c })}
            </p>
          ))}
          {result.retention_loss_accepted && (
            <p className="warning">{t("check.retentionNotCarried")}</p>
          )}
          {result.durability_note && (
            <p className="warning">{t("check.durabilityDegraded", { note: result.durability_note })}</p>
          )}
          <p className="note">{SOURCE_KEPT_NOTE}</p>
          <div className="actions">
            <button type="button" data-testid="repair-test-new" onClick={() => void testNewArchive()} disabled={busy}>
              {t("check.testNew")}
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
        {t("check.leftOut", { total })}
      </p>
      <ul className="staged" aria-label={t("check.leftOutList")}>
        {keyed(items, (o) => `${o.path.text}:${o.code}`).map(({ key, item: o }) => (
          <li key={key} data-testid="repair-omitted">
            <Name name={o.path} /> <span className="meta">
              {t("check.omittedMeta", { kind: o.kind, code: o.code, snapshots: o.snapshots.join(", ") })}
            </span>{" "}
            <Prose text={o.reason} />
          </li>
        ))}
      </ul>
      {BigInt(total) > BigInt(items.length) && (
        <p className="note">{t("common.andMore", { n: (BigInt(total) - BigInt(items.length)).toString() })}</p>
      )}
    </>
  );
}

/** The plan as the core library made it, for review before any approval. */
function PlanReview({ plan: p }: { plan: RepairPlanView }) {
  return (
    <div className="panel" data-testid="repair-plan-view" data-outcome={p.outcome} data-exit={p.exit_code} role="group" aria-label={t("check.planGroup")}>
      <h3>{t("check.planHeading", { file: p.file_name })}</h3>
      <p data-testid="repair-plan-line">
        <strong>{planLine(p)}</strong>
      </p>
      <p className="note">{PLAN_NOTE}</p>
      <dl className="report-facts">
        <dt>{t("check.head")}</dt>
        <dd>
          {p.head_seq === null
            ? t("check.headNone")
            : t("check.headFound", { seq: p.head_seq, by: p.head_found_by ?? t("check.headFoundUnknown") })}
        </dd>
        {p.tail_state && (
          <>
            <dt>{t("check.afterHead")}</dt>
            <dd>{t("check.afterHeadValue", { state: p.tail_state, len: p.tail_len ?? "" })}</dd>
          </>
        )}
        {p.chain_break_at !== null && (
          <>
            <dt>{t("check.chainBreak")}</dt>
            <dd>
              {t("check.chainBreakBefore", { seq: p.chain_break_at })}
              {p.chain_break_reason && (
                <>
                  : <Prose text={p.chain_break_reason} />
                </>
              )}
            </dd>
          </>
        )}
        <dt>{t("check.damage")}</dt>
        <dd>{p.damage_found ? t("check.damageYes") : t("check.damageNone")}</dd>
      </dl>
      <p>{t("check.ladder")}</p>
      <ol className="ladder">
        {p.ladder.map((l) => (
          <li key={l.step} data-testid="ladder-step" data-step={l.step} data-status={l.status}>
            {t("check.ladderStep", { name: l.name })}<strong>{l.status.replaceAll("_", " ").toUpperCase()}</strong> — <Prose text={l.detail} />
          </li>
        ))}
      </ol>
      <p>
        {t("check.snapshotsHeld", { n: p.snapshots.length })}
        {p.snapshots
          .map((s) =>
            s.trust === "chain" ? `${s.seq}` : t("check.snapshotTrust", { seq: s.seq, trust: s.trust.replaceAll("_", " ") }),
          )
          .join(", ") || t("check.snapshotsNone")}
      </p>
      {p.lost.length > 0 && (
        <ul className="staged" aria-label={t("check.snapshotsNotWritten")}>
          {p.lost.map((l) => (
            <li key={l.seq} data-testid="repair-lost">
              {t("check.lostWould", { seq: l.seq })}
              <span className="meta">({l.code})</span> <Prose text={l.reason} />
            </li>
          ))}
        </ul>
      )}
      {p.omitted.length > 0 && <OmittedList items={p.omitted} total={p.omitted_total} />}
      {p.manifest_failures > 0 && (
        <p className="warning">{t("check.manifestFailures", { n: p.manifest_failures })}</p>
      )}
      {p.retention?.state === "carried" && (
        <p data-testid="repair-retention">
          {t("check.retentionCarried", {
            holds: p.retention.holds,
            lost: p.retention.holds_lost > 0 ? t("check.retentionCarriedLost", { n: p.retention.holds_lost }) : "",
            expired: p.retention.expired,
          })}
        </p>
      )}
      {p.retention?.state === "unresolved" && (
        <p className="warning" data-testid="repair-retention">
          {t("check.retentionCannot", { code: p.retention.code })}<Prose text={p.retention.reason} />
        </p>
      )}
      {p.parity && (
        <p>
          {t("check.parity", {
            percent: p.parity.declared_percent ?? t("check.parityUnknown"),
            rebuilt: p.parity.shards_rebuilt,
            damaged: p.parity.shards_damaged,
            beyond: p.parity.groups_beyond_capacity,
          })}
        </p>
      )}
      {p.copies.length > 0 && (
        <ul className="staged" aria-label={t("check.copiesUsed")}>
          {keyed(p.copies, (c) => c.file_name).map(({ key, item: c }) => (
            <li key={key} data-testid="repair-copy-status" data-status={c.status}>
              {t("check.copyStatus", { file: c.file_name, status: c.status.replaceAll("_", " "), frames: c.frames_donated })}
              <Prose text={c.detail} />
            </li>
          ))}
        </ul>
      )}
      {p.salvage && (
        <p className={p.salvage.limit_reached ? "warning" : undefined}>
          {t("check.salvageLine", {
            confirmed: p.salvage.confirmed_commits,
            unconfirmed: p.salvage.unconfirmed_commits,
            orphans: p.salvage.orphan_data_objects,
            limit: p.salvage.limit_reached ? t("check.salvageLimit") : "",
          })}
        </p>
      )}
    </div>
  );
}
