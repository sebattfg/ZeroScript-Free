@echo off
REM ============================================================================
REM  ZeroScript Free — launcher
REM
REM  This file does only three things, and nothing is hidden:
REM    1. Find Python on your PC.
REM    2. Install the ONE dependency (the "websockets" library) if missing.
REM    3. Run bridge.py — the local bridge, sitting right next to this file.
REM
REM  Nothing is downloaded and run behind your back. Open bridge.py in any text
REM  editor and read it: it's the whole program. This window stays open so you
REM  can see what the bridge is doing — close it to stop the bridge.
REM ============================================================================
setlocal
title ZeroScript Bridge
cd /d "%~dp0"

REM --- 1. Find Python (prefer the "py" launcher, fall back to "python") -------
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
    where python >nul 2>nul && set "PY=python"
)
if not defined PY (
    echo.
    echo   Python is not installed.
    echo   Install it once from https://www.python.org/downloads/
    echo   ^(tick "Add python.exe to PATH" in the installer^), then run this again.
    echo.
    pause
    exit /b 1
)

REM --- 2. Make sure the "websockets" library is present ----------------------
%PY% -c "import websockets" >nul 2>nul
if errorlevel 1 (
    echo   Installing the websockets library ^(one-time^)...
    %PY% -m pip install --user websockets
    if errorlevel 1 (
        echo.
        echo   Could not install websockets. Check your internet connection.
        echo.
        pause
        exit /b 1
    )
)

REM --- 3. Run the bridge -----------------------------------------------------
echo.
%PY% "%~dp0bridge.py"

REM If the bridge exits (error or you closed it), keep the window so the
REM message stays readable.
echo.
echo   Bridge stopped. Close this window, or press a key to relaunch.
pause >nul
exit /b 0
