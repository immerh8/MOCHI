// What the app says about updates (spec §23.3). A failure is never styled as
// success; an unsigned installer is never called verified, trusted, safe, or
// secure; the update's own signature is what authenticates an update.
// Release notes and the detail of a failure come from the network: they are
// shown as text only and never as part of these strings' markup.
import type { UpdateFailureKind, UpdateOffer } from "../ipc/update";

export const messages = {
  heading: "Updates",
  intro:
    "MOCHI never checks for updates, and never downloads or installs one, unless you ask. A check is one request to GitHub (github.com/immerh8/MOCHI/releases) that carries no file names or archive contents.",
  check: "Check for updates",
  checking: "Checking for updates…",
  startup: "Check for updates when MOCHI starts (off unless you turn it on)",
  startupOn: "MOCHI will check once each time it starts. It still asks before downloading anything.",
  startupOff: "MOCHI will not check for updates by itself.",
  signing:
    "MOCHI's installers are not code-signed with a Windows publisher certificate, so Windows SmartScreen shows \"unknown publisher\" when you run one: choose More info, then Run anyway. An update is authenticated by MOCHI's own update signature, which this app checks before it installs anything; an update whose signature does not match is refused.",
  loadFailed: "Could not read the update settings.",
  saveFailed: "Could not save the update setting.",
  version: "You are running version {current}.",
  dialogLabel: "A new version is available",
  later: "Not now",
  install: "Download and install",
  cancel: "Cancel download",
  adminPrompt: "Ubuntu will ask for your password to install the package.",
  closesApp: "MOCHI closes when the installer starts.",
  manual:
    "This copy of MOCHI was not installed from a MOCHI package, so it cannot update itself. Download the new version from:",
  notesHeading: "Release notes",
  notesNone: "The release has no notes.",
  notesCut: "The notes are cut here; the release page has the rest.",
  installing: "Downloading the update…",
  installingBytes: "Downloaded {size}",
  installingOf: "Downloaded {size} of {total}",
  cancelled: "Cancelled. The update was not installed.",
  installedRestart:
    "Version {version} was installed. Close MOCHI and open it again to use it.",
  installFailed: "The update was not installed",
} as const;

export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
}

export function upToDate(current: string): string {
  return fill("No newer version was found. You are running version {current}.", { current });
}

export function available(offer: UpdateOffer): string {
  return fill("Version {version} is available. You are running version {current}.", {
    version: offer.version,
    current: offer.current_version,
  });
}

/** One sentence per kind of failure, with the network's own words last, as text. */
export function failureText(kind: UpdateFailureKind, detail: string): string {
  switch (kind) {
    case "offline":
      return "Could not reach the update server. Check your connection and try again. Nothing was changed.";
    case "server":
      return `The update server did not give a usable answer. Nothing was changed. (${detail})`;
    case "signature":
      return "The update's signature did not match, so it was refused. Nothing was installed.";
    case "install":
      return `The update was downloaded but not installed. (${detail})`;
    case "unavailable":
      return `Updates are not available in this build. (${detail})`;
    case "other":
      return `The check for updates did not finish. (${detail})`;
  }
}
