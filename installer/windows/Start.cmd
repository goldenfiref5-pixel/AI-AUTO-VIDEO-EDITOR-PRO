@echo off
REM ===========================================================================
REM  AI Auto Editor Pro - Start
REM
REM  This wrapper exists so the window ALWAYS stays open. Launching
REM  powershell.exe straight from a shortcut hides parse errors: the window
REM  closes instantly and the user sees nothing at all.
REM ===========================================================================
title AI Auto Editor Pro - Start
setlocal

REM %~dp0 keeps its trailing backslash; strip it so paths stay clean.
set "HERE=%~dp0"
set "HERE=%HERE:~0,-1%"

if not exist "%HERE%\Setup.ps1" (
  echo.
  echo   [X] Setup.ps1 is missing from:
  echo       %HERE%
  echo.
  echo   The installation is incomplete. Please reinstall.
  echo.
  pause
  exit /b 1
)

where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [X] Windows PowerShell was not found on this system.
  echo.
  pause
  exit /b 1
)

powershell.exe -NoProfile -NoLogo -ExecutionPolicy Bypass -File "%HERE%\Setup.ps1" -Action Start -InstallRoot "%HERE%"
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo   ---------------------------------------------------------------
  echo   Finished with errors ^(exit code %RC%^).
  echo   Everything printed above is the full detail. Nothing is hidden.
  echo   ---------------------------------------------------------------
)

echo.
echo   Press any key to close this window...
pause >nul
exit /b %RC%
