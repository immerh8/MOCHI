// Typed wrappers over the speed commands: compression cores (release 0.9.11)
// and fast extract. Rust saves the choices and applies them to jobs started
// afterwards.
import { invoke } from "@tauri-apps/api/core";

import type { SpeedSettingsView } from "./generated/SpeedSettingsView";

export type { SpeedSettingsView };

export function getSpeedSettings(): Promise<SpeedSettingsView> {
  return invoke<SpeedSettingsView>("get_speed_settings");
}

export function setSpeedSettings(allCores: boolean, fastExtract: boolean): Promise<SpeedSettingsView> {
  return invoke<SpeedSettingsView>("set_speed_settings", { allCores, fastExtract });
}
