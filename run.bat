@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo [icloud-desk] Creating virtual environment...
  python -m venv .venv || goto :err
  ".venv\Scripts\python.exe" -m pip install -U pip >nul
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :err
)
".venv\Scripts\python.exe" main.py %*
exit /b %errorlevel%

:err
echo [icloud-desk] Setup failed.
pause
exit /b 1
