:: SPDX-License-Identifier: GPL-3.0-or-later
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

REM Prefer the py launcher - it never resolves to the Microsoft Store stub.
where py >nul 2>nul && set "PY=py -3"
call :validate_py && goto :found

REM Fall back to python on PATH, but skip the Store stub (WindowsApps) which
REM cannot run pip and silently fails.
set "PY=python"
call :validate_py && goto :found

set "PY="
goto :need_install

:found
echo         Found: %PY%
goto :install_deps

:need_install
REM --- Python not found, try winget -------------------------------------------
echo         Not found. Installing via winget...
echo.
winget install --id Python.Python.3.12 --source winget --accept-package-agreements --accept-source-agreements
echo.
echo   Checking again...
set "PY=py -3"
call :validate_py && goto :ready
set "PY=python"
call :validate_py && goto :ready
echo.
echo   ERROR: Python not found after install.
echo   Install manually: https://www.python.org/downloads/
echo   Tick "Add python.exe to PATH" then run this again.
echo.
pause
exit /b 1
:ready
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
        echo   ERROR: Could not install websockets ^(see pip output above^).
        echo   Common causes: no internet, or Python has no working pip.
        echo   If you used the Microsoft Store python, install from
        echo   https://www.python.org/downloads/ instead ^(tick "Add to PATH"^).
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

REM --- Subroutine: verify %PY% is a real, usable Python ------------------------
REM Returns 0 only if the interpreter runs AND has a working pip. This rejects
REM the Microsoft Store stub (WindowsApps\python.exe), which exits non-zero / has
REM no pip, so we never select an interpreter that cannot install packages.
:validate_py
%PY% -m pip --version >nul 2>nul
exit /b %errorlevel%
