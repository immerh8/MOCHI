// The start screen and the plain wording of the main path (D10). Technical
// terms (snapshot, commit, hash) stay in the "Technical details" areas and in
// help text; the main path says "version", "files", and "folder".
export const start = {
  "start.heading": "What would you like to do?",
  "start.create": "Create archive",
  "start.createHint": "Pack files and folders into one new file.",
  "start.open": "Open archive",
  "start.openHint": "Look inside an archive and pick what to take out.",
  "start.extract": "Extract archive",
  "start.extractHint": "Choose an archive and take everything out of it.",
  "start.dropHint":
    "You can also drop files and folders here to put them in a new archive, or drop a .mochi file to open it.",
  "start.note":
    "An archive packs files into one file. It is not a second copy of them: keep an independent copy of anything you cannot lose.",
  "start.recent": "Recent archives",
  "start.recentOpen": "Open {name}",
  "start.recentFolder": "in {folder}",
  "start.forgetRecent": "Clear this list",
  "start.openRecentFailed": "Could not open that archive",
  "start.openDroppedFailed": "Could not open the dropped archive",
  "start.advanced": "Advanced: search, test and repair, passphrases, other formats, settings",
  "start.advancedHint":
    "Tools for checking an archive, repairing damage, changing passphrases, reading ZIP, 7z, RAR and tar files, and the app's settings.",
  "start.showInFolder": "Show in folder",
  "start.showInFolderFailed": "Could not show the folder",
  "start.technical": "Technical details",
} as const;
