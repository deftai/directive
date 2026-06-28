"""Tests for scripts/verify_hooks_installed.py (#1463 / #2049).

Covers the hardened, three-state ``verify:hooks-installed`` health check that
replaces the old ``core.hooksPath == .githooks`` string compare (which produced
a FALSE GREEN in vendored consumer projects):

- exit 0 -- hooks installed AND functional (deft CLI dispatch, no scripts/ required).
- exit 1 -- not installed, OR wired-but-non-functional.
- exit 2 -- config error (project root missing, git unavailable).

``_configured_hooks_path`` is monkeypatched per test so we drive the
core.hooksPath value deterministically without leaving real ``.git`` dirs in
pytest's ``tmp_path`` (the Windows cleanup-race concern from #281).
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "verify_hooks_installed.py"

DEFT_PRE_COMMIT = """#!/usr/bin/env sh
deft verify:branch --project-root "$REPO_ROOT"
deft verify:encoding --staged --project-root "$REPO_ROOT"
deft verify:vbrief-conformance --staged --project-root "$REPO_ROOT"
"""

DEFT_PRE_PUSH = """#!/usr/bin/env sh
deft preflight-gh --pre-push-stdin
"""


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def gate():
    return _load_module("verify_hooks_installed", SCRIPT_PATH)


def _stub_hooks_path(monkeypatch, gate, value, error=None) -> None:
    def fake(_root: Path) -> tuple[str | None, str | None]:  # noqa: ARG001
        return value, error

    monkeypatch.setattr(gate, "_configured_hooks_path", fake)


def _make_hooks_dir(root: Path, rel: str = ".githooks") -> Path:
    hooks = root / rel
    hooks.mkdir(parents=True, exist_ok=True)
    for name, body in (("pre-commit", DEFT_PRE_COMMIT), ("pre-push", DEFT_PRE_PUSH)):
        hook = hooks / name
        hook.write_text(body, encoding="utf-8")
        hook.chmod(0o755)
    return hooks


def test_own_repo_layout_passes(gate, tmp_path, monkeypatch):
    """Directive repo layout: .githooks/ at root, no scripts/ required (#2049)."""
    _make_hooks_dir(tmp_path)
    _stub_hooks_path(monkeypatch, gate, ".githooks")
    code, msg = gate.evaluate(tmp_path)
    assert code == 0
    assert "dispatch via deft CLI" in msg


def test_vendored_layout_passes_without_scripts(gate, tmp_path, monkeypatch):
    """Python-free consumer: hooks at root, no scripts/ directory."""
    _make_hooks_dir(tmp_path)
    _stub_hooks_path(monkeypatch, gate, ".githooks")
    code, msg = gate.evaluate(tmp_path)
    assert code == 0
    assert "dispatch via deft CLI" in msg
    assert not (tmp_path / "scripts").exists()


def test_posix_executable_hooks_pass(gate, tmp_path, monkeypatch):
    """POSIX: present + executable hooks pass the #1477 exec check."""
    if os.name != "posix":
        pytest.skip("exec-bit check is POSIX-only")
    _make_hooks_dir(tmp_path)
    _stub_hooks_path(monkeypatch, gate, ".githooks")
    code, msg = gate.evaluate(tmp_path)
    assert code == 0
    assert "dispatch via deft CLI" in msg


def test_posix_non_executable_hooks_fail(gate, tmp_path, monkeypatch):
    """POSIX: present but NON-executable hooks are the #1477 inert-gate class."""
    if os.name != "posix":
        pytest.skip("exec-bit check is POSIX-only")
    hooks = tmp_path / ".githooks"
    hooks.mkdir()
    for name, body in (("pre-commit", DEFT_PRE_COMMIT), ("pre-push", DEFT_PRE_PUSH)):
        hook = hooks / name
        hook.write_text(body, encoding="utf-8")
        hook.chmod(0o644)
    _stub_hooks_path(monkeypatch, gate, ".githooks")
    code, msg = gate.evaluate(tmp_path)
    assert code == 1
    assert "not executable" in msg


def test_hooks_path_unset_is_not_installed(gate, tmp_path, monkeypatch):
    _stub_hooks_path(monkeypatch, gate, None)
    code, msg = gate.evaluate(tmp_path)
    assert code == 1
    assert "not installed" in msg


def test_wired_but_hooks_dir_missing_fails(gate, tmp_path, monkeypatch):
    _stub_hooks_path(monkeypatch, gate, ".githooks")
    code, msg = gate.evaluate(tmp_path)
    assert code == 1
    assert "NON-FUNCTIONAL" in msg
    assert "does not exist" in msg


def test_wired_but_hook_files_missing_fails(gate, tmp_path, monkeypatch):
    (tmp_path / ".githooks").mkdir()
    _stub_hooks_path(monkeypatch, gate, ".githooks")
    code, msg = gate.evaluate(tmp_path)
    assert code == 1
    assert "NON-FUNCTIONAL" in msg
    assert "pre-commit" in msg


def test_legacy_python_hooks_fail(gate, tmp_path, monkeypatch):
    hooks = _make_hooks_dir(tmp_path)
    (hooks / "pre-commit").write_text(
        "python3 scripts/preflight_branch.py\n", encoding="utf-8"
    )
    _stub_hooks_path(monkeypatch, gate, ".githooks")
    code, msg = gate.evaluate(tmp_path)
    assert code == 1
    assert "NON-FUNCTIONAL" in msg
    assert "Python scripts" in msg


def test_pre_push_verify_branch_rejected(gate, tmp_path, monkeypatch):
    hooks = _make_hooks_dir(tmp_path)
    (hooks / "pre-push").write_text(
        "deft verify:branch --project-root x\ndeft preflight-gh --pre-push-stdin\n",
        encoding="utf-8",
    )
    _stub_hooks_path(monkeypatch, gate, ".githooks")
    code, msg = gate.evaluate(tmp_path)
    assert code == 1
    assert "pre-push must not invoke verify:branch" in msg


def test_absolute_hooks_path_resolved(gate, tmp_path, monkeypatch):
    hooks = _make_hooks_dir(tmp_path, "custom-hooks")
    _stub_hooks_path(monkeypatch, gate, str(hooks))
    code, msg = gate.evaluate(tmp_path)
    assert code == 0
    assert "dispatch via deft CLI" in msg


def test_missing_project_root_is_config_error(gate, tmp_path):
    code, msg = gate.evaluate(tmp_path / "does-not-exist")
    assert code == 2
    assert "does not exist" in msg


def test_git_unavailable_is_config_error(gate, tmp_path, monkeypatch):
    _stub_hooks_path(monkeypatch, gate, None, error="git executable not found on PATH")
    code, msg = gate.evaluate(tmp_path)
    assert code == 2
    assert "cannot read core.hooksPath" in msg


def test_main_quiet_returns_code(gate, tmp_path, monkeypatch):
    _make_hooks_dir(tmp_path)
    _stub_hooks_path(monkeypatch, gate, ".githooks")
    code = gate.main(["--project-root", str(tmp_path), "--quiet"])
    assert code == 0
