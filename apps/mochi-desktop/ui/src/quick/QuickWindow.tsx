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
import { attentionHint, cautionCount, countParts, joinParts, logRecord } from "../result/details";
import type { DetailRow, ResultDetails } from "../result/details";
import { InlineDetails } from "../result/Result";
import { formatLabel } from "../write/format";
import { LOCAL_COMMIT_NOTE, progressText as writeProgress } from "../write/messages";
import { AddForm } from "./AddForm";
import type { AddFormStart } from "./AddForm";
import "./quick.css";

interface Job {
  action: QuickAction;
  name: string;
  items: number;
}

type View =
  | { kind: "waiting" }
  | { kind: "form" }
  | { kind: "running"; progress: { phase: string; completed: number; total: number | null } | null }
  | { kind: "passphrase"; wrong: boolean }
  | {
      kind: "done";
      lines: string[];
      folder: boolean;
      failed: boolean;
      warn: boolean;
      details: ResultDetails | null;
      record: string | null;
    };

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
      const parts = joinParts(countParts(event.files, event.directories, event.bytes));
      const add = event.action === "add";
      // A plain ZIP or tar file (plan O31): what was written, and no commit status.
      const plain = add && event.format !== "mochi";
      const rows: DetailRow[] = [
        { label: t("quick.rowLocation"), value: event.location.text },
        { label: t("quick.rowFiles"), value: event.files.toLocaleString("en-US") },
        { label: t("quick.rowFolders"), value: event.directories.toLocaleString("en-US") },
        { label: t("quick.rowSize"), value: formatSize(String(event.bytes)) },
      ];
      if (plain) {
        rows.unshift({ label: t("quick.rowFormat"), value: formatLabel(event.format) });
        rows.push({ label: t("quick.rowFileSize"), value: formatSize(String(event.output_bytes)) });
      }
      if (add && !plain) {
        rows.push({
          label: t("quick.rowStatus"),
          value: t("write.statusCommitted"),
          ...(event.status ? { sub: event.status } : {}),
        });
      }
      if (event.durability_note) {
        rows.push({
          label: t("quick.rowFolderEntry"),
          value: t("quick.notConfirmed"),
          sub: t("quick.degradedMark"),
          note: event.durability_note,
          caution: true,
        });
      }
      if (event.skipped > 0) {
        rows.push({
          label: t(add ? "quick.rowNotStored" : "quick.rowNotExtracted"),
          value: tc(event.skipped, "common.itemOne", "common.itemMany"),
          ...(event.note ? { note: t("quick.firstReason", { note: event.note }) } : {}),
          caution: true,
        });
      }
      const head = plain
        ? t("quick.doneExport", { parts, name: event.name.text })
        : add
          ? t("quick.doneAdd", { name: event.name.text, parts })
          : t("quick.doneExtract", { parts, name: event.name.text });
      const line =
        event.skipped > 0
          ? `${head}${t("common.statusSeparator")}${t(add ? "quick.lineNotAdded" : "quick.lineNotExtracted", { n: event.skipped.toLocaleString("en-US") })}`
          : head;
      const record = [
        plain ? `export ${event.format}` : add ? `add commit ${event.status ?? ""}` : "extract",
        `files ${event.files}, folders ${event.directories}, bytes ${event.bytes}`,
        `skipped ${event.skipped}`,
        event.durability_note
          ? `directory entry not confirmed durable (${event.durability_note})`
          : "directory entry confirmed",
      ].join("; ");
      return {
        kind: "done",
        lines: [line],
        folder: true,
        failed: false,
        warn: event.skipped > 0,
        details: {
          rows,
          notes: [plain ? t("quick.exportNote") : add ? LOCAL_COMMIT_NOTE : t("quick.extractNote")],
        },
        record,
      };
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
        warn: false,
        details: null,
        record: null,
      };
    case "cancelled":
      return {
        kind: "done",
        lines: [t(event.action === "add" ? "write.cancelledCreate" : "quick.cancelledExtract")],
        folder: false,
        failed: false,
        warn: false,
        details: null,
        record: null,
      };
    case "failed":
      return {
        kind: "done",
        lines: [t("common.failed", { code: event.code, message: event.message })],
        folder: false,
        failed: true,
        warn: false,
        details: null,
        record: null,
      };
    case "aborted":
      return {
        kind: "done",
        lines: [t("common.stoppedUnexpectedly", { message: event.message })],
        folder: false,
        failed: true,
        warn: false,
        details: null,
        record: null,
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
  // The Add form: what was chosen (updated when another item joins) and the form's starting values.
  const [prompt, setPrompt] = useState<{ items: number; subject: string; start: AddFormStart } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const passphraseRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(
    () =>
      subscribeQuick((event) => {
        if (event.event === "started") {
          setJob({ action: event.action, name: event.subject.text, items: event.items });
          setPrompt(null);
          setView({ kind: "running", progress: null });
          setCancelling(false);
          setProblem(null);
          return;
        }
        if (event.event === "add_prompt") {
          setPrompt((prev) => ({
            items: event.items,
            subject: event.subject.text,
            // Only the first values start the form; later ones just change the count.
            start: prev?.start ?? { name: event.name, folder: event.folder.text, format: event.format },
          }));
          setView({ kind: "form" });
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
        if (end) {
          setView(end);
          // The technical record goes to the console, once per result.
          if (end.kind === "done" && end.record) logRecord(end.record);
        }
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

  const heading =
    view.kind === "form" && prompt
      ? prompt.items > 1
        ? t("quick.formTitleMore", { name: prompt.subject, n: prompt.items - 1 })
        : t("quick.formTitle", { name: prompt.subject })
      : job
        ? title(job)
        : t("quick.waiting");
  const addProgress = job?.action === "add";

  return (
    <main className="quick" data-testid="quick" aria-labelledby="quick-title">
      <h1 id="quick-title" data-testid="quick-title">
        {heading}
      </h1>
      {view.kind === "waiting" && <p data-testid="quick-waiting">{t("common.starting")}</p>}
      {view.kind === "form" && prompt && <AddForm start={prompt.start} />}
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
              <p key={line} className={view.warn && i === 0 ? "warning" : i === 0 ? undefined : "note"}>
                {line}
              </p>
            ))}
            {view.details && cautionCount(view.details) > 0 && (
              <span className="sr-only" data-testid="quick-attention">
                {attentionHint(cautionCount(view.details))}
              </span>
            )}
          </div>
          {view.details && <InlineDetails prefix="quick" details={view.details} />}
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
