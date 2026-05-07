"""
tests/cli/test_run_bat_path.py -- regression test for run.bat self-relative
resolution of the `run` Python entry point.

Issue: #791 -- run.bat:25 resolved `run` against the caller's CWD instead of
the directory of run.bat itself, breaking the documented
``..\\deft\\run upgrade`` flow on Windows whenever the caller's CWD was not
the deft repo root.

Fix: replaced ``python.exe run %*`` with ``python.exe "%~dp0run" %*``. The
``%~dp0`` expansion is the canonical Windows idiom for self-relative path
resolution -- expands to drive+path of the executing batch file with a
trailing backslash. See vbrief/active/.../791-runbat-cwd-resolution-bug.

This is a Windows-only smoke test (skipped on Linux/macOS where ``run.bat``
is irrelevant). It runs ``run.bat help`` with ``cwd`` set to a fresh
``tempfile.TemporaryDirectory`` so a regression to the bare ``run`` token
would surface as a non-zero exit (Python could not find the script
``run`` in the empty temp directory).

The ``help`` subcommand is in ``run::_UPGRADE_GATE_SKIP_COMMANDS`` so it
exits cleanly without touching project state, network, or version markers
-- ideal for a deterministic CI smoke test.

Author: Deft Directive agent -- 2026-05-03
Refs: #791
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

# Module-level repo root (matches the pattern used in tests/content/test_structure.py).
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_RUN_BAT = _REPO_ROOT / "run.bat"


def _system_python_meets_run_bat_minimum() -> bool:
    """Return True if the ``python.exe`` on PATH satisfies run.bat's >=3.13 gate.

    run.bat refuses to dispatch to ``run`` on Python <3.13 (lines 21-22) and
    instead prints the Microsoft Store upgrade message + exits 1, regardless of
    whether the launcher's CWD-vs-%~dp0 fix is correct. The smoke test below
    therefore needs the same minimum the launcher itself requires; on a CI
    host with Python <3.13 it must skip rather than spuriously fail.

    The probe is intentionally narrow: we shell out to the resolved
    ``python.exe`` (the same one ``cmd.exe`` will discover from run.bat) and
    parse its ``--version`` output. If anything goes wrong (no python on PATH,
    timeout, malformed version string), we fall back to ``False`` -- the test
    skips, which is the safe outcome.
    """
    python_exe = shutil.which("python.exe") or shutil.which("python")
    if not python_exe:
        return False
    try:
        proc = subprocess.run(
            [python_exe, "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    out = (proc.stdout or proc.stderr).strip()
    # Format: ``Python 3.13.1`` -- mirror run.bat's tokens=2 split + tokens=1,2 dot split.
    parts = out.split()
    if len(parts) < 2:
        return False
    version_parts = parts[1].split(".")
    if len(version_parts) < 2:
        return False
    try:
        major = int(version_parts[0])
        minor = int(version_parts[1])
    except ValueError:
        return False
    return (major, minor) >= (3, 13)


@pytest.mark.skipif(
    platform.system() != "Windows",
    reason="run.bat is the Windows launcher; .sh equivalent has no analogous bug",
)
@pytest.mark.skipif(
    not _system_python_meets_run_bat_minimum(),
    reason=(
        "system python.exe is <3.13; run.bat short-circuits to the Microsoft "
        "Store install fallback before reaching the %~dp0 dispatch line, so "
        "this test cannot exercise the fix on this host"
    ),
)
def test_run_bat_resolves_run_against_self_dir_from_arbitrary_cwd() -> None:
    """run.bat help must exit 0 even when invoked with cwd != deft repo root.

    Regression guard for #791. Pre-fix the launcher resolved the bare
    ``run`` token against the caller's CWD; invoking it from any
    directory other than the deft repo root caused python.exe to fail
    with ``can't open file 'run'``. Post-fix the launcher uses
    ``"%~dp0run"`` so resolution is anchored at the location of run.bat
    itself, regardless of the caller's CWD.
    """
    assert _RUN_BAT.is_file(), f"run.bat missing at {_RUN_BAT}"

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp).resolve()
        # Belt-and-suspenders: a CWD that demonstrably is NOT the deft
        # repo root (no `run` file) and is NOT a parent of the deft
        # repo root either, so the only way `python.exe run` could find
        # the script is via the absolute path expansion under test.
        assert not (tmp_path / "run").exists(), (
            "tempdir unexpectedly contains a `run` file -- test environment is unclean"
        )

        # Fresh subprocess env -- preserve PATH (so python.exe is found)
        # but force UTF-8 stdio so the child's print path is deterministic
        # on Windows (cp1252 default would not affect this test, but it
        # mirrors the project-wide convention).
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"

        # Run the launcher from the tmp dir; on the pre-fix code path
        # python.exe would emit ``can't open file 'run'`` and exit 2.
        result = subprocess.run(
            [str(_RUN_BAT), "help"],
            cwd=str(tmp_path),
            capture_output=True,
            text=True,
            timeout=60,
            env=env,
            shell=False,
        )

        assert result.returncode == 0, (
            f"run.bat help exited {result.returncode} from cwd={tmp_path!s}\n"
            f"stdout:\n{result.stdout}\n"
            f"stderr:\n{result.stderr}"
        )


@pytest.mark.skipif(
    platform.system() != "Windows",
    reason="run.bat is the Windows launcher; .sh equivalent has no analogous bug",
)
def test_run_bat_uses_self_relative_path_idiom() -> None:
    """run.bat must reference %~dp0run (not bare run) when invoking python.

    Static guard so a future edit that reverts to the bare ``run`` token
    (the #791 regression shape) fails immediately, even on a CI host
    where the subprocess smoke test above is unavailable / disabled.
    """
    text = _RUN_BAT.read_text(encoding="utf-8")
    assert '"%~dp0run"' in text, (
        "run.bat must invoke python.exe with the self-relative path "
        '"%~dp0run" so resolution is anchored at the launcher\'s '
        "directory, not the caller's CWD (#791)."
    )
    # Also assert the regression-shape line is gone (a literal bare
    # `python.exe run %*` invocation would silently re-introduce the bug).
    assert "python.exe run %*" not in text, (
        "run.bat must not invoke `python.exe run %*` -- the bare `run` "
        "token resolves against the caller's CWD on Windows (#791)."
    )
