// The compact window of the shell's quick verbs (plan D6, owner decision
// 2026-10-16). Rust runs the job and tells this window what happened; the
// window sends back a passphrase, a cancel, "show in folder", and "close". It
// never sees or sends a path.
//
// One channel is registered for the life of the window and every event since
// the job began is kept, so a listener that mounts late (React strict mode
// mounts twice in development) still hears the whole job.
import { Channel, invoke } from "@tauri-apps/api/core";

import type { QuickAction } from "./generated/QuickAction";
import type { QuickEvent } from "./generated/QuickEvent";

export type { QuickAction, QuickEvent };

const listeners = new Set<(event: QuickEvent) => void>();
let log: QuickEvent[] = [];
let registered = false;

function remember(event: QuickEvent): void {
  if (event.event === "started") log = [];
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

/** Forget what was heard (tests). */
export function resetQuickForTests(): void {
  log = [];
  listeners.clear();
  registered = false;
}
