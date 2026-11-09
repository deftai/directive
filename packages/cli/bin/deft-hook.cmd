@ECHO OFF
REM Windows PATH shim for deft-hook (AC3.5 / #5998). Sets mode and runs bin.js via Node.
SETLOCAL
SET "DEFT_LAUNCHER_MODE=hook"
SET "NODE_EXE=node"
WHERE node >NUL 2>&1 || SET "NODE_EXE=node.exe"
IF EXIST "%~dp0..\dist\bin.js" (
  "%NODE_EXE%" "%~dp0..\dist\bin.js" %*
  EXIT /B %ERRORLEVEL%
)
ECHO deft-hook: missing %~dp0..\dist\bin.js
EXIT /B 1
