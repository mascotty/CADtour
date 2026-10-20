@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 (
  py -3 launch.py %*
  goto finished
)
where python >nul 2>nul
if not errorlevel 1 (
  python launch.py %*
  goto finished
)
echo Python was not found. Install Python 3.10+ from https://www.python.org/downloads/
echo Enable "Add python.exe to PATH", then run this file again.
:finished
pause
