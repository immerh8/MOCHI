import { useCallback, useState } from "react";

import { useJobFocus } from "./a11y/focus";
import { ProgressMeter } from "./a11y/ProgressMeter";
import { Browser } from "./browser/Browser";
import { ForeignBrowser } from "./foreign/ForeignBrowser";
import { Help } from "./help/Help";
import { Updates } from "./update/Updates";
import { t } from "./i18n";
import { CrashReports } from "./settings/CrashReports";
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
      return t("selfTest.completed", { summary: outcome.summary });
    case "cancelled":
      return t("selfTest.cancelled");
    case "failed":
      return t("selfTest.failed", { code: outcome.code, message: outcome.message });
    case "aborted":
      return t("selfTest.aborted", { message: outcome.message });
  }
}

/** The sections of the window in page order: their heading ids and names. */
const SECTIONS: { id: string; name: () => string }[] = [
  { id: "browser-heading", name: () => t("app.sectionArchive") },
  { id: "write-heading", name: () => t("app.sectionCreate") },
  { id: "extract-heading", name: () => t("app.sectionExtract") },
  { id: "search-heading", name: () => t("app.sectionSearch") },
  { id: "rekey-heading", name: () => t("app.sectionPassphrases") },
  { id: "check-heading", name: () => t("app.sectionCheck") },
  { id: "foreign-heading", name: () => t("app.sectionForeign") },
  { id: "self-test-heading", name: () => t("app.sectionSelfTest") },
  { id: "settings-heading", name: () => t("app.sectionSettings") },
  { id: "help-heading", name: () => t("app.sectionHelp") },
];

/**
 * One tab stop per section so that a keyboard user can reach the part of this
 * long page they want without tabbing through everything above it. Each moves
 * focus to the section's heading (a programmatic focus target), which also
 * tells a screen reader where it landed. They are buttons, not anchors: the
 * window has no `href` at all (the browse E2E spec asserts it), so a name that
 * came from an archive can never end up in one.
 */
function SectionNav() {
  return (
    <nav aria-label={t("app.sections")} className="sections">
      <span>{t("app.sectionsIntro")}</span>
      <ul>
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className="link"
              data-target={s.id}
              onClick={() => {
                const heading = document.getElementById(s.id);
                heading?.focus();
                heading?.scrollIntoView?.({ block: "start" });
              }}
            >
              {s.name()}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function App() {
  const [view, setView] = useState<View>({ state: "idle" });
  const running = view.state === "running";
  const busy = running || view.state === "starting";
  // Starting disables the button that was pressed; give focus back at the end.
  const rememberFocus = useJobFocus(busy);

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
    rememberFocus();
    setView({ state: "starting" });
    startJob(SELF_TEST, onEvent).catch((e: unknown) => {
      setView({
        state: "error",
        text: isIpcError(e)
          ? t("selfTest.couldNotStart", { code: e.code, message: e.message })
          : t("selfTest.couldNotStartPlain"),
      });
    });
  }, [onEvent, rememberFocus]);

  const cancel = useCallback(() => {
    if (view.state !== "running") return;
    const { jobId } = view;
    setView({ ...view, cancelRequested: true });
    cancelJob(jobId).catch(() => {
      // The job's own `finished` event reports how it ended.
    });
  }, [view]);

  return (
    <main>
      <h1>{t("app.title")}</h1>
      <SectionNav />
      <Browser />
      <ForeignBrowser />
      <section aria-labelledby="self-test-heading">
        <h2 id="self-test-heading" tabIndex={-1}>
          {t("selfTest.heading")}
        </h2>
        <p>{t("selfTest.intro")}</p>
        <div className="actions">
          <button type="button" data-testid="start" onClick={start} disabled={busy}>
            {t("selfTest.start")}
          </button>
          <button
            type="button"
            data-testid="cancel"
            onClick={cancel}
            disabled={!running || view.cancelRequested}
          >
            {t("selfTest.cancel")}
          </button>
        </div>
        {running && (
          <div className="progress">
            <ProgressMeter
              completed={view.completed}
              total={view.total}
              barTestId="progress"
              textTestId="progress-text"
              text={
                (view.total === null
                  ? t("common.progressStep", { completed: view.completed })
                  : t("common.progressStepOf", { completed: view.completed, total: view.total })) +
                (view.cancelRequested ? t("common.cancelling") : "")
              }
            />
          </div>
        )}
        <p role="status" data-testid="status" data-state={view.state}>
          {view.state === "idle" && t("selfTest.idle")}
          {view.state === "starting" && t("common.starting")}
          {view.state === "running" && t("selfTest.running")}
          {view.state === "finished" && outcomeText(view.outcome)}
          {view.state === "error" && view.text}
        </p>
      </section>
      <CrashReports>
        <Updates />
      </CrashReports>
      <Help />
    </main>
  );
}
