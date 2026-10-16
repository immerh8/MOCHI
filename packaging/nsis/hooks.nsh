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
;   Explorer verbs  classic context menu (shown under "Show more options" on
;                   Windows 11; the top-level Windows 11 menu needs an
;                   IExplorerCommand handler with package identity: 1.x, O10):
;                     .mochi files   Open with MOCHI / Extract here / Extract to folder
;                     all files and folders   Add to archive
;                   Each runs the app with a verb the app parses and validates in
;                   Rust (src-tauri/src/launch.rs) and then shows its own panel.
;                   A path is never joined into a shell string; "--" ends the
;                   options so that a file named like an option stays a path.
;                   No command line carries a passphrase.
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

; One Explorer verb: key under the given Classes path, the menu text, the argument.
!macro MochiWriteVerb SHELLKEY VERB LABEL OPTION
  WriteRegStr HKCU "${MOCHI_CLASSES}\${SHELLKEY}\shell\${VERB}" "" "${LABEL}"
  WriteRegStr HKCU "${MOCHI_CLASSES}\${SHELLKEY}\shell\${VERB}" "Icon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr HKCU "${MOCHI_CLASSES}\${SHELLKEY}\shell\${VERB}\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" ${OPTION} -- $\"%1$\""
!macroend

!macro MochiDeleteVerb SHELLKEY VERB
  DeleteRegKey HKCU "${MOCHI_CLASSES}\${SHELLKEY}\shell\${VERB}"
  DeleteRegKey /ifempty HKCU "${MOCHI_CLASSES}\${SHELLKEY}\shell"
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
  ; Explorer verbs.
  !insertmacro MochiWriteVerb "SystemFileAssociations\.mochi" "MochiOpen" "Open with ${PRODUCTNAME}" "--open"
  !insertmacro MochiWriteVerb "SystemFileAssociations\.mochi" "MochiExtractHere" "Extract here" "--extract-here"
  !insertmacro MochiWriteVerb "SystemFileAssociations\.mochi" "MochiExtractToFolder" "Extract to folder" "--extract-to-folder"
  !insertmacro MochiWriteVerb "*" "MochiAdd" "Add to ${PRODUCTNAME} archive" "--add"
  !insertmacro MochiWriteVerb "Directory" "MochiAdd" "Add to ${PRODUCTNAME} archive" "--add"

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
  !insertmacro MochiDeleteVerb "SystemFileAssociations\.mochi" "MochiOpen"
  !insertmacro MochiDeleteVerb "SystemFileAssociations\.mochi" "MochiExtractHere"
  !insertmacro MochiDeleteVerb "SystemFileAssociations\.mochi" "MochiExtractToFolder"
  DeleteRegKey /ifempty HKCU "${MOCHI_CLASSES}\SystemFileAssociations\.mochi"
  !insertmacro MochiDeleteVerb "*" "MochiAdd"
  !insertmacro MochiDeleteVerb "Directory" "MochiAdd"
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
