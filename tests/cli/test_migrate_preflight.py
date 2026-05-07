"""Tests for scripts/migrate_preflight.py (#793).

Covers the agent-side environment preflight for ``task migrate:vbrief``:

- exit 0 -- all checks PASS or non-blocking WARN (e.g. dirty git tree).
- exit 1 -- at least one check FAIL (uv missing, framework migrator missing,
  framework schemas dir missing).
- exit 2 -- config error: ``--project-root`` does not exist or is not a
  directory; ``--deft-root`` ditto.

Tests drive ``migrate_preflight.evaluate`` directly (pure function) plus the
``main()`` entry point for the exit-2 paths. Subprocess + ``shutil.which`` are
patched per test so the suite is hermetic and independent of whichever ``uv``
or ``git`` happens to be installed on the host.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PREFLIGHT_PATH = REPO_ROOT / "scripts" / "migrate_preflight.py"


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def preflight():
    """Load the preflight module fresh per test session.

    Loaded once at module import; tests monkeypatch attributes per case.
    """
    return _load_module("migrate_preflight", PREFLIGHT_PATH)


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------


def _make_fake_deft_root(tmp_path: Path, *, with_migrator: bool = True,
                         with_schemas: bool = True) -> Path:
    """Build a fake deft framework checkout under ``tmp_path/deft``.

    Used by tests that need to exercise the layout check independently of
    the real repository (which always has both surfaces present).
    """
    deft_root = tmp_path / "deft"
    (deft_root / "scripts").mkdir(parents=True)
    if with_migrator:
        (deft_root / "scripts" / "migrate_vbrief.py").write_text(
            "# placeholder migrator for tests\n", encoding="utf-8"
        )
    if with_schemas:
        (deft_root / "vbrief" / "schemas").mkdir(parents=True)
    return deft_root


def _make_fake_project_root(tmp_path: Path, *, with_vbrief: bool = True) -> Path:
    project_root = tmp_path / "project"
    project_root.mkdir(parents=True)
    if with_vbrief:
        (project_root / "vbrief").mkdir()
    return project_root


@pytest.fixture()
def stub_uv_present(monkeypatch: pytest.MonkeyPatch, preflight) -> Iterator[None]:
    """Force ``shutil.which('uv')`` to report a hit."""
    monkeypatch.setattr(
        preflight.shutil,
        "which",
        lambda name: "/fake/uv" if name == "uv" else None,
    )
    yield


@pytest.fixture()
def stub_uv_missing(monkeypatch: pytest.MonkeyPatch, preflight) -> Iterator[None]:
    """Force ``shutil.which('uv')`` to report no hit."""
    monkeypatch.setattr(preflight.shutil, "which", lambda name: None)
    yield


@pytest.fixture()
def stub_git_clean(monkeypatch: pytest.MonkeyPatch, preflight) -> Iterator[None]:
    """Force ``git status --porcelain`` to report a clean tree."""

    def fake_run(*args, **kwargs):  # type: ignore[no-untyped-def]
        return subprocess.CompletedProcess(
            args=args[0] if args else [],
            returncode=0,
            stdout="",
            stderr="",
        )

    monkeypatch.setattr(preflight.subprocess, "run", fake_run)
    yield


@pytest.fixture()
def stub_git_dirty(monkeypatch: pytest.MonkeyPatch, preflight) -> Iterator[None]:
    """Force ``git status --porcelain`` to report a dirty tree."""

    def fake_run(*args, **kwargs):  # type: ignore[no-untyped-def]
        return subprocess.CompletedProcess(
            args=args[0] if args else [],
            returncode=0,
            stdout=" M README.md\n?? new-file.txt\n",
            stderr="",
        )

    monkeypatch.setattr(preflight.subprocess, "run", fake_run)
    yield


@pytest.fixture()
def stub_git_missing(monkeypatch: pytest.MonkeyPatch, preflight) -> Iterator[None]:
    """Force ``subprocess.run(['git', ...])`` to raise FileNotFoundError."""

    def fake_run(*args, **kwargs):  # type: ignore[no-untyped-def]
        raise FileNotFoundError(2, "git not found")

    monkeypatch.setattr(preflight.subprocess, "run", fake_run)
    yield


# ---------------------------------------------------------------------------
# Primitive-level tests
# ---------------------------------------------------------------------------


def test_check_uv_pass(preflight, stub_uv_present):
    result = preflight.check_uv()
    assert result.name == "uv"
    assert result.status == "PASS"


def test_check_uv_fail(preflight, stub_uv_missing):
    result = preflight.check_uv()
    assert result.name == "uv"
    assert result.status == "FAIL"
    assert "https://docs.astral.sh/uv/" in result.message


def test_check_layout_pass(preflight, tmp_path):
    deft_root = _make_fake_deft_root(tmp_path)
    project_root = _make_fake_project_root(tmp_path)
    result = preflight.check_layout(deft_root, project_root)
    assert result.status == "PASS"


def test_check_layout_warn_when_project_vbrief_missing(preflight, tmp_path):
    deft_root = _make_fake_deft_root(tmp_path)
    project_root = _make_fake_project_root(tmp_path, with_vbrief=False)
    result = preflight.check_layout(deft_root, project_root)
    assert result.status == "WARN"
    assert "greenfield" in result.message.lower()


def test_check_layout_fail_when_migrator_missing(preflight, tmp_path):
    deft_root = _make_fake_deft_root(tmp_path, with_migrator=False)
    project_root = _make_fake_project_root(tmp_path)
    result = preflight.check_layout(deft_root, project_root)
    assert result.status == "FAIL"
    assert "migrate_vbrief.py" in result.message.lower() or "migrator" in result.message.lower()


def test_check_layout_fail_when_schemas_dir_missing(preflight, tmp_path):
    deft_root = _make_fake_deft_root(tmp_path, with_schemas=False)
    project_root = _make_fake_project_root(tmp_path)
    result = preflight.check_layout(deft_root, project_root)
    assert result.status == "FAIL"
    assert "schemas" in result.message.lower()


def test_check_git_clean_pass(preflight, tmp_path, stub_git_clean):
    result = preflight.check_git_clean(tmp_path)
    assert result.status == "PASS"


def test_check_git_clean_warn_on_dirty_tree(preflight, tmp_path, stub_git_dirty):
    result = preflight.check_git_clean(tmp_path)
    assert result.status == "WARN"
    assert "--dry-run" in result.message


def test_check_git_clean_warn_on_missing_git(preflight, tmp_path, stub_git_missing):
    result = preflight.check_git_clean(tmp_path)
    assert result.status == "WARN"
    assert "git" in result.message.lower()


def test_check_git_clean_warn_on_non_git_directory(preflight, tmp_path, monkeypatch):
    """A non-zero git exit (not a repo) is reported as WARN, not FAIL."""

    def fake_run(*args, **kwargs):  # type: ignore[no-untyped-def]
        return subprocess.CompletedProcess(
            args=args[0] if args else [],
            returncode=128,
            stdout="",
            stderr="fatal: not a git repository\n",
        )

    monkeypatch.setattr(preflight.subprocess, "run", fake_run)
    result = preflight.check_git_clean(tmp_path)
    assert result.status == "WARN"
    assert "not a git repository" in result.message.lower()


# ---------------------------------------------------------------------------
# evaluate(): exit 0 / exit 1 paths
# ---------------------------------------------------------------------------


def test_evaluate_exit_0_when_all_checks_pass(
    preflight, tmp_path, stub_uv_present, stub_git_clean
):
    """Exit 0 -- ready: every check PASS."""
    deft_root = _make_fake_deft_root(tmp_path)
    project_root = _make_fake_project_root(tmp_path)
    code, results = preflight.evaluate(deft_root, project_root)
    assert code == 0
    assert {r.name for r in results} == {"uv", "layout", "git-clean"}
    assert all(r.status in {"PASS", "WARN"} for r in results)


def test_evaluate_exit_0_when_warn_only(
    preflight, tmp_path, stub_uv_present, stub_git_dirty
):
    """Dirty git tree is WARN, NOT FAIL: still exit 0."""
    deft_root = _make_fake_deft_root(tmp_path)
    project_root = _make_fake_project_root(tmp_path)
    code, results = preflight.evaluate(deft_root, project_root)
    assert code == 0
    git_check = next(r for r in results if r.name == "git-clean")
    assert git_check.status == "WARN"


def test_evaluate_exit_1_when_uv_missing(
    preflight, tmp_path, stub_uv_missing, stub_git_clean
):
    """Exit 1 -- not-ready: uv missing FAILS the gate."""
    deft_root = _make_fake_deft_root(tmp_path)
    project_root = _make_fake_project_root(tmp_path)
    code, results = preflight.evaluate(deft_root, project_root)
    assert code == 1
    uv_check = next(r for r in results if r.name == "uv")
    assert uv_check.status == "FAIL"


def test_evaluate_exit_1_when_layout_invalid(
    preflight, tmp_path, stub_uv_present, stub_git_clean
):
    """Exit 1 -- not-ready: framework migrator missing FAILS the gate."""
    deft_root = _make_fake_deft_root(tmp_path, with_migrator=False)
    project_root = _make_fake_project_root(tmp_path)
    code, results = preflight.evaluate(deft_root, project_root)
    assert code == 1
    layout_check = next(r for r in results if r.name == "layout")
    assert layout_check.status == "FAIL"


def test_evaluate_exit_1_aggregates_multiple_failures(
    preflight, tmp_path, stub_uv_missing, stub_git_clean
):
    """Multiple FAIL checks all surface; exit code is still 1."""
    deft_root = _make_fake_deft_root(tmp_path, with_migrator=False)
    project_root = _make_fake_project_root(tmp_path)
    code, results = preflight.evaluate(deft_root, project_root)
    assert code == 1
    fails = [r for r in results if r.status == "FAIL"]
    assert {r.name for r in fails} == {"uv", "layout"}


# ---------------------------------------------------------------------------
# main(): exit 2 (config error) paths
# ---------------------------------------------------------------------------


def test_main_exit_2_when_project_root_missing(preflight, tmp_path, capsys):
    """Exit 2 -- config error: ``--project-root`` doesn't exist."""
    bogus = tmp_path / "does-not-exist"
    code = preflight.main(["--project-root", str(bogus)])
    assert code == 2
    captured = capsys.readouterr()
    assert "--project-root" in captured.err
    assert "does not exist" in captured.err


def test_main_exit_2_when_project_root_is_a_file(preflight, tmp_path, capsys):
    """Exit 2 -- config error: ``--project-root`` is a file, not a directory."""
    file_path = tmp_path / "not-a-dir.txt"
    file_path.write_text("not a dir", encoding="utf-8")
    code = preflight.main(["--project-root", str(file_path)])
    assert code == 2
    captured = capsys.readouterr()
    assert "--project-root" in captured.err


def test_main_exit_2_when_deft_root_missing(preflight, tmp_path, capsys):
    """Exit 2 -- config error: ``--deft-root`` doesn't exist."""
    project_root = _make_fake_project_root(tmp_path)
    bogus_deft = tmp_path / "no-such-deft-root"
    code = preflight.main([
        "--project-root",
        str(project_root),
        "--deft-root",
        str(bogus_deft),
    ])
    assert code == 2
    captured = capsys.readouterr()
    assert "--deft-root" in captured.err


# ---------------------------------------------------------------------------
# main(): exit 0 + 1 smoke tests through the CLI surface
# ---------------------------------------------------------------------------


def test_main_exit_0_smoke(
    preflight, tmp_path, stub_uv_present, stub_git_clean, capsys
):
    """End-to-end exit 0 via ``main()`` with explicit --deft-root + --project-root."""
    deft_root = _make_fake_deft_root(tmp_path)
    project_root = _make_fake_project_root(tmp_path)
    code = preflight.main([
        "--project-root",
        str(project_root),
        "--deft-root",
        str(deft_root),
    ])
    assert code == 0
    captured = capsys.readouterr()
    assert "CHECK uv: PASS" in captured.out


def test_main_exit_1_smoke(
    preflight, tmp_path, stub_uv_missing, stub_git_clean, capsys
):
    """End-to-end exit 1 via ``main()`` -- FAIL line surfaces on stderr."""
    deft_root = _make_fake_deft_root(tmp_path)
    project_root = _make_fake_project_root(tmp_path)
    code = preflight.main([
        "--project-root",
        str(project_root),
        "--deft-root",
        str(deft_root),
    ])
    assert code == 1
    captured = capsys.readouterr()
    assert "CHECK uv: FAIL" in captured.err
    assert "migrate:preflight FAILED" in captured.err


def test_main_quiet_suppresses_pass_lines(
    preflight, tmp_path, stub_uv_present, stub_git_clean, capsys
):
    """``--quiet`` suppresses PASS lines so CI logs only show issues."""
    deft_root = _make_fake_deft_root(tmp_path)
    project_root = _make_fake_project_root(tmp_path)
    code = preflight.main([
        "--project-root",
        str(project_root),
        "--deft-root",
        str(deft_root),
        "--quiet",
    ])
    assert code == 0
    captured = capsys.readouterr()
    assert "CHECK uv: PASS" not in captured.out
    assert "CHECK uv: PASS" not in captured.err
