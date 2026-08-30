@echo off
REM Stops AI Auto Editor Pro. Your projects, media and database are kept.
setlocal
cd /d "%~dp0"
title AI Auto Editor Pro - stopping

echo.
echo   Stopping AI Auto Editor Pro...
echo.

docker compose down
if errorlevel 1 goto failed

echo.
echo   [ok] Stopped. Your data is kept - START-WINDOWS.bat brings it all back.
echo.
echo   To erase everything (projects, media, accounts) run:
echo       docker compose down -v
echo.
pause
exit /b 0

:failed
echo.
echo   [X] Could not stop the containers. Is Docker Desktop running?
echo.
pause
exit /b 1
