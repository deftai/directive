"""
Guard-rail test for #574.

Ensures that no task in ``deft/tasks/*.yml`` declares ``sources:`` or
``generates:`` while simultaneously forwarding ``{{.CLI_ARGS}}`` to a
``uv run python`` dispatched script.

Rationale (quoted from ``conventions/task-caching.md``): when both
``sources:`` and ``generates:`` are declared and every ``generates`` file
exists with an unchanged ``sources`` hash, go-task short-circuits and
skips ``cmds:`` entirely.  ``CLI_ARGS`` are never relayed because the
command is never invoked.  Script-level recovery flags (``--force`` from
the #539 refuse-to-overwrite safety check, for example) therefore never
reach the script, and the operator hits a silent
``"task: Task \"...\" is up to date"`` exit 0 while following deft's own
documented recovery instruction.

This module enforces the invariant via two tests:

1. ``test_cli_args_tasks_declare_no_caching`` -- parametrized over every
   ``deft/tasks/*.yml``.  Parses each file with PyYAML; for every task
   that (a) invokes ``uv run python`` in its ``cmds:`` AND (b) forwards
   ``{{.CLI_ARGS}}`` in the same command, asserts the task declaration
   does NOT contain ``sources:`` or ``generates:`` keys.  Failure
   message points contributors at ``deft/conventions/task-caching.md``.

2. ``test_prd_render_force_overwrites_hand_authored_prd`` -- subprocess
   regression test on a throwaway fixture project: writes a hand-authored
   ``PRD.md`` (no banner), runs ``task prd:render -- --force`` via the
   installed ``task`` binary, and asserts the file was overwritten (head
   contains ``AUTO-GENERATED``).  Skips cleanly when ``task`` is not on
   ``PATH`` (e.g. the default Python CI lane).  The Windows CI matrix
   job ``windows-task-dispatch`` exercises the same path end-to-end via
   the installed ``task`` binary.

See:
  - deftai/directive#574 -- root bug
  - deftai/directive#539 -- refuse-to-overwrite safety feature
  - deftai/directive#573 -- broader ergonomics discussion (deferred)
  - deft/conventions/task-caching.md -- canonical rule
  - deft/tasks/prd.yml -- previous offender, now compliant
  - deft/tests/content/test_taskfile_paths.py -- sibling #566 guard-rail
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
TASKS_DIR = REPO_ROOT / "tasks"
CONVENTION_PATH = "deft/conventions/task-caching.md"


def _task_yaml_files() -> list[Path]:
    return sorted(TASKS_DIR.glob("*.yml")) + sorted(TASKS_DIR.glob("*.yaml"))


# Matches the opening line of a task declaration in a ``tasks:`` block:
# ``  <name>:`` at exactly 2-space indent (go-task's canonical shape across
# this repo's taskfiles).  The captured name groups the task id.  We do not
# try to parse arbitrary YAML indents -- this codebase's taskfiles are all
# 2-space-indented, mirrored by ``tests/content/test_taskfile_paths.py``.
_TASK_HEADER = re.compile(r"^  ([A-Za-z_][\w:-]*)\s*:\s*(?:#.*)?$")

# Matches a caching key declaration at task-level indent (4 spaces).
# Requires the key to be a whole word on its own line (optionally with
# trailing comment) so comments prose or interpolations don't trip us.
_CACHING_KEY = re.compile(r"^    (sources|generates)\s*:\s*(?:#.*)?$")


def _iter_task_blocks(text: str) -> list[tuple[str, int, int]]:
    """Return ``(task_name, start_line, end_line)`` for each task block.

    ``end_line`` is exclusive.  Task blocks end at the next task header
    (line matching ``_TASK_HEADER`` at the same indent) or at end-of-file.
    """
    lines = text.splitlines()
    task_positions: list[tuple[str, int]] = []
    in_tasks_section = False
    for idx, line in enumerate(lines):
        # Track entry/exit of the top-level ``tasks:`` section -- only
        # blocks inside that section qualify as task declarations.
        if line.startswith("tasks:"):
            in_tasks_section = True
            continue
        if in_tasks_section and line and not line.startswith(" ") and line.rstrip() != "tasks:":
            in_tasks_section = False
        if not in_tasks_section:
            continue
        m = _TASK_HEADER.match(line)
        if m is None:
            continue
        task_positions.append((m.group(1), idx))
    blocks: list[tuple[str, int, int]] = []
    for i, (name, start) in enumerate(task_positions):
        end = task_positions[i + 1][1] if i + 1 < len(task_positions) else len(lines)
        blocks.append((name, start, end))
    return blocks


def _block_body(text: str, start: int, end: int) -> str:
    return "\n".join(text.splitlines()[start:end])


def _non_comment_lines(block: str) -> list[str]:
    return [ln for ln in block.splitlines() if not ln.lstrip().startswith("#")]


@pytest.mark.parametrize("taskfile", _task_yaml_files(), ids=lambda p: p.name)
def test_cli_args_tasks_declare_no_caching(taskfile: Path) -> None:
    """Every ``uv run python ... {{.CLI_ARGS}}`` task MUST NOT declare
    ``sources:`` or ``generates:`` -- see ``conventions/task-caching.md``
    and #574.

    Walks every task block under ``tasks:`` in ``tasks/*.yml`` (the repo
    uses 2-space YAML throughout) and for each task whose command lines
    contain both ``uv run python`` and ``{{.CLI_ARGS}}``, asserts the
    task declaration does NOT carry ``sources:`` / ``generates:`` at
    task-level indent.  Comment lines are ignored so explanatory prose
    in comment blocks (e.g. the block at ``tasks/prd.yml::prd:render``)
    does not trip the check.
    """
    text = taskfile.read_text(encoding="utf-8")
    blocks = _iter_task_blocks(text)
    offenders: list[str] = []
    for task_name, start, end in blocks:
        body = _block_body(text, start, end)
        non_comment = "\n".join(_non_comment_lines(body))
        forwards_cli_args = "{{.CLI_ARGS}}" in non_comment
        invokes_uv_run_python = "uv run python" in non_comment
        if not (forwards_cli_args and invokes_uv_run_python):
            continue
        bad_keys: list[str] = []
        for line in _non_comment_lines(body):
            m = _CACHING_KEY.match(line)
            if m is not None:
                bad_keys.append(m.group(1))
        if bad_keys:
            offenders.append(
                f"  {task_name}: declares {', '.join(sorted(set(bad_keys)))} "
                f"while forwarding {{{{.CLI_ARGS}}}} to a uv run python script"
            )

    assert not offenders, (
        f"{taskfile.relative_to(REPO_ROOT)}: tasks that forward "
        f"{{{{.CLI_ARGS}}}} to a `uv run python` dispatched script MUST NOT "
        f"declare `sources:` or `generates:` -- go-task would short-circuit "
        f"before `cmds:` runs, dropping CLI_ARGS and silently breaking the "
        f"#539 refuse-to-overwrite recovery path (#574).  See "
        f"{CONVENTION_PATH} for the canonical rule.\n"
        + "\n".join(offenders)
    )


# ---------------------------------------------------------------------------
# Regression test -- end-to-end via the installed ``task`` binary.
# ---------------------------------------------------------------------------


# The sentinel that prd_render.py writes into every banner line; a
# hand-authored PRD lacks this string and, post-#574, ``task prd:render
# -- --force`` must replace it with output that contains this substring.
_AUTOGEN_SENTINEL = "AUTO-GENERATED by task prd:render"


def _task_binary_available() -> bool:
    return shutil.which("task") is not None


@pytest.mark.skipif(
    not _task_binary_available(),
    reason=(
        "task binary not available on PATH -- the windows-task-dispatch "
        "CI job exercises this path end-to-end; skip on Python-only lanes."
    ),
)
def test_prd_render_force_overwrites_hand_authored_prd() -> None:
    """``task prd:render -- --force`` on a hand-authored PRD overwrites it.

    This is the concrete #574 regression test: prior to the fix,
    ``tasks/prd.yml`` declared ``sources:`` / ``generates:`` that caused
    go-task to short-circuit before ``cmds:`` ran, so ``--force`` never
    reached ``prd_render.py`` and the hand-authored ``PRD.md`` survived
    untouched.  The fix drops the caching declaration; this test
    guarantees that a hand-authored ``PRD.md`` is replaced by an
    auto-generated one when the operator follows the #539 recovery
    instruction.

    Fixture lives under ``$TMPDIR`` / ``$env:TEMP`` -- NEVER inside the
    worktree -- so the test does not collide with any worktree state
    nor trigger the Warp autonomous-agent ``rm`` denylist.
    """
    with tempfile.TemporaryDirectory(prefix="deft-prd-render-574-") as td:
        fixture = Path(td)
        (fixture / "vbrief").mkdir()
        # Minimal specification.vbrief.json with a single narrative so
        # prd_render.py has something to render.
        spec = fixture / "vbrief" / "specification.vbrief.json"
        spec.write_text(
            json.dumps(
                {
                    "vBRIEFInfo": {"version": "0.6"},
                    "plan": {
                        "title": "#574 regression fixture",
                        "status": "draft",
                        "narratives": {
                            "Overview": (
                                "Throwaway fixture asserting "
                                "task prd:render -- --force overwrites a "
                                "hand-authored PRD.md (#574)."
                            ),
                        },
                        "items": [],
                    },
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        # Hand-authored PRD -- lacks the AUTO-GENERATED banner, which is
        # exactly what triggers the #539 refuse-to-overwrite safety check
        # without --force.
        prd = fixture / "PRD.md"
        prd.write_text(
            "# Hand-authored PRD\n\nThis file was not generated by deft.\n",
            encoding="utf-8",
        )
        assert _AUTOGEN_SENTINEL not in prd.read_text(encoding="utf-8")

        # Dispatch `task prd:render -- --force` via the deft Taskfile.
        # We invoke `task -t <abs-path-to-Taskfile>` from the fixture dir
        # so USER_WORKING_DIR resolves to the fixture root, matching the
        # consumer-project shape.
        deft_taskfile = REPO_ROOT / "Taskfile.yml"
        env = os.environ.copy()
        env["PYTHONUTF8"] = "1"
        result = subprocess.run(
            [
                "task",
                "-t",
                str(deft_taskfile),
                "prd:render",
                "--",
                "--force",
            ],
            cwd=str(fixture),
            capture_output=True,
            text=True,
            timeout=60,
            env=env,
        )
        # Combined output is logged on any failure so the #574 reproduction
        # shape (``"Task \"prd:render\" is up to date"`` + exit 0 without
        # PRD.md ever being touched) is immediately obvious from the test
        # output.
        combined = (
            f"exit={result.returncode}\n"
            f"stdout=\n{result.stdout}\n"
            f"stderr=\n{result.stderr}\n"
        )
        assert result.returncode == 0, (
            f"task prd:render -- --force exited non-zero:\n{combined}"
        )
        prd_text = prd.read_text(encoding="utf-8")
        assert _AUTOGEN_SENTINEL in prd_text.splitlines()[0], (
            f"PRD.md first line does not contain {_AUTOGEN_SENTINEL!r} -- "
            f"task prd:render -- --force did NOT overwrite the hand-authored "
            f"file (regression of #574).  See {CONVENTION_PATH} for the rule.\n"
            f"first line: {prd_text.splitlines()[:1]!r}\n"
            f"{combined}"
        )


