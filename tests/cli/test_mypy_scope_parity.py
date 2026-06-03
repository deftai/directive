"""Regression tests for #1475 -- local `task check` mypy scope parity with CI.

The CI Python job runs `mypy tests/` (.github/workflows/ci.yml). Before #1475
the local pre-commit gate `core:lint` (tasks/core.yml, run via `task check`)
only ran `mypy run.py`, so a type error under tests/ passed locally and only
reddened master after merge. These tests pin two invariants:

1. core:lint's mypy invocation covers the tests/ tree (scope parity with CI).
2. A deliberately introduced type error in a tests/-scoped module makes mypy
   FAIL (non-zero exit) under the project's pyproject.toml config -- i.e. the
   broadened gate fails rather than advises.

Refs https://github.com/deftai/directive/issues/1475.
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


def _mypy_invocations(text: str) -> list[str]:
    """Return non-comment lines that invoke mypy (`run mypy ...`)."""
    return [
        line.strip()
        for line in text.splitlines()
        if "run mypy" in line and not line.strip().startswith("#")
    ]


def _targets_tests_tree(invocation: str) -> bool:
    """Return True only when `tests` is a positional mypy target.

    Guards against a loose substring match: ``tests`` appearing as the value of
    a flag (e.g. ``--exclude tests/``) or anywhere other than a positional
    argument must NOT count as covering the tests/ tree.
    """
    after_mypy = invocation.split(" mypy ", 1)[-1] if " mypy " in invocation else ""
    tokens = after_mypy.split()
    for index, token in enumerate(tokens):
        if token.startswith("-"):
            continue
        previous = tokens[index - 1] if index > 0 else ""
        if token.rstrip("/") == "tests" and not previous.startswith("-"):
            return True
    return False


def test_core_lint_mypy_invocation_covers_tests_tree() -> None:
    """core:lint must run mypy over the tests/ tree to match CI (#1475)."""
    invocations = _mypy_invocations(CORE_YML.read_text(encoding="utf-8"))
    assert invocations, "core.yml must invoke mypy in the lint task"
    assert any(_targets_tests_tree(inv) for inv in invocations), (
        "core:lint mypy invocation must pass tests/ as a positional target for "
        f"CI parity (#1475); got: {invocations}"
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
