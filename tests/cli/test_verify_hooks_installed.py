"""Tests for scripts/verify_hooks_installed.py (#1463).

Covers the hardened, three-state ``verify:hooks-installed`` health check that
replaces the old ``core.hooksPath == .githooks`` string compare (which produced
a FALSE GREEN in vendored consumer projects):

- exit 0 -- hooks installed AND functional (own-repo + vendored layouts).
- exit 1 -- not installed, OR wired-but-non-functional (the #1463 false-green
  class: core.hooksPath set but the hooks dir / hooks / gate scripts missing).
- exit 2 -- config error (project root missing, git unavailable).

``_configured_hooks_path`` is monkeypatched per test so we drive the
core.hooksPath value deterministically without leaving real ``.git`` dirs in
pytest's ``tmp_path`` (the Windows cleanup-race concern from #281).
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "verify_hooks_installed.py"


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
    """Force ``_configured_hooks_path`` to return a deterministic result."""

    def fake(_root: Path) -> tuple[str | None, str | None]:  # noqa: ARG001
        return value, error

    monkeypatch.setattr(gate, "_configured_hooks_path", fake)


def _make_hooks_dir(root: Path, rel: str = ".githooks") -> Path:
    hooks = root / rel
    hooks.mkdir(parents=True, exist_ok=True)
    for name in ("pre-commit", "pre-push"):
        (hooks / name).write_text("#!/usr/bin/env sh\nexit 0\n", encoding="utf-8")
    return hooks


def _make_scripts_dir(root: Path, rel: str) -> Path:
    scripts = root / Path(rel)
    scripts.mkdir(parents=True, exist_ok=True)
    for name in ("preflight_branch.py", "verify_encoding.py", "preflight_gh.py"):
        (scripts / name).write_text("# gate\n", encoding="utf-8")
    return scripts


def test_own_repo_layout_passes(gate, tmp_path, monkeypatch):
    """Directive repo layout: .githooks/ + scripts/ both at the root."""
    _make_hooks_dir(tmp_path)
    _make_scripts_dir(tmp_path, "scripts")
    _stub_hooks_path(monkeypatch, gate, ".githooks")
    code, msg = gate.evaluate(tmp_path)
    assert code == 0
    assert "installed and functional" in msg


def test_vendored_layout_passes(gate, tmp_path, monkeypatch):
    """Vendored consumer: root .githooks/ wired, gate scripts under .deft/core/scripts/."""
    _make_hooks_dir(tmp_path)
    _make_scripts_dir(tmp_path, ".deft/core/scripts")
    _stub_hooks_path(monkeypatch, gate, ".githooks")
    code, msg = gate.evaluate(tmp_path)
    assert code == 0
    assert "installed and functional" in msg


def test_hooks_path_unset_is_not_installed(gate, tmp_path, monkeypatch):
    _stub_hooks_path(monkeypatch, gate, None)
    code, msg = gate.evaluate(tmp_path)
    assert code == 1
    assert "not installed" in msg


def test_wired_but_hooks_dir_missing_fails(gate, tmp_path, monkeypatch):
    """The #1463 false-green: core.hooksPath set but the directory does not exist."""
    # No .githooks/ created at the root.
    _make_scripts_dir(tmp_path, ".deft/core/scripts")
    _stub_hooks_path(monkeypatch, gate, ".githooks")
    code, msg = gate.evaluate(tmp_path)
    assert code == 1
    assert "NON-FUNCTIONAL" in msg
    assert "does not exist" in msg


def test_wired_but_hook_files_missing_fails(gate, tmp_path, monkeypatch):
    """Hooks dir exists but pre-commit / pre-push are absent."""
    (tmp_path / ".githooks").mkdir()
    _make_scripts_dir(tmp_path, ".deft/core/scripts")
    _stub_hooks_path(monkeypatch, gate, ".githooks")
    code, msg = gate.evaluate(tmp_path)
    assert code == 1
    assert "NON-FUNCTIONAL" in msg
    assert "pre-commit" in msg


def test_wired_but_gate_scripts_unresolvable_fails(gate, tmp_path, monkeypatch):
    """Hooks present but NO scripts dir in any known layout -- the core #1463 bug."""
    _make_hooks_dir(tmp_path)
    # No scripts/, .deft/core/scripts/, or deft/scripts/ created.
    _stub_hooks_path(monkeypatch, gate, ".githooks")
    code, msg = gate.evaluate(tmp_path)
    assert code == 1
    assert "NON-FUNCTIONAL" in msg
    assert "gate scripts cannot be" in msg


def test_wired_but_partial_scripts_dir_fails(gate, tmp_path, monkeypatch):
    """Scripts dir resolves via the probe but a referenced gate script is missing."""
    _make_hooks_dir(tmp_path)
    scripts = tmp_path / ".deft" / "core" / "scripts"
    scripts.mkdir(parents=True)
    # Only the probe script exists; verify_encoding.py / preflight_gh.py are absent.
    (scripts / "preflight_branch.py").write_text("# gate\n", encoding="utf-8")
    _stub_hooks_path(monkeypatch, gate, ".githooks")
    code, msg = gate.evaluate(tmp_path)
    assert code == 1
    assert "NON-FUNCTIONAL" in msg
    assert "verify_encoding.py" in msg


def test_absolute_hooks_path_resolved(gate, tmp_path, monkeypatch):
    """An absolute core.hooksPath is honored verbatim (not joined to the root)."""
    hooks = _make_hooks_dir(tmp_path, "custom-hooks")
    _make_scripts_dir(tmp_path, "scripts")
    _stub_hooks_path(monkeypatch, gate, str(hooks))
    code, msg = gate.evaluate(tmp_path)
    assert code == 0
    assert "installed and functional" in msg


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
    """main() resolves --project-root and honors --quiet (smoke)."""
    _make_hooks_dir(tmp_path)
    _make_scripts_dir(tmp_path, "scripts")
    _stub_hooks_path(monkeypatch, gate, ".githooks")
    code = gate.main(["--project-root", str(tmp_path), "--quiet"])
    assert code == 0
