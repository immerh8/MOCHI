import { t } from "../i18n";
import type { NameText } from "../ipc/browse";
import type { ReportView, StatusView } from "../ipc/check";
import {
  coverageLine,
  dimensionLabel,
  FRESHNESS_NOTE,
  headline,
  keyed,
  KEYLESS_NOTE,
  overallLine,
  STATUS_MEANING,
  statusClass,
  statusLabel,
  statusMark,
} from "./messages";

/**
 * Text from a report or plan (core's sentences, which can quote archive
 * data), as text only and wrapping. The backend escaped control and bidi
 * characters; a marker says when it did.
 */
export function Prose({ text }: { text: NameText }) {
  return (
    <>
      <span className="prose">{text.text}</span>
      {!text.verbatim && <span className="escaped">{t("common.escapedMarker")}</span>}
    </>
  );
}

/**
 * A §20.4 status. Only PASS carries the success class (§23.3 #2). The status
 * is always its own word, never just a colour; a glyph (CSS `::before` from
 * `data-mark`) and the border style (solid, dashed) repeat it for people who
 * cannot tell the colours apart.
 */
export function StatusBadge({ status }: { status: StatusView }) {
  return (
    <span
      className={statusClass(status)}
      data-testid="status-badge"
      data-status={status}
      data-mark={statusMark(status)}
      title={STATUS_MEANING[status]}
    >
      {statusLabel(status)}
    </span>
  );
}

export interface ReportProps {
  report: ReportView;
  /** Export the report's JSON (Rust shows the save dialog). */
  onExport: () => void;
  exporting: boolean;
}

/**
 * A report schema v1 as the core library produced it: every dimension with
 * its own status, the overall status and policy result (which never hide a
 * failing dimension), findings, what was not checked, and the exact JSON that
 * "Export report JSON" writes. Archive-derived text is rendered as text.
 */
export function Report({ report: r, onExport, exporting }: ReportProps) {
  const freshness = r.dimensions.find((d) => d.dimension === "freshness");
  const coverage = coverageLine(r);
  return (
    <div
      className="panel report"
      data-testid="report"
      data-kind={r.kind}
      data-overall={r.overall_status}
      data-exit={r.exit_code}
      role="group"
      aria-label={t(r.kind === "health" ? "report.health" : "report.test")}
    >
      <p data-testid="report-headline">
        <strong>{headline(r)}</strong>
      </p>
      <p data-testid="report-overall">
        <StatusBadge status={r.overall_status} /> {overallLine(r)}
      </p>
      <table className="dimensions" aria-label={t("report.dimensionsTable")}>
        <thead>
          <tr>
            <th scope="col">{t("report.colDimension")}</th>
            <th scope="col">{t("report.colStatus")}</th>
            <th scope="col">{t("report.colPolicy")}</th>
          </tr>
        </thead>
        <tbody>
          {r.dimensions.map((d) => (
            <tr key={d.dimension} data-testid="dimension" data-dimension={d.dimension} data-status={d.status}>
              <th scope="row">{dimensionLabel(d.dimension)}</th>
              <td>
                <StatusBadge status={d.status} />
              </td>
              <td>{t(d.required ? "report.required" : "report.notRequired")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.keyless && (
        <p role="note" className="warning" data-testid="report-keyless-note">
          {KEYLESS_NOTE}
        </p>
      )}
      {freshness && freshness.status === "UNKNOWN" && (
        <p role="note" className="note" data-testid="report-freshness-note">
          {FRESHNESS_NOTE}
        </p>
      )}
      <dl className="report-facts">
        {r.archive_id && (
          <>
            <dt>{t("report.archiveId")}</dt>
            <dd className="hash">{r.archive_id}</dd>
          </>
        )}
        {r.checked_commit && (
          <>
            <dt>{t("report.checkedCommit")}</dt>
            <dd className="hash">{r.checked_commit}</dd>
          </>
        )}
        <dt>{t("report.freshnessAnchor")}</dt>
        <dd>{r.freshness_anchor}</dd>
        {r.scope && (
          <>
            <dt>{t("report.scope")}</dt>
            <dd>
              <Prose text={r.scope} />
            </dd>
          </>
        )}
        {r.completed_at && (
          <>
            <dt>{t("report.completed")}</dt>
            <dd>{r.completed_at}</dd>
          </>
        )}
      </dl>
      {coverage && <p data-testid="report-coverage">{coverage}</p>}
      {r.findings.length > 0 && (
        <>
          <p className="warning">{t("report.findings")}</p>
          <ul className="staged" aria-label={t("report.findingsList")}>
            {keyed(r.findings, (f) => `${f.code}:${f.message?.text ?? ""}`).map(({ key, item: f }) => (
              <li key={key} data-testid="finding" data-code={f.code} data-severity={f.severity}>
                <span className="meta">
                  {t("report.findingMeta", {
                    severity: f.severity,
                    code: f.code,
                    affected: f.affected
                      ? t("report.findingAffected", { first: f.affected.first, last: f.affected.last })
                      : "",
                  })}
                </span>{" "}
                {f.message && <Prose text={f.message} />}
              </li>
            ))}
          </ul>
        </>
      )}
      {r.skipped.length > 0 && (
        <>
          <p>{t("report.notChecked")}</p>
          <ul className="staged" aria-label={t("report.notCheckedList")}>
            {keyed(r.skipped, (s) => s.item.text).map(({ key, item: s }) => (
              <li key={key} data-testid="skipped">
                <Prose text={s.item} />: <Prose text={s.reason} />
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="actions">
        <button type="button" data-testid="report-export" onClick={onExport} disabled={exporting}>
          {t("report.export")}
        </button>
      </div>
      <details>
        <summary>{t("report.jsonSummary")}</summary>
        <pre className="json" data-testid="report-json">
          {r.json}
        </pre>
      </details>
    </div>
  );
}
