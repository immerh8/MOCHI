import { useEffect, useRef, useState } from "react";

import { ProgressMeter } from "../a11y/ProgressMeter";
import { formatSize } from "../browser/format";
import { progressText as extractProgress } from "../extract/messages";
import { t, tc } from "../i18n";
import {
  cancelQuick,
  closeQuick,
  sendQuickPassphrase,
  showQuickFolder,
  subscribeQuick,
  type QuickAction,
  type QuickEvent,
} from "../ipc/quick";
import { isIpcError } from "../ipc/jobs";
import { LOCAL_COMMIT_NOTE, progressText as writeProgress } from "../write/messages";
import "./quick.css";

interface Job {
  action: QuickAction;
  name: string;
  items: number;
}

type View =
  | { kind: "waiting" }
  | { kind: "running"; progress: { phase: string; completed: number; total: number | null } | null }
  | { kind: "passphrase"; wrong: boolean }
  | { kind: "done"; lines: string[]; folder: boolean; failed: boolean };

function title(job: Job): string {
  switch (job.action) {
    case "extract_here":
      return t("quick.titleExtractHere", { name: job.name });
    case "extract_to_folder":
      return t("quick.titleExtractToFolder", { name: job.name });
    case "add":
      return job.items > 1
        ? t("quick.titleAddMore", { name: job.name, n: job.items - 1 })
        : t("quick.titleAdd", { name: job.name });
  }
}

/** The final view for a terminal event; `null` for an event that is not one. */
function finished(event: QuickEvent): View | null {
  switch (event.event) {
    case "done": {
      const counts = t("quick.counts", {
        files: tc(event.files, "count.fileOne", "count.fileMany"),
        folders: tc(event.directories, "count.folderOne", "count.folderMany"),
      });
      const lines: string[] = [];
      if (event.action === "add") {
        lines.push(
          t("quick.doneAdd", { name: event.name.text }),
          t("quick.doneAddDetail", {
            counts,
            size: formatSize(String(event.bytes)),
            status: event.status ?? "",
          }),
        );
        if (event.skipped > 0) {
          lines.push(t("quick.skippedAdd", { n: event.skipped, note: event.note ?? "" }));
        }
        if (event.durability_note) lines.push(t("write.degraded", { note: event.durability_note }));
        lines.push(LOCAL_COMMIT_NOTE);
      } else {
        lines.push(t("quick.doneExtract", { counts, name: event.name.text }));
        lines.push(t("quick.doneExtractIn", { location: event.location.text }));
        if (event.skipped > 0) {
          lines.push(t("quick.skippedExtract", { n: event.skipped, note: event.note ?? "" }));
        }
        if (event.durability_note) lines.push(t("write.degraded", { note: event.durability_note }));
        lines.push(t("quick.extractNote"));
      }
      return { kind: "done", lines, folder: true, failed: false };
    }
    case "fallback":
      return {
        kind: "done",
        lines: [
          t(event.conflicts === 1 ? "quick.fallbackOne" : "quick.fallbackMany", {
            n: event.conflicts,
            destination: event.destination.text,
          }),
        ],
        folder: false,
        failed: false,
      };
    case "cancelled":
      return {
        kind: "done",
        lines: [t(event.action === "add" ? "write.cancelledCreate" : "quick.cancelledExtract")],
        folder: false,
        failed: false,
      };
    case "failed":
      return {
        kind: "done",
        lines: [t("common.failed", { code: event.code, message: event.message })],
        folder: false,
        failed: true,
      };
    case "aborted":
      return {
        kind: "done",
        lines: [t("common.stoppedUnexpectedly", { message: event.message })],
        folder: false,
        failed: true,
      };
    default:
      return null;
  }
}

/**
 * The compact window of "Extract here", "Extract to new folder", and "Add to archive" (plan
 * D6, owner decision 2026-10-16): progress while Rust runs the job, then a short result with
 * "Show in folder" and Close. It names no path; an archive that is encrypted asks for its
 * passphrase here, once.
 */
export function QuickWindow() {
  const [job, setJob] = useState<Job | null>(null);
  const [view, setView] = useState<View>({ kind: "waiting" });
  const [cancelling, setCancelling] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const passphraseRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(
    () =>
      subscribeQuick((event) => {
        if (event.event === "started") {
          setJob({ action: event.action, name: event.subject.text, items: event.items });
          setView({ kind: "running", progress: null });
          setCancelling(false);
          setProblem(null);
          return;
        }
        if (event.event === "need_passphrase") {
          setView({ kind: "passphrase", wrong: event.wrong });
          return;
        }
        if (event.event === "progress") {
          setView({
            kind: "running",
            progress: { phase: event.phase, completed: event.completed, total: event.total },
          });
          return;
        }
        const end = finished(event);
        if (end) setView(end);
      }),
    [],
  );

  useEffect(() => {
    if (view.kind === "passphrase") passphraseRef.current?.focus();
    if (view.kind === "done") closeRef.current?.focus();
  }, [view]);

  const report = (e: unknown) =>
    setProblem(isIpcError(e) ? t("common.failed", { code: e.code, message: e.message }) : null);

  const cancel = () => {
    setCancelling(true);
    cancelQuick().catch(report);
  };

  const submitPassphrase = () => {
    const input = passphraseRef.current;
    if (!input || input.value === "") return;
    const value = input.value;
    // Not kept: the field is emptied as it is sent.
    input.value = "";
    setView({ kind: "running", progress: null });
    sendQuickPassphrase(value).catch(report);
  };

  const heading = job ? title(job) : t("quick.waiting");
  const addProgress = job?.action === "add";

  return (
    <main className="quick" data-testid="quick" aria-labelledby="quick-title">
      <h1 id="quick-title" data-testid="quick-title">
        {heading}
      </h1>
      {view.kind === "waiting" && <p data-testid="quick-waiting">{t("common.starting")}</p>}
      {view.kind === "running" && (
        <>
          <div className="progress" data-testid="quick-progress">
            <ProgressMeter
              completed={view.progress?.completed ?? 0}
              total={view.progress?.total ?? null}
              text={
                view.progress
                  ? (addProgress ? writeProgress : extractProgress)(
                      view.progress.phase,
                      view.progress.completed,
                      view.progress.total,
                    )
                  : t("common.starting")
              }
              textTestId="quick-progress-text"
            />
          </div>
          <div className="actions">
            <button type="button" data-testid="quick-cancel" disabled={cancelling} onClick={cancel}>
              {cancelling ? t("quick.cancelling") : t("common.cancel")}
            </button>
          </div>
        </>
      )}
      {view.kind === "passphrase" && (
        <form
          data-testid="quick-passphrase"
          onSubmit={(e) => {
            e.preventDefault();
            submitPassphrase();
          }}
        >
          <p role={view.wrong ? "alert" : "note"} data-testid="quick-passphrase-note">
            {t(view.wrong ? "quick.passphraseWrong" : "quick.passphraseNeeded", { name: job?.name ?? "" })}
          </p>
          <label>
            {t("quick.passphrase")}
            <input ref={passphraseRef} type="password" autoComplete="off" data-testid="quick-passphrase-input" />
          </label>
          <div className="actions">
            <button type="submit" data-testid="quick-passphrase-submit">
              {t("quick.passphraseSubmit")}
            </button>
            <button type="button" data-testid="quick-passphrase-cancel" onClick={cancel}>
              {t("common.cancel")}
            </button>
          </div>
        </form>
      )}
      {view.kind === "done" && (
        <>
          <div
            role={view.failed ? "alert" : "status"}
            data-testid="quick-result"
            data-state={view.failed ? "failed" : "finished"}
          >
            {view.lines.map((line, i) => (
              <p key={line} className={i === 0 ? undefined : "note"}>
                {line}
              </p>
            ))}
          </div>
          <div className="actions">
            {view.folder && (
              <button type="button" data-testid="quick-show-folder" onClick={() => showQuickFolder().catch(report)}>
                {t("quick.showFolder")}
              </button>
            )}
            <button type="button" ref={closeRef} data-testid="quick-close" onClick={() => closeQuick().catch(report)}>
              {t("common.close")}
            </button>
          </div>
        </>
      )}
      {problem && (
        <p role="alert" className="error" data-testid="quick-problem">
          {problem}
        </p>
      )}
    </main>
  );
}
