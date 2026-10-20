@ECHO OFF
REM Windows PATH shim for deft-hook (AC3.5). npm may not auto-pick this file when
REM bin points at the POSIX script; keep beside bin/deft-hook for manual/global use
REM and for package managers that install sibling .cmd. Sets mode and runs bin.js.
SET DEFT_LAUNCHER_MODE=hook
NODE_EXE=node
WHERE node >NUL 2>&1 || SET NODE_EXE=node.exe
"%~dp0..\dist\bin.js" 2>NUL
IF EXIST "%~dp0..\dist\bin.js" (
  %NODE_EXE% "%~dp0..\dist\bin.js" %*
  EXIT /B %ERRORLEVEL%
)
ECHO deft-hook: missing %~dp0..\dist\bin.js
EXIT /B 1
