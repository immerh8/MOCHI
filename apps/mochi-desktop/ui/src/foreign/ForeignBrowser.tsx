import { useCallback, useEffect, useRef, useState } from "react";

import { useJobFocus } from "../a11y/focus";
import { Live } from "../a11y/Live";
import { Panel } from "../a11y/Panel";
import { ProgressMeter } from "../a11y/ProgressMeter";
import { errorText, formatSize, shortSize } from "../browser/format";
import { t, tc } from "../i18n";
import { Name } from "../browser/Name";
import { VirtualList } from "../browser/VirtualList";
import {
  closeForeignArchive,
  foreignChildren,
  openForeignArchive,
  planExtractForeign,
} from "../ipc/foreign";
import type { ForeignArchiveSummary, ForeignExtractPlan, ForeignRow } from "../ipc/foreign";
import { cancelJob, isIpcError, startJob } from "../ipc/jobs";
import type { JobEvent, JobOutcome } from "../ipc/jobs";
import type { NameText } from "../ipc/browse";
import {
  describeOutcome,
  dimensionsLine,
  EXTRACT_NOTE,
  FOREIGN_NOTE,
  needsPassword,
  progressText,
  TEST_NOTE,
  WEAK_NOTE,
} from "./messages";

/** Row height of the list, in pixels (matches `.vrow` in CSS). */
const ROW_HEIGHT = 28;

type Crumb = { key: string; name: NameText };

type Ask = { reason: "ask" | "wrong" };

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

function kindLabel(row: ForeignRow): string {
  switch (row.kind) {
    case "directory":
      return t("foreign.kindFolder");
    case "file":
      return t("foreign.kindFile");
    case "link":
      return t("foreign.kindLink");
    case "special":
      return t("foreign.kindSpecial");
  }
}

const kindGlyph = (row: ForeignRow) =>
  row.kind === "directory" ? "▣" : row.kind === "file" ? "▢" : "◇";

/**
 * Plan D8: open a ZIP, 7z, RAR, tar, or tar.gz archive read-only; browse it,
 * read and check its entries, and extract from it. It is labelled as a
 * foreign format throughout and uses none of MOCHI's verification wording or
 * health dimensions. The archive and the folder come from native dialogs shown
 * by Rust; a password is typed here once and kept in Rust.
 */
export function ForeignBrowser() {
  const [open, setOpen] = useState<ForeignArchiveSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [path, setPath] = useState<Crumb[]>([]);
  const [total, setTotal] = useState<{ id: string; n: number } | null>(null);
  const [selected, setSelected] = useState<ForeignRow | null>(null);
  const [plan, setPlan] = useState<{ plan: ForeignExtractPlan; keys: string[]; what: NameText | null } | null>(
    null,
  );
  const [job, setJob] = useState<JobView>({ state: "idle" });
  const passwordRef = useRef<HTMLInputElement>(null);

  const handle = open?.handle ?? null;
  const dir = path.at(-1)?.key ?? null;
  const listingId = `${handle ?? ""}:${dir ?? ""}`;
  const count = total?.id === listingId ? total.n : null;
  const jobBusy = job.state === "starting" || job.state === "running";
  const rememberFocus = useJobFocus(jobBusy);

  const listError = useCallback((e: unknown) => setError(errorText(t("foreign.listFailed"), e)), []);

  useEffect(() => {
    if (handle === null) return;
    let live = true;
    foreignChildren(handle, dir, 0, 1).then(
      (p) => {
        if (live) setTotal({ id: listingId, n: p.total });
      },
      (e: unknown) => {
        if (live) listError(e);
      },
    );
    return () => {
      live = false;
    };
  }, [handle, dir, listingId, listError]);

  const loadPage = useCallback(
    (offset: number, limit: number) =>
      handle === null
        ? Promise.resolve([])
        : foreignChildren(handle, dir, offset, limit).then((p) => p.entries),
    [handle, dir],
  );

  const navigate = (to: Crumb[]) => {
    setPath(to);
    setSelected(null);
  };

  /** Open: the dialog first, or (after a password prompt) the same file again. */
  const doOpen = async (retry: boolean) => {
    setError(null);
    setBusy(true);
    const password = retry ? (passwordRef.current?.value ?? "") : null;
    try {
      const summary = await openForeignArchive(retry, password);
      // The password has been sent; do not keep it in the field.
      if (passwordRef.current) passwordRef.current.value = "";
      if (summary === null) return;
      if (open) await closeForeignArchive(open.handle).catch(() => false);
      setAsk(null);
      setOpen(summary);
      setPlan(null);
      setJob({ state: "idle" });
      navigate([]);
    } catch (e) {
      if (passwordRef.current) passwordRef.current.value = "";
      const kind = isIpcError(e) ? needsPassword(e.code) : null;
      if (kind !== null) setAsk({ reason: kind });
      else {
        setAsk(null);
        setError(errorText(t("foreign.openFailed"), e));
      }
    } finally {
      setBusy(false);
    }
  };

  const doClose = async () => {
    if (!open) return;
    await closeForeignArchive(open.handle).catch(() => false);
    setOpen(null);
    setPlan(null);
    setError(null);
    setJob({ state: "idle" });
    navigate([]);
  };

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
    if (event.event === "finished" && event.outcome.status === "completed") setPlan(null);
  }, []);

  const begin = (request: Parameters<typeof startJob>[0]) => {
    rememberFocus();
    setError(null);
    setJob({ state: "starting" });
    startJob(request, onEvent).catch((e: unknown) => {
      setJob({ state: "idle" });
      setError(errorText(t("foreign.startFailed"), e));
    });
  };

  const planFor = (keys: string[], what: NameText | null, pick: boolean) => {
    if (handle === null) return;
    setError(null);
    setJob({ state: "idle" });
    planExtractForeign(handle, keys, pick).then(
      (p) => {
        if (p !== null) setPlan({ plan: p, keys, what });
      },
      (e: unknown) => setError(errorText(t("foreign.folderFailed"), e)),
    );
  };

  const cancel = () => {
    if (job.state !== "running") return;
    const { jobId } = job;
    setJob({ ...job, cancelRequested: true });
    cancelJob(jobId).catch(() => undefined);
  };

  const described = job.state === "done" ? describeOutcome(job.outcome) : null;
  const done = job.state === "done" && job.outcome.status === "completed" ? job.outcome : null;
  const hasConflicts = plan !== null && plan.plan.plan.conflicts_total > 0;

  return (
    <section aria-labelledby="foreign-heading" className="browser foreign" data-testid="foreign">
      <h2 id="foreign-heading" tabIndex={-1}>
        {t("foreign.heading")}
      </h2>
      <div className="actions">
        <button type="button" data-testid="foreign-open" onClick={() => void doOpen(false)} disabled={busy || jobBusy}>
          {t("foreign.open")}
        </button>
        <button type="button" data-testid="foreign-close" onClick={() => void doClose()} disabled={!open || busy || jobBusy}>
          {t("foreign.close")}
        </button>
      </div>
      {error && (
        <p role="alert" className="error" data-testid="foreign-error">
          {error}
        </p>
      )}
      {ask && (
        <Panel
          label={t("foreign.passwordGroup")}
          heading={t("foreign.passwordGroup")}
          testId="foreign-password"
          fallbackId="foreign-heading"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void doOpen(true);
            }}
          >
            <p role="note" data-testid="foreign-password-note">
              {t(ask.reason === "wrong" ? "foreign.wrongPassword" : "foreign.needPassword")}
            </p>
            <label>
              {t("foreign.password")}{" "}
              <input ref={passwordRef} type="password" autoComplete="off" data-testid="foreign-password-input" />
            </label>
            <div className="actions">
              <button type="submit" data-testid="foreign-password-submit" disabled={busy}>
                {t("foreign.passwordSubmit")}
              </button>
              <button type="button" data-testid="foreign-password-cancel" onClick={() => setAsk(null)}>
                {t("common.cancel")}
              </button>
            </div>
          </form>
        </Panel>
      )}
      {!open && !error && !ask && <p data-testid="foreign-empty">{t("foreign.empty")}</p>}
      {open && (
        <>
          <p className="archive-meta" data-testid="foreign-meta">
            <strong>{open.file_name}</strong>
            {t("browser.metaSeparator")}
            {t("foreign.meta", { format: open.format })}
            {t("browser.metaSeparator")}
            {tc(open.entries, "count.entryOne", "count.entryMany")}
            {open.opened_with_password ? t("foreign.openedWithPassword") : ""}
          </p>
          <p className="note" data-testid="foreign-label">
            {FOREIGN_NOTE}
          </p>
          <p className="note" data-testid="foreign-dimensions">
            {dimensionsLine(open.dimensions)}
          </p>
          <p className="note" data-testid="foreign-checks">
            {t("foreign.checks", { checks: open.checks })}
          </p>
          {open.weak_encryption && (
            <p role="note" className="warning" data-testid="foreign-weak">
              {WEAK_NOTE}
            </p>
          )}
          {!open.complete && (
            <p role="note" className="warning" data-testid="foreign-partial">
              {t("foreign.partial", { reason: open.stop_reason?.text ?? t("foreign.partialDefault") })}
            </p>
          )}
          {open.notes.length > 0 && (
            <ul className="staged" aria-label={t("foreign.limitNotes")} data-testid="foreign-notes">
              {open.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <div className="actions">
            <button
              type="button"
              data-testid="foreign-test"
              disabled={jobBusy}
              onClick={() => begin({ kind: "test_foreign", handle: open.handle })}
              title={TEST_NOTE}
            >
              {t("foreign.testButton")}
            </button>
            <button
              type="button"
              data-testid="foreign-extract-all"
              disabled={jobBusy}
              onClick={() => planFor([], null, true)}
            >
              {t("foreign.extractAll")}
            </button>
            <button
              type="button"
              data-testid="foreign-extract-selected"
              disabled={jobBusy || selected === null || selected.key === null}
              onClick={() => selected?.key && planFor([selected.key], selected.name, true)}
              title={selected ? undefined : t("foreign.selectFirst")}
            >
              {t("foreign.extractSelected")}
            </button>
          </div>
          <p className="note">{TEST_NOTE}</p>

          {plan && (
            <Panel
              label={t("foreign.planGroup")}
              heading={t("foreign.planHeading")}
              testId="foreign-plan"
              fallbackId="foreign-heading"
            >
              <dl>
                <dt>{t("foreign.folder")}</dt>
                <dd data-testid="foreign-destination">{plan.plan.plan.destination}</dd>
                <dt>{t("foreign.what2")}</dt>
                <dd>
                  {plan.what ? <Name name={plan.what} /> : t("foreign.everything")} (
                  {t(plan.plan.plan.entries === 1 ? "foreign.itemsOne" : "foreign.itemsMany", {
                    n: plan.plan.plan.entries.toLocaleString("en-US"),
                  })}
                  )
                </dd>
              </dl>
              <p className="note">{EXTRACT_NOTE}</p>
              {plan.plan.skipped_kinds > 0 && (
                <p role="note" className="warning" data-testid="foreign-skipped-kinds">
                  {t(plan.plan.skipped_kinds === 1 ? "foreign.skippedKindsOne" : "foreign.skippedKindsMany", {
                    n: plan.plan.skipped_kinds.toLocaleString("en-US"),
                  })}
                </p>
              )}
              {hasConflicts && (
                <div data-testid="foreign-conflicts">
                  <p role="note" className="warning">
                    {t(plan.plan.plan.conflicts_total === 1 ? "foreign.cannotOne" : "foreign.cannotMany", {
                      n: plan.plan.plan.conflicts_total.toLocaleString("en-US"),
                    })}
                  </p>
                  <ul className="staged" aria-label={t("foreign.cannotList")}>
                    {plan.plan.plan.conflicts.map((c) => (
                      <li key={`${c.code}:${c.path.text}`} data-testid="foreign-conflict">
                        <Name name={c.path} /> <span className="meta">({c.code})</span> {c.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="actions">
                <button
                  type="button"
                  data-testid="foreign-extract-confirm"
                  disabled={jobBusy}
                  onClick={() =>
                    begin({
                      kind: "extract_foreign",
                      handle: open.handle,
                      keys: plan.keys,
                      on_conflict: hasConflicts ? "skip_conflicts" : "stop",
                    })
                  }
                >
                  {hasConflicts ? t("foreign.confirmSkip") : t("foreign.confirm")}
                </button>
                <button
                  type="button"
                  data-testid="foreign-change-folder"
                  disabled={jobBusy}
                  onClick={() => planFor(plan.keys, plan.what, true)}
                >
                  {t("foreign.changeFolder")}
                </button>
                <button type="button" data-testid="foreign-plan-close" disabled={jobBusy} onClick={() => setPlan(null)}>
                  {t("common.close")}
                </button>
              </div>
            </Panel>
          )}

          {jobBusy && (
            <div className="progress" data-testid="foreign-running">
              {job.state === "running" && (
                <ProgressMeter
                  completed={job.completed}
                  total={job.total}
                  text={
                    (job.phase ? progressText(job.phase, job.completed, job.total) : t("common.starting")) +
                    (job.cancelRequested ? t("common.cancelling") : "")
                  }
                  textTestId="foreign-progress"
                />
              )}
              <button
                type="button"
                data-testid="foreign-cancel"
                onClick={cancel}
                disabled={job.state !== "running" || job.cancelRequested}
              >
                {t("common.cancel")}
              </button>
            </div>
          )}

          <Live data-testid="foreign-status" data-state={job.state === "done" ? job.outcome.status : undefined}>
            {described && job.state === "done" && (
            <>
              <p data-testid="foreign-headline">{described.headline}</p>
              {done?.foreign_test && (
                <div data-testid="foreign-test-report">
                  <ul className="staged" aria-label={t("foreign.whatChecked")}>
                    {done.foreign_test.checks.map((c) => (
                      <li key={c.what} data-testid="foreign-check-count">
                        {t("foreign.checkCount", { count: c.count.toLocaleString("en-US"), what: c.what })}
                      </li>
                    ))}
                  </ul>
                  <p className="note" data-testid="foreign-stream-check">
                    {t("foreign.streamCheck", { check: done.foreign_test.stream_check })}
                  </p>
                  <p className="note">{dimensionsLine(done.foreign_test.dimensions)}</p>
                  {done.foreign_test.stop_reason && (
                    <p className="warning">{t("foreign.stoppedEarly", { reason: done.foreign_test.stop_reason.text })}</p>
                  )}
                  {done.foreign_test.problems.length > 0 && (
                    <ul className="staged" data-testid="foreign-problems" aria-label={t("foreign.problems")}>
                      {done.foreign_test.problems.map((p) => (
                        <li key={`${p.path.text}:${p.what.text}`} data-testid="foreign-problem">
                          <Name name={p.path} /> — {p.what.text}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {done?.extract && done.extract.not_extracted.length > 0 && (
                <>
                  <p className="warning">{t("foreign.notExtracted")}</p>
                  <ul className="staged" data-testid="foreign-not-extracted" aria-label={t("foreign.notExtractedList")}>
                    {done.extract.not_extracted.map((e) => (
                      <li key={`${e.code}:${e.path.text}`} data-testid="foreign-not-extracted-item">
                        <Name name={e.path} /> <span className="meta">({e.code})</span> {e.reason.text}
                      </li>
                    ))}
                  </ul>
                  {done.extract.not_extracted_total > done.extract.not_extracted.length && (
                    <p className="note">
                      {t("common.andMore", {
                        n: (done.extract.not_extracted_total - done.extract.not_extracted.length).toLocaleString("en-US"),
                      })}
                    </p>
                  )}
                </>
              )}
              {described.notes.map((l) => (
                <p key={l} className="note">
                  {l}
                </p>
              ))}
            </>
            )}
          </Live>

          <div className="listing">
            <nav aria-label={t("foreign.currentFolder")} className="crumbs" data-testid="foreign-crumbs">
              <button type="button" className="link" onClick={() => navigate([])}>
                {open.file_name}
              </button>
              {path.map((c, i) => (
                <span key={c.key}>
                  {t("common.nameSeparator")}
                  <button type="button" className="link" onClick={() => navigate(path.slice(0, i + 1))}>
                    <Name name={c.name} />
                  </button>
                </span>
              ))}
            </nav>
            <p className="count" data-testid="foreign-count">
              {count === null
                ? t("common.loading")
                : t("foreign.countInFolder", { count: tc(count, "count.entryOne", "count.entryMany") })}
            </p>
            {count !== null && (
              <VirtualList
                key={listingId}
                total={count}
                rowHeight={ROW_HEIGHT}
                loadPage={loadPage}
                label={t("foreign.folderContents")}
                hintId="foreign-entry-hint"
                testId="foreign-entries"
                onError={listError}
                renderRow={(row: ForeignRow, _index: number, tabIndex: 0 | -1) => (
                  <button
                    type="button"
                    className={selected && row.key !== null && row.key === selected.key ? "entry selected" : "entry"}
                    data-testid="foreign-entry"
                    data-kind={row.kind}
                    data-refused={row.note ? "true" : undefined}
                    aria-pressed={selected !== null && row.key !== null && row.key === selected.key}
                    tabIndex={tabIndex}
                    onClick={() => setSelected(row)}
                    onDoubleClick={() => {
                      if (row.kind === "directory" && row.key !== null)
                        navigate([...path, { key: row.key, name: row.name }]);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && row.kind === "directory" && row.key !== null) {
                        e.preventDefault();
                        navigate([...path, { key: row.key, name: row.name }]);
                      }
                    }}
                  >
                    <span className="kind" aria-label={kindLabel(row)}>
                      {kindGlyph(row)}
                    </span>
                    <span className="entry-name">
                      <Name name={row.name} />
                      {row.encryption && <span className="meta"> · {row.encryption}</span>}
                      {row.note && <span className="meta"> · {row.note}</span>}
                    </span>
                    <span className="size">
                      {row.kind === "directory"
                        ? t("browser.itemsCount", { n: (row.child_dirs + row.child_files).toLocaleString("en-US") })
                        : row.size === null
                          ? ""
                          : shortSize(row.size)}
                    </span>
                  </button>
                )}
              />
            )}
            <p className="note" id="foreign-entry-hint">
              {t("foreign.listHint")}
            </p>
          </div>
          {selected && (
            <section className="details" aria-label={t("foreign.details")} data-testid="foreign-details">
              <h3>{t("foreign.details")}</h3>
              <dl>
                <dt>{t("foreign.detailName")}</dt>
                <dd>
                  <Name name={selected.name} />
                </dd>
                <dt>{t("foreign.detailKind")}</dt>
                <dd>{kindLabel(selected)}</dd>
                {selected.size !== null && (
                  <>
                    <dt>{t("foreign.detailSize")}</dt>
                    <dd>{formatSize(selected.size)}</dd>
                  </>
                )}
                {selected.encryption && (
                  <>
                    <dt>{t("foreign.detailEncryption")}</dt>
                    <dd>{selected.encryption}</dd>
                  </>
                )}
              </dl>
              <p className="note">{t("foreign.detailsNote")}</p>
            </section>
          )}
        </>
      )}
    </section>
  );
}
