import { useCallback, useEffect, useRef, useState } from "react";

import { errorText, formatSize, shortSize } from "../browser/format";
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
      return "Folder";
    case "file":
      return "File";
    case "link":
      return "Link";
    case "special":
      return "Special file";
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

  const listError = useCallback((e: unknown) => setError(errorText("Could not list", e)), []);

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
        setError(errorText("Could not open the archive", e));
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
    setError(null);
    setJob({ state: "starting" });
    startJob(request, onEvent).catch((e: unknown) => {
      setJob({ state: "idle" });
      setError(errorText("Could not start", e));
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
      (e: unknown) => setError(errorText("Could not check the folder", e)),
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
      <h2 id="foreign-heading">Other archive formats (read-only)</h2>
      <div className="actions">
        <button type="button" data-testid="foreign-open" onClick={() => void doOpen(false)} disabled={busy || jobBusy}>
          Open ZIP, 7z, RAR or tar…
        </button>
        <button type="button" data-testid="foreign-close" onClick={() => void doClose()} disabled={!open || busy || jobBusy}>
          Close
        </button>
      </div>
      {error && (
        <p role="alert" className="error" data-testid="foreign-error">
          {error}
        </p>
      )}
      {ask && (
        <form
          className="panel"
          data-testid="foreign-password"
          onSubmit={(e) => {
            e.preventDefault();
            void doOpen(true);
          }}
        >
          <p role="note" data-testid="foreign-password-note">
            {ask.reason === "wrong"
              ? "That password did not open the archive. Try again."
              : "This archive's names are encrypted, so a password is needed before it can be listed."}
          </p>
          <label>
            Password{" "}
            <input ref={passwordRef} type="password" autoComplete="off" data-testid="foreign-password-input" />
          </label>
          <div className="actions">
            <button type="submit" data-testid="foreign-password-submit" disabled={busy}>
              Open
            </button>
            <button type="button" data-testid="foreign-password-cancel" onClick={() => setAsk(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {!open && !error && !ask && <p data-testid="foreign-empty">No ZIP, 7z, RAR or tar archive is open.</p>}
      {open && (
        <>
          <p className="archive-meta" data-testid="foreign-meta">
            <strong>{open.file_name}</strong> · {open.format} archive (foreign format) ·{" "}
            {open.entries.toLocaleString("en-US")} {open.entries === 1 ? "entry" : "entries"}
            {open.opened_with_password ? " · opened with a password" : ""}
          </p>
          <p className="note" data-testid="foreign-label">
            {FOREIGN_NOTE}
          </p>
          <p className="note" data-testid="foreign-dimensions">
            {dimensionsLine(open.dimensions)}
          </p>
          <p className="note" data-testid="foreign-checks">
            Checks this format has: {open.checks}.
          </p>
          {open.weak_encryption && (
            <p role="note" className="warning" data-testid="foreign-weak">
              {WEAK_NOTE}
            </p>
          )}
          {!open.complete && (
            <p role="note" className="warning" data-testid="foreign-partial">
              Partial listing: {open.stop_reason?.text ?? "the listing stopped early"}. Entries after
              that point are not shown.
            </p>
          )}
          {open.notes.length > 0 && (
            <ul className="staged" aria-label="Limits reached while listing" data-testid="foreign-notes">
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
              Read and check entries
            </button>
            <button
              type="button"
              data-testid="foreign-extract-all"
              disabled={jobBusy}
              onClick={() => planFor([], null, true)}
            >
              Extract all…
            </button>
            <button
              type="button"
              data-testid="foreign-extract-selected"
              disabled={jobBusy || selected === null || selected.key === null}
              onClick={() => selected?.key && planFor([selected.key], selected.name, true)}
              title={selected ? undefined : "Select an entry first"}
            >
              Extract selected…
            </button>
          </div>
          <p className="note">{TEST_NOTE}</p>

          {plan && (
            <div className="panel" role="group" aria-label="Extract to" data-testid="foreign-plan">
              <h3>Extract to…</h3>
              <dl>
                <dt>Folder</dt>
                <dd data-testid="foreign-destination">{plan.plan.plan.destination}</dd>
                <dt>What</dt>
                <dd>
                  {plan.what ? <Name name={plan.what} /> : "Everything in the archive"} (
                  {plan.plan.plan.entries.toLocaleString("en-US")}{" "}
                  {plan.plan.plan.entries === 1 ? "item" : "items"})
                </dd>
              </dl>
              <p className="note">{EXTRACT_NOTE}</p>
              {plan.plan.skipped_kinds > 0 && (
                <p role="note" className="warning" data-testid="foreign-skipped-kinds">
                  {plan.plan.skipped_kinds.toLocaleString("en-US")}{" "}
                  {plan.plan.skipped_kinds === 1 ? "entry is" : "entries are"} a link or special file and
                  will be skipped.
                </p>
              )}
              {hasConflicts && (
                <div data-testid="foreign-conflicts">
                  <p role="note" className="warning">
                    {plan.plan.plan.conflicts_total.toLocaleString("en-US")}{" "}
                    {plan.plan.plan.conflicts_total === 1 ? "entry cannot" : "entries cannot"} be extracted
                    here:
                  </p>
                  <ul className="staged" aria-label="Entries that cannot be extracted">
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
                  {hasConflicts ? "Extract the rest, skipping these" : "Extract"}
                </button>
                <button
                  type="button"
                  data-testid="foreign-change-folder"
                  disabled={jobBusy}
                  onClick={() => planFor(plan.keys, plan.what, true)}
                >
                  Choose a different folder…
                </button>
                <button type="button" data-testid="foreign-plan-close" disabled={jobBusy} onClick={() => setPlan(null)}>
                  Close
                </button>
              </div>
            </div>
          )}

          {jobBusy && (
            <div className="progress" data-testid="foreign-running">
              {job.state === "running" && (
                <span data-testid="foreign-progress">
                  {job.phase ? progressText(job.phase, job.completed, job.total) : "Starting…"}
                  {job.cancelRequested ? " (cancelling…)" : ""}
                </span>
              )}
              <button
                type="button"
                data-testid="foreign-cancel"
                onClick={cancel}
                disabled={job.state !== "running" || job.cancelRequested}
              >
                Cancel
              </button>
            </div>
          )}

          {described && job.state === "done" && (
            <div role="status" data-testid="foreign-status" data-state={job.outcome.status}>
              <p data-testid="foreign-headline">{described.headline}</p>
              {done?.foreign_test && (
                <div data-testid="foreign-test-report">
                  <ul className="staged" aria-label="What was checked">
                    {done.foreign_test.checks.map((c) => (
                      <li key={c.what} data-testid="foreign-check-count">
                        {c.count.toLocaleString("en-US")} × {c.what}
                      </li>
                    ))}
                  </ul>
                  <p className="note" data-testid="foreign-stream-check">
                    Whole-archive check: {done.foreign_test.stream_check}
                  </p>
                  <p className="note">{dimensionsLine(done.foreign_test.dimensions)}</p>
                  {done.foreign_test.stop_reason && (
                    <p className="warning">Stopped early: {done.foreign_test.stop_reason.text}</p>
                  )}
                  {done.foreign_test.problems.length > 0 && (
                    <ul className="staged" data-testid="foreign-problems" aria-label="Entries with problems">
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
                  <p className="warning">Not extracted:</p>
                  <ul className="staged" data-testid="foreign-not-extracted" aria-label="Entries not extracted">
                    {done.extract.not_extracted.map((e) => (
                      <li key={`${e.code}:${e.path.text}`} data-testid="foreign-not-extracted-item">
                        <Name name={e.path} /> <span className="meta">({e.code})</span> {e.reason.text}
                      </li>
                    ))}
                  </ul>
                  {done.extract.not_extracted_total > done.extract.not_extracted.length && (
                    <p className="note">
                      …and{" "}
                      {(done.extract.not_extracted_total - done.extract.not_extracted.length).toLocaleString("en-US")}{" "}
                      more.
                    </p>
                  )}
                </>
              )}
              {described.notes.map((l) => (
                <p key={l} className="note">
                  {l}
                </p>
              ))}
            </div>
          )}

          <div className="listing">
            <nav aria-label="Current folder" className="crumbs" data-testid="foreign-crumbs">
              <button type="button" className="link" onClick={() => navigate([])}>
                {open.file_name}
              </button>
              {path.map((c, i) => (
                <span key={c.key}>
                  {" / "}
                  <button type="button" className="link" onClick={() => navigate(path.slice(0, i + 1))}>
                    <Name name={c.name} />
                  </button>
                </span>
              ))}
            </nav>
            <p className="count" data-testid="foreign-count">
              {count === null
                ? "Loading…"
                : `${count.toLocaleString("en-US")} ${count === 1 ? "entry" : "entries"} in this folder`}
            </p>
            {count !== null && (
              <VirtualList
                key={listingId}
                total={count}
                rowHeight={ROW_HEIGHT}
                loadPage={loadPage}
                label="Folder contents"
                testId="foreign-entries"
                onError={listError}
                renderRow={(row: ForeignRow) => (
                  <button
                    type="button"
                    className={selected && row.key !== null && row.key === selected.key ? "entry selected" : "entry"}
                    data-testid="foreign-entry"
                    data-kind={row.kind}
                    data-refused={row.note ? "true" : undefined}
                    aria-pressed={selected !== null && row.key !== null && row.key === selected.key}
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
                        ? `${(row.child_dirs + row.child_files).toLocaleString("en-US")} items`
                        : row.size === null
                          ? ""
                          : shortSize(row.size)}
                    </span>
                  </button>
                )}
              />
            )}
          </div>
          {selected && (
            <section className="details" aria-label="Details" data-testid="foreign-details">
              <h3>Details</h3>
              <dl>
                <dt>Name</dt>
                <dd>
                  <Name name={selected.name} />
                </dd>
                <dt>Kind</dt>
                <dd>{kindLabel(selected)}</dd>
                {selected.size !== null && (
                  <>
                    <dt>Declared size</dt>
                    <dd>{formatSize(selected.size)}</dd>
                  </>
                )}
                {selected.encryption && (
                  <>
                    <dt>Encryption</dt>
                    <dd>{selected.encryption}</dd>
                  </>
                )}
              </dl>
              <p className="note">
                Listing reads the archive's index only. The size is what the archive claims; no entry
                has been read or checked.
              </p>
            </section>
          )}
        </>
      )}
    </section>
  );
}
