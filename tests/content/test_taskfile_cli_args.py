"""
Guard-rail test for #577.

Ensures that no command line in ``deft/tasks/*.yml`` wraps the
``{{.CLI_ARGS}}`` template interpolation in Taskfile-level double quotes.

go-task already shell-escapes ``CLI_ARGS`` with single quotes on its own,
so re-wrapping the interpolation in double quotes produces ``"'value'"``
at dispatch time.  On Windows with pwsh/cmd invoking ``task.exe``, nested
quotes are preserved verbatim, so the Python script's ``argv`` gets a
literal single-quote-prefixed filename (e.g.
``'.\\vbrief\\proposed\\<slug>.vbrief.json'``) that fails to open.  That
failure mode previously broke all seven ``task scope:*`` lifecycle
commands on Windows (#577).

The canonical forwarding form -- used by every other task file in
``deft/tasks/`` that forwards CLI_ARGS (``migrate.yml``, ``prd.yml``,
``issue.yml``, ``reconcile.yml``) -- is bare, unquoted
``{{.CLI_ARGS}}``.  This module enforces that convention.

Complements ``tests/content/test_taskfile_paths.py`` (added in #568 for
the #566 guard-rail).

See:
  - deftai/directive#577 -- root bug
  - deft/tasks/scope.yml -- previous offender, now compliant
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
TASKS_DIR = REPO_ROOT / "tasks"

# Match ``"{{.CLI_ARGS}}"`` -- the exact anti-pattern from #577.
# Permissive about whitespace inside the template braces and case of the
# ``CLI_ARGS`` identifier, but anchored to the double-quote characters
# immediately surrounding the interpolation so single-quoted Python
# literals (e.g. change.yml's ``'{{.CLI_ARGS}}'.strip()`` inside a
# ``uv run python -c "..."``) do not trip the check.
_DOUBLE_QUOTED_CLI_ARGS = re.compile(
    r'"\s*\{\{\s*\.CLI_ARGS\s*\}\}\s*"',
)


def _task_yaml_files() -> list[Path]:
    return sorted(TASKS_DIR.glob("*.yml")) + sorted(TASKS_DIR.glob("*.yaml"))


@pytest.mark.parametrize("taskfile", _task_yaml_files(), ids=lambda p: p.name)
def test_no_double_quoted_cli_args(taskfile: Path) -> None:
    """No command line in any tasks/*.yml may wrap ``{{.CLI_ARGS}}`` in
    Taskfile-level double quotes -- see #577.

    Inspects non-comment lines only so commentary about the anti-pattern
    (e.g. in this file's own prose or in ``tasks/scope.yml``'s header
    block) does not trip the check.
    """
    text = taskfile.read_text(encoding="utf-8")
    matches: list[tuple[int, str]] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        stripped = line.lstrip()
        if stripped.startswith("#"):
            continue
        if _DOUBLE_QUOTED_CLI_ARGS.search(line):
            matches.append((lineno, line.rstrip()))
    assert not matches, (
        f"{taskfile.relative_to(REPO_ROOT)} contains forbidden double-quote-"
        f"wrapped {{{{.CLI_ARGS}}}} interpolation (go-task shell-escapes "
        f"CLI_ARGS with single quotes; re-wrapping in double quotes yields "
        f'``"\'path\'"`` at dispatch time on Windows and breaks argv -- '
        f"see #577).  Use bare ``{{{{.CLI_ARGS}}}}`` instead:\n"
        + "\n".join(f"  line {ln}: {text}" for ln, text in matches)
    )
