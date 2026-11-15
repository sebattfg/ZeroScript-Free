@echo off
setlocal
title NonZeroScript Controller
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  set "PY=py -3"
) else (
  where python >nul 2>nul
  if %errorlevel%==0 (
    set "PY=python"
  ) else (
    echo.
    echo Python 3 was not found.
    echo Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
    echo.
    pause
    exit /b 1
  )
)

%PY% main.py
if errorlevel 1 (
  echo.
  echo The controller exited with an error. Press any key to close.
  pause >nul
)
endlocal
