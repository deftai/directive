"""Regression tests for the deft self-check mypy scope (#1475) and its
vendored-consumer tolerance (#1474).

The CI Python job runs `mypy tests/` (.github/workflows/ci.yml). Before #1475
the local pre-commit gate `core:lint` (tasks/core.yml, run via `task check`)
only ran `mypy run.py`, so a type error under tests/ passed locally and only
reddened master after merge. These tests pin:

1. core:lint type-checks the tests/ tree (scope parity with CI).
2. core:lint AND core:test both tolerate a missing tests/ directory so a
   vendored consumer -- whose bundled tests/ the installer (#1482) prunes --
   does not fail `task deft:check` (#1474).
3. A deliberately introduced type error in a tests/-scoped module makes mypy
   FAIL (non-zero exit) under the project's pyproject.toml config -- i.e. the
   broadened gate fails rather than advises.

Refs https://github.com/deftai/directive/issues/1475,
https://github.com/deftai/directive/issues/1474.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CORE_YML = REPO_ROOT / "tasks" / "core.yml"
PYPROJECT = REPO_ROOT / "pyproject.toml"
CI_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "ci.yml"


def _task_block(text: str, task_name: str) -> str:
    """Return the raw YAML text of the top-level core.yml ``task_name`` block.

    The block spans from the task header to (but excluding) the next top-level
    (exactly-2-space-indented) task header, so only the requested task's body
    is inspected.
    """
    lines = text.splitlines()
    header = f"  {task_name}:"
    start = next((i for i, line in enumerate(lines) if line == header), None)
    assert start is not None, f"core.yml must define a `{task_name}` task"
    block: list[str] = []
    for line in lines[start + 1 :]:
        is_top_level_header = (
            line.startswith("  ")
            and not line.startswith("   ")
            and line.rstrip().endswith(":")
        )
        if is_top_level_header:
            break
        block.append(line)
    return "\n".join(block)


def test_core_lint_type_checks_tests_tree() -> None:
    """core:lint must type-check the tests/ tree to match CI (#1475)."""
    block = _task_block(CORE_YML.read_text(encoding="utf-8"), "lint")
    assert "mypy" in block, "core:lint must invoke mypy"
    assert "'tests'" in block, (
        "core:lint must include tests as a mypy target for CI parity (#1475); "
        f"lint block:\n{block}"
    )


def test_core_lint_and_test_tolerate_missing_tests_tree() -> None:
    """core:lint and core:test must guard a missing tests/ dir (#1474).

    The installer (#1482) prunes the vendored tests/ from a consumer deposit,
    and `task deft:check` runs BOTH core:lint and core:test, so each must build
    its target set conditionally instead of passing an absent tests/ path. This
    pins the two gates staying in lockstep so neither regresses the vendored
    consumer back to a hard failure.
    """
    core_yml = CORE_YML.read_text(encoding="utf-8")
    for task_name in ("lint", "test"):
        block = _task_block(core_yml, task_name)
        assert "Path('tests').exists()" in block, (
            f"core:{task_name} must guard the tests/ path so a vendored consumer "
            f"(no tests/) does not fail (#1474); block:\n{block}"
        )


def test_ci_workflow_runs_mypy_over_tests() -> None:
    """The CI parity anchor: CI runs `mypy tests/` (#1475).

    If CI's mypy target ever changes, this fails so the local gate in
    tasks/core.yml is reconciled in the same change.
    """
    ci_text = CI_WORKFLOW.read_text(encoding="utf-8")
    assert "mypy tests/" in ci_text, (
        "CI workflow must run `mypy tests/` -- this is the parity target the "
        "local core:lint gate mirrors (#1475)"
    )


def test_tests_override_present_in_pyproject() -> None:
    """The shared tests.* mypy override keeps local + CI rules identical (#1475)."""
    pyproject_text = PYPROJECT.read_text(encoding="utf-8")
    assert 'module = "tests.*"' in pyproject_text, (
        "pyproject.toml must carry the [[tool.mypy.overrides]] module=\"tests.*\" "
        "block so local and CI mypy share identical tests/ rules (#1475)"
    )


def test_mypy_fails_on_tests_type_error(tmp_path: Path) -> None:
    """A deliberate type error in a tests/-scoped module fails mypy (#1475).

    Proves acceptance criteria a1/a3: the broadened gate FAILS (non-zero exit)
    rather than advising. The module lives under a ``tests`` package so the
    project's ``tests.*`` override applies (disallow_untyped_defs=false) -- yet
    a real argument-type mismatch is still reported, exactly the class of error
    that previously slipped past the local gate.
    """
    pkg = tmp_path / "tests"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    bad_module = pkg / "test_deliberate_type_error_1475.py"
    bad_module.write_text(
        "def _typed_add(a: int, b: int) -> int:\n"
        "    return a + b\n"
        "\n"
        "\n"
        "# Passing str where int is required -- a real type mismatch that the\n"
        "# tests.* override does NOT relax (it only relaxes missing annotations).\n"
        "_result: int = _typed_add('not-an-int', 'also-not-an-int')\n",
        encoding="utf-8",
    )

    # Run mypy the way the gate does -- `uv run mypy` against the framework
    # project -- so the behavioral proof exercises the same interpreter and
    # mypy version tasks/core.yml selects. Fall back to the current
    # interpreter's mypy module when uv is not on PATH so the test still runs
    # in a bare environment.
    uv_bin = shutil.which("uv")
    if uv_bin is not None:
        mypy_cmd = [
            uv_bin,
            "--project",
            str(REPO_ROOT),
            "run",
            "mypy",
            "--config-file",
            str(PYPROJECT),
            str(pkg),
        ]
    else:  # fallback when uv is not on PATH
        mypy_cmd = [
            sys.executable,
            "-m",
            "mypy",
            "--config-file",
            str(PYPROJECT),
            str(pkg),
        ]
    proc = subprocess.run(
        mypy_cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=str(tmp_path),
    )

    assert proc.returncode != 0, (
        "mypy must FAIL on a deliberate tests/ type error under the project "
        f"config (#1475); exit={proc.returncode}\n"
        f"stdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
    )
    combined = (proc.stdout + proc.stderr).lower()
    assert "error:" in combined, (
        "expected mypy to report a type error on the deliberate mismatch "
        f"(#1475)\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
    )
