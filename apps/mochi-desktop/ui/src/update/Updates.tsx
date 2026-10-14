import { useCallback, useEffect, useId, useRef, useState } from "react";

import { formatSize } from "../browser/format";
import { cancelJob, isIpcError, startJob } from "../ipc/jobs";
import type { JobEvent } from "../ipc/jobs";
import { checkForUpdate, getUpdateSettings, setUpdateSettings } from "../ipc/update";
import type { UpdateOffer, UpdateSettingsView } from "../ipc/update";
import { available, failureText, fill, messages as m, upToDate } from "./messages";

type View =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "up_to_date"; current: string }
  | { state: "available"; offer: UpdateOffer }
  | { state: "installing"; jobId: number | null; done: number; total: number | null; cancelRequested: boolean; offer: UpdateOffer }
  | { state: "installed"; version: string }
  | { state: "cancelled" }
  | { state: "failed"; text: string };

/**
 * Settings: "Check for updates". Nothing here talks to the network by itself:
 * the explicit button asks, the start-up check exists only if the user turned
 * it on (off by default, and Rust refuses an automatic check while it is off),
 * and nothing is downloaded or installed until the user confirms the version
 * shown. Release notes are remote text: rendered as a text node, never HTML.
 */
export function Updates() {
  const [settings, setSettings] = useState<UpdateSettingsView | null>(null);
  const [view, setView] = useState<View>({ state: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const askedRef = useRef(false);
  const headingId = useId();
  const notesId = useId();

  const runCheck = useCallback(async (automatic: boolean) => {
    setError(null);
    setView({ state: "checking" });
    try {
      const result = await checkForUpdate(automatic);
      switch (result.result) {
        case "skipped":
          setView({ state: "idle" });
          break;
        case "up_to_date":
          setView({ state: "up_to_date", current: result.current_version });
          break;
        case "available":
          setView({ state: "available", offer: result.offer });
          break;
        case "failed":
          setView({ state: "failed", text: failureText(result.kind, result.detail) });
          break;
      }
    } catch (e) {
      setView({
        state: "failed",
        text: failureText("other", isIpcError(e) ? `${e.code}: ${e.message}` : "unknown error"),
      });
    }
  }, []);

  useEffect(() => {
    let live = true;
    getUpdateSettings().then(
      (s) => {
        if (!live) return;
        setSettings(s);
        // Only an opted-in start-up check; the explicit button is separate.
        if (s.check_on_start && !askedRef.current) {
          askedRef.current = true;
          void runCheck(true);
        }
      },
      () => {
        if (live) setError(m.loadFailed);
      },
    );
    return () => {
      live = false;
    };
  }, [runCheck]);

  const toggle = async (on: boolean) => {
    setError(null);
    setSaving(true);
    try {
      setSettings(await setUpdateSettings(on));
    } catch {
      setError(m.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  const onEvent = useCallback((event: JobEvent) => {
    setView((prev) => {
      if (prev.state !== "installing") return prev;
      switch (event.event) {
        case "started":
          return { ...prev, jobId: event.job_id };
        case "progress":
          return { ...prev, done: event.completed, total: event.total };
        case "finished": {
          const o = event.outcome;
          if (o.status === "completed") return { state: "installed", version: prev.offer.version };
          if (o.status === "cancelled") return { state: "cancelled" };
          return { state: "failed", text: `${m.installFailed}: ${o.message}` };
        }
      }
    });
  }, []);

  const install = (offer: UpdateOffer) => {
    setError(null);
    setView({ state: "installing", jobId: null, done: 0, total: null, cancelRequested: false, offer });
    startJob({ kind: "install_update", version: offer.version }, onEvent).catch((e: unknown) => {
      setView({
        state: "failed",
        text: `${m.installFailed}: ${isIpcError(e) ? e.message : "could not start"}`,
      });
    });
  };

  const cancel = () => {
    if (view.state !== "installing" || view.jobId === null) return;
    setView({ ...view, cancelRequested: true });
    cancelJob(view.jobId).catch(() => {
      // The job's own `finished` event says how it ended.
    });
  };

  const busy = view.state === "checking" || view.state === "installing";

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId}>{m.heading}</h2>
      <p>{m.intro}</p>
      <p>{m.signing}</p>
      {settings && <p data-testid="update-version">{fill(m.version, { current: settings.current_version })}</p>}
      <div className="actions">
        <button type="button" data-testid="update-check" onClick={() => void runCheck(false)} disabled={busy}>
          {m.check}
        </button>
      </div>
      <p>
        <label>
          <input
            type="checkbox"
            data-testid="update-startup"
            checked={settings?.check_on_start ?? false}
            disabled={settings === null || saving}
            onChange={(e) => void toggle(e.target.checked)}
          />{" "}
          {m.startup}
        </label>
      </p>
      {settings && <p>{settings.check_on_start ? m.startupOn : m.startupOff}</p>}
      {error && <p role="alert">{error}</p>}
      <p role="status" data-testid="update-status" data-state={view.state}>
        {view.state === "checking" && m.checking}
        {view.state === "up_to_date" && upToDate(view.current)}
        {view.state === "cancelled" && m.cancelled}
        {view.state === "installed" && fill(m.installedRestart, { version: view.version })}
      </p>
      {view.state === "failed" && (
        <p role="alert" data-testid="update-failed">
          {view.text}
        </p>
      )}
      {(view.state === "available" || view.state === "installing") && (
        <div role="group" aria-label={m.dialogLabel} data-testid="update-dialog">
          <h3>{available(view.offer)}</h3>
          {view.offer.date && <p>{view.offer.date}</p>}
          <h4 id={notesId}>{m.notesHeading}</h4>
          {/* Remote text: a text node inside <pre>, never markup. */}
          <pre aria-labelledby={notesId} data-testid="update-notes" className="update-notes">
            {view.offer.notes ?? m.notesNone}
          </pre>
          {view.offer.notes_truncated && <p>{m.notesCut}</p>}
          {view.offer.install_mode === "manual" ? (
            <>
              <p>{m.manual}</p>
              <p data-testid="update-page">{view.offer.download_page}</p>
              <div className="actions">
                <button type="button" onClick={() => setView({ state: "idle" })}>
                  {m.later}
                </button>
              </div>
            </>
          ) : (
            <>
              {view.offer.needs_admin_prompt && <p>{m.adminPrompt}</p>}
              <p>{m.closesApp}</p>
              <div className="actions">
                <button
                  type="button"
                  data-testid="update-install"
                  disabled={view.state === "installing"}
                  onClick={() => install(view.offer)}
                >
                  {m.install}
                </button>
                {view.state === "available" ? (
                  <button type="button" data-testid="update-later" onClick={() => setView({ state: "idle" })}>
                    {m.later}
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid="update-cancel"
                    onClick={cancel}
                    disabled={view.jobId === null || view.cancelRequested}
                  >
                    {m.cancel}
                  </button>
                )}
              </div>
            </>
          )}
          {view.state === "installing" && (
            <div className="progress">
              <progress data-testid="update-progress" value={view.done} max={view.total ?? undefined} />
              <span data-testid="update-progress-text">
                {view.total === null
                  ? fill(m.installingBytes, { size: formatSize(String(view.done)) })
                  : fill(m.installingOf, {
                      size: formatSize(String(view.done)),
                      total: formatSize(String(view.total)),
                    })}
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
