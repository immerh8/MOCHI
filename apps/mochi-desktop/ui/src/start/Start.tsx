import { t } from "../i18n";
import type { RecentView } from "../ipc/start";

export interface StartProps {
  busy: boolean;
  recents: RecentView[];
  onCreate: () => void;
  onOpen: () => void;
  onExtract: () => void;
  onOpenRecent: (index: number) => void;
  onForgetRecent: () => void;
}

/**
 * The first screen (D10): three plain actions, the recent archives, and one
 * quiet sentence about what an archive is not. Everything technical is in
 * the Advanced area below. Names from the recent list come from file names
 * on disk, so they are rendered as text only.
 */
export function Start({ busy, recents, onCreate, onOpen, onExtract, onOpenRecent, onForgetRecent }: StartProps) {
  return (
    <div className="start" data-testid="start-screen">
      <div className="big-actions">
        <button type="button" className="big" data-testid="start-create" onClick={onCreate} disabled={busy}>
          <span className="big-title">{t("start.create")}</span>
          <span className="big-hint">{t("start.createHint")}</span>
        </button>
        <button type="button" className="big" data-testid="open-archive" onClick={onOpen} disabled={busy}>
          <span className="big-title">{t("start.open")}</span>
          <span className="big-hint">{t("start.openHint")}</span>
        </button>
        <button type="button" className="big" data-testid="start-extract" onClick={onExtract} disabled={busy}>
          <span className="big-title">{t("start.extract")}</span>
          <span className="big-hint">{t("start.extractHint")}</span>
        </button>
      </div>
      <p className="note" data-testid="start-drop-hint">
        {t("start.dropHint")}
      </p>
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
      <p className="note quiet" data-testid="start-note">
        {t("start.note")}
      </p>
    </div>
  );
}
