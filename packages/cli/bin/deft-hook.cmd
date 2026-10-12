@ECHO off
REM PATH shim for deft-hook (AC3.5). npm installs this beside bin/deft-hook on Windows.
SET "DEFT_LAUNCHER_MODE=hook"
node "%~dp0..\dist\bin.js" %*
