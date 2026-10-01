#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if [ ! -f venv/.ok ]; then
  python3 -m venv venv
  . venv/bin/activate
  pip install -r requirements.txt
  playwright install chromium
  touch venv/.ok
else
  . venv/bin/activate
fi
python app.py
