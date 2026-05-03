@echo off
setlocal

REM Check if Python is installed
python.exe --version >nul 2>&1
if errorlevel 1 (
    echo Python is not installed or not in PATH.
    goto :install_python
)

REM Get Python version
for /f "tokens=2" %%v in ('python.exe --version 2^>^&1') do set PYTHON_VERSION=%%v

REM Extract major and minor version numbers
for /f "tokens=1,2 delims=." %%a in ("%PYTHON_VERSION%") do (
    set MAJOR=%%a
    set MINOR=%%b
)

REM Check if version is 3.13 or higher
if %MAJOR% LSS 3 goto :need_upgrade
if %MAJOR% EQU 3 if %MINOR% LSS 13 goto :need_upgrade

REM Run with all passed arguments
REM Resolve `run` against the directory of this batch file (%~dp0, trailing
REM backslash) so `..\deft\run.bat <cmd>` works from any consumer CWD; the
REM bare token resolves against the caller's CWD on Windows and broke the
REM documented `..\deft\run upgrade` flow (#791).
python.exe "%~dp0run" %*
exit /b %errorlevel%

:need_upgrade
echo Python %PYTHON_VERSION% is installed, but Python 3.13 or higher is required.

:install_python
echo.
echo Opening Microsoft Store to install Python 3.13...
start "" ms-windows-store://pdp/?ProductId=9PNRBTZXMB4Z
echo.
echo If the store did not open, please visit:
echo https://apps.microsoft.com/detail/9PNRBTZXMB4Z?hl=en-us^&gl=US^&ocid=pdpshare
echo.
pause
exit /b 1
