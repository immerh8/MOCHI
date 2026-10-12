import { useCallback, useState } from "react";

import { cancelJob, isIpcError, startJob } from "./ipc/jobs";
import type { JobEvent, JobOutcome } from "./ipc/jobs";

/** The D0 sample job: about five seconds, so it can be watched and cancelled. */
export const SELF_TEST = { kind: "self_test", steps: 50, step_ms: 100 } as const;

type View =
  | { state: "idle" }
  | { state: "starting" }
  | {
      state: "running";
      jobId: number;
      completed: number;
      total: number | null;
      cancelRequested: boolean;
    }
  | { state: "finished"; outcome: JobOutcome }
  | { state: "error"; text: string };

/**
 * Status wording follows spec §23.3: only a completed job is reported as
 * complete, nothing gets success styling (this is not a verification, so
 * there is no PASS to show), and a cancelled or failed job says plainly
 * that it did not finish.
 */
export function outcomeText(outcome: JobOutcome): string {
  switch (outcome.status) {
    case "completed":
      return `Completed: ${outcome.summary}.`;
    case "cancelled":
      return "Cancelled. The self-test stopped before finishing.";
    case "failed":
      return `Failed (${outcome.code}): ${outcome.message}`;
    case "aborted":
      return `Stopped unexpectedly: ${outcome.message}`;
  }
}

export function App() {
  const [view, setView] = useState<View>({ state: "idle" });

  const onEvent = useCallback((event: JobEvent) => {
    setView((prev) => {
      switch (event.event) {
        case "started":
          return prev.state === "running"
            ? prev
            : {
                state: "running",
                jobId: event.job_id,
                completed: 0,
                total: null,
                cancelRequested: false,
              };
        case "progress":
          if (prev.state === "finished") return prev;
          return {
            state: "running",
            jobId: event.job_id,
            completed: event.completed,
            total: event.total,
            cancelRequested: prev.state === "running" && prev.cancelRequested,
          };
        case "finished":
          return { state: "finished", outcome: event.outcome };
      }
    });
  }, []);

  const start = useCallback(() => {
    setView({ state: "starting" });
    startJob(SELF_TEST, onEvent).catch((e: unknown) => {
      setView({
        state: "error",
        text: isIpcError(e) ? `Could not start (${e.code}): ${e.message}` : "Could not start.",
      });
    });
  }, [onEvent]);

  const cancel = useCallback(() => {
    if (view.state !== "running") return;
    const { jobId } = view;
    setView({ ...view, cancelRequested: true });
    cancelJob(jobId).catch(() => {
      // The job's own `finished` event reports how it ended.
    });
  }, [view]);

  const running = view.state === "running";
  const busy = running || view.state === "starting";

  return (
    <main>
      <h1>MOCHI</h1>
      <section aria-labelledby="self-test-heading">
        <h2 id="self-test-heading">Job runner self-test</h2>
        <p>
          A sample job that reads and writes nothing. It reports progress and
          can be cancelled, which is how every long operation in this app will
          behave.
        </p>
        <div className="actions">
          <button type="button" data-testid="start" onClick={start} disabled={busy}>
            Start self-test
          </button>
          <button
            type="button"
            data-testid="cancel"
            onClick={cancel}
            disabled={!running || view.cancelRequested}
          >
            Cancel
          </button>
        </div>
        {running && (
          <div className="progress">
            <progress
              data-testid="progress"
              value={view.completed}
              max={view.total ?? undefined}
            />
            <span data-testid="progress-text">
              {view.total === null
                ? `Step ${view.completed}`
                : `Step ${view.completed} of ${view.total}`}
              {view.cancelRequested ? " (cancelling…)" : ""}
            </span>
          </div>
        )}
        <p role="status" data-testid="status" data-state={view.state}>
          {view.state === "idle" && "Not started."}
          {view.state === "starting" && "Starting…"}
          {view.state === "running" && "Running."}
          {view.state === "finished" && outcomeText(view.outcome)}
          {view.state === "error" && view.text}
        </p>
      </section>
    </main>
  );
}
