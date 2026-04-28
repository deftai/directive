"""test_release_subprocess_path.py -- Tests for the #721 Windows PATHEXT fix.

Coverage:
- ``release._resolve_gh`` returns ``shutil.which("gh")`` (delegation contract).
- ``release._resolve_gh`` returns ``None`` when ``gh`` is not on PATH; downstream
  callers in all four release scripts surface the canonical
  ``"gh CLI not found on PATH"`` reason.
- Every gh subprocess call site in scripts/release.py /
  scripts/release_publish.py / scripts/release_rollback.py /
  scripts/release_e2e.py invokes ``subprocess.run`` with
  ``argv[0] == <resolved absolute path>`` (NOT bare ``"gh"``).
- Every gh subprocess call site propagates ``env=os.environ.copy()`` so the
  child process inherits the operator's PATH (defense in depth on top of the
  resolved-absolute-path fix).
- The Windows-specific ``gh.cmd`` PATHEXT case: when ``shutil.which`` returns
  ``r"C:\\Program Files\\GitHub CLI\\gh.cmd"``, the resolved value is used
  verbatim as ``argv[0]`` (the whole point of the fix -- bare ``"gh"`` would
  miss PATHEXT lookups in ``CreateProcess`` while ``gh.cmd`` resolves
  correctly).

Refs #721 (this fix), #74 (release pipeline foundation),
#716 (release safety hardening; introduced the publish/rollback/e2e
companions which inherited the same defect).
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_release_modules():
    """Load scripts/release.py and the three sibling scripts in-process.

    Mirrors the loader used by tests/cli/test_release*.py so this module's
    monkeypatching targets the same module objects (``release``,
    ``release_publish``, ``release_rollback``, ``release_e2e``) the
    sibling tests register.
    """
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))

    def _load(name: str):
        if name in sys.modules:
            return sys.modules[name]
        spec = importlib.util.spec_from_file_location(
            name, scripts_dir / f"{name}.py"
        )
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        return module

    release = _load("release")
    release_publish = _load("release_publish")
    release_rollback = _load("release_rollback")
    release_e2e = _load("release_e2e")
    return release, release_publish, release_rollback, release_e2e


release, release_publish, release_rollback, release_e2e = _load_release_modules()


# ---------------------------------------------------------------------------
# _resolve_gh
# ---------------------------------------------------------------------------


class TestResolveGh:
    def test_resolve_gh_returns_shutil_which_result(self, monkeypatch):
        """Helper delegates to shutil.which so PATHEXT is honored on Windows."""
        sentinel = "/usr/local/bin/gh"
        monkeypatch.setattr(
            release.shutil,
            "which",
            lambda name: sentinel if name == "gh" else None,
        )
        assert release._resolve_gh() == sentinel

    def test_resolve_gh_returns_none_when_missing(self, monkeypatch):
        """``None`` from shutil.which propagates so callers can surface the canonical error."""
        monkeypatch.setattr(release.shutil, "which", lambda _name: None)
        assert release._resolve_gh() is None


# ---------------------------------------------------------------------------
# Missing-binary fallback: every gh caller in the four scripts MUST surface the
# canonical "gh CLI not found on PATH" reason when _resolve_gh returns None.
# ---------------------------------------------------------------------------


class TestMissingBinaryFallback:
    @pytest.fixture(autouse=True)
    def _patch_which_none(self, monkeypatch):
        monkeypatch.setattr(release.shutil, "which", lambda _name: None)

    def _no_subprocess(self, monkeypatch):
        def boom(*_a, **_kw):  # pragma: no cover - asserted not called
            raise AssertionError(
                "subprocess.run must NOT be invoked when gh is missing"
            )

        monkeypatch.setattr(subprocess, "run", boom)

    def test_release_create_github_release_surfaces_canonical_reason(self, monkeypatch, tmp_path):
        self._no_subprocess(monkeypatch)
        ok, reason = release.create_github_release(
            tmp_path, "0.21.0", "deftai/directive", notes="", draft=True
        )
        assert ok is False
        assert reason == "gh CLI not found on PATH"

    def test_release_publish_view_release_surfaces_canonical_reason(self, monkeypatch):
        self._no_subprocess(monkeypatch)
        state, payload, reason = release_publish.view_release(
            "0.21.0", "deftai/directive"
        )
        assert state == "gh-error"
        assert payload is None
        assert reason == "gh CLI not found on PATH"

    def test_release_publish_edit_surfaces_canonical_reason(self, monkeypatch):
        self._no_subprocess(monkeypatch)
        ok, reason = release_publish.edit_release_publish(
            "0.21.0", "deftai/directive"
        )
        assert ok is False
        assert reason == "gh CLI not found on PATH"

    def test_release_rollback_view_json_surfaces_canonical_reason(self, monkeypatch):
        self._no_subprocess(monkeypatch)
        ok, payload, reason = release_rollback._gh_release_view_json(
            "0.21.0", "deftai/directive"
        )
        assert ok is False
        assert payload is None
        assert reason == "gh CLI not found on PATH"

    def test_release_rollback_delete_surfaces_canonical_reason(self, monkeypatch):
        self._no_subprocess(monkeypatch)
        ok, reason = release_rollback.gh_release_delete(
            "0.21.0", "deftai/directive"
        )
        assert ok is False
        assert reason == "gh CLI not found on PATH"

    def test_release_e2e_provision_surfaces_canonical_reason(self, monkeypatch):
        self._no_subprocess(monkeypatch)
        ok, reason = release_e2e.provision_temp_repo("deftai", "x")
        assert ok is False
        assert reason == "gh CLI not found on PATH"

    def test_release_e2e_destroy_surfaces_canonical_reason(self, monkeypatch):
        self._no_subprocess(monkeypatch)
        ok, reason = release_e2e.destroy_temp_repo("deftai", "x")
        assert ok is False
        assert reason == "gh CLI not found on PATH"

    def test_release_e2e_run_rehearsal_surfaces_canonical_reason(self, monkeypatch):
        self._no_subprocess(monkeypatch)
        ok, reason = release_e2e.run_rehearsal("deftai", "x")
        assert ok is False
        assert reason == "gh CLI not found on PATH"


# ---------------------------------------------------------------------------
# Resolved-path argv[0]: each helper passes the absolute path returned by
# shutil.which as argv[0], NOT the bare string "gh". This is the central fix
# for the Windows PATHEXT defect.
# ---------------------------------------------------------------------------


# Use the canonical Windows install path as the sentinel for the resolved
# absolute path. shutil.which DOES honor PATHEXT and would return this exact
# string on a real Windows host with the official GitHub CLI installer; using
# the literal here proves the fix routes the verbatim path to argv[0].
_WIN_GH_CMD = r"C:\Program Files\GitHub CLI\gh.cmd"


class TestResolvedPathArgv:
    @pytest.fixture
    def patched_which(self, monkeypatch):
        monkeypatch.setattr(release.shutil, "which", lambda _name: _WIN_GH_CMD)
        return _WIN_GH_CMD

    @staticmethod
    def _capture_subprocess(monkeypatch, *, returncode=0, stdout="{}", stderr=""):
        captured: dict = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            captured["kwargs"] = kwargs
            return SimpleNamespace(
                stdout=stdout, stderr=stderr, returncode=returncode
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        return captured

    def test_release_publish_view_uses_resolved_path(
        self, monkeypatch, patched_which
    ):
        captured = self._capture_subprocess(
            monkeypatch,
            stdout='{"isDraft":true,"name":"v0.21.0","tagName":"v0.21.0","url":"u"}',
        )
        release_publish.view_release("0.21.0", "deftai/directive")
        assert captured["cmd"][0] == patched_which
        assert captured["cmd"][0] != "gh"
        # Sanity: the rest of argv is the gh subcommand we expect, not garbage.
        assert "release" in captured["cmd"]
        assert "view" in captured["cmd"]

    def test_release_rollback_delete_uses_resolved_path(
        self, monkeypatch, patched_which
    ):
        captured = self._capture_subprocess(monkeypatch)
        release_rollback.gh_release_delete("0.21.0", "deftai/directive")
        assert captured["cmd"][0] == patched_which
        assert captured["cmd"][0] != "gh"
        assert "delete" in captured["cmd"]
        assert "--cleanup-tag" in captured["cmd"]

    def test_release_create_github_release_uses_resolved_path(
        self, monkeypatch, patched_which, tmp_path
    ):
        captured = self._capture_subprocess(monkeypatch)
        release.create_github_release(
            tmp_path, "0.21.0", "deftai/directive", notes="", draft=True
        )
        assert captured["cmd"][0] == patched_which
        assert captured["cmd"][0] != "gh"
        assert "release" in captured["cmd"]
        assert "create" in captured["cmd"]

    def test_release_e2e_provision_uses_resolved_path(
        self, monkeypatch, patched_which
    ):
        captured = self._capture_subprocess(monkeypatch)
        release_e2e.provision_temp_repo("deftai", "x")
        assert captured["cmd"][0] == patched_which
        assert captured["cmd"][0] != "gh"
        assert "repo" in captured["cmd"]
        assert "create" in captured["cmd"]


# ---------------------------------------------------------------------------
# env propagation: every gh subprocess.run gets ``env=os.environ.copy()`` so
# the child process inherits the parent's PATH and any user-set credentials
# (e.g. GH_TOKEN / GITHUB_TOKEN). This is defense-in-depth on top of the
# resolved-absolute-path fix.
# ---------------------------------------------------------------------------


class TestEnvPropagation:
    @pytest.fixture
    def patched_which(self, monkeypatch):
        monkeypatch.setattr(release.shutil, "which", lambda _name: "/usr/bin/gh")
        return "/usr/bin/gh"

    @staticmethod
    def _capture_subprocess(monkeypatch, *, returncode=0, stdout="{}", stderr=""):
        captured: dict = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            captured["kwargs"] = kwargs
            return SimpleNamespace(
                stdout=stdout, stderr=stderr, returncode=returncode
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        return captured

    def _assert_env_kwarg(self, captured: dict) -> None:
        assert "env" in captured["kwargs"], (
            "subprocess.run MUST receive an env= kwarg so the child gh "
            "process inherits the operator's PATH and credentials"
        )
        env = captured["kwargs"]["env"]
        # Equality: env MUST equal the snapshot captured at call time, which
        # in turn equals os.environ.copy() because nothing mutated os.environ
        # between fixture setup and the subprocess.run call.
        assert env == os.environ.copy()
        # The dict MUST be a copy, not the live os.environ object -- mutating
        # the env dict before subprocess.run forks should not pollute the
        # parent's environment.
        assert env is not os.environ

    def test_release_publish_view_propagates_env(
        self, monkeypatch, patched_which
    ):
        captured = self._capture_subprocess(
            monkeypatch,
            stdout='{"isDraft":false,"name":"v0.21.0","tagName":"v0.21.0","url":"u"}',
        )
        release_publish.view_release("0.21.0", "deftai/directive")
        self._assert_env_kwarg(captured)

    def test_release_publish_edit_propagates_env(
        self, monkeypatch, patched_which
    ):
        captured = self._capture_subprocess(monkeypatch)
        release_publish.edit_release_publish("0.21.0", "deftai/directive")
        self._assert_env_kwarg(captured)

    def test_release_rollback_view_json_propagates_env(
        self, monkeypatch, patched_which
    ):
        captured = self._capture_subprocess(monkeypatch)
        release_rollback._gh_release_view_json(
            "0.21.0", "deftai/directive"
        )
        self._assert_env_kwarg(captured)

    def test_release_rollback_delete_propagates_env(
        self, monkeypatch, patched_which
    ):
        captured = self._capture_subprocess(monkeypatch)
        release_rollback.gh_release_delete("0.21.0", "deftai/directive")
        self._assert_env_kwarg(captured)

    def test_release_create_github_release_propagates_env(
        self, monkeypatch, patched_which, tmp_path
    ):
        captured = self._capture_subprocess(monkeypatch)
        release.create_github_release(
            tmp_path, "0.21.0", "deftai/directive", notes="", draft=True
        )
        self._assert_env_kwarg(captured)

    def test_release_e2e_provision_propagates_env(
        self, monkeypatch, patched_which
    ):
        captured = self._capture_subprocess(monkeypatch)
        release_e2e.provision_temp_repo("deftai", "x")
        self._assert_env_kwarg(captured)

    def test_release_e2e_destroy_propagates_env(
        self, monkeypatch, patched_which
    ):
        captured = self._capture_subprocess(monkeypatch)
        release_e2e.destroy_temp_repo("deftai", "x")
        self._assert_env_kwarg(captured)

    def test_release_e2e_run_rehearsal_propagates_env(
        self, monkeypatch, patched_which
    ):
        captured = self._capture_subprocess(monkeypatch)
        release_e2e.run_rehearsal("deftai", "x")
        self._assert_env_kwarg(captured)


# ---------------------------------------------------------------------------
# Windows PATHEXT: when shutil.which returns the canonical gh.cmd path, that
# verbatim string is used as argv[0] across every gh caller. This is the bug
# #721 was filed for -- python's CreateProcess does not consult PATHEXT, so
# bare "gh" cannot find "gh.cmd"; the fix is to resolve once via shutil.which
# (which DOES honor PATHEXT) and pass the resolved path verbatim.
# ---------------------------------------------------------------------------


class TestGhCmdPathextCase:
    @pytest.fixture(autouse=True)
    def _patch_which_to_gh_cmd(self, monkeypatch):
        monkeypatch.setattr(release.shutil, "which", lambda _name: _WIN_GH_CMD)

    @staticmethod
    def _capture(monkeypatch, *, stdout="{}", returncode=0):
        captured: dict = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            captured["kwargs"] = kwargs
            return SimpleNamespace(
                stdout=stdout, stderr="", returncode=returncode
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        return captured

    def test_resolve_gh_returns_gh_cmd_verbatim(self):
        # The whole point of #721: gh.cmd is what shutil.which finds via
        # PATHEXT on Windows; release._resolve_gh must NOT mangle it.
        assert release._resolve_gh() == _WIN_GH_CMD
        assert release._resolve_gh().endswith("gh.cmd")

    def test_publish_view_passes_gh_cmd_verbatim(self, monkeypatch):
        captured = self._capture(
            monkeypatch,
            stdout='{"isDraft":true,"name":"v0.21.0","tagName":"v0.21.0","url":"u"}',
        )
        release_publish.view_release("0.21.0", "deftai/directive")
        assert captured["cmd"][0] == _WIN_GH_CMD
        # Defensive: the literal must include the .cmd extension; bare "gh"
        # would have failed the original CreateProcess lookup on Windows.
        assert captured["cmd"][0].endswith("gh.cmd")

    def test_rollback_delete_passes_gh_cmd_verbatim(self, monkeypatch):
        captured = self._capture(monkeypatch)
        release_rollback.gh_release_delete("0.21.0", "deftai/directive")
        assert captured["cmd"][0] == _WIN_GH_CMD
        assert captured["cmd"][0].endswith("gh.cmd")

    def test_create_github_release_passes_gh_cmd_verbatim(
        self, monkeypatch, tmp_path
    ):
        captured = self._capture(monkeypatch)
        release.create_github_release(
            tmp_path, "0.21.0", "deftai/directive", notes="", draft=True
        )
        assert captured["cmd"][0] == _WIN_GH_CMD
        assert captured["cmd"][0].endswith("gh.cmd")

    def test_e2e_provision_passes_gh_cmd_verbatim(self, monkeypatch):
        captured = self._capture(monkeypatch)
        release_e2e.provision_temp_repo("deftai", "x")
        assert captured["cmd"][0] == _WIN_GH_CMD
        assert captured["cmd"][0].endswith("gh.cmd")
