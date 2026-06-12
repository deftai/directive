# Lifecycle Taskfile Exit Smoke

Issue #1053 reported a Windows PowerShell 5.1 recurrence where successful lifecycle commands were observed as failures by the agent harness. This Linux worker cannot execute a live PowerShell 5.1 shell, so the checked-in regression focuses on the portable contract that failed: captured task-command success must return exit code 0 and avoid false failure markers in stdout or stderr.

The smoke in `tests/cli/test_lifecycle_task_exit_semantics.py` runs the actual command trio against an isolated fixture project:

- `task scope:promote -- vbrief/proposed/<fixture>.vbrief.json`
- `task scope:activate -- vbrief/pending/<fixture>.vbrief.json`
- `task vbrief:preflight -- vbrief/active/<fixture>.vbrief.json`

Each command is captured with explicit UTF-8 decoding and `errors="replace"`, with `PYTHONUTF8=1` matching the Taskfile's Windows-safe environment. The expected success semantics are: return code 0, a normal success message on stdout, and no captured `Traceback`, `UnicodeDecodeError`, `ERROR:`, or `Error:` marker.
