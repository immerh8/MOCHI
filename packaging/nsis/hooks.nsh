; NSIS installer hooks for MOCHI (plan D6, decision O10). Tauri includes this file
; into its generated installer (bundle.windows.nsis.installerHooks) and calls the
; NSIS_HOOK_* macros below. Everything is written under HKCU: the installer is
; per-user (installMode currentUser) and never elevates.
;
; What is registered, and nothing else (the uninstall hook removes each of it):
;
;   .mochi          the association itself comes from bundle.fileAssociations
;                   (Tauri's APP_ASSOCIATE; ProgID "MOCHI.Archive"). Its leftovers
;                   are cleaned here, because Tauri's APP_UNASSOCIATE leaves the
;                   ".mochi" key and a "<ProgID>_backup" value behind.
;   Install key     Tauri's HKCU\Software\<publisher>\<product> install-location
;                   key, which Tauri's own uninstaller keeps unless the user
;                   ticks "delete application data" (removed here, not on update).
;   Explorer menu   one cascading submenu "MOCHI" (7-Zip style; the owner decision of
;                   2026-10-16), in the classic context menu, which Windows 11 shows
;                   under "Show more options" (the top-level Windows 11 menu needs an
;                   IExplorerCommand handler with package identity: 1.x, O10).
;                   It is a key "MochiMenu" with MUIVerb and an empty SubCommands
;                   value, whose own "shell" key holds the entries (the numeric
;                   prefixes fix their order):
;                     .mochi files            Open with MOCHI / Extract here /
;                                             Extract to a new folder / Add to archive /
;                                             Add to archive...
;                     all files and folders   Add to archive / Add to archive...
;                   Each runs the app with a verb the app parses and validates in
;                   Rust (src-tauri/src/launch.rs). The panel verbs (Open with MOCHI,
;                   Add to archive...) show the main window. The quick verbs (Extract
;                   here, Extract to a new folder, Add to archive) work at once in a
;                   small window, and never overwrite: a collision falls back to the
;                   main window's extract plan. A path is never joined into a shell
;                   string; "--" ends the options so that a file named like an option
;                   stays a path. No command line carries a passphrase.
;                   (Earlier versions registered four flat verbs; they are removed on
;                   install and uninstall.)
;   Opt-in          ZIP, 7z, RAR, tar, tar.gz/tgz (and so .gz, Windows keys on the
;                   last extension): offered under "Open with" for those types
;                   only if the user says yes (a question at install time, default
;                   NO; /ASSOCIATE_FOREIGN on the command line says yes, silent
;                   installs say no). It never writes a type's default value and
;                   never touches the user's choice; Windows lets only the user
;                   make MOCHI the default (Settings > Default apps).
;
; Windows Server runners cannot show Explorer's menu; the keys are checked by
; packaging/smoke-nsis.ps1 and the menu itself is on the release checklist
; (docs/packaging.md).

!define MOCHI_ASSOC_PROGID "MOCHI.Archive"
!define MOCHI_FOREIGN_PROGID "MOCHI.Foreign"
!define MOCHI_CLASSES "Software\Classes"

; One entry of the submenu: its key under the given Classes path, the menu text, the argument.
!macro MochiWriteItem SHELLKEY ITEM LABEL OPTION
  WriteRegStr HKCU "${MOCHI_CLASSES}\${SHELLKEY}\shell\MochiMenu\shell\${ITEM}" "" "${LABEL}"
  WriteRegStr HKCU "${MOCHI_CLASSES}\${SHELLKEY}\shell\MochiMenu\shell\${ITEM}" "Icon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr HKCU "${MOCHI_CLASSES}\${SHELLKEY}\shell\MochiMenu\shell\${ITEM}\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" ${OPTION} -- $\"%1$\""
!macroend

; The submenu itself: "MOCHI", with an empty SubCommands value so that the shell
; builds the cascade from the key's own "shell" subkey.
!macro MochiWriteMenu SHELLKEY
  WriteRegStr HKCU "${MOCHI_CLASSES}\${SHELLKEY}\shell\MochiMenu" "MUIVerb" "${PRODUCTNAME}"
  WriteRegStr HKCU "${MOCHI_CLASSES}\${SHELLKEY}\shell\MochiMenu" "Icon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr HKCU "${MOCHI_CLASSES}\${SHELLKEY}\shell\MochiMenu" "SubCommands" ""
!macroend

!macro MochiWriteAddItems SHELLKEY
  !insertmacro MochiWriteItem "${SHELLKEY}" "40Add" "Add to archive" "--add-now"
  !insertmacro MochiWriteItem "${SHELLKEY}" "50AddPanel" "Add to archive..." "--add"
!macroend

!macro MochiDeleteVerb SHELLKEY VERB
  DeleteRegKey HKCU "${MOCHI_CLASSES}\${SHELLKEY}\shell\${VERB}"
  DeleteRegKey /ifempty HKCU "${MOCHI_CLASSES}\${SHELLKEY}\shell"
!macroend

; The flat verbs of earlier versions (0.1.0), replaced by the submenu.
!macro MochiDeleteLegacyVerbs
  !insertmacro MochiDeleteVerb "SystemFileAssociations\.mochi" "MochiOpen"
  !insertmacro MochiDeleteVerb "SystemFileAssociations\.mochi" "MochiExtractHere"
  !insertmacro MochiDeleteVerb "SystemFileAssociations\.mochi" "MochiExtractToFolder"
  !insertmacro MochiDeleteVerb "*" "MochiAdd"
  !insertmacro MochiDeleteVerb "Directory" "MochiAdd"
!macroend

; Offer MOCHI under "Open with" for one extension (never the default value).
!macro MochiOfferFor EXT
  WriteRegStr HKCU "${MOCHI_CLASSES}\.${EXT}\OpenWithProgids" "${MOCHI_FOREIGN_PROGID}" ""
!macroend

!macro MochiWithdrawFor EXT
  DeleteRegValue HKCU "${MOCHI_CLASSES}\.${EXT}\OpenWithProgids" "${MOCHI_FOREIGN_PROGID}"
  DeleteRegKey /ifempty HKCU "${MOCHI_CLASSES}\.${EXT}\OpenWithProgids"
  DeleteRegKey /ifempty HKCU "${MOCHI_CLASSES}\.${EXT}"
!macroend

!macro MochiRegisterForeign
  WriteRegStr HKCU "${MOCHI_CLASSES}\${MOCHI_FOREIGN_PROGID}" "" "Archive (opened with MOCHI)"
  WriteRegStr HKCU "${MOCHI_CLASSES}\${MOCHI_FOREIGN_PROGID}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr HKCU "${MOCHI_CLASSES}\${MOCHI_FOREIGN_PROGID}\shell" "" "open"
  WriteRegStr HKCU "${MOCHI_CLASSES}\${MOCHI_FOREIGN_PROGID}\shell\open" "" "Open with ${PRODUCTNAME}"
  WriteRegStr HKCU "${MOCHI_CLASSES}\${MOCHI_FOREIGN_PROGID}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --open -- $\"%1$\""
  !insertmacro MochiOfferFor "zip"
  !insertmacro MochiOfferFor "7z"
  !insertmacro MochiOfferFor "rar"
  !insertmacro MochiOfferFor "tar"
  !insertmacro MochiOfferFor "tgz"
  !insertmacro MochiOfferFor "gz"
!macroend

!macro MochiUnregisterForeign
  !insertmacro MochiWithdrawFor "zip"
  !insertmacro MochiWithdrawFor "7z"
  !insertmacro MochiWithdrawFor "rar"
  !insertmacro MochiWithdrawFor "tar"
  !insertmacro MochiWithdrawFor "tgz"
  !insertmacro MochiWithdrawFor "gz"
  DeleteRegKey HKCU "${MOCHI_CLASSES}\${MOCHI_FOREIGN_PROGID}"
!macroend

!macro NSIS_HOOK_PREINSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Explorer submenu (and the flat verbs of earlier versions removed).
  !insertmacro MochiDeleteLegacyVerbs
  !insertmacro MochiWriteMenu "SystemFileAssociations\.mochi"
  !insertmacro MochiWriteItem "SystemFileAssociations\.mochi" "10Open" "Open with ${PRODUCTNAME}" "--open"
  !insertmacro MochiWriteItem "SystemFileAssociations\.mochi" "20ExtractHere" "Extract here" "--extract-here"
  !insertmacro MochiWriteItem "SystemFileAssociations\.mochi" "30ExtractToFolder" "Extract to a new folder" "--extract-to-folder"
  !insertmacro MochiWriteAddItems "SystemFileAssociations\.mochi"
  !insertmacro MochiWriteMenu "*"
  !insertmacro MochiWriteAddItems "*"
  !insertmacro MochiWriteMenu "Directory"
  !insertmacro MochiWriteAddItems "Directory"

  ; The opt-in. An update keeps whatever the user chose at the first install.
  ${If} $UpdateMode <> 1
    StrCpy $R9 0
    ${GetOptions} $CMDLINE "/ASSOCIATE_FOREIGN" $R0
    ${IfNot} ${Errors}
      StrCpy $R9 1
    ${ElseIf} $PassiveMode <> 1
      ; Silent installs (/S) take the default, NO, without showing this.
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also offer ${PRODUCTNAME} in the $\"Open with$\" list for ZIP, 7z, RAR, TAR, TGZ and GZ files?$\r$\n$\r$\nThis does not make ${PRODUCTNAME} the default program for them; you can still choose that yourself in Windows Settings. You can undo this by uninstalling ${PRODUCTNAME}." /SD IDNO IDNO mochi_skip_foreign
      StrCpy $R9 1
      mochi_skip_foreign:
    ${EndIf}
    ${If} $R9 = 1
      !insertmacro MochiRegisterForeign
    ${EndIf}
  ${EndIf}
  !insertmacro UPDATEFILEASSOC
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro MochiDeleteLegacyVerbs
  !insertmacro MochiDeleteVerb "SystemFileAssociations\.mochi" "MochiMenu"
  DeleteRegKey /ifempty HKCU "${MOCHI_CLASSES}\SystemFileAssociations\.mochi"
  !insertmacro MochiDeleteVerb "*" "MochiMenu"
  !insertmacro MochiDeleteVerb "Directory" "MochiMenu"
  ; Parent keys this created (never removed if anything else lives in them).
  DeleteRegKey /ifempty HKCU "${MOCHI_CLASSES}\SystemFileAssociations"
  DeleteRegKey /ifempty HKCU "${MOCHI_CLASSES}\*"
  DeleteRegKey /ifempty HKCU "${MOCHI_CLASSES}\Directory"

  ; Tauri's APP_UNASSOCIATE restores the previous default (empty if none) and
  ; leaves "<ProgID>_backup" behind: remove what is ours.
  DeleteRegValue HKCU "${MOCHI_CLASSES}\.mochi" "${MOCHI_ASSOC_PROGID}_backup"
  ReadRegStr $R0 HKCU "${MOCHI_CLASSES}\.mochi" ""
  ${If} $R0 == ""
    DeleteRegValue HKCU "${MOCHI_CLASSES}\.mochi" ""
  ${EndIf}
  DeleteRegKey /ifempty HKCU "${MOCHI_CLASSES}\.mochi"

  ${If} $UpdateMode <> 1
    !insertmacro MochiUnregisterForeign
    ; Tauri's install-location key (written at install, ${MANUPRODUCTKEY}; with
    ; installMode currentUser that is HKCU). Its uninstaller removes it only when
    ; "delete application data" is ticked. An update (/UPDATE) keeps it: the next
    ; install reads it to find the folder. A reinstall writes it again.
    DeleteRegKey HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"
  ${EndIf}
  !insertmacro UPDATEFILEASSOC
!macroend
