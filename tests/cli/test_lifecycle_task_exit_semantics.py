"""Taskfile lifecycle exit-semantics smoke coverage (#1053).

The original recurrence was observed through Windows PowerShell 5.1 capture,
where successful lifecycle transitions were reported to the harness as failures.
This test exercises the actual Taskfile wrappers from an isolated fixture project
and asserts the command trio returns success without false-failure markers in the
captured streams.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
TASKFILE = REPO_ROOT / "Taskfile.yml"
VBRIEF_NAME = "2026-06-12-lifecycle-exit-smoke.vbrief.json"


def _write_fixture_project(project_root: Path) -> None:
    shutil.copytree(
        REPO_ROOT / "scripts",
        project_root / "scripts",
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )
    vbrief_root = project_root / "vbrief"
    for folder in ("proposed", "pending", "active", "completed", "cancelled"):
        (vbrief_root / folder).mkdir(parents=True, exist_ok=True)
    (vbrief_root / "PROJECT-DEFINITION.vbrief.json").write_text(
        json.dumps(
            {
                "vBRIEFInfo": {"version": "0.6"},
                "plan": {
                    "title": "Lifecycle exit smoke fixture",
                    "status": "running",
                    "items": [],
                    "policy": {"wipCap": 10},
                },
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (vbrief_root / "proposed" / VBRIEF_NAME).write_text(
        json.dumps(
            {
                "vBRIEFInfo": {"version": "0.6"},
                "plan": {
                    "title": "Lifecycle exit smoke",
                    "status": "proposed",
                    "items": [],
                },
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def _run_task(*args: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    # Headless worker/fixture projects do not have a session-start ritual.
    env["DEFT_SESSION_RITUAL_SKIP"] = "1"
    # cwd is inherited from the (monkeypatch-chdir'd) process working directory
    # so the test exercises the auto-restoring chdir contract (#1681) rather than
    # passing an explicit subprocess cwd that would mask a stray chdir leak.
    return subprocess.run(
        ["task", "-t", str(TASKFILE), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
        env=env,
        check=False,
    )


def _assert_success_capture(result: subprocess.CompletedProcess[str], expected_stdout: str) -> None:
    combined = f"stdout=\n{result.stdout}\nstderr=\n{result.stderr}\n"
    assert result.returncode == 0, f"expected exit 0, got {result.returncode}\n{combined}"
    assert expected_stdout in result.stdout
    false_failure_markers = ("Traceback", "UnicodeDecodeError", "ERROR:", "Error:")
    for marker in false_failure_markers:
        assert marker not in combined, f"false failure marker {marker!r} in capture:\n{combined}"


@pytest.mark.skipif(shutil.which("task") is None, reason="go-task binary is not installed")
def test_lifecycle_taskfile_commands_preserve_success_exit_semantics(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Promote -> activate -> preflight succeeds through the Taskfile wrappers.

    Uses pytest's auto-restoring ``monkeypatch.chdir`` instead of a bare
    ``os.chdir`` (#1681): with ``tmp_path_retention_count=0`` pytest deletes the
    fixture directory at teardown, so an unrestored chdir would strand every
    later test in a missing working directory and cascade ``FileNotFoundError``.
    """
    original_cwd = os.getcwd()
    _write_fixture_project(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert Path(os.getcwd()) == tmp_path

    promote = _run_task(
        "scope:promote",
        "--",
        f"vbrief/proposed/{VBRIEF_NAME}",
    )
    _assert_success_capture(promote, "Promoted")
    assert (tmp_path / "vbrief" / "pending" / VBRIEF_NAME).exists()

    activate = _run_task(
        "scope:activate",
        "--",
        f"vbrief/pending/{VBRIEF_NAME}",
    )
    _assert_success_capture(activate, "Activated")
    assert (tmp_path / "vbrief" / "active" / VBRIEF_NAME).exists()

    preflight = _run_task(
        "vbrief:preflight",
        "--",
        f"vbrief/active/{VBRIEF_NAME}",
    )
    _assert_success_capture(preflight, "ready for implementation")

    # monkeypatch.chdir restores os.getcwd() to original_cwd at teardown; the
    # autouse cwd guard in tests/conftest.py asserts that restoration holds so a
    # future stray chdir cannot cascade across the session (#1681).
    assert Path(original_cwd).exists()
