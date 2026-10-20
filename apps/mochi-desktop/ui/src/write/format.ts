// The formats a new archive can have (plan O31, owner decision 2026-10-20) and
// the names that go with them. The window only edits the text of a name;
// Rust checks it again and decides the file's final name and place.
import { t } from "../i18n";
import type { ArchiveFormat } from "../ipc/write";

/** In the order shown; `.mochi` is the default. */
export const FORMATS: readonly ArchiveFormat[] = ["mochi", "zip", "tar", "tar_gz", "tar_zst"];

const EXTENSION: Record<ArchiveFormat, string> = {
  mochi: ".mochi",
  zip: ".zip",
  tar: ".tar",
  tar_gz: ".tar.gz",
  tar_zst: ".tar.zst",
};

/** Longest first, so `.tar.gz` is taken off as one piece. */
const KNOWN = [".tar.zst", ".tar.gz", ".mochi", ".tzst", ".tgz", ".zip", ".tar"];

export function extensionOf(format: ArchiveFormat): string {
  return EXTENSION[format];
}

export function formatLabel(format: ArchiveFormat): string {
  switch (format) {
    case "mochi":
      return t("write.formatMochi");
    case "zip":
      return t("write.formatZip");
    case "tar":
      return t("write.formatTar");
    case "tar_gz":
      return t("write.formatTarGz");
    case "tar_zst":
      return t("write.formatTarZst");
  }
}

/** Whether the format has a compression level to choose (plain tar does not). */
export function hasLevel(format: ArchiveFormat): boolean {
  return format !== "tar";
}

/** Whether the format has the MOCHI-only options (a password, repair data, tar compatibility). */
export function isMochi(format: ArchiveFormat): boolean {
  return format === "mochi";
}

/** `name` without a trailing archive extension. */
export function stripArchiveExtension(name: string): string {
  const lower = name.toLowerCase();
  for (const ext of KNOWN) {
    if (lower.endsWith(ext) && name.length > ext.length) return name.slice(0, name.length - ext.length);
  }
  return name;
}

/**
 * `name` with the format's extension: one it already has is kept, another
 * archive extension is replaced, and a name without one gets it added.
 */
export function nameForFormat(name: string, format: ArchiveFormat): string {
  const ext = EXTENSION[format];
  if (name.toLowerCase().endsWith(ext) && name.length > ext.length) return name;
  return stripArchiveExtension(name) + ext;
}
