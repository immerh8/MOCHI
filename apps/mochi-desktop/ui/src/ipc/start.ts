// Typed wrappers over the start-screen commands (D10). Types come from Rust
// through ts-rs (./generated, never edited by hand). The webview names no
// path: recent archives are opened by position, a dropped archive is held in
// Rust, and "Show in folder" asks Rust to show a folder it resolved itself.
import { invoke } from "@tauri-apps/api/core";

import type { ExtractPlan } from "./generated/ExtractPlan";
import type { OpenOutcome } from "./generated/OpenOutcome";
import type { RecentView } from "./generated/RecentView";
import type { ShowTarget } from "./generated/ShowTarget";
import type { StagedView } from "./generated/StagedView";

export type { RecentView, ShowTarget };

export function recentArchives(): Promise<RecentView[]> {
  return invoke<RecentView[]>("recent_archives");
}

export function forgetRecentArchives(): Promise<null> {
  return invoke<null>("forget_recent_archives");
}

export function openRecent(index: number): Promise<OpenOutcome> {
  return invoke<OpenOutcome>("open_recent", { index });
}

/**
 * Open the archive file just dropped on the window (a `.mochi` file or a
 * foreign archive, routed in Rust); `null` if none waits.
 */
export function openDroppedArchive(): Promise<OpenOutcome | null> {
  return invoke<OpenOutcome | null>("open_dropped_archive");
}

/**
 * Stage the archive file just dropped on the window as an ordinary source to
 * add, instead of opening it (for example a .zip dropped on an open MOCHI
 * archive). Rejects if no dropped file waits or it cannot be staged.
 */
export function stageDroppedArchive(): Promise<StagedView> {
  return invoke<StagedView>("stage_dropped_archive");
}

export function showInFolder(what: ShowTarget): Promise<null> {
  return invoke<null>("show_in_folder", { what });
}

/** Plan an extraction into a new folder next to the archive. Nothing is extracted. */
export function planExtractDefault(handle: number, seq: number, keys: string[]): Promise<ExtractPlan> {
  return invoke<ExtractPlan>("plan_extract_default", { handle, seq, keys });
}

/**
 * Quick extract: make a new folder named after the archive on the Desktop
 * (Rust resolves it; `name`, `name (2)`, ... never an existing one) and plan
 * extracting `keys` (empty: everything) into it. The extraction itself is
 * started with `start_job` and writes into that folder.
 */
export function planExtractDesktop(handle: number, seq: number, keys: string[]): Promise<ExtractPlan> {
  return invoke<ExtractPlan>("plan_extract_desktop", { handle, seq, keys });
}

/** Remove the new folder a default plan made, if nothing was extracted into it. */
export function discardExtractFolder(): Promise<null> {
  return invoke<null>("discard_extract_folder");
}
