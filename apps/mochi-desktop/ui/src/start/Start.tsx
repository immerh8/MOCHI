import { t } from "../i18n";
import type { RecentView } from "../ipc/start";
import { ExtractIcon, FolderIcon, GearIcon, PlusIcon } from "./icons";

export interface StartProps {
  busy: boolean;
  recents: RecentView[];
  onCreate: () => void;
  onOpen: () => void;
  onExtract: () => void;
  onOpenRecent: (index: number) => void;
  onForgetRecent: () => void;
  /** Open the Advanced area at its settings and move focus there. */
  onSettings: () => void;
}

/**
 * The first screen (D10): the mascot and name, a quiet place to drop files,
 * three plain actions, the recent archives, and one quiet sentence about what
 * an archive is not. Everything technical is in the Advanced area below. The
 * mascot is a CSS background on an empty element, never an `img`; names from
 * the recent list come from file names on disk, so they are rendered as text
 * only.
 */
export function Start({
  busy,
  recents,
  onCreate,
  onOpen,
  onExtract,
  onOpenRecent,
  onForgetRecent,
  onSettings,
}: StartProps) {
  return (
    <div className="start" data-testid="start-screen">
      <div className="hero">
        <span className="mascot-hero" aria-hidden="true" />
        <span className="wordmark" aria-hidden="true">
          {t("app.title")}
        </span>
        <p className="tagline">{t("app.tagline")}</p>
      </div>
      <hr className="divider" />
      <div className="drop-zone" data-testid="start-drop-hint">
        <p className="drop-zone-title">{t("start.dropZone")}</p>
        <p className="note">{t("start.dropHint")}</p>
      </div>
      <div className="big-actions">
        <button type="button" className="big" data-testid="start-create" onClick={onCreate} disabled={busy}>
          <span className="big-title">
            <PlusIcon />
            {t("start.create")}
          </span>
          <span className="big-hint">{t("start.createHint")}</span>
        </button>
        <button type="button" className="big primary" data-testid="open-archive" onClick={onOpen} disabled={busy}>
          <span className="big-title">
            <FolderIcon />
            {t("start.open")}
          </span>
          <span className="big-hint">{t("start.openHint")}</span>
        </button>
        <button type="button" className="big" data-testid="start-extract" onClick={onExtract} disabled={busy}>
          <span className="big-title">
            <ExtractIcon />
            {t("start.extract")}
          </span>
          <span className="big-hint">{t("start.extractHint")}</span>
        </button>
      </div>
      {recents.length > 0 && (
        <section aria-labelledby="recent-heading" className="recent" data-testid="recent">
          <h3 id="recent-heading">{t("start.recent")}</h3>
          <ul className="staged">
            {recents.map((r) => (
              <li key={r.index}>
                <button
                  type="button"
                  className="link"
                  data-testid="recent-open"
                  aria-label={t("start.recentOpen", { name: r.name })}
                  onClick={() => onOpenRecent(r.index)}
                  disabled={busy}
                >
                  {r.name}
                </button>{" "}
                <span className="meta">{t("start.recentFolder", { folder: r.folder })}</span>
              </li>
            ))}
          </ul>
          <button type="button" className="link" data-testid="recent-forget" onClick={onForgetRecent} disabled={busy}>
            {t("start.forgetRecent")}
          </button>
        </section>
      )}
      <div className="start-footer">
        <p className="note quiet" data-testid="start-note">
          {t("start.note")}
        </p>
        <button
          type="button"
          className="icon-button"
          data-testid="start-settings"
          aria-label={t("start.settings")}
          title={t("start.settings")}
          onClick={onSettings}
        >
          <GearIcon />
        </button>
      </div>
    </div>
  );
}
