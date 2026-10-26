// Typed wrappers over the compression-speed commands (release 0.9.11). Rust
// saves the choice and applies it to writes started afterwards.
import { invoke } from "@tauri-apps/api/core";

import type { SpeedSettingsView } from "./generated/SpeedSettingsView";

export type { SpeedSettingsView };

export function getSpeedSettings(): Promise<SpeedSettingsView> {
  return invoke<SpeedSettingsView>("get_speed_settings");
}

export function setSpeedSettings(allCores: boolean): Promise<SpeedSettingsView> {
  return invoke<SpeedSettingsView>("set_speed_settings", { allCores });
}
