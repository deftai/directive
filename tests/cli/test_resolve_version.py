"""test_resolve_version.py -- Tests for scripts/resolve_version.py (#723).

Covers the three resolution branches:
- ``$DEFT_RELEASE_VERSION`` env override wins over git tag.
- ``git describe --tags --abbrev=0`` fallback (stripped of leading ``v``).
- ``0.0.0-dev`` fallback when neither env nor git produce a value.
- ``main()`` writes the resolved version to stdout WITHOUT a trailing newline.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module():
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "resolve_version",
        scripts_dir / "resolve_version.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["resolve_version"] = module
    spec.loader.exec_module(module)
    return module


resolve_version = _load_module()


# ---------------------------------------------------------------------------
# _from_env
# ---------------------------------------------------------------------------


class TestFromEnv:
    def test_returns_value_when_set(self, monkeypatch):
        monkeypatch.setenv("DEFT_RELEASE_VERSION", "0.21.0")
        assert resolve_version._from_env() == "0.21.0"

    def test_returns_none_when_unset(self, monkeypatch):
        monkeypatch.delenv("DEFT_RELEASE_VERSION", raising=False)
        assert resolve_version._from_env() is None

    def test_returns_none_when_empty(self, monkeypatch):
        monkeypatch.setenv("DEFT_RELEASE_VERSION", "")
        assert resolve_version._from_env() is None

    def test_strips_whitespace(self, monkeypatch):
        monkeypatch.setenv("DEFT_RELEASE_VERSION", "  0.21.0\n")
        assert resolve_version._from_env() == "0.21.0"

    def test_returns_none_on_pure_whitespace(self, monkeypatch):
        monkeypatch.setenv("DEFT_RELEASE_VERSION", "   \n")
        assert resolve_version._from_env() is None


# ---------------------------------------------------------------------------
# _from_git
# ---------------------------------------------------------------------------


class TestFromGit:
    def test_strips_leading_v(self, monkeypatch):
        def fake_run(cmd, **kwargs):
            return SimpleNamespace(stdout="v0.20.2\n", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert resolve_version._from_git() == "0.20.2"

    def test_returns_unprefixed_tag(self, monkeypatch):
        def fake_run(cmd, **kwargs):
            return SimpleNamespace(stdout="0.21.0\n", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert resolve_version._from_git() == "0.21.0"

    def test_returns_none_when_git_missing(self, monkeypatch):
        def fake_run(cmd, **kwargs):
            raise FileNotFoundError("git")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert resolve_version._from_git() is None

    def test_returns_none_on_timeout(self, monkeypatch):
        def fake_run(cmd, **kwargs):
            raise subprocess.TimeoutExpired(cmd, timeout=10)

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert resolve_version._from_git() is None

    def test_returns_none_on_nonzero_exit(self, monkeypatch):
        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout="", stderr="No names found", returncode=128
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert resolve_version._from_git() is None

    def test_returns_none_on_empty_stdout(self, monkeypatch):
        def fake_run(cmd, **kwargs):
            return SimpleNamespace(stdout="\n", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert resolve_version._from_git() is None

    def test_returns_none_when_only_v(self, monkeypatch):
        # Defensive: a tag that is bare "v" should not become an empty version.
        def fake_run(cmd, **kwargs):
            return SimpleNamespace(stdout="v\n", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert resolve_version._from_git() is None


# ---------------------------------------------------------------------------
# resolve_version (priority chain)
# ---------------------------------------------------------------------------


class TestResolveVersion:
    def test_env_wins_over_git(self, monkeypatch):
        monkeypatch.setenv("DEFT_RELEASE_VERSION", "0.21.0")

        def fake_run(cmd, **kwargs):  # pragma: no cover - asserted not called
            raise AssertionError("git must not be invoked when env is set")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert resolve_version.resolve_version() == "0.21.0"

    def test_git_used_when_env_missing(self, monkeypatch):
        monkeypatch.delenv("DEFT_RELEASE_VERSION", raising=False)

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(stdout="v0.20.2\n", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert resolve_version.resolve_version() == "0.20.2"

    def test_dev_fallback_when_neither_available(self, monkeypatch):
        monkeypatch.delenv("DEFT_RELEASE_VERSION", raising=False)

        def fake_run(cmd, **kwargs):
            raise FileNotFoundError("git")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert resolve_version.resolve_version() == resolve_version.DEV_FALLBACK
        assert resolve_version.DEV_FALLBACK == "0.0.0-dev"


# ---------------------------------------------------------------------------
# main (stdout contract for go-task `sh:` capture)
# ---------------------------------------------------------------------------


class TestMain:
    def test_main_writes_resolved_version_without_trailing_newline(
        self, monkeypatch, capsys
    ):
        monkeypatch.setenv("DEFT_RELEASE_VERSION", "0.21.0")
        rc = resolve_version.main([])
        assert rc == 0
        captured = capsys.readouterr()
        # go-task strips trailing whitespace from `sh:` capture in any case,
        # but emitting a clean string keeps stdout identical to the value
        # callers receive when invoking resolve_version() directly.
        assert captured.out == "0.21.0"
        assert "\n" not in captured.out

    def test_main_default_is_dev_when_nothing_resolves(self, monkeypatch, capsys):
        monkeypatch.delenv("DEFT_RELEASE_VERSION", raising=False)

        def fake_run(cmd, **kwargs):
            raise FileNotFoundError("git")

        monkeypatch.setattr(subprocess, "run", fake_run)
        rc = resolve_version.main([])
        assert rc == 0
        captured = capsys.readouterr()
        assert captured.out == "0.0.0-dev"


# ---------------------------------------------------------------------------
# Regression: subprocess smoke test (only runs when python is on PATH)
# ---------------------------------------------------------------------------


class TestSubprocessSmoke:
    def test_subprocess_invocation_with_env_override(self, monkeypatch):
        # Run the script as a real subprocess to exercise the
        # ``if __name__ == \"__main__\"`` guard and the os.environ path.
        env_override = "0.99.0"
        result = subprocess.run(
            [sys.executable, str(REPO_ROOT / "scripts" / "resolve_version.py")],
            capture_output=True,
            text=True,
            env={**__import__("os").environ, "DEFT_RELEASE_VERSION": env_override},
            check=False,
        )
        assert result.returncode == 0
        assert result.stdout == env_override
