"""
Guard-rail test for #566.

Ensures that no command line in ``deft/tasks/*.yml`` uses the
``{{.TASKFILE_DIR}}/../scripts/...`` path-traversal pattern for dispatching
Python scripts.  That pattern fails on Windows under ``uv run python``
because ``{{.TASKFILE_DIR}}`` expands to a native-separator path (e.g.
``C:\\repos\\...\\deft\\tasks``) and concatenating ``/../scripts/...``
produces a mixed-separator path that Windows' path normalization collapses
incorrectly, dropping the ``deft\\`` prefix.

The canonical replacement is ``{{.DEFT_ROOT}}/scripts/...`` where
``DEFT_ROOT`` is defined at the root ``deft/Taskfile.yml`` level and
captures ``{{.TASKFILE_DIR}}`` once at the correct scope.  That path is
traversal-free and tolerates being quoted for parent-directory-with-spaces
cases.

See:
  - deftai/directive#566 -- root bug
  - deft/Taskfile.yml -- DEFT_ROOT definition
  - deft/tasks/*.yml -- call sites
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
TASKS_DIR = REPO_ROOT / "tasks"

# Match the exact anti-pattern in a command line.  Deliberately permissive
# about surrounding whitespace and alternative casing of ``TASKFILE_DIR``
# but tightly scoped to ``/..`` traversal -- legitimate ``{{.TASKFILE_DIR}}``
# uses that do NOT traverse upward are allowed (e.g. a task operating on
# its own sibling fixtures).
_ANTIPATTERN_CMD = re.compile(
    r"^\s*-\s+.*\{\{\s*\.TASKFILE_DIR\s*\}\}/\.\.",
    re.MULTILINE,
)

# Secondary pattern: catches the fragment anywhere in a command line even if
# the exact shape above drifts (e.g. wrapped quoting).  Used for an
# informational assertion -- failure here is still a defect.
_ANTIPATTERN_FRAGMENT = re.compile(
    r"\{\{\s*\.TASKFILE_DIR\s*\}\}[\\/]\.\.",
)


def _task_yaml_files() -> list[Path]:
    return sorted(TASKS_DIR.glob("*.yml")) + sorted(TASKS_DIR.glob("*.yaml"))


@pytest.mark.parametrize("taskfile", _task_yaml_files(), ids=lambda p: p.name)
def test_no_taskfile_dir_traversal_in_command_lines(taskfile: Path) -> None:
    """Every ``cmds:`` entry must resolve scripts via DEFT_ROOT, not
    TASKFILE_DIR/.. -- see #566."""
    text = taskfile.read_text(encoding="utf-8")
    matches = []
    # Inspect only non-comment lines that look like list items under cmds:.
    for lineno, line in enumerate(text.splitlines(), start=1):
        stripped = line.lstrip()
        if stripped.startswith("#"):
            continue
        if _ANTIPATTERN_CMD.match(line):
            matches.append((lineno, line.rstrip()))
    assert not matches, (
        f"{taskfile.relative_to(REPO_ROOT)} contains forbidden "
        f"{{{{.TASKFILE_DIR}}}}/.. traversal in command lines (replace with "
        f"{{{{.DEFT_ROOT}}}} -- see #566):\n"
        + "\n".join(f"  line {ln}: {text}" for ln, text in matches)
    )


# Matches `DEFT_ROOT: '{{joinPath .TASKFILE_DIR ".."}}'` with flexible
# whitespace/quoting around the template -- the inner template must use
# joinPath (eager, filepath.Clean-normalized) rather than a bare
# {{.TASKFILE_DIR}}/.. concatenation.
_DEFT_ROOT_JOINPATH = re.compile(
    r"""^\s*DEFT_ROOT\s*:\s*['\"]?
        \{\{\s*joinPath\s+\.TASKFILE_DIR\s+"\.\."\s*\}\}
        ['\"]?\s*$""",
    re.MULTILINE | re.VERBOSE,
)

# Subfiles that dispatch scripts via {{.DEFT_ROOT}} -- each must define its
# own DEFT_ROOT via joinPath so the path resolves to the deft/ root
# regardless of include-scope var re-evaluation.
_SUBFILES_USING_DEFT_ROOT = sorted(
    {
        p.name
        for p in _task_yaml_files()
        if re.search(r"\{\{\s*\.DEFT_ROOT\s*\}\}", p.read_text(encoding="utf-8"))
    }
)


@pytest.mark.parametrize("subfile_name", _SUBFILES_USING_DEFT_ROOT)
def test_deft_root_var_defined_via_joinpath(subfile_name: str) -> None:
    """Every sub-taskfile that references DEFT_ROOT must define it via
    joinPath (eager, filepath.Clean-normalized). Relying on the root
    Taskfile's `{{.TASKFILE_DIR}}` does not work because go-task
    re-evaluates var templates at use site in included subfiles, where
    TASKFILE_DIR points at the subfile's own directory (#566)."""
    subfile = TASKS_DIR / subfile_name
    text = subfile.read_text(encoding="utf-8")
    assert _DEFT_ROOT_JOINPATH.search(text), (
        f"{subfile.relative_to(REPO_ROOT)} references {{{{.DEFT_ROOT}}}} but "
        f"does not define it via `DEFT_ROOT: '{{{{joinPath .TASKFILE_DIR \"..\"}}}}'` "
        f"in its top-level `vars:` block (#566)."
    )
