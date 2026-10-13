import { useCallback, useEffect, useRef, useState } from "react";

import { errorText } from "../browser/format";
import { Name } from "../browser/Name";
import type { ArchiveSummary, NameText } from "../ipc/browse";
import { cancelJob, startJob } from "../ipc/jobs";
import type { IpcError, JobEvent, JobRequest } from "../ipc/jobs";
import {
  chooseDestination,
  clearStaged,
  stageSources,
  stagedSources,
  unstageSource,
  watchDrops,
} from "../ipc/write";
import type { CompressionPreset, SourcePick, StagedView } from "../ipc/write";
import { DELETE_NOTE, outcomeLines, progressText, TAR_NOTES } from "./messages";
import type { Operation } from "./messages";

/** The compression presets, in the order shown. */
export const PRESETS: { id: CompressionPreset; label: string; hint: string }[] = [
  { id: "fast", label: "Fast", hint: "quickest, larger archive" },
  { id: "balanced", label: "Balanced", hint: "the default" },
  { id: "smaller", label: "Smaller", hint: "slowest, smallest archive" },
];

/** The entry the list has selected, for the remove flow. */
export type SelectedEntry = { key: string; name: NameText };

export interface WriterProps {
  /** The open archive, if any: what "Add" adds to. */
  archive: ArchiveSummary | null;
  /** Whether the snapshot on screen is the latest; only it can be changed. */
  viewingHead: boolean;
  selected: SelectedEntry | null;
  /**
   * A commit was published. `archive` is the archive as it now stands (the
   * same handle for an add or remove, a new one for a create), `null` if it
   * could not be reopened.
   */
  onCommitted: (archive: ArchiveSummary | null) => void;
}

type Mode = "closed" | "create" | "add" | "remove";

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
  | { state: "done"; lines: string[]; committed: boolean }
  | { state: "error"; text: string };

const EMPTY: StagedView = { items: [], destination: null };

function kindLabel(kind: "file" | "folder" | "other"): string {
  return kind === "folder" ? "Folder" : kind === "file" ? "File" : "Not stored (not a file or folder)";
}

/**
 * Plan D2: create an archive, add to one, and remove entries from its current
 * snapshot. The webview names no path: sources come from native dialogs shown
 * by Rust or from files dropped on the window (Rust receives them), and the
 * jobs run in Rust over the shared job channel.
 */
export function Writer({ archive, viewingHead, selected, onCommitted }: WriterProps) {
  const [mode, setMode] = useState<Mode>("closed");
  const [staged, setStaged] = useState<StagedView>(EMPTY);
  const [problems, setProblems] = useState<IpcError[]>([]);
  const [dragging, setDragging] = useState(false);
  const [preset, setPreset] = useState<CompressionPreset>("balanced");
  const [tar, setTar] = useState(false);
  const [job, setJob] = useState<JobView>({ state: "idle" });
  const [error, setError] = useState<string | null>(null);

  // The drop listener is registered once; it reads the latest values here.
  const latestRef = useRef({ archive, busy: false });
  useEffect(() => {
    latestRef.current = {
      archive,
      busy: job.state === "starting" || job.state === "running",
    };
  });
  const operationRef = useRef<Operation>("add");
  const onCommittedRef = useRef(onCommitted);
  useEffect(() => {
    onCommittedRef.current = onCommitted;
  });

  useEffect(() => {
    stagedSources().then(setStaged, () => undefined);
    watchDrops((event) => {
      if (event.event === "hover") {
        setDragging(event.active);
        return;
      }
      setStaged(event.staged);
      setProblems(event.problems);
      if (latestRef.current.busy) return;
      setMode((m) => (m === "create" || m === "add" ? m : latestRef.current.archive ? "add" : "create"));
    }).catch((e: unknown) => setError(errorText("Drag and drop is not available", e)));
  }, []);

  const busy = job.state === "starting" || job.state === "running";

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
        case "finished": {
          const o = event.outcome;
          return {
            state: "done",
            lines: outcomeLines(operationRef.current, o),
            committed: o.status === "completed" && o.commit !== undefined,
          };
        }
      }
    });
    if (event.event === "finished") {
      const o = event.outcome;
      stagedSources().then(setStaged, () => undefined);
      if (o.status === "completed" && o.commit) {
        setMode("closed");
        setProblems([]);
        onCommittedRef.current(o.commit.archive ?? null);
      }
    }
  }, []);

  const run = (op: Operation, request: JobRequest) => {
    operationRef.current = op;
    setError(null);
    setJob({ state: "starting" });
    startJob(request, onEvent).catch((e: unknown) => {
      setJob({ state: "idle" });
      setError(errorText("Could not start", e));
    });
  };

  const stage = (pick: SourcePick) => {
    setError(null);
    stageSources(pick).then(
      (out) => {
        setStaged(out.staged);
        setProblems(out.problems);
      },
      (e: unknown) => setError(errorText("Could not add the selection", e)),
    );
  };

  const unstage = (index: number) => {
    unstageSource(index).then(setStaged, (e: unknown) => setError(errorText("Could not remove", e)));
  };

  const open = (to: Mode) => {
    setJob({ state: "idle" });
    setError(null);
    setProblems([]);
    setMode(to);
  };

  const close = () => {
    setMode("closed");
    setProblems([]);
    setError(null);
  };

  const discard = () => {
    clearStaged().then(setStaged, () => undefined);
  };

  const create = () => {
    setError(null);
    chooseDestination().then(
      (view) => {
        if (view === null) return; // the user cancelled the dialog
        setStaged(view);
        run("create", { kind: "create_archive", preset, tar_compatible: tar });
      },
      (e: unknown) => setError(errorText("Could not choose a location", e)),
    );
  };

  const cancel = () => {
    if (job.state !== "running") return;
    const { jobId } = job;
    setJob({ ...job, cancelRequested: true });
    cancelJob(jobId).catch(() => undefined);
  };

  const canAdd = archive !== null;
  const canRemove = archive !== null && viewingHead && selected !== null;

  const stagedList = (
    <>
      <div className="actions">
        <button type="button" data-testid="stage-files" onClick={() => stage("files")} disabled={busy}>
          Add files…
        </button>
        <button type="button" data-testid="stage-folder" onClick={() => stage("folder")} disabled={busy}>
          Add folder…
        </button>
        <button type="button" data-testid="stage-clear" onClick={discard} disabled={busy || staged.items.length === 0}>
          Clear
        </button>
      </div>
      <p className="note">You can also drop files and folders anywhere on this window.</p>
      {staged.items.length === 0 ? (
        <p data-testid="staged-empty">Nothing chosen yet.</p>
      ) : (
        <ul className="staged" data-testid="staged-list" aria-label="Chosen items">
          {staged.items.map((item, i) => (
            <li key={item.name.text} data-testid="staged-item">
              <span className="kind-label">{kindLabel(item.kind)}</span> <Name name={item.name} />
              <button
                type="button"
                className="link"
                data-testid="unstage"
                onClick={() => unstage(i)}
                disabled={busy}
              >
                Remove from list
              </button>
            </li>
          ))}
        </ul>
      )}
      {problems.length > 0 && (
        <ul role="alert" className="error" data-testid="write-problems">
          {problems.map((p) => (
            <li key={`${p.code}:${p.message}`}>
              Not added ({p.code}): {p.message}
            </li>
          ))}
        </ul>
      )}
    </>
  );

  return (
    <section aria-labelledby="write-heading" className="writer" data-testid="writer">
      <h2 id="write-heading">Create and add</h2>
      {dragging && (
        <p className="drop-overlay" data-testid="drop-overlay" role="note">
          Drop files and folders to choose them.
        </p>
      )}
      <div className="actions">
        <button type="button" data-testid="new-archive" onClick={() => open("create")} disabled={busy}>
          New archive…
        </button>
        <button
          type="button"
          data-testid="add-to-archive"
          onClick={() => open("add")}
          disabled={busy || !canAdd}
          title={canAdd ? undefined : "Open an archive first"}
        >
          Add to archive…
        </button>
        <button
          type="button"
          data-testid="remove-entry"
          onClick={() => open("remove")}
          disabled={busy || !canRemove}
          title={
            !archive
              ? "Open an archive first"
              : !viewingHead
                ? "Only the latest commit can be changed"
                : selected
                  ? undefined
                  : "Select an entry first"
          }
        >
          Remove from snapshot…
        </button>
      </div>
      {error && (
        <p role="alert" className="error" data-testid="write-error">
          {error}
        </p>
      )}

      {mode === "create" && (
        <div className="panel" data-testid="write-panel" role="group" aria-label="New archive">
          <h3>New archive</h3>
          {stagedList}
          <fieldset disabled={busy}>
            <legend>Compression</legend>
            {PRESETS.map((p) => (
              <label key={p.id}>
                <input
                  type="radio"
                  name="preset"
                  data-testid={`preset-${p.id}`}
                  checked={preset === p.id}
                  onChange={() => setPreset(p.id)}
                />{" "}
                {p.label} <span className="meta">({p.hint})</span>
              </label>
            ))}
          </fieldset>
          <fieldset disabled={busy}>
            <legend>Compatibility</legend>
            <label>
              <input
                type="checkbox"
                data-testid="tar-compatible"
                checked={tar}
                onChange={(e) => setTar(e.target.checked)}
              />{" "}
              Readable with standard zstd + tar
            </label>
            <ul className="note" data-testid="tar-notes">
              {TAR_NOTES.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </fieldset>
          <fieldset disabled>
            <legend>Not available yet</legend>
            <label>
              <input type="checkbox" data-testid="encryption-unavailable" disabled /> Encryption
            </label>
            <label>
              <input type="checkbox" data-testid="recovery-unavailable" disabled /> Recovery record
            </label>
            <p className="note">These arrive in a later version and cannot be turned on yet.</p>
          </fieldset>
          <div className="actions">
            <button
              type="button"
              data-testid="create-confirm"
              onClick={create}
              disabled={busy || staged.items.length === 0}
            >
              Choose location and create…
            </button>
            <button type="button" data-testid="write-close" onClick={close} disabled={busy}>
              Close
            </button>
          </div>
        </div>
      )}

      {mode === "add" && archive && (
        <div className="panel" data-testid="write-panel" role="group" aria-label="Add to archive">
          <h3>
            Add to <Name name={{ text: archive.file_name, verbatim: true }} />
          </h3>
          <p className="note">
            This makes one new commit. An item with the same name as one in the latest snapshot
            replaces it there; the earlier version stays in the history.
            {archive.profile.tar_compatible
              ? " This archive is TAR-compatible, as chosen when it was created."
              : ""}
          </p>
          {stagedList}
          <div className="actions">
            <button
              type="button"
              data-testid="add-confirm"
              onClick={() => run("add", { kind: "add_to_archive", handle: archive.handle })}
              disabled={busy || staged.items.length === 0}
            >
              Add to archive
            </button>
            <button type="button" data-testid="write-close" onClick={close} disabled={busy}>
              Close
            </button>
          </div>
        </div>
      )}

      {mode === "remove" && archive && selected && (
        <div className="panel" data-testid="write-panel" role="group" aria-label="Remove from snapshot">
          <h3>Remove from the current snapshot</h3>
          <p>
            Remove <Name name={selected.name} /> from the current snapshot?
          </p>
          <p className="note" data-testid="delete-note">
            {DELETE_NOTE}
          </p>
          <div className="actions">
            <button
              type="button"
              data-testid="delete-confirm"
              onClick={() =>
                run("delete", { kind: "delete_from_archive", handle: archive.handle, keys: [selected.key] })
              }
              disabled={busy}
            >
              Remove from snapshot
            </button>
            <button type="button" data-testid="delete-keep" onClick={close} disabled={busy}>
              Keep it
            </button>
          </div>
        </div>
      )}

      {(job.state === "starting" || job.state === "running") && (
        <div className="progress" data-testid="write-running">
          {job.state === "running" && (
            <>
              <progress value={job.total === null ? undefined : job.completed} max={job.total ?? undefined} />
              <span data-testid="write-progress">
                {job.phase ? progressText(job.phase, job.completed, job.total) : "Starting…"}
                {job.cancelRequested ? " (cancelling…)" : ""}
              </span>
            </>
          )}
          {job.state === "starting" && <span>Starting…</span>}
          <button
            type="button"
            data-testid="write-cancel"
            onClick={cancel}
            disabled={job.state !== "running" || job.cancelRequested}
          >
            Cancel
          </button>
        </div>
      )}
      {job.state === "done" && (
        <div role="status" data-testid="write-status" data-committed={job.committed}>
          {job.lines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
      )}
    </section>
  );
}
