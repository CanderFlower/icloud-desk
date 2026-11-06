@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo [icloud-desk] Creating virtual environment...
  python -m venv .venv || goto :err
  ".venv\Scripts\python.exe" -m pip install -U pip >nul
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :err
)
:: Dev entry point. No args = open UI in the browser; otherwise forwarded to the CLI.
::   run.bat                    open UI (real account)
::   run.bat --demo ui          open UI with demo data
::   run.bat calendar events    any icd command
if "%~1"=="" (
  ".venv\Scripts\python.exe" icd.py ui --browser
) else (
  ".venv\Scripts\python.exe" icd.py %*
)
exit /b %errorlevel%

:err
echo [icloud-desk] Setup failed.
pause
exit /b 1
