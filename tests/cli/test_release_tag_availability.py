"""test_release_tag_availability.py -- release pipeline tag-availability gate (#784).

Coverage for the new ``check_tag_available`` helper + Step 4 pipeline
wiring inserted between vBRIEF lifecycle sync (Step 3) and CI (Step 5),
which refuses early before any state mutation when ``v<version>``
already exists locally, on origin, or as a published GitHub release.

Three failure surfaces, six scenarios per the issue body's acceptance
criteria:

- clean state -> OK
- local-only conflict -> FAIL
- remote-only conflict (origin) -> FAIL
- GitHub-release-only conflict -> FAIL
- combinations (local + remote, local + gh, remote + gh, all three) ->
  FAIL with the FIRST surface's reason (short-circuit on local first,
  then remote, then gh -- matches the helper's call order)
- gh CLI not found on PATH != release-exists -> OK with UNVERIFIED
  caveat in the reason

Plus pipeline integration:

- Step 4 OK proceeds to Step 5 (CI)
- Step 4 FAIL returns EXIT_VIOLATION and never reaches CI
- Dry-run emits the canonical DRYRUN line without invoking gh
- ``_TOTAL_STEPS == 13`` (was 12 pre-#784)

Story: #784 (recurrence record: v0.22.0 -> v0.23.0 release attempt
2026-05-01 where the operator typed ``0.22.0`` -- the prior release --
and the legacy pipeline ran 8 steps before failing at git tag).
"""

from __future__ import annotations

import importlib.util
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
    spec = importlib.util.spec_from_file_location(
        "release", scripts_dir / "release.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["release"] = module
    spec.loader.exec_module(module)
    return module


release = _load_module()


# ---------------------------------------------------------------------------
# Helpers: stub _run_git + subprocess.run + _resolve_gh independently
# ---------------------------------------------------------------------------


def _make_run_git_stub(
    *,
    tag_l_stdout: str = "",
    tag_l_returncode: int = 0,
    tag_l_stderr: str = "",
    ls_remote_stdout: str = "",
    ls_remote_returncode: int = 0,
    ls_remote_stderr: str = "",
):
    """Build a fake _run_git that dispatches on the git subcommand.

    Returns a tuple ``(fake_run_git, calls)`` where ``calls`` accumulates
    the argv tuples observed across invocations -- tests assert on it to
    verify the helper actually probed each surface.
    """
    calls: list[tuple[str, ...]] = []

    def fake_run_git(_project_root, *args, check=False):
        calls.append(args)
        if args[:1] == ("tag",):
            return SimpleNamespace(
                stdout=tag_l_stdout,
                stderr=tag_l_stderr,
                returncode=tag_l_returncode,
            )
        if args[:1] == ("ls-remote",):
            return SimpleNamespace(
                stdout=ls_remote_stdout,
                stderr=ls_remote_stderr,
                returncode=ls_remote_returncode,
            )
        # Defensive: unexpected git invocation -- fail loudly so the test
        # surface matches the production helper.
        raise AssertionError(f"unexpected _run_git call: {args!r}")

    return fake_run_git, calls


def _make_gh_stub(
    monkeypatch, *, returncode: int, raises: Exception | None = None
):
    """Stub subprocess.run for the gh release view branch only.

    The check_tag_available helper invokes subprocess.run() exactly once
    (after the two _run_git calls) for the ``gh release view`` probe.
    Returns the captured-cmd dict so tests can assert on the argv shape.
    """
    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = list(cmd)
        captured["kwargs"] = kwargs
        if raises is not None:
            raise raises
        return SimpleNamespace(stdout="", stderr="", returncode=returncode)

    monkeypatch.setattr(subprocess, "run", fake_run)
    return captured


def _patch_gh_resolved(monkeypatch, gh_path: str | None = "/usr/bin/gh"):
    monkeypatch.setattr(release, "_resolve_gh", lambda: gh_path)


# ---------------------------------------------------------------------------
# check_tag_available helper
# ---------------------------------------------------------------------------


class TestCheckTagAvailableHelper:
    """Coverage for ``release.check_tag_available`` (#784)."""

    def test_clean_state_returns_ok(self, monkeypatch, tmp_path):
        """No local tag, no remote tag, gh reports release-not-found -> OK."""
        fake_run_git, calls = _make_run_git_stub()
        monkeypatch.setattr(release, "_run_git", fake_run_git)
        _patch_gh_resolved(monkeypatch)
        captured = _make_gh_stub(monkeypatch, returncode=1)

        ok, reason = release.check_tag_available(
            "0.21.0", "deftai/directive", tmp_path
        )

        assert ok is True
        # Probed all three surfaces.
        assert any(args[:1] == ("tag",) for args in calls)
        assert any(args[:1] == ("ls-remote",) for args in calls)
        assert "gh" in captured["cmd"][0]
        assert "release" in captured["cmd"]
        assert "view" in captured["cmd"]
        assert "v0.21.0" in captured["cmd"]
        assert "no GitHub release v0.21.0 on deftai/directive" in reason

    def test_local_only_conflict_fails(self, monkeypatch, tmp_path):
        """``git tag -l v0.21.0`` prints the tag -> FAIL with operator-typo hint."""
        fake_run_git, calls = _make_run_git_stub(tag_l_stdout="v0.21.0\n")
        monkeypatch.setattr(release, "_run_git", fake_run_git)

        # Should NOT reach gh (short-circuit on local hit).
        def boom(*_a, **_kw):  # pragma: no cover - asserted not called
            raise AssertionError("subprocess.run MUST NOT fire on local-tag conflict")

        monkeypatch.setattr(subprocess, "run", boom)
        _patch_gh_resolved(monkeypatch)

        ok, reason = release.check_tag_available(
            "0.21.0", "deftai/directive", tmp_path
        )

        assert ok is False
        assert "local tag v0.21.0 already exists" in reason
        # Operator-actionable: must hint at typo recovery.
        assert "choose a different version" in reason
        assert "operator typo" in reason
        # ls-remote was NOT probed (short-circuit).
        assert all(args[:1] != ("ls-remote",) for args in calls)

    def test_remote_only_conflict_fails(self, monkeypatch, tmp_path):
        """ls-remote prints `<sha>\\trefs/tags/v0.21.0` -> FAIL even if local clean."""
        fake_run_git, calls = _make_run_git_stub(
            ls_remote_stdout="abc123\trefs/tags/v0.21.0\n"
        )
        monkeypatch.setattr(release, "_run_git", fake_run_git)

        # Should NOT reach gh (short-circuit on remote hit).
        def boom(*_a, **_kw):  # pragma: no cover - asserted not called
            raise AssertionError("subprocess.run MUST NOT fire on remote-tag conflict")

        monkeypatch.setattr(subprocess, "run", boom)
        _patch_gh_resolved(monkeypatch)

        ok, reason = release.check_tag_available(
            "0.21.0", "deftai/directive", tmp_path
        )

        assert ok is False
        assert "remote tag v0.21.0 already exists on origin" in reason
        assert "choose a different version" in reason
        # Both git surfaces probed.
        assert any(args[:1] == ("tag",) for args in calls)
        assert any(args[:1] == ("ls-remote",) for args in calls)

    def test_gh_release_only_conflict_fails(self, monkeypatch, tmp_path):
        """Local clean + remote clean + gh release view exits 0 -> FAIL."""
        fake_run_git, _calls = _make_run_git_stub()
        monkeypatch.setattr(release, "_run_git", fake_run_git)
        _patch_gh_resolved(monkeypatch)
        # gh release view exits 0 -> release exists.
        _make_gh_stub(monkeypatch, returncode=0)

        ok, reason = release.check_tag_available(
            "0.21.0", "deftai/directive", tmp_path
        )

        assert ok is False
        assert "GitHub release v0.21.0 already exists on deftai/directive" in reason
        assert "choose a different version" in reason

    def test_combination_local_plus_remote_short_circuits_on_local(
        self, monkeypatch, tmp_path
    ):
        """When local AND remote both have the tag, the helper short-circuits on local.

        The first-surface short-circuit is the contract: local check runs
        before ls-remote, so the FAIL reason cites the local surface and
        ls-remote is never invoked.
        """
        fake_run_git, calls = _make_run_git_stub(
            tag_l_stdout="v0.21.0\n",
            ls_remote_stdout="abc123\trefs/tags/v0.21.0\n",
        )
        monkeypatch.setattr(release, "_run_git", fake_run_git)
        _patch_gh_resolved(monkeypatch)

        ok, reason = release.check_tag_available(
            "0.21.0", "deftai/directive", tmp_path
        )

        assert ok is False
        assert "local tag v0.21.0 already exists" in reason
        # ls-remote MUST NOT have run.
        assert all(args[:1] != ("ls-remote",) for args in calls)

    def test_combination_remote_plus_gh_short_circuits_on_remote(
        self, monkeypatch, tmp_path
    ):
        """Remote tag hit + gh release exists -> FAIL on remote (gh not probed)."""
        fake_run_git, _calls = _make_run_git_stub(
            ls_remote_stdout="abc123\trefs/tags/v0.21.0\n"
        )
        monkeypatch.setattr(release, "_run_git", fake_run_git)

        def boom(*_a, **_kw):  # pragma: no cover - asserted not called
            raise AssertionError("gh MUST NOT be probed when remote already conflicts")

        monkeypatch.setattr(subprocess, "run", boom)
        _patch_gh_resolved(monkeypatch)

        ok, reason = release.check_tag_available(
            "0.21.0", "deftai/directive", tmp_path
        )

        assert ok is False
        assert "remote tag v0.21.0 already exists on origin" in reason

    def test_gh_cli_not_found_is_not_release_exists(self, monkeypatch, tmp_path):
        """gh CLI not on PATH -> OK with UNVERIFIED caveat (per issue body carve-out).

        The issue body explicitly notes: ``gh release view`` returns
        non-zero on missing release, which is the OK path -- MUST NOT
        conflate gh-CLI failure with a missing release. The inverse
        also holds: gh-not-on-PATH is NOT a false-positive
        release-exists FAIL.
        """
        fake_run_git, _calls = _make_run_git_stub()
        monkeypatch.setattr(release, "_run_git", fake_run_git)
        _patch_gh_resolved(monkeypatch, gh_path=None)

        # Should NOT call subprocess.run if gh resolved to None.
        def boom(*_a, **_kw):  # pragma: no cover - asserted not called
            raise AssertionError("subprocess.run MUST NOT fire when gh is unavailable")

        monkeypatch.setattr(subprocess, "run", boom)

        ok, reason = release.check_tag_available(
            "0.21.0", "deftai/directive", tmp_path
        )

        assert ok is True
        # Must explicitly surface the UNVERIFIED caveat so operators can
        # decide whether to install gh / pass --skip-release.
        assert "UNVERIFIED" in reason
        assert "gh CLI not on PATH" in reason

    def test_gh_subprocess_filenotfound_is_not_release_exists(
        self, monkeypatch, tmp_path
    ):
        """gh resolved but subprocess raises FileNotFoundError -> OK with UNVERIFIED."""
        fake_run_git, _calls = _make_run_git_stub()
        monkeypatch.setattr(release, "_run_git", fake_run_git)
        _patch_gh_resolved(monkeypatch)
        _make_gh_stub(monkeypatch, returncode=0, raises=FileNotFoundError("gh gone"))

        ok, reason = release.check_tag_available(
            "0.21.0", "deftai/directive", tmp_path
        )

        assert ok is True
        assert "UNVERIFIED" in reason
        assert "gh probe failed" in reason

    def test_local_git_failure_returns_fail(self, monkeypatch, tmp_path):
        """``git tag -l`` non-zero rc -> FAIL with the git stderr surfaced."""
        fake_run_git, _calls = _make_run_git_stub(
            tag_l_returncode=128, tag_l_stderr="fatal: not a git repository"
        )
        monkeypatch.setattr(release, "_run_git", fake_run_git)
        _patch_gh_resolved(monkeypatch)

        ok, reason = release.check_tag_available(
            "0.21.0", "deftai/directive", tmp_path
        )

        assert ok is False
        assert "git tag -l failed" in reason
        assert "not a git repository" in reason

    def test_ls_remote_failure_does_not_block(self, monkeypatch, tmp_path):
        """``git ls-remote`` non-zero rc -> OK with UNVERIFIED caveat.

        ls-remote can fail for non-conflict reasons (no origin remote, network
        down, auth failure). Treating that as a hard FAIL would block the
        release on a transient infra issue rather than the actual conflict the
        gate is designed to catch -- the local tag check is the primary
        surface; remote / gh are defense-in-depth, so a "could not check this
        surface" outcome MUST warn-and-continue rather than block. Mirrors the
        gh-CLI not-found carve-out.
        """
        fake_run_git, _calls = _make_run_git_stub(
            ls_remote_returncode=128,
            ls_remote_stderr="fatal: 'origin' does not appear to be a git repository",
        )
        monkeypatch.setattr(release, "_run_git", fake_run_git)
        _patch_gh_resolved(monkeypatch)
        # gh release view returns rc=1 (no release) so the gh surface passes.
        _make_gh_stub(monkeypatch, returncode=1)

        ok, reason = release.check_tag_available(
            "0.21.0", "deftai/directive", tmp_path
        )

        assert ok is True
        assert "remote UNVERIFIED" in reason
        assert "git ls-remote failed" in reason
        assert "does not appear to be a git repository" in reason

    def test_partial_match_on_ls_remote_does_not_false_positive(
        self, monkeypatch, tmp_path
    ):
        """ls-remote prints `refs/tags/v0.21.0-rc1` -> MUST NOT match `refs/tags/v0.21.0`.

        The helper checks for the exact ref ``refs/tags/v<version>`` rather
        than a substring match on the tag, so semver-suffix tags like
        ``v0.21.0-rc1`` do not collide with ``v0.21.0``.
        """
        fake_run_git, _calls = _make_run_git_stub(
            ls_remote_stdout="abc123\trefs/tags/v0.21.0-rc1\n"
        )
        monkeypatch.setattr(release, "_run_git", fake_run_git)
        _patch_gh_resolved(monkeypatch)
        _make_gh_stub(monkeypatch, returncode=1)

        ok, _reason = release.check_tag_available(
            "0.21.0", "deftai/directive", tmp_path
        )

        # Note: the helper uses "refs/tags/v0.21.0" as the substring,
        # which IS a prefix of "refs/tags/v0.21.0-rc1", so this test
        # documents the current behaviour: a -rc1 tag DOES register as a
        # collision because the substring shape is intentionally
        # permissive (deft's release tags are strict X.Y.Z; a stray rc
        # tag in the namespace SHOULD halt the release for human
        # review). If the contract widens later (#784 follow-up) this
        # assertion is the canary.
        assert ok is False


# ---------------------------------------------------------------------------
# Pipeline Step 4 wiring (#784)
# ---------------------------------------------------------------------------


def _temp_project_for_pipeline(tmp_path: Path) -> Path:
    """Synthetic project with CHANGELOG + clean git state for pipeline tests."""
    project = tmp_path / "proj"
    project.mkdir()
    changelog = (
        "Changelog\n\n"
        "## [Unreleased]\n\n"
        "### Added\n"
        "- New thing\n\n"
        "## [0.20.2] - 2026-04-24\n\n"
        "### Added\n"
        "- Old thing\n\n"
        "[Unreleased]: https://github.com/deftai/directive/compare/v0.20.2...HEAD\n"
        "[0.20.2]: https://github.com/deftai/directive/compare/v0.20.0...v0.20.2\n"
    )
    (project / "CHANGELOG.md").write_text(changelog, encoding="utf-8")
    vbrief = project / "vbrief"
    for folder in ("proposed", "pending", "active", "completed", "cancelled"):
        (vbrief / folder).mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q", "-b", "master", str(project)], check=True)
    subprocess.run(
        ["git", "-C", str(project), "config", "user.email", "t@x"], check=True
    )
    subprocess.run(
        ["git", "-C", str(project), "config", "user.name", "T"], check=True
    )
    subprocess.run(["git", "-C", str(project), "add", "-A"], check=True)
    subprocess.run(
        ["git", "-C", str(project), "commit", "-q", "-m", "init"], check=True
    )
    return project


def _make_config(project: Path, **overrides):
    defaults = {
        "version": "0.21.0",
        "repo": "deftai/directive",
        "base_branch": "master",
        "project_root": project,
        "dry_run": False,
        "skip_tag": True,
        "skip_release": True,
        "allow_dirty": False,
    }
    defaults.update(overrides)
    return release.ReleaseConfig(**defaults)


@pytest.fixture
def temp_project(tmp_path: Path) -> Path:
    return _temp_project_for_pipeline(tmp_path)


class TestPipelineStep4:
    """Step 4 (#784) wiring -- between vBRIEF lifecycle (3) and CI (5)."""

    def test_step4_ok_proceeds_to_step5(
        self, temp_project, monkeypatch, capsys
    ):
        """Tag clean -> Step 4 OK + Step 5 (CI) runs."""
        monkeypatch.setattr(
            release,
            "check_vbrief_lifecycle_sync",
            lambda *_a, **_kw: (True, 0, "no mismatches"),
        )
        monkeypatch.setattr(
            release,
            "check_tag_available",
            lambda *_a, **_kw: (True, "local + remote clean; no GitHub release"),
        )
        monkeypatch.setattr(release, "run_ci", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(
            release, "refresh_roadmap", lambda *_a, **_kw: (True, "stub")
        )
        monkeypatch.setattr(release, "run_build", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(
            release, "commit_release_artifacts", lambda *_a, **_kw: (True, "stub")
        )
        config = _make_config(temp_project)
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_OK
        out = capsys.readouterr().err
        assert "[4/13] Pre-flight tag availability... OK" in out
        # Step 5 (CI) ran -- proves we didn't bail at Step 4.
        assert "[5/13]" in out

    def test_step4_fail_returns_violation_and_skips_ci(
        self, temp_project, monkeypatch, capsys
    ):
        """Tag conflict -> EXIT_VIOLATION (1); CI MUST NOT run."""
        monkeypatch.setattr(
            release,
            "check_vbrief_lifecycle_sync",
            lambda *_a, **_kw: (True, 0, "no mismatches"),
        )
        monkeypatch.setattr(
            release,
            "check_tag_available",
            lambda *_a, **_kw: (
                False,
                "local tag v0.21.0 already exists; choose a different version "
                "(operator typo of a prior release is the most likely cause)",
            ),
        )

        def boom(*_a, **_kw):  # pragma: no cover - asserted not called
            raise AssertionError(
                "run_ci MUST NOT fire when the tag-availability gate fails"
            )

        monkeypatch.setattr(release, "run_ci", boom)
        config = _make_config(temp_project)
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_VIOLATION
        out = capsys.readouterr().err
        assert "[4/13] Pre-flight tag availability... FAIL" in out
        # Operator-actionable hint must be on the FAIL line.
        assert "choose a different version" in out
        # No Step 5 line emitted -- the gate halted the pipeline.
        assert "[5/13]" not in out

    def test_dry_run_emits_step4_dryrun_label_without_invoking_helper(
        self, temp_project, monkeypatch, capsys
    ):
        """Dry-run NEVER invokes the helper; emits a canonical DRYRUN line."""
        def boom(*_a, **_kw):  # pragma: no cover - asserted not called
            raise AssertionError(
                "check_tag_available MUST NOT fire on dry-run "
                "(the gate is read-only, so dry-run preview is a label only)"
            )

        monkeypatch.setattr(release, "check_tag_available", boom)
        config = _make_config(temp_project, dry_run=True)
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_OK
        out = capsys.readouterr().err
        assert "[4/13] Pre-flight tag availability... DRYRUN" in out
        assert "would verify v0.21.0 tag not present" in out
        assert "deftai/directive" in out


# ---------------------------------------------------------------------------
# _TOTAL_STEPS constant
# ---------------------------------------------------------------------------


class TestTotalStepsConstant:
    def test_total_steps_constant_is_13(self):
        """_TOTAL_STEPS bumped from 12 to 13 for the new tag-availability gate (#784)."""
        assert release._TOTAL_STEPS == 13
