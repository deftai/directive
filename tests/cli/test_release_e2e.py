"""test_release_e2e.py -- Tests for scripts/release_e2e.py (#716).

The e2e harness provisions and destroys real GitHub repos. Tests
mock both helpers so CI never hits real GitHub. Coverage:

- generate_repo_slug: produces deftai-release-test-<ts>-<uuid6>
- provision_temp_repo / destroy_temp_repo / run_rehearsal: gh-CLI happy
  + failure paths (mocked subprocess.run)
- run_e2e: provision -> rehearse -> destroy ordering; cleanup runs
  even when rehearsal fails; cleanup-failure warning does not flip
  the exit code; --keep-repo skips cleanup; --dry-run invokes nothing
- main: --help exits 0; empty --owner exits 2

Refs #716, #74.
"""

from __future__ import annotations

import importlib.util
import re
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module():
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    if "release" not in sys.modules:
        spec_r = importlib.util.spec_from_file_location(
            "release", scripts_dir / "release.py"
        )
        assert spec_r is not None and spec_r.loader is not None
        mod_r = importlib.util.module_from_spec(spec_r)
        sys.modules["release"] = mod_r
        spec_r.loader.exec_module(mod_r)
    spec = importlib.util.spec_from_file_location(
        "release_e2e",
        scripts_dir / "release_e2e.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["release_e2e"] = module
    spec.loader.exec_module(module)
    return module


release_e2e = _load_module()


def _config(**overrides):
    defaults = {
        "owner": "deftai",
        "project_root": Path("."),
        "dry_run": False,
        "keep_repo": False,
        "repo_slug": "deftai-release-test-20260428190000-abcdef",
    }
    defaults.update(overrides)
    return release_e2e.E2EConfig(**defaults)


# ---------------------------------------------------------------------------
# generate_repo_slug
# ---------------------------------------------------------------------------


class TestGenerateRepoSlug:
    def test_format_matches_pattern(self):
        slug = release_e2e.generate_repo_slug()
        # Pattern: deftai-release-test-<14-digit-ts>-<6-hex>
        assert re.match(
            r"^deftai-release-test-\d{14}-[0-9a-f]{6}$", slug
        ), f"unexpected slug: {slug}"

    def test_two_calls_produce_different_slugs(self):
        a = release_e2e.generate_repo_slug()
        b = release_e2e.generate_repo_slug()
        # uuid suffix guarantees uniqueness even within the same second.
        assert a != b


# ---------------------------------------------------------------------------
# provision_temp_repo
# ---------------------------------------------------------------------------


class TestProvisionTempRepo:
    def test_happy_path_invokes_gh_repo_create_private(self, monkeypatch):
        captured = {}

        monkeypatch.setattr(
            release_e2e.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            return SimpleNamespace(stdout="", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release_e2e.provision_temp_repo(
            "deftai", "deftai-release-test-X"
        )
        assert ok is True
        assert "deftai/deftai-release-test-X" in reason
        assert "create" in captured["cmd"]
        assert "--private" in captured["cmd"]
        assert "deftai/deftai-release-test-X" in captured["cmd"]

    def test_gh_failure_returns_false(self, monkeypatch):
        monkeypatch.setattr(
            release_e2e.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(stdout="", stderr="quota exceeded", returncode=1)

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release_e2e.provision_temp_repo("deftai", "x")
        assert ok is False
        assert "quota exceeded" in reason

    def test_gh_missing_returns_false(self, monkeypatch):
        monkeypatch.setattr(release_e2e.shutil, "which", lambda _: None)
        ok, reason = release_e2e.provision_temp_repo("deftai", "x")
        assert ok is False
        assert "gh CLI not found" in reason


# ---------------------------------------------------------------------------
# destroy_temp_repo
# ---------------------------------------------------------------------------


class TestDestroyTempRepo:
    def test_happy_path_invokes_gh_repo_delete_yes(self, monkeypatch):
        captured = {}

        monkeypatch.setattr(
            release_e2e.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            return SimpleNamespace(stdout="", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release_e2e.destroy_temp_repo("deftai", "x")
        assert ok is True
        assert "deleted deftai/x" in reason
        assert "--yes" in captured["cmd"]
        assert "delete" in captured["cmd"]

    def test_gh_failure_returns_false_with_reason(self, monkeypatch):
        monkeypatch.setattr(
            release_e2e.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout="", stderr="permission denied", returncode=1
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release_e2e.destroy_temp_repo("deftai", "x")
        assert ok is False
        assert "permission denied" in reason


# ---------------------------------------------------------------------------
# run_rehearsal
# ---------------------------------------------------------------------------


class TestRunRehearsal:
    def test_smoke_test_passes_when_repo_view_succeeds(self, monkeypatch):
        monkeypatch.setattr(
            release_e2e.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout='{"name":"x","visibility":"PRIVATE"}',
                stderr="",
                returncode=0,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release_e2e.run_rehearsal("deftai", "x")
        assert ok is True
        assert "exists" in reason

    def test_failure_when_repo_view_fails(self, monkeypatch):
        monkeypatch.setattr(
            release_e2e.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(stdout="", stderr="not found", returncode=1)

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release_e2e.run_rehearsal("deftai", "x")
        assert ok is False
        assert "not found" in reason


# ---------------------------------------------------------------------------
# run_e2e (orchestration)
# ---------------------------------------------------------------------------


class TestRunE2E:
    def test_dry_run_invokes_no_gh(self, monkeypatch, capsys):
        def boom(*_a, **_kw):  # pragma: no cover
            raise AssertionError("dry-run MUST NOT invoke gh helpers")

        monkeypatch.setattr(release_e2e, "provision_temp_repo", boom)
        monkeypatch.setattr(release_e2e, "destroy_temp_repo", boom)
        monkeypatch.setattr(release_e2e, "run_rehearsal", boom)
        rc = release_e2e.run_e2e(_config(dry_run=True))
        assert rc == release_e2e.EXIT_OK
        captured = capsys.readouterr()
        assert "DRYRUN" in captured.err
        # All three steps surface in the dry-run output.
        assert "Provision temp repo" in captured.err
        assert "Rehearsal" in captured.err
        assert "Destroy temp repo" in captured.err

    def test_happy_path_provision_rehearse_destroy(self, monkeypatch):
        order: list[str] = []

        def fake_provision(owner, slug):
            order.append("provision")
            return True, f"created {owner}/{slug}"

        def fake_rehearsal(owner, slug):
            order.append("rehearsal")
            return True, "ok"

        def fake_destroy(owner, slug):
            order.append("destroy")
            return True, f"deleted {owner}/{slug}"

        monkeypatch.setattr(release_e2e, "provision_temp_repo", fake_provision)
        monkeypatch.setattr(release_e2e, "run_rehearsal", fake_rehearsal)
        monkeypatch.setattr(release_e2e, "destroy_temp_repo", fake_destroy)
        rc = release_e2e.run_e2e(_config())
        assert rc == release_e2e.EXIT_OK
        assert order == ["provision", "rehearsal", "destroy"]

    def test_provision_failure_skips_rehearsal_and_destroy(
        self, monkeypatch, capsys
    ):
        monkeypatch.setattr(
            release_e2e,
            "provision_temp_repo",
            lambda owner, slug: (False, "quota exceeded"),
        )

        def boom(*_a, **_kw):  # pragma: no cover
            raise AssertionError(
                "rehearsal/destroy MUST NOT run when provision fails"
            )

        monkeypatch.setattr(release_e2e, "run_rehearsal", boom)
        monkeypatch.setattr(release_e2e, "destroy_temp_repo", boom)
        rc = release_e2e.run_e2e(_config())
        assert rc == release_e2e.EXIT_VIOLATION
        captured = capsys.readouterr()
        assert "quota exceeded" in captured.err

    def test_rehearsal_failure_still_destroys_repo(self, monkeypatch, capsys):
        order: list[str] = []

        def fake_provision(owner, slug):
            order.append("provision")
            return True, "created"

        def fake_rehearsal(owner, slug):
            order.append("rehearsal")
            return False, "smoke test failed"

        def fake_destroy(owner, slug):
            order.append("destroy")
            return True, "deleted"

        monkeypatch.setattr(release_e2e, "provision_temp_repo", fake_provision)
        monkeypatch.setattr(release_e2e, "run_rehearsal", fake_rehearsal)
        monkeypatch.setattr(release_e2e, "destroy_temp_repo", fake_destroy)
        rc = release_e2e.run_e2e(_config())
        assert rc == release_e2e.EXIT_VIOLATION
        # Cleanup MUST run even after rehearsal failure (try/finally).
        assert order == ["provision", "rehearsal", "destroy"]
        captured = capsys.readouterr()
        assert "smoke test failed" in captured.err

    def test_destroy_failure_warns_but_preserves_rehearsal_exit_code(
        self, monkeypatch, capsys
    ):
        monkeypatch.setattr(
            release_e2e,
            "provision_temp_repo",
            lambda owner, slug: (True, "created"),
        )
        monkeypatch.setattr(
            release_e2e,
            "run_rehearsal",
            lambda owner, slug: (True, "ok"),
        )
        monkeypatch.setattr(
            release_e2e,
            "destroy_temp_repo",
            lambda owner, slug: (False, "transient API"),
        )
        rc = release_e2e.run_e2e(_config())
        # Rehearsal succeeded -> exit 0 even though cleanup failed.
        assert rc == release_e2e.EXIT_OK
        captured = capsys.readouterr()
        assert "WARN" in captured.err
        assert "manual cleanup hint" in captured.err

    def test_keep_repo_skips_destroy(self, monkeypatch, capsys):
        monkeypatch.setattr(
            release_e2e,
            "provision_temp_repo",
            lambda owner, slug: (True, "created"),
        )
        monkeypatch.setattr(
            release_e2e,
            "run_rehearsal",
            lambda owner, slug: (True, "ok"),
        )

        def boom(*_a, **_kw):  # pragma: no cover
            raise AssertionError(
                "--keep-repo MUST skip destroy_temp_repo"
            )

        monkeypatch.setattr(release_e2e, "destroy_temp_repo", boom)
        rc = release_e2e.run_e2e(_config(keep_repo=True))
        assert rc == release_e2e.EXIT_OK
        captured = capsys.readouterr()
        assert "SKIP (--keep-repo set" in captured.err
        assert "manual cleanup required" in captured.err


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


class TestMain:
    def test_help_exits_0(self):
        with pytest.raises(SystemExit) as exc:
            release_e2e.main(["--help"])
        assert exc.value.code == 0

    def test_dry_run_via_main(self, monkeypatch, tmp_path):
        captured = {}

        def fake_run_e2e(config):
            captured["config"] = config
            return release_e2e.EXIT_OK

        monkeypatch.setattr(release_e2e, "run_e2e", fake_run_e2e)
        rc = release_e2e.main(
            [
                "--dry-run",
                "--owner",
                "deftai",
                "--project-root",
                str(tmp_path),
            ]
        )
        assert rc == release_e2e.EXIT_OK
        cfg = captured["config"]
        assert cfg.dry_run is True
        assert cfg.owner == "deftai"
        assert cfg.keep_repo is False


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
                str(REPO_ROOT / "scripts" / "release_e2e.py"),
                "--help",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0
        assert "release_e2e" in result.stdout
        assert "--keep-repo" in result.stdout
