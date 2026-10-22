import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { Panel } from "../a11y/Panel";
import { Hint } from "../a11y/Hint";
import { errorText } from "../browser/format";
import { formatNumber, t } from "../i18n";
import { extractFolderDialog } from "../ipc/dialogs";
import { browseExtractFolder, extractWizardSetup } from "../ipc/start";

/**
 * WinRAR's "Extract to..." window: an editable destination folder with
 * Browse..., the folders used lately (newest first), and a choice to extract
 * into a new folder named after the archive (on by default). Enter confirms.
 *
 * The folder text is the user's; Rust validates it (`folders::existing_folder`)
 * and `onSubmit` rejects with Rust's message if it will not do, which is shown
 * here and keeps the window open. The same window serves MOCHI and foreign
 * archives: the caller plans and extracts.
 */
export function ExtractToDialog({
  count,
  onSubmit,
  onClose,
}: {
  /** Entries selected; 0 extracts everything. */
  count: number;
  /** Plan and start with these choices; reject to keep the window open with the error. */
  onSubmit: (folder: string, newFolder: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [folder, setFolder] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const [newFolder, setNewFolder] = useState(true);
  const [ready, setReady] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The folder field starts with the folder used last, else the Desktop.
  useEffect(() => {
    let live = true;
    extractWizardSetup().then(
      (s) => {
        if (!live) return;
        setFolder(s.destination);
        setRecent(s.recent);
        setReady(true);
      },
      (e: unknown) => {
        if (!live) return;
        setReady(true);
        setError(errorText(t("extract.toFailed"), e));
      },
    );
    return () => {
      live = false;
    };
  }, []);
  // Once it is filled in, the field takes focus with its text selected, so
  // typing replaces it and Enter accepts it.
  useEffect(() => {
    if (!ready) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [ready]);

  const browse = () => {
    setError(null);
    browseExtractFolder(folder, extractFolderDialog()).then(
      (picked) => {
        if (picked !== null) setFolder(picked);
      },
      (e: unknown) => setError(errorText(t("extract.toBrowseFailed"), e)),
    );
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (working) return;
    setError(null);
    setWorking(true);
    onSubmit(folder, newFolder).then(
      () => undefined,
      (err: unknown) => {
        setWorking(false);
        setError(errorText(t("extract.toFailed"), err));
      },
    );
  };

  return (
    <Panel
      label={t("extract.toHeading")}
      heading={t("extract.toHeading")}
      testId="extract-to-dialog"
      fallbackId="extract-heading"
      onClose={working ? undefined : onClose}
    >
      <form onSubmit={submit} className="extract-to">
        <p className="note" data-testid="extract-to-what">
          {count === 0
            ? t("extract.toWhatAll")
            : count === 1
              ? t("extract.toWhatOne")
              : t("extract.toWhatMany", { n: formatNumber(count) })}
        </p>
        <label htmlFor="extract-to-folder">{t("extract.toFolder")}</label>
        <div className="extract-to-row">
          <input
            id="extract-to-folder"
            ref={inputRef}
            type="text"
            value={folder}
            data-testid="extract-to-folder"
            spellCheck={false}
            autoComplete="off"
            disabled={working}
            onChange={(e) => setFolder(e.target.value)}
          />
          <button type="button" data-testid="extract-to-browse" onClick={browse} disabled={working}>
            {t("extract.toBrowse")}
          </button>
        </div>
        {recent.length > 0 && (
          <div className="extract-to-recent">
            <span id="extract-to-recent-label" className="meta">
              {t("extract.toRecent")}
            </span>
            <ul aria-labelledby="extract-to-recent-label" data-testid="extract-to-recent">
              {recent.map((r) => (
                <li key={r}>
                  <button
                    type="button"
                    className="link"
                    data-testid="extract-to-recent-item"
                    title={r}
                    disabled={working}
                    onClick={() => {
                      setFolder(r);
                      inputRef.current?.focus();
                    }}
                  >
                    {r}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <label className="extract-to-check">
          <input
            type="checkbox"
            checked={newFolder}
            data-testid="extract-to-new-folder"
            disabled={working}
            onChange={(e) => setNewFolder(e.target.checked)}
          />
          {t("extract.toNewFolder")}
        </label>
        {error && (
          <p role="alert" className="error" data-testid="extract-to-error">
            {error}
          </p>
        )}
        <div className="actions dialog-actions">
          <Hint testId="extract-to-note" text={t("extract.toNote")} />
          <button type="submit" className="primary" data-testid="extract-to-ok" disabled={working || !ready}>
            {t("extract.toOk")}
          </button>
          <button type="button" data-testid="extract-to-cancel" onClick={onClose} disabled={working}>
            {t("common.cancel")}
          </button>
        </div>
      </form>
    </Panel>
  );
}
