@echo off
chcp 65001 >nul
cd /d %~dp0
if not exist venv\.ok (
  python -m venv venv
  call venv\Scripts\activate
  pip install -r requirements.txt
  playwright install chromium
  echo ok> venv\.ok
) else (
  call venv\Scripts\activate
)
python app.py
pause
