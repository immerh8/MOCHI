import { useEffect, useId, useState } from "react";

import { errorText } from "../browser/format";
import { t } from "../i18n";
import { getSpeedSettings, setSpeedSettings } from "../ipc/speed";
import type { SpeedSettingsView } from "../ipc/speed";

/**
 * Release 0.9.11: whether writes compress on every processor core (the
 * default) or on one. Only a speed choice: the archive is the same bytes
 * either way. Also fast extract (off by default): extraction skips the
 * per-file flush, which the note says costs durability after a power
 * failure. Rust saves both and applies them to the next job.
 */
export function Speed() {
  const [state, setState] = useState<SpeedSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const noteId = useId();
  const fastNoteId = useId();

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

  const change = async (allCores: boolean, fastExtract: boolean) => {
    setError(null);
    setBusy(true);
    try {
      setState(await setSpeedSettings(allCores, fastExtract));
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
            onChange={(e) => void change(e.target.checked, state?.fast_extract ?? false)}
          />{" "}
          {t("settings.speedAllCores", { n: state?.cores ?? "…" })}
        </label>
      </p>
      <p id={noteId} className="note">
        {t("settings.speedNote")}
      </p>
      <p>
        <label>
          <input
            type="checkbox"
            data-testid="speed-fast-extract"
            aria-describedby={fastNoteId}
            checked={state?.fast_extract ?? false}
            disabled={state === null || busy}
            onChange={(e) => void change(state?.all_cores ?? true, e.target.checked)}
          />{" "}
          {t("settings.fastExtract")}
        </label>
      </p>
      <p id={fastNoteId} className="note">
        {t("settings.fastExtractNote")}
      </p>
      {error !== null && <p role="alert">{error}</p>}
    </>
  );
}
