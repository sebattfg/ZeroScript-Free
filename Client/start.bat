:: SPDX-License-Identifier: GPL-3.0-or-later
@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title ZeroScript Bridge
cd /d "%~dp0"

if not exist "%~dp0logs" mkdir "%~dp0logs" >nul 2>nul
set "LOGFILE=%~dp0logs\start.log"
call :log "===== %DATE% %TIME%  start.bat launched ====="
REM Log the Windows build once per launch - most support requests arrive as a
REM single terminal screenshot, so anything that identifies the machine's
REM environment must be either ON SCREEN or in this log.
for /f "tokens=*" %%v in ('ver') do call :log "%%v"

echo.
echo   === ZeroScript Bridge ===
echo.

REM Refuse to run from inside a ZIP preview: Explorer extracts start.bat alone
REM to %TEMP%, so bridge.py is missing and the launch fails with a confusing
REM Python error. Detect the missing file up front with a plain explanation -
REM this is one of the most common first-run mistakes.
if not exist "%~dp0bridge.py" (
    echo   ERROR: bridge.py not found next to start.bat.
    echo.
    echo   If you opened start.bat from inside the downloaded ZIP, first EXTRACT
    echo   the whole ZIP ^(right-click, "Extract All..."^), then run start.bat
    echo   from the extracted folder.
    echo.
    call :log "FATAL: bridge.py missing next to start.bat (run from inside ZIP?)."
    pause
    exit /b 1
)

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

REM Last resort: scan the standard install folders directly. Covers the common
REM case where Python was installed WITHOUT "Add to PATH" and without the py
REM launcher, so neither "py" nor "python" resolves. Newest version first.
for %%R in (
    "%LOCALAPPDATA%\Programs\Python"
    "%ProgramFiles%"
    "%ProgramFiles(x86)%"
) do (
    if exist "%%~R" (
        for /f "delims=" %%D in ('dir /b /ad /o-n "%%~R\Python3*" 2^>nul') do (
            if exist "%%~R\%%D\python.exe" (
                set PY="%%~R\%%D\python.exe"
                call :validate_py && goto :found
            )
        )
    )
)

set "PY="
call :log "Python not found on PATH or in standard install folders."
goto :need_install

:found
REM Print the exact interpreter VERSION on screen (not just the launcher name):
REM a user screenshot must tell us whether the failure is a too-old Python
REM without asking them to run anything else.
REM "call" prefix: when %PY% is a quoted full path (the no-PATH scan case), a
REM bare quoted command inside for /f trips cmd's leading-quote stripping rule;
REM call re-parses the line and keeps the quotes intact.
for /f "tokens=*" %%v in ('call %PY% --version 2^>^&1') do (
    echo         Found: %PY%  ^(%%v^)
    call :log "Python found: %PY% (%%v)"
)
goto :install_deps

:need_install
REM --- Python not found, try winget -------------------------------------------
REM winget itself may be absent (LTSC / old Win10 / stripped installs). Without
REM this check the "winget" line fails with an unrelated "not recognized" error
REM that users screenshot without context - name the real problem instead.
where winget >nul 2>nul
if errorlevel 1 (
    echo   ERROR: Python is not installed and winget ^(Windows package manager^)
    echo   is not available on this PC, so it cannot be installed automatically.
    echo.
    echo   Install Python manually: https://www.python.org/downloads/
    echo   IMPORTANT: tick "Add python.exe to PATH", then run start.bat again.
    echo.
    call :log "FATAL: no Python and no winget on this machine."
    pause
    exit /b 1
)
echo         Not found. Installing via winget...
echo.
winget install --id Python.Python.3.12 --source winget --accept-package-agreements --accept-source-agreements
if errorlevel 1 call :log "winget install returned an error (see console output above)."
echo.
echo   Checking again...
set "PY=py -3"
call :validate_py && goto :ready
set "PY=python"
call :validate_py && goto :ready
REM A winget install does NOT refresh THIS console's PATH, so "py"/"python" can
REM stay unresolvable in the very session that installed them. Rescan the
REM standard install folders directly (same scan as the pre-install fallback)
REM before telling the user it failed - a plain restart-and-retry would have
REM worked, so we do its equivalent for them.
for %%R in (
    "%LOCALAPPDATA%\Programs\Python"
    "%ProgramFiles%"
    "%ProgramFiles(x86)%"
) do (
    if exist "%%~R" (
        for /f "delims=" %%D in ('dir /b /ad /o-n "%%~R\Python3*" 2^>nul') do (
            if exist "%%~R\%%D\python.exe" (
                set PY="%%~R\%%D\python.exe"
                call :validate_py && goto :ready
            )
        )
    )
)
echo.
echo   ERROR: Python not found after install.
echo   Install manually: https://www.python.org/downloads/
echo   Tick "Add python.exe to PATH" then run this again.
echo.
call :log "FATAL: no usable Python found even after winget install."
pause
exit /b 1
:ready
echo         Python ready!
call :log "Python ready after winget install: %PY%"

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
        echo   Common causes: no internet, a firewall/antivirus blocking pip,
        echo   or Python has no working pip. If you used the Microsoft Store
        echo   python, install from https://www.python.org/downloads/ instead
        echo   ^(tick "Add to PATH"^).
        echo.
        call :log "FATAL: pip install websockets failed."
        pause
        exit /b 1
    )
)
echo         OK
call :log "websockets library OK"

REM --- 3. Run the bridge ------------------------------------------------------
echo.
echo   [3/3] Starting bridge...

REM If a previous bridge is already listening on 17613, say so instead of
REM silently killing it - a double-launch is easy to do by mistake (e.g.
REM double-clicking start.bat twice) and should not look like nothing happened.
set "OLDPID="
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :17613 ^| findstr LISTENING 2^>nul') do (
    set "OLDPID=%%a"
)
if defined OLDPID (
    echo         A previous bridge ^(pid !OLDPID!^) is already running on this port.
    echo         Replacing it with this new instance...
    call :log "Killing previous bridge instance (pid !OLDPID!) on port 17613."
    taskkill /F /T /PID !OLDPID! >nul 2>nul
    REM Give Windows a moment to actually free the socket before we rebind it.
    timeout /t 1 /nobreak >nul
    set "STILLTHERE="
    for /f "tokens=5" %%a in ('netstat -aon ^| findstr :17613 ^| findstr LISTENING 2^>nul') do (
        set "STILLTHERE=%%a"
    )
    if defined STILLTHERE (
        echo.
        echo   WARNING: port 17613 is still held by pid !STILLTHERE! after trying
        echo   to close the previous bridge. If the bridge below fails to start,
        echo   close that process manually in Task Manager ^(or restart Windows^)
        echo   and run start.bat again.
        echo.
        call :log "WARNING: port 17613 still held by pid !STILLTHERE! after taskkill."
    )
)

echo.
echo  ############################################################
echo  ##                                                        ##
echo  ##   KEEP THIS TERMINAL OPEN - DO NOT CLOSE THIS WINDOW   ##
echo  ##                                                        ##
echo  ##   ZeroScript stops working if you close it. Just       ##
echo  ##   minimize this window and leave it running.           ##
echo  ##                                                        ##
echo  ############################################################
echo.
call :log "Launching bridge.py with %PY%"
%PY% "%~dp0bridge.py"
REM Show the exit code ON SCREEN, not only in the log: a screenshot of this
REM terminal is usually the only diagnostic we get, and "Bridge stopped" alone
REM does not say whether it crashed (non-zero) or was closed normally.
set "BRIDGE_EXIT=%errorlevel%"
call :log "bridge.py exited with code %BRIDGE_EXIT%"

echo.
if not "%BRIDGE_EXIT%"=="0" (
    echo   Bridge stopped with ERROR code %BRIDGE_EXIT% - scroll up for the Python
    echo   error message and include THIS WHOLE WINDOW in any bug report.
    echo   Log file: logs\start.log
) else (
    echo   Bridge stopped normally.
)
echo   Press any key to close.
pause >nul
exit /b 0

REM --- Subroutine: verify %PY% is a real, usable Python ------------------------
REM Returns 0 only if the interpreter runs, has a working pip, AND is Python 3.9
REM or newer. The pip check rejects the Microsoft Store stub (WindowsApps\
REM python.exe). The version check rejects old interpreters (e.g. 3.7/3.8) that
REM lack asyncio.to_thread, which the bridge requires.
:validate_py
%PY% -m pip --version >nul 2>nul || exit /b 1
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul
exit /b %errorlevel%

REM --- Subroutine: append a line to start.log (best-effort, never blocks) -----
:log
REM Redirect FIRST, then echo. With the redirect at the end, a message that
REM ENDS IN A DIGIT (e.g. "exited with code 0") makes cmd parse "0>>" as a
REM file-handle redirect: the digit is eaten and the line prints to the console
REM instead of the log (seen live). echo( is the safe echo form for arbitrary text.
>>"%LOGFILE%" 2>nul echo(%~1
exit /b 0
