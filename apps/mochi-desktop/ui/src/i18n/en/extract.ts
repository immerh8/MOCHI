// Extraction (plan D3; spec §23.3): extracting is not a verification, so
// nothing here gets success styling.
export const extract = {
  "extract.heading": "Extract",
  "extract.all": "Extract all",
  "extract.selected": "Extract selected",
  "extract.openFirst": "Open an archive first",
  "extract.selectFirst": "Select an entry first",
  "extract.folderFailed": "Could not check the folder",
  "extract.startFailed": "Could not start",
  "extract.group": "Extract to",
  "extract.panelHeading": "Extract to this folder?",
  "extract.folder": "Folder",
  "extract.what": "What",
  "extract.wholeCommit": "Everything in version {seq}",
  "extract.entryFromCommit": " from version {seq}",
  "extract.entriesCount": " ({count})",
  "extract.parentsNote": "The folders above a selected entry are created too.",
  "extract.folderNote": "Extract into a folder only you can modify.",
  "extract.caseInsensitive": "This folder treats names that differ only in case as the same name.",
  "extract.cannotOne": "{n} entry cannot be extracted into this folder:",
  "extract.cannotMany": "{n} entries cannot be extracted into this folder:",
  "extract.cannotList": "Entries that cannot be extracted",
  "extract.conflictNote":
    "Nothing is overwritten and no name is changed. If a folder is skipped, everything inside it is skipped too.",
  "extract.notOffered":
    "Replacing existing items, or keeping both under a new name, is not available yet. To keep both, extract into a different or new folder.",
  "extract.noConflicts":
    "Nothing in this folder conflicts with the entries to extract. Nothing is overwritten either way.",
  "extract.confirmSkip": "Extract the rest, skipping these",
  "extract.confirm": "Extract",
  "extract.changeFolder": "Choose a different folder…",
  "extract.newFolderNote":
    "A new folder was made for this next to the archive, so nothing that is already on your computer can be replaced.",
  "extract.recheck": "Check again",
  "extract.notExtracted": "Not extracted:",
  "extract.notExtractedList": "Entries not extracted",
  "extract.attributesList": "Attributes not applied",
  "extract.checkNote":
    "Each extracted file was checked against the hashes recorded in the archive before it was kept. Extracting is not a verification of the archive: nothing else in it was checked.",
  "extract.cancelled": "Cancelled. The extraction stopped before it finished.",
  "extract.cancelledNote1":
    "Files extracted before you cancelled stay in the folder, each one complete. The file being written was discarded.",
  "extract.cancelledNote2":
    "Folders already made may not have their recorded times and permissions yet: those are applied at the end.",
  "extract.nothingWritten": "Nothing was written.",
  "extract.mayHaveExtracted": "Some files may already have been extracted into the folder.",
  "extract.extractedAll": "Extracted {what} from version {seq} to {dest}.",
  "extract.what2": "{files} ({size}) and {folders}",
  "extract.notExtractedOne": "{n} entry was not extracted.",
  "extract.notExtractedMany": "{n} entries were not extracted.",
  "extract.attributesUnavailable":
    "No times, permissions, or other attributes were applied: they could not be read from the archive ({reason}).",
  "extract.durabilityNote":
    "Degraded: the folder's entries are not confirmed durable on disk ({note}).",
  "extract.attributeLine":
    "Not applied: {attribute}, on {count}. First: {path}{escaped}. {reason}",
  "extract.progressRestoreOf": "Extracting: {completed} of {total} entries",
  "extract.progressRestore": "Extracting: {completed} entries",
  "extract.progressPhaseOf": "{phase}: {completed} of {total}",
  "extract.progressPhase": "{phase}: {completed}",
} as const;
