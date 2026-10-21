// The toolbar and its menu. Labels are one or two words; the longer
// explanation is the button's tooltip.
export const toolbar = {
  "toolbar.label": "Actions",
  "toolbar.test": "Test",
  "toolbar.testTip": "Test this archive",
  "toolbar.readOnly": "Archives in other formats are read-only",
  "toolbar.info": "Info",
  "toolbar.infoTip": "Show or hide details",
  "toolbar.openFirst": "Open an archive first",
  "toolbar.openTip": "Open an archive (Ctrl+O)",
  "toolbar.more": "More",
  "toolbar.repair": "Repair",
  "toolbar.foreign": "Other formats…",
  "toolbar.selfTest": "Self-test",
  "toolbar.helpTip": "Help and keyboard keys",
  // Why a button or menu item is off (shell/availability.ts); the item stays visible.
  "avail.noArchive": "Open an archive first",
  "avail.locked": "Enter the archive's passphrase first",
  "avail.noSelection": "Select an entry first",
  "avail.emptyList": "There is nothing here to select",
  "avail.busy": "Wait for the current task to finish",
  "avail.notEncrypted": "Only an encrypted MOCHI archive has passphrases",
} as const;
