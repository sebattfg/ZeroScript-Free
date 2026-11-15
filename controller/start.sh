#!/usr/bin/env bash
# NonZeroScript controller - Linux launcher.
cd "$(dirname "$0")" || exit 1

PY=""
command -v python3 >/dev/null 2>&1 && PY=python3
[ -z "$PY" ] && command -v python >/dev/null 2>&1 && PY=python

if [ -z "$PY" ]; then
  echo "Python 3 was not found. Install python3 and run this again."
  exit 1
fi

exec "$PY" main.py "$@"
