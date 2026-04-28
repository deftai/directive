"""test_release_publish.py -- Tests for scripts/release_publish.py (#716).

Covers the four-state machine + the post-edit verification step:

- view_release: returns "draft" / "published" / "not-found" / "gh-error"
- edit_release_publish: invokes `gh release edit --draft=false`
- run_publish: dry-run (no gh calls), happy path (draft -> published),
  draft-not-found refusal (exit 1), already-published no-op (exit 0),
  gh failure on view (exit 1), gh failure on edit (exit 1),
  post-edit verification mismatch (exit 1)
- main: invalid version exits 2, --help exits 0

Refs #716, #74.
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module():
    """Load scripts/release_publish.py in-process, alongside release.py."""
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    # Ensure release is loaded first (release_publish imports it).
    if "release" not in sys.modules:
        spec_r = importlib.util.spec_from_file_location(
            "release", scripts_dir / "release.py"
        )
        assert spec_r is not None and spec_r.loader is not None
        mod_r = importlib.util.module_from_spec(spec_r)
        sys.modules["release"] = mod_r
        spec_r.loader.exec_module(mod_r)
    spec = importlib.util.spec_from_file_location(
        "release_publish",
        scripts_dir / "release_publish.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["release_publish"] = module
    spec.loader.exec_module(module)
    return module


release_publish = _load_module()


# ---------------------------------------------------------------------------
# view_release
# ---------------------------------------------------------------------------


class TestViewRelease:
    def test_draft_state(self, monkeypatch):
        payload = {
            "isDraft": True,
            "name": "v0.21.0",
            "tagName": "v0.21.0",
            "url": "https://github.com/deftai/directive/releases/tag/v0.21.0",
        }

        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout=json.dumps(payload), stderr="", returncode=0
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        state, body, reason = release_publish.view_release(
            "0.21.0", "deftai/directive"
        )
        assert state == "draft"
        assert body is not None and body["isDraft"] is True
        assert reason == ""

    def test_published_state(self, monkeypatch):
        payload = {
            "isDraft": False,
            "name": "v0.21.0",
            "tagName": "v0.21.0",
            "url": "https://github.com/deftai/directive/releases/tag/v0.21.0",
        }

        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout=json.dumps(payload), stderr="", returncode=0
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        state, body, reason = release_publish.view_release(
            "0.21.0", "deftai/directive"
        )
        assert state == "published"
        assert body is not None and body["isDraft"] is False

    def test_not_found(self, monkeypatch):
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout="",
                stderr="release not found",
                returncode=1,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        state, body, reason = release_publish.view_release(
            "9.9.9", "deftai/directive"
        )
        assert state == "not-found"
        assert body is None
        assert "not found" in reason

    def test_gh_error_other_than_not_found(self, monkeypatch):
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout="",
                stderr="auth required",
                returncode=4,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        state, body, reason = release_publish.view_release(
            "0.21.0", "deftai/directive"
        )
        assert state == "gh-error"
        assert "auth required" in reason

    def test_gh_missing_returns_gh_error(self, monkeypatch):
        monkeypatch.setattr(release_publish.shutil, "which", lambda _: None)
        state, _body, reason = release_publish.view_release(
            "0.21.0", "deftai/directive"
        )
        assert state == "gh-error"
        assert "gh CLI not found" in reason

    def test_non_json_response_returns_gh_error(self, monkeypatch):
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout="not json", stderr="", returncode=0
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        state, _body, reason = release_publish.view_release(
            "0.21.0", "deftai/directive"
        )
        assert state == "gh-error"
        assert "non-JSON" in reason


# ---------------------------------------------------------------------------
# edit_release_publish
# ---------------------------------------------------------------------------


class TestEditReleasePublish:
    def test_happy_invokes_draft_false(self, monkeypatch):
        captured = {}

        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            return SimpleNamespace(stdout="", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release_publish.edit_release_publish(
            "0.21.0", "deftai/directive"
        )
        assert ok is True
        assert "flipped v0.21.0" in reason
        assert "--draft=false" in captured["cmd"]
        assert "v0.21.0" in captured["cmd"]
        assert "deftai/directive" in captured["cmd"]

    def test_failure_returns_false(self, monkeypatch):
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout="", stderr="permission denied", returncode=1
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release_publish.edit_release_publish(
            "0.21.0", "deftai/directive"
        )
        assert ok is False
        assert "permission denied" in reason


# ---------------------------------------------------------------------------
# run_publish
# ---------------------------------------------------------------------------


def _make_config(**overrides):
    defaults = {
        "version": "0.21.0",
        "repo": "deftai/directive",
        "project_root": Path("."),
        "dry_run": False,
    }
    defaults.update(overrides)
    return release_publish.PublishConfig(**defaults)


class TestRunPublish:
    def test_dry_run_invokes_no_gh(self, monkeypatch, capsys):
        def boom(*_a, **_kw):  # pragma: no cover - asserted not called
            raise AssertionError("gh helpers must not run in dry-run mode")

        monkeypatch.setattr(release_publish, "view_release", boom)
        monkeypatch.setattr(release_publish, "edit_release_publish", boom)
        rc = release_publish.run_publish(_make_config(dry_run=True))
        assert rc == release_publish.EXIT_OK
        captured = capsys.readouterr()
        assert "DRYRUN" in captured.err
        assert "release view" in captured.err
        assert "release edit" in captured.err

    def test_happy_path_draft_to_published(self, monkeypatch, capsys):
        sequence = iter(
            [
                ("draft", {"url": "https://example.com/r"}, ""),
                ("published", {"url": "https://example.com/r"}, ""),
            ]
        )

        monkeypatch.setattr(
            release_publish, "view_release",
            lambda version, repo: next(sequence),
        )
        monkeypatch.setattr(
            release_publish,
            "edit_release_publish",
            lambda version, repo: (True, f"flipped v{version} to published"),
        )
        rc = release_publish.run_publish(_make_config())
        assert rc == release_publish.EXIT_OK
        captured = capsys.readouterr()
        assert "draft found" in captured.err
        assert "is now public" in captured.err

    def test_draft_not_found_refusal(self, monkeypatch, capsys):
        monkeypatch.setattr(
            release_publish,
            "view_release",
            lambda version, repo: ("not-found", None, "release not found"),
        )

        def boom_edit(*_a, **_kw):  # pragma: no cover
            raise AssertionError(
                "edit_release_publish must not be called when release is missing"
            )

        monkeypatch.setattr(release_publish, "edit_release_publish", boom_edit)
        rc = release_publish.run_publish(_make_config())
        assert rc == release_publish.EXIT_VIOLATION
        captured = capsys.readouterr()
        assert "not found" in captured.err

    def test_already_published_no_op(self, monkeypatch, capsys):
        monkeypatch.setattr(
            release_publish,
            "view_release",
            lambda version, repo: (
                "published",
                {"url": "https://example.com/r"},
                "",
            ),
        )

        def boom_edit(*_a, **_kw):  # pragma: no cover
            raise AssertionError(
                "edit_release_publish must not be called when already published "
                "(idempotent no-op)"
            )

        monkeypatch.setattr(release_publish, "edit_release_publish", boom_edit)
        rc = release_publish.run_publish(_make_config())
        assert rc == release_publish.EXIT_OK
        captured = capsys.readouterr()
        assert "NOOP" in captured.err
        assert "already published" in captured.err

    def test_gh_failure_on_view_exits_violation(self, monkeypatch, capsys):
        monkeypatch.setattr(
            release_publish,
            "view_release",
            lambda version, repo: ("gh-error", None, "auth required"),
        )

        def boom_edit(*_a, **_kw):  # pragma: no cover
            raise AssertionError("edit_release_publish must not be called on gh-error")

        monkeypatch.setattr(release_publish, "edit_release_publish", boom_edit)
        rc = release_publish.run_publish(_make_config())
        assert rc == release_publish.EXIT_VIOLATION
        captured = capsys.readouterr()
        assert "auth required" in captured.err

    def test_gh_failure_on_edit_exits_violation(self, monkeypatch, capsys):
        monkeypatch.setattr(
            release_publish,
            "view_release",
            lambda version, repo: ("draft", {"url": "https://example.com/r"}, ""),
        )
        monkeypatch.setattr(
            release_publish,
            "edit_release_publish",
            lambda version, repo: (False, "gh release edit failed: 404"),
        )
        rc = release_publish.run_publish(_make_config())
        assert rc == release_publish.EXIT_VIOLATION
        captured = capsys.readouterr()
        assert "gh release edit failed" in captured.err

    def test_post_edit_verification_mismatch_exits_violation(
        self, monkeypatch, capsys
    ):
        # First view returns draft (proceed), edit succeeds, second view
        # still reports draft (verification mismatch) -> exit 1.
        sequence = iter(
            [
                ("draft", {"url": "https://example.com/r"}, ""),
                ("draft", {"url": "https://example.com/r"}, ""),
            ]
        )

        monkeypatch.setattr(
            release_publish,
            "view_release",
            lambda version, repo: next(sequence),
        )
        monkeypatch.setattr(
            release_publish,
            "edit_release_publish",
            lambda version, repo: (True, "flipped (apparently)"),
        )
        rc = release_publish.run_publish(_make_config())
        assert rc == release_publish.EXIT_VIOLATION
        captured = capsys.readouterr()
        assert "post-edit state is 'draft'" in captured.err


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


class TestMain:
    def test_invalid_version_exits_2(self, capsys):
        rc = release_publish.main(["not-a-version"])
        assert rc == release_publish.EXIT_CONFIG_ERROR
        captured = capsys.readouterr()
        assert "Invalid version" in captured.err

    def test_help_exits_0(self):
        with pytest.raises(SystemExit) as exc:
            release_publish.main(["--help"])
        assert exc.value.code == 0

    def test_dry_run_via_main(self, monkeypatch, tmp_path):
        captured = {}

        def fake_run_publish(config):
            captured["config"] = config
            return release_publish.EXIT_OK

        monkeypatch.setattr(release_publish, "run_publish", fake_run_publish)
        rc = release_publish.main(
            [
                "0.21.0",
                "--dry-run",
                "--repo",
                "deftai/directive",
                "--project-root",
                str(tmp_path),
            ]
        )
        assert rc == release_publish.EXIT_OK
        assert captured["config"].dry_run is True
        assert captured["config"].repo == "deftai/directive"
        assert captured["config"].version == "0.21.0"


# ---------------------------------------------------------------------------
# Subprocess smoke
# ---------------------------------------------------------------------------


class TestSubprocessSmoke:
    def test_help_via_subprocess(self):
        if shutil.which("python") is None:
            pytest.skip("python not on PATH")
        result = subprocess.run(
            [
                sys.executable,
                str(REPO_ROOT / "scripts" / "release_publish.py"),
                "--help",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0
        assert "release_publish" in result.stdout
        assert "--dry-run" in result.stdout
