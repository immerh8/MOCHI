// The compact result of a create, add, remove, or extract: one short line, and
// a Details panel for everything else (owner request, release 0.9.3). Nothing
// here is a verification, so nothing gets success styling (spec §23.3).
export const result = {
  "result.details": "Details",
  "result.detailsWithNotes": "Details, {notes}",
  "result.notesOne": "{n} note",
  "result.notesMany": "{n} notes",
  "result.dismiss": "Dismiss",
} as const;
