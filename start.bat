@echo off
setlocal
chcp 65001 >nul
title ZeroScript Bridge
cd /d "%~dp0"

echo.
echo   === ZeroScript Bridge ===
echo.

REM --- 1. Find Python ---------------------------------------------------------
echo   [1/3] Looking for Python...
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
    where python >nul 2>nul && set "PY=python"
)

if defined PY (
    echo         Found: %PY%
    goto :install_deps
)

REM --- Python not found, try winget -------------------------------------------
echo         Not found. Installing via winget...
echo.
winget install --id Python.Python.3.12 --source winget --accept-package-agreements --accept-source-agreements
echo.
echo   Checking again...
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
    where python >nul 2>nul && set "PY=python"
)
if not defined PY (
    echo.
    echo   ERROR: Python not found after install.
    echo   Install manually: https://www.python.org/downloads/
    echo   Tick "Add python.exe to PATH" then run this again.
    echo.
    pause
    exit /b 1
)
echo         Python ready!

:install_deps
REM --- 2. Install websockets --------------------------------------------------
echo.
echo   [2/3] Checking websockets library...
%PY% -c "import websockets" >nul 2>nul
if errorlevel 1 (
    echo         Installing websockets - first time only...
    %PY% -m pip install --user websockets
    if errorlevel 1 (
        echo.
        echo   ERROR: Could not install websockets.
        echo   Check your internet connection and try again.
        echo.
        pause
        exit /b 1
    )
)
echo         OK

REM --- 3. Run the bridge ------------------------------------------------------
echo.
echo   [3/3] Starting bridge...
REM Kill any previous instance using port 17613 so we can bind cleanly.
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :17613 ^| findstr LISTENING 2^>nul') do (
    taskkill /F /PID %%a >nul 2>nul
)
echo.
%PY% "%~dp0bridge.py"

echo.
echo   Bridge stopped. Press any key to close.
pause >nul
exit /b 0
