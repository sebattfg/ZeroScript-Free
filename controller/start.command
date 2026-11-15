#!/bin/bash
# NonZeroScript controller - macOS double-click launcher.
# The repo pins LF endings for *.command (see .gitattributes).
cd "$(dirname "$0")" || exit 1

PY=""
command -v python3 >/dev/null 2>&1 && PY=python3
[ -z "$PY" ] && command -v python >/dev/null 2>&1 && PY=python

if [ -z "$PY" ]; then
  echo
  echo "Python 3 was not found."
  echo "Install it from https://www.python.org/downloads/ and run this again."
  echo
  read -r -p "Press Return to close..."
  exit 1
fi

"$PY" main.py
code=$?
if [ $code -ne 0 ]; then
  echo
  echo "The controller exited with code $code."
  read -r -p "Press Return to close..."
fi
