; tools/installer.nsi -- the OsanaKami IDE Studio installer, compiled in ONE makensis
; pass by tools/make-installer.mjs.
;
; Why this file exists instead of electron-builder's NSIS target: that target
; compiles makensis with -DBUILD_UNINSTALLER and then EXECUTES the result so the
; installer can write out its own uninstaller.  On this machine that chained run
; pops an NSIS dialog ("Error writing temporary file.  Make sure your temp
; folder is valid.") and exits 2, so the real second pass -- the installer with
; the uninstaller embedded -- never runs.  Here WriteUninstaller embeds the
; uninstaller at build time and nothing is executed while building, so there is
; no chain to break.
;
; Every path is a -D define handed over by tools/make-installer.mjs; the
; defaults below are only so the file still compiles by hand from the repo root:
;   makensis tools\installer.nsi

Unicode true
!include "MUI2.nsh"

; --------------------------------------------------------------------------
; Inputs (overridable with -D on the makensis command line)
; --------------------------------------------------------------------------
!ifndef APP_NAME
  !define APP_NAME "OsanaKami IDE Studio"
!endif
!ifndef APP_VERSION
  !define APP_VERSION "0.1.0"
!endif
; VIProductVersion needs four numbers, so the caller passes "0.1.0.0".
!ifndef APP_VERSION4
  !define APP_VERSION4 "0.1.0.0"
!endif
!ifndef APP_EXE
  !define APP_EXE "OsanaKami IDE Studio.exe"
!endif
!ifndef APP_ID
  !define APP_ID "com.osanakami.idestudio"
!endif
!ifndef APP_PUBLISHER
  !define APP_PUBLISHER "OsanaKami IDE Studio"
!endif
!ifndef PAYLOAD_DIR
  !define PAYLOAD_DIR "..\dist\win-unpacked"
!endif
!ifndef LICENCE_FILE
  !define LICENCE_FILE "..\EULA.txt"
!endif
!ifndef ICON_FILE
  !define ICON_FILE "..\electron\icon.ico"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "..\dist\${APP_NAME} Setup ${APP_VERSION}.exe"
!endif
!ifndef UNINST_KEY
  !define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"
!endif
!ifndef APP_KEY
  !define APP_KEY "Software\${APP_NAME}"
!endif
!ifndef UNINST_EXE
  !define UNINST_EXE "Uninstall ${APP_NAME}.exe"
!endif

; --------------------------------------------------------------------------
; Installer identity, destination, compression
; --------------------------------------------------------------------------
Name "${APP_NAME}"
OutFile "${OUT_FILE}"
; Per-user install by default; /D=... still wins for a scripted install.
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
RequestExecutionLevel user
; Compression: zlib.  This is not a size preference, it is the only setting that
; produces a working installer at this payload size.  Measured on this machine
; with 386,091,554 bytes of payload (127 files):
;   * SetCompressor /SOLID lzma -> NSIS aborts during startup with exit code 2
;     ("Error writing temporary file. Make sure your temp folder is valid.")
;     and installs nothing.  That is the same failure electron-builder's NSIS
;     target hits for this app.
;   * SetCompressor lzma (per-file) -> worse: exit code 0 after 1 s, no dialog,
;     nothing installed at all.
;   * SetCompressor zlib -> silent install of 129 files / 386,165,054 bytes in
;     12 s, uninstaller works and removes everything, exit code 0.
; A 439 KB payload survives /SOLID and per-file LZMA (build\tiny-solid.exe,
; build\tiny-smoke.exe), so the trigger is the payload size, not the compressor
; name.  -DLZMA=1 stays available for experiments on small payloads only.
!ifdef LZMA
  SetCompressor lzma
!else
  SetCompressor zlib
!endif

VIProductVersion "${APP_VERSION4}"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "FileDescription" "${APP_NAME} Setup"
VIAddVersionKey "FileVersion" "${APP_VERSION4}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey "LegalCopyright" "${APP_PUBLISHER}"

; --------------------------------------------------------------------------
; Look: MUI2 assisted installer
; --------------------------------------------------------------------------
!define MUI_ABORTWARNING
!define MUI_ICON "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Run ${APP_NAME}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${LICENCE_FILE}"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

; --------------------------------------------------------------------------
; Install: lay down dist\win-unpacked verbatim, shortcut, Add/Remove entry
; --------------------------------------------------------------------------
Section "!${APP_NAME}" SecInstall
  SectionIn RO
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  SetOverwrite on
  File /r "${PAYLOAD_DIR}\*.*"

  ; The licence page is compiled in; the installed copy also carries the same
  ; file next to the app, so the program directory is self-describing.
  SetOutPath "$INSTDIR"
  File "${LICENCE_FILE}"

  ; Embedded here, at build time -- no second makensis pass, no self-exec.
  WriteUninstaller "$INSTDIR\${UNINST_EXE}"

  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"

  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\${UNINST_EXE}"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\${UNINST_EXE}" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  WriteRegStr HKCU "${APP_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${APP_KEY}" "Version" "${APP_VERSION}"
SectionEnd

; --------------------------------------------------------------------------
; Uninstall: remove exactly what SecInstall created
; --------------------------------------------------------------------------
Section "Uninstall"
  SetShellVarContext current
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "${APP_KEY}"
  RMDir /r "$INSTDIR"
SectionEnd
