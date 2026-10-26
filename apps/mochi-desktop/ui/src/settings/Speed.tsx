import { useEffect, useId, useState } from "react";

import { errorText } from "../browser/format";
import { t } from "../i18n";
import { getSpeedSettings, setSpeedSettings } from "../ipc/speed";
import type { SpeedSettingsView } from "../ipc/speed";

/**
 * Release 0.9.11: whether writes compress on every processor core (the
 * default) or on one. Only a speed choice: the archive is the same bytes
 * either way. Rust saves it and applies it to the next job.
 */
export function Speed() {
  const [state, setState] = useState<SpeedSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const noteId = useId();

  useEffect(() => {
    let live = true;
    getSpeedSettings().then(
      (s) => {
        if (live) setState(s);
      },
      (e: unknown) => {
        if (live) setError(errorText(t("settings.speedLoadFailed"), e));
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const change = async (allCores: boolean) => {
    setError(null);
    setBusy(true);
    try {
      setState(await setSpeedSettings(allCores));
    } catch (e) {
      setError(errorText(t("settings.speedSaveFailed"), e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h3>{t("settings.speedHeading")}</h3>
      <p>
        <label>
          <input
            type="checkbox"
            data-testid="speed-all-cores"
            aria-describedby={noteId}
            checked={state?.all_cores ?? true}
            disabled={state === null || busy}
            onChange={(e) => void change(e.target.checked)}
          />{" "}
          {t("settings.speedAllCores", { n: state?.cores ?? "…" })}
        </label>
      </p>
      <p id={noteId} className="note">
        {t("settings.speedNote")}
      </p>
      {error !== null && <p role="alert">{error}</p>}
    </>
  );
}
