import type { ReactNode } from "react";

import { t } from "../i18n";

/**
 * The bar under a file list: the small mascot face, two quiet lines of hint,
 * and the actions (the primary one last). The face is a CSS background on an
 * empty element, never an `img`. The hint says only what the screen is doing:
 * it is browsing, and whether an entry is selected.
 */
export function StatusBar({ selected, children }: { selected: boolean; children: ReactNode }) {
  return (
    <div className="statusbar">
      <span className="mascot-face" aria-hidden="true" />
      <p className="statusbar-hint">
        <span>{t("common.barViewing")}</span>
        <span className="statusbar-sub">{t(selected ? "common.barSelected" : "common.barSelect")}</span>
      </p>
      <div className="statusbar-actions">{children}</div>
    </div>
  );
}
