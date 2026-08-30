@echo off
REM ===========================================================================
REM  AI Auto Editor Pro - one-click start for Windows.
REM
REM  Double-click this file. Everything the platform needs (PostgreSQL, Redis,
REM  FFmpeg, Node) runs inside Docker, so Docker Desktop is the only thing you
REM  install yourself.
REM ===========================================================================

setlocal
cd /d "%~dp0"
title AI Auto Editor Pro

echo.
echo   AI Auto Editor Pro
echo   ==================
echo.

REM --- 1. Is Docker installed? ----------------------------------------------
where docker >nul 2>&1
if errorlevel 1 goto no_docker

REM --- 2. Is the Docker engine actually running? ----------------------------
docker info >nul 2>&1
if errorlevel 1 goto docker_stopped
echo   [ok] Docker is running

REM --- 3. Configuration ------------------------------------------------------
if exist ".env" goto have_env

echo   [..] Creating .env with freshly generated secrets
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\setup-env.ps1"
if errorlevel 1 goto env_failed
echo   [ok] Created .env
goto build

:have_env
echo   [ok] Using your existing .env

REM --- Ports ------------------------------------------------------------------
REM .env is the source of truth; fall back to the compose defaults so the
REM readiness check and the browser open follow a custom WEB_PORT / API_PORT.
set "WEB_PORT=3000"
set "API_PORT=4000"
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    if /i "%%A"=="WEB_PORT" set "WEB_PORT=%%B"
    if /i "%%A"=="API_PORT" set "API_PORT=%%B"
  )
)
REM Strip any surrounding quotes a hand-edited .env may carry.
set "WEB_PORT=%WEB_PORT:"=%"
set "API_PORT=%API_PORT:"=%"

REM --- 4. Build and start ----------------------------------------------------
:build
echo.
echo   Building and starting containers.
echo   The first run downloads and compiles everything - expect 5 to 10 minutes.
echo   Later runs take a few seconds.
echo.

docker compose up -d --build
if errorlevel 1 goto compose_failed

REM --- 5. Wait until it actually answers -------------------------------------
echo.
echo   Waiting for the platform to come up...
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\wait-ready.ps1" -WebPort %WEB_PORT% -ApiPort %API_PORT%
if errorlevel 1 goto not_ready

echo.
echo   [ok] API   http://localhost:%API_PORT%
echo   [ok] App   http://localhost:%WEB_PORT%
echo.

start "" http://localhost:%WEB_PORT%

echo   Next steps
echo     1. Create an account - the first one becomes the administrator.
echo     2. Open API management and add a Gemini API key.
echo        Get one free at https://aistudio.google.com/apikey
echo     3. Create a project and upload a voiceover.
echo.
echo   Close it later with STOP-WINDOWS.bat - your data is kept.
echo.
pause
exit /b 0

REM --- Failure paths ---------------------------------------------------------
:no_docker
echo   [X] Docker Desktop is not installed.
echo.
echo       Install it from https://www.docker.com/products/docker-desktop/
echo       then run this file again.
echo.
pause
exit /b 1

:docker_stopped
echo   [X] Docker Desktop is installed but not running.
echo.
echo       Start Docker Desktop from the Start menu, wait for the whale icon
echo       in the system tray to stop animating, then run this file again.
echo.
pause
exit /b 1

:env_failed
echo   [X] Could not create the .env file.
echo       Check that .env.example is present next to this script.
echo.
pause
exit /b 1

:compose_failed
echo.
echo   [X] The containers failed to build or start.
echo       Run this to see why:  docker compose logs --tail=80
echo.
pause
exit /b 1

:not_ready
echo.
echo   [X] The platform did not answer within five minutes.
echo       Run this to see why:  docker compose logs --tail=80
echo.
pause
exit /b 1
