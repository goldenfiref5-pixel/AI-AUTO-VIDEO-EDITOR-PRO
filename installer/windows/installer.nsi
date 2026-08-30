; ---------------------------------------------------------------------------
;  AI Auto Editor Pro — Windows installer.
;
;  Installs per-user into %LOCALAPPDATA% rather than Program Files. The app
;  writes its settings file and stores media inside the install directory, so a
;  location the user already owns avoids both the UAC prompt and the silent
;  permission failures a Program Files install would cause.
; ---------------------------------------------------------------------------

Unicode true
SetCompressor /SOLID lzma

!define APP_NAME    "AI Auto Editor Pro"
!define APP_SLUG    "AIAutoEditorPro"
!define APP_VERSION "1.0.0"
!define APP_PUBLISHER "AI Auto Editor Pro"

Name "${APP_NAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\${APP_SLUG}"
InstallDirRegKey HKCU "Software\${APP_SLUG}" "InstallDir"

; Per-user install: no elevation, so no UAC prompt on the installer itself.
RequestExecutionLevel user
ShowInstDetails show
ShowUnInstDetails show

!include "MUI2.nsh"

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "${APP_NAME}"
!define MUI_WELCOMEPAGE_TEXT \
"This installs ${APP_NAME} on your computer.$\r$\n$\r$\n\
It turns a voiceover recording into a finished video: transcription, story \
analysis, consistent characters, generated scenes, captions and rendering.$\r$\n$\r$\n\
The platform runs entirely on your machine. The first launch checks for Docker \
Desktop, which provides the database, cache and video engine, and downloads it \
automatically with a progress bar if it is missing.$\r$\n$\r$\n\
You will also need a free Google Gemini API key, which you add inside the app."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_TITLE "Installed"
!define MUI_FINISHPAGE_TEXT \
"${APP_NAME} is installed.$\r$\n$\r$\n\
The first start downloads Docker Desktop if it is not already present, then \
builds the platform. That takes 5 to 10 minutes and needs an internet \
connection. Later starts take seconds and work offline, apart from the calls to \
Google's Gemini API that generation itself makes."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Start ${APP_NAME} now"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Function LaunchApp
  ; -ExecutionPolicy Bypass so the shortcut works on a default Windows policy.
  Exec 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\Setup.ps1" -Action Start -InstallRoot "$INSTDIR"'
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  SetOverwrite on

  ; Everything except the user's own settings, which are preserved below.
  File /r "${STAGEDIR}\*.*"

  WriteRegStr HKCU "Software\${APP_SLUG}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\${APP_SLUG}" "Version" "${APP_VERSION}"

  ; Add/Remove Programs entry.
  !define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_SLUG}"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayName"     "${APP_NAME}"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayVersion"  "${APP_VERSION}"
  WriteRegStr   HKCU "${UNINST_KEY}" "Publisher"       "${APP_PUBLISHER}"
  WriteRegStr   HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr   HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" \
    "powershell.exe" \
    '-NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\Setup.ps1" -Action Start -InstallRoot "$INSTDIR"' \
    "$SYSDIR\shell32.dll" 137
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Stop ${APP_NAME}.lnk" \
    "powershell.exe" \
    '-NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\Setup.ps1" -Action Stop -InstallRoot "$INSTDIR"' \
    "$SYSDIR\shell32.dll" 132
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Diagnose ${APP_NAME}.lnk" \
    "powershell.exe" \
    '-NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\Setup.ps1" -Action Doctor -InstallRoot "$INSTDIR"' \
    "$SYSDIR\shell32.dll" 23
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall.lnk" "$INSTDIR\Uninstall.exe"

  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" \
    "powershell.exe" \
    '-NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\Setup.ps1" -Action Start -InstallRoot "$INSTDIR"' \
    "$SYSDIR\shell32.dll" 137
SectionEnd

Section "Uninstall"
  ; Stop and remove the containers first, so uninstalling does not strand a
  ; running stack with no way to shut it down.
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\Setup.ps1" -Action Stop -InstallRoot "$INSTDIR"'

  Delete "$DESKTOP\${APP_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APP_NAME}"

  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_SLUG}"
  DeleteRegKey HKCU "Software\${APP_SLUG}"
SectionEnd
