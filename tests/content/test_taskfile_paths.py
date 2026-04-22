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
``DEFT_ROOT`` is defined per-subfile in each ``deft/tasks/*.yml`` that
dispatches a script, via ``{{joinPath .TASKFILE_DIR ".."}}``.  The
per-subfile definition is load-bearing: go-task re-evaluates var templates
at use site in included subfiles, so a root-Taskfile-level
``DEFT_ROOT: '{{.TASKFILE_DIR}}'`` would expand to the subfile's own
directory (``tasks/``) when referenced from inside a subfile, not to the
``deft/`` root.  ``joinPath`` is eager and uses Go's ``filepath.Clean``,
yielding a native-separator, ``..``-free absolute path that tolerates
being quoted for parent-directory-with-spaces cases.

This module enforces two invariants via parametrized tests:

1. ``test_no_taskfile_dir_traversal_in_command_lines`` -- no non-comment
   command line in any ``deft/tasks/*.yml`` matches
   ``{{.TASKFILE_DIR}}/..``.  Both the list-item-anchored shape and the
   looser fragment shape are checked so mixed-separator drift can't slip
   through (e.g. YAML folded/block-scalar wrapping that moves the
   fragment off its list-item line).
2. ``test_deft_root_var_defined_via_joinpath`` -- every subfile that
   references ``{{.DEFT_ROOT}}`` MUST define it in its own ``vars:`` block
   via the exact ``{{joinPath .TASKFILE_DIR ".."}}`` form (forbids a bare
   ``{{.TASKFILE_DIR}}``-style definition that would re-evaluate).

See:
  - deftai/directive#566 -- root bug
  - deft/Taskfile.yml -- why root-level DEFT_ROOT is intentionally absent
  - deft/tasks/*.yml -- per-subfile joinPath definitions and call sites
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
# its own sibling fixtures).  Anchored to ``^\s*-\s+`` so it only matches
# YAML list items (command lines under ``cmds:``), not comments or scalars.
_ANTIPATTERN_CMD = re.compile(
    r"^\s*-\s+.*\{\{\s*\.TASKFILE_DIR\s*\}\}/\.\.",
    re.MULTILINE,
)

# Broader secondary pattern: catches the fragment anywhere in a line even if
# the YAML list-item prefix is split across folded/block-scalar continuations
# or the quoting wraps it onto a subsequent line where the ``^\s*-\s+`` anchor
# of _ANTIPATTERN_CMD would miss it.  Also catches ``\..`` with a backslash
# separator instead of forward slash ([\\/] character class) so contributors
# experimenting with native-separator forms on Windows can't slip past.
_ANTIPATTERN_FRAGMENT = re.compile(
    r"\{\{\s*\.TASKFILE_DIR\s*\}\}[\\/]\.\.",
)


def _task_yaml_files() -> list[Path]:
    return sorted(TASKS_DIR.glob("*.yml")) + sorted(TASKS_DIR.glob("*.yaml"))


@pytest.mark.parametrize("taskfile", _task_yaml_files(), ids=lambda p: p.name)
def test_no_taskfile_dir_traversal_in_command_lines(taskfile: Path) -> None:
    """Every ``cmds:`` entry must resolve scripts via DEFT_ROOT, not
    TASKFILE_DIR/.. -- see #566.

    Two passes, both over non-comment content:

    1. _ANTIPATTERN_CMD: strict YAML list-item shape (``^\\s*-\\s+``) --
       catches the canonical offending form.
    2. _ANTIPATTERN_FRAGMENT: looser fragment shape -- catches
       mixed-separator variants and YAML wrapping that move the fragment
       off its list-item line.  Defense-in-depth.
    """
    text = taskfile.read_text(encoding="utf-8")
    strict_matches: list[tuple[int, str]] = []
    fragment_matches: list[tuple[int, str]] = []
    # Inspect only non-comment lines that look like list items under cmds:.
    for lineno, line in enumerate(text.splitlines(), start=1):
        stripped = line.lstrip()
        if stripped.startswith("#"):
            continue
        if _ANTIPATTERN_CMD.match(line):
            strict_matches.append((lineno, line.rstrip()))
        if _ANTIPATTERN_FRAGMENT.search(line):
            fragment_matches.append((lineno, line.rstrip()))
    matches = strict_matches or fragment_matches
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
