// The compact window of the shell's quick verbs (plan D6, owner decision
// 2026-10-16). Rust runs the job and tells this window what happened; the
// window sends back a passphrase, a cancel, "show in folder", and "close". It
// never sees or sends a path.
//
// One channel is registered for the life of the window and every event since
// the job began is kept, so a listener that mounts late (React strict mode
// mounts twice in development) still hears the whole job.
import { Channel, invoke } from "@tauri-apps/api/core";

import { destinationDialog } from "./dialogs";

import type { ArchiveFormat } from "./generated/ArchiveFormat";
import type { QuickAction } from "./generated/QuickAction";
import type { QuickAddRequest } from "./generated/QuickAddRequest";
import type { QuickEvent } from "./generated/QuickEvent";
import type { QuickLocation } from "./generated/QuickLocation";

export type { ArchiveFormat, QuickAction, QuickAddRequest, QuickEvent, QuickLocation };

const listeners = new Set<(event: QuickEvent) => void>();
let log: QuickEvent[] = [];
let registered = false;

function remember(event: QuickEvent): void {
  if (event.event === "started") log = [];
  // A form sent again (another item joined it) replaces the one before.
  if (event.event === "add_prompt") log = log.filter((e) => e.event !== "add_prompt");
  const last = log[log.length - 1];
  if (event.event === "progress" && last?.event === "progress") log.pop();
  log.push(event);
}

/** Listen for the job's events; returns the function that stops listening. */
export function subscribeQuick(onEvent: (event: QuickEvent) => void): () => void {
  listeners.add(onEvent);
  for (const past of [...log]) onEvent(past);
  if (!registered) {
    registered = true;
    const channel = new Channel<QuickEvent>();
    channel.onmessage = (event) => {
      remember(event);
      for (const l of [...listeners]) l(event);
    };
    invoke<null>("watch_quick", { onEvent: channel }).catch(() => {
      registered = false;
    });
  }
  return () => {
    listeners.delete(onEvent);
  };
}

/** The passphrase the job asked for. It crosses IPC once and is not kept. */
export function sendQuickPassphrase(passphrase: string): Promise<null> {
  return invoke<null>("quick_passphrase", { passphrase });
}

export function cancelQuick(): Promise<null> {
  return invoke<null>("quick_cancel");
}

/** Open the folder the job wrote into; Rust remembers which. */
export function showQuickFolder(): Promise<null> {
  return invoke<null>("quick_show_folder");
}

export function closeQuick(): Promise<null> {
  return invoke<null>("quick_close");
}

/**
 * The Add form's Browse…: Rust shows the save dialog and keeps the folder.
 * Resolves with the folder's display text and the file name, or `null` when
 * the dialog was cancelled.
 */
export function chooseQuickLocation(name: string, format: ArchiveFormat): Promise<QuickLocation | null> {
  return invoke<QuickLocation | null>("quick_choose_location", {
    name,
    format,
    text: destinationDialog(format),
  });
}

/**
 * OK on the Add form. Rust checks the request; a refusal (a name that exists,
 * a bad name) rejects with an `IpcError` and the form stays open. A passphrase
 * crosses here, once.
 */
export function submitQuickAdd(request: QuickAddRequest): Promise<null> {
  return invoke<null>("quick_add_submit", { request });
}

/** Forget what was heard (tests). */
export function resetQuickForTests(): void {
  log = [];
  listeners.clear();
  registered = false;
}
