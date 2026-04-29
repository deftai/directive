"""test_release_e2e.py -- Tests for scripts/release_e2e.py (#716, #720).

Coverage:
- generate_repo_slug: produces deftai-release-test-<ts>-<uuid6>
- provision_temp_repo / destroy_temp_repo: gh-CLI happy + failure paths
- #720 rehearsal step helpers (each isolated for independent testing):
  - clone_repo_to_temp: subprocess.run argv + success / failure paths
  - set_origin_to_temp_repo: argv contains 'remote set-url' + temp URL
  - push_mirror: argv contains 'push --mirror'
  - dispatch_task_release: argv carries --skip-ci + --skip-build
  - verify_draft_release: success path + isDraft=false refusal +
    tagName mismatch refusal
  - verify_tag: ls-remote presence / absence
  - dispatch_task_release_rollback: argv shape
- run_rehearsal: walks the seven steps in order; short-circuits on first
  failure; passes the configured version through
- run_e2e: provision -> rehearse -> destroy ordering; cleanup runs even
  when rehearsal fails OR raises; cleanup-failure warning preserves
  rehearsal exit code; --keep-repo skips destroy; --dry-run invokes nothing
- main: --help exits 0; dry-run round-trip via main

Refs #716, #720, #74.
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
        assert re.match(
            r"^deftai-release-test-\d{14}-[0-9a-f]{6}$", slug
        ), f"unexpected slug: {slug}"

    def test_two_calls_produce_different_slugs(self):
        a = release_e2e.generate_repo_slug()
        b = release_e2e.generate_repo_slug()
        # uuid suffix guarantees uniqueness even within the same second.
        assert a != b


# ---------------------------------------------------------------------------
# provision_temp_repo / destroy_temp_repo
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
# Rehearsal step helpers (#720)
# ---------------------------------------------------------------------------


class TestCloneRepoToTemp:
    def test_happy_path(self, monkeypatch, tmp_path):
        captured = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            return SimpleNamespace(stdout="", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release_e2e.clone_repo_to_temp(
            tmp_path / "src", tmp_path / "clone"
        )
        assert ok is True
        assert "clone" in captured["cmd"]
        assert str(tmp_path / "src") in captured["cmd"]
        assert str(tmp_path / "clone") in captured["cmd"]

    def test_failure_surfaces_stderr(self, monkeypatch, tmp_path):
        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout="", stderr="not a git repository", returncode=128
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release_e2e.clone_repo_to_temp(
            tmp_path / "src", tmp_path / "clone"
        )
        assert ok is False
        assert "not a git repository" in reason


class TestSetOriginToTempRepo:
    def test_happy_path_uses_https_url(self, monkeypatch, tmp_path):
        captured = {}

        def fake_run_git(project_root, *args, check=False):
            captured["args"] = args
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        monkeypatch.setattr(release_e2e.release, "_run_git", fake_run_git)
        ok, reason = release_e2e.set_origin_to_temp_repo(
            tmp_path, "deftai", "deftai-release-test-X"
        )
        assert ok is True
        assert "https://github.com/deftai/deftai-release-test-X.git" in reason
        assert captured["args"] == (
            "remote",
            "set-url",
            "origin",
            "https://github.com/deftai/deftai-release-test-X.git",
        )

    def test_failure_surfaces_stderr(self, monkeypatch, tmp_path):
        def fake_run_git(project_root, *args, check=False):
            return SimpleNamespace(
                returncode=128, stdout="", stderr="no such remote"
            )

        monkeypatch.setattr(release_e2e.release, "_run_git", fake_run_git)
        ok, reason = release_e2e.set_origin_to_temp_repo(
            tmp_path, "deftai", "x"
        )
        assert ok is False
        assert "no such remote" in reason


class TestPushMirror:
    def test_happy_path_uses_mirror_flag(self, monkeypatch, tmp_path):
        captured = {}

        def fake_run_git(project_root, *args, check=False):
            captured["args"] = args
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        monkeypatch.setattr(release_e2e.release, "_run_git", fake_run_git)
        ok, _ = release_e2e.push_mirror(tmp_path)
        assert ok is True
        assert captured["args"] == ("push", "--mirror")

    def test_failure_surfaces_stderr(self, monkeypatch, tmp_path):
        def fake_run_git(project_root, *args, check=False):
            return SimpleNamespace(
                returncode=1, stdout="", stderr="permission denied"
            )

        monkeypatch.setattr(release_e2e.release, "_run_git", fake_run_git)
        ok, reason = release_e2e.push_mirror(tmp_path)
        assert ok is False
        assert "permission denied" in reason


class TestDispatchTaskRelease:
    def test_argv_carries_skip_ci_and_skip_build(self, monkeypatch, tmp_path):
        monkeypatch.setattr(release_e2e.shutil, "which", lambda _: "/usr/bin/task")
        captured = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            return SimpleNamespace(stdout="", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, _ = release_e2e.dispatch_task_release(
            tmp_path, "0.0.1", "deftai/temp-x"
        )
        assert ok is True
        # #720 acceptance: --skip-ci AND --skip-build are passed through.
        assert "--skip-ci" in captured["cmd"]
        assert "--skip-build" in captured["cmd"]
        assert captured["cmd"][0] == "task"
        assert captured["cmd"][1] == "release"
        assert "0.0.1" in captured["cmd"]
        assert "deftai/temp-x" in captured["cmd"]

    def test_task_missing_returns_false(self, monkeypatch, tmp_path):
        monkeypatch.setattr(release_e2e.shutil, "which", lambda _: None)
        ok, reason = release_e2e.dispatch_task_release(
            tmp_path, "0.0.1", "deftai/x"
        )
        assert ok is False
        assert "task binary not found" in reason

    def test_failure_surfaces_stderr(self, monkeypatch, tmp_path):
        monkeypatch.setattr(release_e2e.shutil, "which", lambda _: "/usr/bin/task")

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout="", stderr="pipeline step failed", returncode=1
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release_e2e.dispatch_task_release(
            tmp_path, "0.0.1", "deftai/x"
        )
        assert ok is False
        assert "pipeline step failed" in reason


class TestVerifyDraftRelease:
    def test_happy_path_isdraft_true_and_tag_match(self, monkeypatch):
        monkeypatch.setattr(release_e2e.shutil, "which", lambda _: "/usr/bin/gh")

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout='{"isDraft": true, "tagName": "v0.0.1", "name": "v0.0.1", "url": "..."}',
                stderr="",
                returncode=0,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release_e2e.verify_draft_release(
            "deftai", "x", "0.0.1"
        )
        assert ok is True
        assert "verified draft v0.0.1" in reason

    def test_isdraft_false_refuses(self, monkeypatch):
        monkeypatch.setattr(release_e2e.shutil, "which", lambda _: "/usr/bin/gh")

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout='{"isDraft": false, "tagName": "v0.0.1"}',
                stderr="",
                returncode=0,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release_e2e.verify_draft_release(
            "deftai", "x", "0.0.1"
        )
        assert ok is False
        assert "isDraft=true" in reason

    def test_tag_mismatch_refuses(self, monkeypatch):
        monkeypatch.setattr(release_e2e.shutil, "which", lambda _: "/usr/bin/gh")

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout='{"isDraft": true, "tagName": "v9.9.9"}',
                stderr="",
                returncode=0,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release_e2e.verify_draft_release(
            "deftai", "x", "0.0.1"
        )
        assert ok is False
        assert "tagName" in reason
        assert "v9.9.9" in reason

    def test_gh_failure_returns_false(self, monkeypatch):
        monkeypatch.setattr(release_e2e.shutil, "which", lambda _: "/usr/bin/gh")

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout="", stderr="not found", returncode=1
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release_e2e.verify_draft_release(
            "deftai", "x", "0.0.1"
        )
        assert ok is False
        assert "not found" in reason


class TestVerifyTag:
    def test_present_succeeds(self, monkeypatch, tmp_path):
        def fake_run_git(project_root, *args, check=False):
            return SimpleNamespace(
                returncode=0,
                stdout="abc123\trefs/tags/v0.0.1\n",
                stderr="",
            )

        monkeypatch.setattr(release_e2e.release, "_run_git", fake_run_git)
        ok, _ = release_e2e.verify_tag(tmp_path, "0.0.1")
        assert ok is True

    def test_absent_refuses(self, monkeypatch, tmp_path):
        def fake_run_git(project_root, *args, check=False):
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        monkeypatch.setattr(release_e2e.release, "_run_git", fake_run_git)
        ok, reason = release_e2e.verify_tag(tmp_path, "0.0.1")
        assert ok is False
        assert "not present" in reason


class TestDispatchTaskReleaseRollback:
    def test_argv_shape(self, monkeypatch, tmp_path):
        monkeypatch.setattr(release_e2e.shutil, "which", lambda _: "/usr/bin/task")
        captured = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            return SimpleNamespace(stdout="", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, _ = release_e2e.dispatch_task_release_rollback(
            tmp_path, "0.0.1", "deftai/x"
        )
        assert ok is True
        assert captured["cmd"][0] == "task"
        assert captured["cmd"][1] == "release:rollback"
        assert "0.0.1" in captured["cmd"]
        assert "deftai/x" in captured["cmd"]


# ---------------------------------------------------------------------------
# run_rehearsal (#720) -- pipeline-mirror orchestration
# ---------------------------------------------------------------------------


class TestRunRehearsal:
    def _patch_all_steps(self, monkeypatch, *, fail_at=None):
        """Patch every rehearsal helper to return (True, ...) by default;
        if ``fail_at`` is set, the named helper returns (False, ...).
        Captures the call order in a list and returns it for assertion.
        """
        order: list[str] = []

        def make_helper(name, ok=True):
            def helper(*args, **kwargs):
                order.append(name)
                if not ok:
                    return False, f"{name} failed"
                return True, f"{name} ok"
            return helper

        names = [
            "clone_repo_to_temp",
            "set_origin_to_temp_repo",
            "push_mirror",
            "dispatch_task_release",
            "verify_draft_release",
            "verify_tag",
            "dispatch_task_release_rollback",
        ]
        for name in names:
            monkeypatch.setattr(
                release_e2e, name, make_helper(name, ok=(name != fail_at))
            )
        return order

    def test_happy_path_walks_all_seven_steps_in_order(
        self, monkeypatch, tmp_path
    ):
        order = self._patch_all_steps(monkeypatch)
        ok, reason = release_e2e.run_rehearsal(
            "deftai", "deftai-release-test-X", tmp_path
        )
        assert ok is True
        assert "pipeline-mirror rehearsal succeeded" in reason
        assert order == [
            "clone_repo_to_temp",
            "set_origin_to_temp_repo",
            "push_mirror",
            "dispatch_task_release",
            "verify_draft_release",
            "verify_tag",
            "dispatch_task_release_rollback",
        ]

    def test_clone_failure_short_circuits(self, monkeypatch, tmp_path):
        order = self._patch_all_steps(monkeypatch, fail_at="clone_repo_to_temp")
        ok, reason = release_e2e.run_rehearsal(
            "deftai", "x", tmp_path
        )
        assert ok is False
        assert "clone" in reason
        # Subsequent steps must NOT run.
        assert order == ["clone_repo_to_temp"]

    def test_task_release_failure_short_circuits_before_verify(
        self, monkeypatch, tmp_path
    ):
        order = self._patch_all_steps(
            monkeypatch, fail_at="dispatch_task_release"
        )
        ok, reason = release_e2e.run_rehearsal(
            "deftai", "x", tmp_path
        )
        assert ok is False
        assert "task release" in reason
        # The verify steps must NOT run after task release fails.
        assert "verify_draft_release" not in order
        assert "verify_tag" not in order
        assert "dispatch_task_release_rollback" not in order

    def test_rollback_step_runs_last(self, monkeypatch, tmp_path):
        order = self._patch_all_steps(monkeypatch)
        release_e2e.run_rehearsal("deftai", "x", tmp_path)
        assert order[-1] == "dispatch_task_release_rollback"

    def test_passes_version_through_to_helpers(self, monkeypatch, tmp_path):
        """The configured rehearsal version is forwarded to dispatch_task_release."""
        captured = {}

        def fake_dispatch(clone_dir, version, repo):
            captured["version"] = version
            captured["repo"] = repo
            return True, "ok"

        # Patch only the helpers we care about; the others are no-ops.
        monkeypatch.setattr(
            release_e2e, "clone_repo_to_temp",
            lambda *a, **kw: (True, "ok"),
        )
        monkeypatch.setattr(
            release_e2e, "set_origin_to_temp_repo",
            lambda *a, **kw: (True, "ok"),
        )
        monkeypatch.setattr(
            release_e2e, "push_mirror", lambda *a, **kw: (True, "ok")
        )
        monkeypatch.setattr(
            release_e2e, "dispatch_task_release", fake_dispatch
        )
        monkeypatch.setattr(
            release_e2e, "verify_draft_release",
            lambda *a, **kw: (True, "ok"),
        )
        monkeypatch.setattr(
            release_e2e, "verify_tag", lambda *a, **kw: (True, "ok")
        )
        monkeypatch.setattr(
            release_e2e, "dispatch_task_release_rollback",
            lambda *a, **kw: (True, "ok"),
        )
        ok, _ = release_e2e.run_rehearsal(
            "deftai", "deftai-release-test-X", tmp_path, version="0.0.1"
        )
        assert ok is True
        assert captured["version"] == "0.0.1"
        assert captured["repo"] == "deftai/deftai-release-test-X"


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
        # #720: dry-run preview mentions the new pipeline-mirror semantics.
        assert "pipeline-mirror" in captured.err

    def test_happy_path_provision_rehearse_destroy(self, monkeypatch):
        order: list[str] = []

        def fake_provision(owner, slug):
            order.append("provision")
            return True, f"created {owner}/{slug}"

        def fake_rehearsal(owner, slug, project_root, version=None):
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

        def fake_rehearsal(owner, slug, project_root, version=None):
            order.append("rehearsal")
            return False, "task release failed"

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
        assert "task release failed" in captured.err

    def test_rehearsal_exception_still_destroys_repo(self, monkeypatch):
        """Defence in depth: any exception during rehearsal must still
        trigger destroy via the try/finally."""
        order: list[str] = []

        monkeypatch.setattr(
            release_e2e,
            "provision_temp_repo",
            lambda owner, slug: (True, "created"),
        )

        def fake_rehearsal(owner, slug, project_root, version=None):
            order.append("rehearsal")
            raise RuntimeError("network blew up mid-clone")

        def fake_destroy(owner, slug):
            order.append("destroy")
            return True, "deleted"

        monkeypatch.setattr(release_e2e, "run_rehearsal", fake_rehearsal)
        monkeypatch.setattr(release_e2e, "destroy_temp_repo", fake_destroy)
        with pytest.raises(RuntimeError, match="network blew up"):
            release_e2e.run_e2e(_config())
        # Cleanup MUST have run even though the rehearsal raised.
        assert order == ["rehearsal", "destroy"]

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
            lambda owner, slug, project_root, version=None: (True, "ok"),
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
            lambda owner, slug, project_root, version=None: (True, "ok"),
        )

        def boom(*_a, **_kw):  # pragma: no cover
            raise AssertionError("--keep-repo MUST skip destroy_temp_repo")

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
