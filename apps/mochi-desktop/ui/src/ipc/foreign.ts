// Typed wrappers over the foreign-archive commands (plan D8). Types come from
// Rust through ts-rs (./generated, never edited by hand). The webview names no
// path: Rust shows the native dialogs, and a password is sent once, in the
// call that opens the archive; Rust keeps it, this side does not.
import { invoke } from "@tauri-apps/api/core";

import type { CheckCount } from "./generated/CheckCount";
import type { ForeignArchiveSummary } from "./generated/ForeignArchiveSummary";
import type { ForeignChildrenPage } from "./generated/ForeignChildrenPage";
import type { ForeignDimensionsView } from "./generated/ForeignDimensionsView";
import type { ForeignExtractPlan } from "./generated/ForeignExtractPlan";
import type { ForeignHit } from "./generated/ForeignHit";
import type { ForeignRow } from "./generated/ForeignRow";
import type { ForeignSearchResult } from "./generated/ForeignSearchResult";
import type { ForeignTestReport } from "./generated/ForeignTestReport";

export type {
  CheckCount,
  ForeignArchiveSummary,
  ForeignChildrenPage,
  ForeignDimensionsView,
  ForeignExtractPlan,
  ForeignHit,
  ForeignRow,
  ForeignSearchResult,
  ForeignTestReport,
};

/**
 * Show the open dialog and open the chosen ZIP/7z/RAR/tar archive read-only;
 * `null` if cancelled. With `retry`, re-open the file whose password was asked
 * for last instead of showing the dialog.
 */
export function openForeignArchive(
  retry: boolean,
  password: string | null,
): Promise<ForeignArchiveSummary | null> {
  return invoke<ForeignArchiveSummary | null>("open_foreign_archive", { retry, password });
}

export function closeForeignArchive(handle: number): Promise<boolean> {
  return invoke<boolean>("close_foreign_archive", { handle });
}

export function foreignChildren(
  handle: number,
  dir: string | null,
  offset: number,
  limit: number,
): Promise<ForeignChildrenPage> {
  return invoke<ForeignChildrenPage>("foreign_children", { handle, dir, offset, limit });
}

/** Plan an extraction; `null` if the user cancelled the folder dialog. */
export function planExtractForeign(
  handle: number,
  keys: string[],
  pick: boolean,
): Promise<ForeignExtractPlan | null> {
  return invoke<ForeignExtractPlan | null>("plan_extract_foreign", { handle, keys, pick });
}

/** Names in the open archive that contain `query` (names only, never contents). */
export function foreignSearch(handle: number, query: string, ignoreCase: boolean): Promise<ForeignSearchResult> {
  return invoke<ForeignSearchResult>("foreign_search", { handle, query, ignoreCase });
}
