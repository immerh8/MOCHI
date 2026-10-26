// Release 0.9.11: the compression-speed switch. On (every core) unless the
// user turned it off; it only asks Rust to change the setting.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, expect, test } from "vitest";

import type { SpeedSettingsView } from "../ipc/speed";
import { Speed } from "./Speed";

function backend(initial: SpeedSettingsView = { all_cores: true, cores: 6 }, failSet = false) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  let state = initial;
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: a });
    if (cmd === "get_speed_settings") return state;
    if (cmd === "set_speed_settings") {
      if (failSet) throw { code: "IO_ERROR", message: "disk full" };
      state = { ...state, all_cores: a.allCores as boolean };
      return state;
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  return calls;
}

afterEach(() => clearMocks());

test("every core is on by default and the label names how many", async () => {
  backend();
  render(<Speed />);
  const box = screen.getByTestId("speed-all-cores");
  await waitFor(() => expect(box).toBeEnabled());
  expect(box).toBeChecked();
  expect(screen.getByText(/every processor core \(6\)/)).toBeInTheDocument();
  expect(screen.getByText(/The archive is the same either way/)).toBeInTheDocument();
});

test("turning it off asks Rust for one core, and back on for every core", async () => {
  const user = userEvent.setup();
  const calls = backend();
  render(<Speed />);
  const box = screen.getByTestId("speed-all-cores");
  await waitFor(() => expect(box).toBeEnabled());
  await user.click(box);
  await waitFor(() => expect(box).not.toBeChecked());
  await user.click(box);
  await waitFor(() => expect(box).toBeChecked());
  expect(calls.filter((c) => c.cmd === "set_speed_settings").map((c) => c.args.allCores)).toEqual([false, true]);
});

test("a failed change is shown and the switch keeps the saved state", async () => {
  const user = userEvent.setup();
  backend({ all_cores: true, cores: 4 }, true);
  render(<Speed />);
  const box = screen.getByTestId("speed-all-cores");
  await waitFor(() => expect(box).toBeEnabled());
  await user.click(box);
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not change the speed setting");
  expect(box).toBeChecked();
});
