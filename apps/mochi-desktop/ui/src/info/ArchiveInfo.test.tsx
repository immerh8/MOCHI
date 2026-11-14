// The archive Info window (owner request 2026-11-14): totals, sizes and ratio as Rust
// computed them, the recorded settings, and plain words for what the format does not have.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, expect, test, vi } from "vitest";

import type { ArchiveInfoView, ArchiveSummary } from "../ipc/browse";
import { audit } from "../test/audit";
import { ArchiveInfo, ratioPercent } from "./ArchiveInfo";

const archive: ArchiveSummary = {
  handle: 3,
  file_name: "photos <b>2026</b>.mochi",
  archive_id: "ab".repeat(16),
  profile: { tar_compatible: false, encrypted: true, redundancy_percent: 10 },
  commits: [],
  retention_error: null,
};

const view = (over: Partial<ArchiveInfoView> = {}): ArchiveInfoView => ({
  seq: 2,
  folders: "18",
  files: "52",
  total_size: "1370125",
  packed_size: "907505",
  chunks: "60",
  file_size: "1000000",
  chunk_size: "8388608",
  zstd_level: 3,
  ...over,
});

afterEach(() => clearMocks());

test("ratio is packed over total, rounded, and absent when nothing is stored", () => {
  expect(ratioPercent("907505", "1370125")).toBe(66);
  expect(ratioPercent("1", "3")).toBe(33);
  expect(ratioPercent("2", "3")).toBe(67);
  expect(ratioPercent("0", "0")).toBeNull();
  expect(ratioPercent("x", "3")).toBeNull();
  expect(ratioPercent("18446744073709551615", "18446744073709551615")).toBe(100);
});

test("shows the version's totals and settings, and asks Rust for the version on screen", async () => {
  const calls: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "archive_info") {
      calls.push(args);
      return view();
    }
    throw new Error(cmd);
  });
  const onClose = vi.fn();
  render(<ArchiveInfo archive={archive} seq={2} onClose={onClose} />);
  expect(await screen.findByTestId("info-files")).toHaveTextContent("52");
  expect(calls).toEqual([{ handle: 3, seq: 2 }]);
  expect(screen.getByTestId("info-folders")).toHaveTextContent("18");
  expect(screen.getByTestId("info-total")).toHaveTextContent("1.3 MiB");
  expect(screen.getByTestId("info-total")).toHaveAttribute("title", expect.stringContaining("1,370,125 bytes"));
  expect(screen.getByTestId("info-packed")).toHaveTextContent("886.2 KiB");
  expect(screen.getByTestId("info-ratio")).toHaveTextContent("66%");
  expect(screen.getByTestId("info-dictionary")).toHaveTextContent("Up to 8.0 MiB");
  expect(screen.getByTestId("info-level")).toHaveTextContent("Zstandard level 3");
  expect(screen.getByTestId("info-encryption")).toHaveTextContent("Present");
  expect(screen.getByTestId("info-recovery")).toHaveTextContent("10% parity");
  expect(screen.getByTestId("info-comment")).toHaveTextContent("Not part of the MOCHI format");
  // The archive's file name is text, never markup.
  expect(screen.getByTestId("archive-info").querySelector("b")).toBeNull();
  expect(screen.getByText("photos <b>2026</b>.mochi")).toBeInTheDocument();
  expect(audit()).toEqual([]);
  await userEvent.click(screen.getByTestId("archive-info-ok"));
  expect(onClose).toHaveBeenCalledOnce();
});

test("what the archive did not record is said, never guessed; an empty version has no ratio", async () => {
  mockIPC(() => view({ total_size: "0", packed_size: "0", chunk_size: null, zstd_level: null, file_size: null }));
  render(<ArchiveInfo archive={{ ...archive, profile: { ...archive.profile, encrypted: false, redundancy_percent: null } }} seq={0} onClose={() => {}} />);
  expect(await screen.findByTestId("info-ratio")).toHaveTextContent("—");
  expect(screen.getByTestId("info-dictionary")).toHaveTextContent("Not recorded");
  expect(screen.getByTestId("info-level")).toHaveTextContent("Not recorded");
  expect(screen.queryByTestId("info-file-size")).toBeNull();
  expect(screen.getByTestId("info-encryption")).toHaveTextContent("Absent");
  expect(screen.getByTestId("info-recovery")).toHaveTextContent("Absent");
});

test("a failure is said with its code", async () => {
  mockIPC(() => {
    throw { code: "INVALID_ARGUMENT", message: "no such archive" };
  });
  render(<ArchiveInfo archive={archive} seq={2} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByTestId("archive-info-error")).toHaveTextContent("INVALID_ARGUMENT"));
});
