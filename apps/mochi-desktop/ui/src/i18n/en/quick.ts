// The compact window of the shell's quick verbs (plan D6, owner decision 2026-10-16).
// Wording follows spec §23.3: a new archive is a local commit, not a backup; an extraction is
// not a verification; a cancelled extraction keeps what it already wrote.
export const quick = {
  "quick.titleExtractHere": "Extracting {name}",
  "quick.titleExtractToFolder": "Extracting {name} to a new folder",
  "quick.titleAdd": "Adding {name} to a new archive",
  "quick.titleAddMore": "Adding {name} and {n} more to a new archive",
  "quick.passphraseNeeded": "{name} is encrypted. Enter its passphrase to extract it.",
  "quick.passphraseWrong": "That passphrase did not open {name}. Enter it again.",
  "quick.passphrase": "Passphrase",
  "quick.passphraseSubmit": "Extract",
  "quick.cancelling": "Cancelling…",
  "quick.doneExtract": "Extracted {parts} into {name}",
  "quick.extractNote":
    "Each extracted file was checked against the hashes recorded in the archive before it was kept. Extracting is not a verification of the archive.",
  "quick.doneAdd": "Archive created: {name} · {parts}",
  "quick.lineNotAdded": "{n} not added",
  "quick.lineNotExtracted": "{n} not extracted",
  "quick.firstReason": "First reason: {note}",
  "quick.rowLocation": "Location",
  "quick.rowFiles": "Files",
  "quick.rowFolders": "Folders",
  "quick.rowSize": "Size",
  "quick.rowStatus": "Status",
  "quick.rowFolderEntry": "Folder entry on disk",
  "quick.notConfirmed": "Not confirmed",
  "quick.degradedMark": "Degraded",
  "quick.rowNotStored": "Not stored",
  "quick.rowNotExtracted": "Not extracted",
  "quick.fallbackOne":
    "Nothing was written: {n} entry would collide with something already in {destination}. The extract plan is open in the main window, where you choose what to do.",
  "quick.fallbackMany":
    "Nothing was written: {n} entries would collide with something already in {destination}. The extract plan is open in the main window, where you choose what to do.",
  "quick.cancelledExtract":
    "Cancelled. Files already extracted stay in the folder, each one complete. The file being written was discarded.",
  "quick.waiting": "Waiting for the job…",
  "quick.showFolder": "Show in folder",
} as const;
