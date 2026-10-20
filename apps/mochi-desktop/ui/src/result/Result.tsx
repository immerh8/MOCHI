import { Fragment, useEffect, useId, useRef, useState } from "react";
import type { Ref } from "react";

import { Live } from "../a11y/Live";
import { Name } from "../browser/Name";
import { t } from "../i18n";
import { CloseIcon, InfoIcon } from "../icons";
import type { DetailRow, ResultDetails } from "./details";
import { cautionCount, notesText } from "./details";

/** The rows of a Details panel as a definition list, then its short notes. */
export function DetailsList({ details, testId }: { details: ResultDetails; testId?: string }) {
  return (
    <>
      <dl className="result-list" data-testid={testId}>
        {details.rows.map((row) => (
          <Fragment key={row.label}>
            <dt>{row.label}</dt>
            <dd className={row.caution ? "result-caution" : undefined} data-testid={row.testId}>
              <Row row={row} />
            </dd>
          </Fragment>
        ))}
      </dl>
      {details.notes.map((n) => (
        <p className="note" key={n}>
          {n}
        </p>
      ))}
    </>
  );
}

function Row({ row }: { row: DetailRow }) {
  return (
    <>
      {row.value !== undefined && <span className="result-value">{row.value}</span>}
      {row.sub !== undefined && <small className="result-sub">{row.sub}</small>}
      {row.note !== undefined && <span className="result-reason">{row.note}</span>}
      {row.items !== undefined && (
        <ul className="result-items">
          {row.items.map((item) => (
            <li key={`${item.name?.text ?? ""}:${item.code ?? ""}:${item.text ?? ""}`} data-testid={row.itemTestId}>
              {item.name && <Name name={item.name} />}
              {item.code !== undefined && <span className="meta"> ({item.code})</span>}
              {item.text !== undefined && (item.name ? ": " : "")}
              {item.text}
            </li>
          ))}
        </ul>
      )}
      {row.more !== undefined && row.more > 0 && (
        <span className="result-reason">{t("common.andMore", { n: row.more.toLocaleString("en-US") })}</span>
      )}
    </>
  );
}

export interface ResultBarProps {
  /** Prefix of the test ids: `<prefix>-details-toggle`, `-details`, `-dismiss`, `-show-folder`. */
  prefix: string;
  /** The test id of the live region that carries the line. */
  statusTestId: string;
  statusAttrs?: Record<string, string | boolean | undefined>;
  statusRef?: Ref<HTMLDivElement>;
  /** What to say; empty while there is nothing to show. The first is the headline. */
  lines: string[];
  headlineTestId?: string;
  /** Part of the job did not happen: the line gets warning styling. */
  warn?: boolean;
  /** The Details panel; `null` for results that have nothing more to say. */
  details: ResultDetails | null;
  onShowFolder?: (() => void) | undefined;
  onDismiss: () => void;
  /** Where focus goes after the result is dismissed (an element id). */
  fallbackId: string;
}

/**
 * A finished job as one short line, with "Show in folder", a Details button,
 * and a dismiss button on the same row (owner request, release 0.9.3). The
 * details open in a side panel, closed by default; the line stays neutral
 * (nothing here is a verification), and a caution badge on the Details
 * button says when the panel holds something that is not fully good.
 */
export function ResultBar({
  prefix,
  statusTestId,
  statusAttrs,
  statusRef,
  lines,
  headlineTestId,
  warn = false,
  details,
  onShowFolder,
  onDismiss,
  fallbackId,
}: ResultBarProps) {
  const drawerId = useId();
  const headingId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The panel belongs to one result: a new result starts closed.
  const [openFor, setOpenFor] = useState<ResultDetails | null>(null);
  const open = details !== null && openFor === details;
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open) {
      headingRef.current?.focus();
    } else if (wasOpenRef.current) {
      // Closed by Escape or the Close button: give focus back to the opener.
      toggleRef.current?.focus();
    }
    wasOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setOpenFor(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const has = lines.length > 0;
  const cautions = details === null ? 0 : cautionCount(details);

  return (
    <div className={has ? "result has-result" : "result"} data-testid={has ? `${prefix}-result` : undefined}>
      <Live
        ref={statusRef}
        data-testid={statusTestId}
        className={warn ? "result-text warning" : "result-text"}
        {...statusAttrs}
      >
        {lines.map((line, i) => (
          <p
            key={line}
            className={i === 0 ? undefined : "note"}
            data-testid={i === 0 ? headlineTestId : undefined}
          >
            {line}
          </p>
        ))}
      </Live>
      {has && (
        <div className="result-actions">
          {onShowFolder && (
            <button type="button" data-testid={`${prefix}-show-folder`} onClick={onShowFolder}>
              {t("start.showInFolder")}
            </button>
          )}
          {details !== null && (
            <button
              ref={toggleRef}
              type="button"
              className="icon-button result-details-button"
              data-testid={`${prefix}-details-toggle`}
              data-cautions={cautions}
              aria-label={
                cautions > 0 ? t("result.detailsWithNotes", { notes: notesText(cautions) }) : t("result.details")
              }
              title={t("result.details")}
              aria-expanded={open}
              aria-controls={drawerId}
              onClick={() => setOpenFor(open ? null : details)}
            >
              <InfoIcon />
              {cautions > 0 && <span className="result-badge" aria-hidden="true" data-testid={`${prefix}-badge`} />}
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            data-testid={`${prefix}-dismiss`}
            aria-label={t("result.dismiss")}
            title={t("result.dismiss")}
            onClick={() => {
              // The button is about to go away: keep focus on the page.
              document.getElementById(fallbackId)?.focus();
              onDismiss();
            }}
          >
            <CloseIcon />
          </button>
        </div>
      )}
      {details !== null && (
        <aside
          id={drawerId}
          className="result-drawer"
          aria-labelledby={headingId}
          hidden={!open}
          data-testid={`${prefix}-details`}
        >
          <div className="result-drawer-head">
            <h3 id={headingId} ref={headingRef} tabIndex={-1}>
              {t("result.details")}
            </h3>
            <button type="button" data-testid={`${prefix}-details-close`} onClick={() => setOpenFor(null)}>
              {t("common.close")}
            </button>
          </div>
          <DetailsList details={details} testId={`${prefix}-details-list`} />
        </aside>
      )}
    </div>
  );
}

/**
 * The compact window's version of the Details panel: a small disclosure under
 * the line, since that window is too small for a side panel. Same rows, same
 * caution badge.
 */
export function InlineDetails({ prefix, details }: { prefix: string; details: ResultDetails }) {
  const regionId = useId();
  const [open, setOpen] = useState(false);
  const cautions = cautionCount(details);
  return (
    <>
      <button
        type="button"
        className="result-inline-toggle"
        data-testid={`${prefix}-details-toggle`}
        data-cautions={cautions}
        aria-label={cautions > 0 ? t("result.detailsWithNotes", { notes: notesText(cautions) }) : t("result.details")}
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((v) => !v)}
      >
        {t("result.details")}
        {cautions > 0 && <span className="result-badge" aria-hidden="true" data-testid={`${prefix}-badge`} />}
      </button>
      <div id={regionId} className="result-inline" hidden={!open} data-testid={`${prefix}-details`}>
        <DetailsList details={details} testId={`${prefix}-details-list`} />
      </div>
    </>
  );
}
