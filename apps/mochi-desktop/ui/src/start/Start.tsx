import { t } from "../i18n";
import type { RecentView } from "../ipc/start";
import { FolderIcon, PlusIcon } from "../icons";

export interface StartProps {
  busy: boolean;
  recents: RecentView[];
  onCreate: () => void;
  onOpen: () => void;
  onOpenRecent: (index: number) => void;
  onForgetRecent: () => void;
}

/**
 * The empty window (D10): the mascot, a place to drop files, Create and Open,
 * and the recent archives as a short quiet list. What an archive is not (a
 * second copy) is in the Help panel and in the drop zone's tooltip; the
 * technical tools are in the toolbar's More menu. The mascot is a CSS
 * background on an empty element, never an `img`; names from the recent list
 * come from file names on disk, so they are rendered as text only.
 */
export function Start({ busy, recents, onCreate, onOpen, onOpenRecent, onForgetRecent }: StartProps) {
  return (
    <div className="start" data-testid="start-screen">
      <div className="hero">
        <span className="mascot-hero" aria-hidden="true" />
        <span className="wordmark" aria-hidden="true">
          {t("app.title")}
        </span>
        <p className="tagline">{t("app.tagline")}</p>
      </div>
      <div className="drop-zone" data-testid="start-drop-hint" title={t("start.dropHint")}>
        <p className="drop-zone-title">{t("start.dropZone")}</p>
      </div>
      <div className="big-actions">
        <button type="button" className="big" data-testid="start-create" onClick={onCreate} disabled={busy}>
          <span className="big-title">
            <PlusIcon />
            {t("start.create")}
          </span>
        </button>
        <button type="button" className="big primary" data-testid="open-archive" onClick={onOpen} disabled={busy}>
          <span className="big-title">
            <FolderIcon />
            {t("start.open")}
          </span>
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
    </div>
  );
}
