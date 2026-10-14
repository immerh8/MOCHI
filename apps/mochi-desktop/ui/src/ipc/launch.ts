// The shell's open, extract, and add verbs (plan D6). Rust receives the
// command line and opens or stages for itself; the webview hears only that an
// archive was opened, or why a launch failed. It never sees or sends a path.
import { Channel, invoke } from "@tauri-apps/api/core";

import type { LaunchEvent } from "./generated/LaunchEvent";

export type { LaunchEvent };

/** Listen for launches. Anything that arrived before this call is delivered now. */
export function watchLaunches(onEvent: (event: LaunchEvent) => void): Promise<null> {
  const channel = new Channel<LaunchEvent>();
  channel.onmessage = onEvent;
  return invoke<null>("watch_launches", { onLaunch: channel });
}
