"""test_release.py -- Tests for scripts/release.py (#74).

Covers:
- _validate_version: accepts strict X.Y.Z; rejects pre-release / leading 'v' / etc.
- _resolve_repo: --repo flag wins; git remote fallback parses https/ssh; default fallback.
- promote_changelog: heading promotion, fresh Unreleased block, sub-sections preserved,
  link footer rewrite (compare URL + new version line), greenfield (no prev) fallback,
  malformed/missing Unreleased rejected.
- _section_for_version: extracts the body of a versioned heading.
- _split_body_and_links: splits at the first [X.Y.Z]: or [Unreleased]: line.
- task_has_target: matches task list output for present/absent targets.
- run_ci: prefers ci:local; falls back to check; fails when neither exists.
- run_pipeline: dry-run prints plan with no writes; dirty-tree refuses without
  --allow-dirty (exit 1) and accepts with the flag; wrong branch refuses (exit 1);
  --skip-tag suppresses git tag/push; --skip-release suppresses gh release;
  CI failure exits 1; CHANGELOG missing exits 2.
- main: malformed version exits 2.
- Round-trip on a synthetic temporary project with a real CHANGELOG.md fixture +
  --dry-run yields exit 0 and leaves CHANGELOG byte-identical.

Total tests >= 30 to satisfy the >=25 minimum stated in the spec.

Story: #74 (chore: automate release process and CI changelog enforcement),
       refs #233 (More Determinism umbrella), #642 workflow umbrella,
       #635 epic, #709 (Repair Authority [AXIOM]),
       #710 (data-file-conventions check follow-up).
"""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module():
    """Load scripts/release.py in-process."""
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "release",
        scripts_dir / "release.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Register in sys.modules BEFORE exec so @dataclass introspection in
    # release.py (which calls sys.modules.get(cls.__module__).__dict__) can
    # resolve the module rather than tripping AttributeError on None.
    sys.modules["release"] = module
    spec.loader.exec_module(module)
    return module


release = _load_module()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


SAMPLE_CHANGELOG = """\
 Changelog

All notable changes to the project.

## [Unreleased]

### Added
- New release automation (#74)

### Changed
- Refactored module X

### Fixed
- Bug Y

## [0.20.2] - 2026-04-24

### Added
- Prior change

## [0.20.0] - 2026-04-23

### Added
- Older change

[Unreleased]: https://github.com/deftai/directive/compare/v0.20.2...HEAD
[0.20.2]: https://github.com/deftai/directive/compare/v0.20.0...v0.20.2
[0.20.0]: https://github.com/deftai/directive/compare/v0.19.0...v0.20.0
"""


GREENFIELD_CHANGELOG = """\
 Changelog

## [Unreleased]

### Added
- First feature
"""


@pytest.fixture
def temp_project(tmp_path: Path) -> Path:
    """Initialise a synthetic project with CHANGELOG.md and a clean git tree."""
    project = tmp_path / "proj"
    project.mkdir()
    (project / "CHANGELOG.md").write_text(SAMPLE_CHANGELOG, encoding="utf-8")
    # Initialise a git repo so check_git_clean / current_branch work locally.
    subprocess.run(
        ["git", "init", "-q", "-b", "master", str(project)], check=True
    )
    subprocess.run(
        ["git", "-C", str(project), "config", "user.email", "test@example.com"],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(project), "config", "user.name", "Tester"], check=True
    )
    subprocess.run(
        ["git", "-C", str(project), "add", "CHANGELOG.md"], check=True
    )
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


# ---------------------------------------------------------------------------
# _validate_version
# ---------------------------------------------------------------------------


class TestValidateVersion:
    @pytest.mark.parametrize("version", ["0.0.0", "0.21.0", "1.2.3", "10.20.30"])
    def test_accepts_strict_semver(self, version: str):
        # Should not raise.
        release._validate_version(version)

    @pytest.mark.parametrize(
        "version",
        [
            "v0.21.0",        # leading v
            "0.21",           # only two parts
            "0.21.0-rc.1",    # pre-release
            "0.21.0+build",   # build metadata
            "0.21.0.0",       # four parts
            "abc",            # garbage
            "",               # empty
        ],
    )
    def test_rejects_invalid(self, version: str):
        with pytest.raises(ValueError):
            release._validate_version(version)


# ---------------------------------------------------------------------------
# _resolve_repo
# ---------------------------------------------------------------------------


class TestResolveRepo:
    def test_flag_overrides_remote(self, tmp_path):
        # No git remote needed; flag short-circuits.
        assert release._resolve_repo("custom/repo", tmp_path) == "custom/repo"

    def test_https_remote_parsed(self, monkeypatch, tmp_path):
        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout="https://github.com/deftai/directive.git\n",
                stderr="",
                returncode=0,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert release._resolve_repo(None, tmp_path) == "deftai/directive"

    def test_ssh_remote_parsed(self, monkeypatch, tmp_path):
        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout="git@github.com:deftai/directive.git\n",
                stderr="",
                returncode=0,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert release._resolve_repo(None, tmp_path) == "deftai/directive"

    def test_remote_failure_falls_back_to_default(self, monkeypatch, tmp_path):
        def fake_run(cmd, **kwargs):
            return SimpleNamespace(stdout="", stderr="boom", returncode=1)

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert release._resolve_repo(None, tmp_path) == release.DEFAULT_REPO

    def test_unparseable_remote_falls_back(self, monkeypatch, tmp_path):
        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout="ftp://elsewhere/foo\n", stderr="", returncode=0
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert release._resolve_repo(None, tmp_path) == release.DEFAULT_REPO

    def test_git_missing_falls_back(self, monkeypatch, tmp_path):
        def fake_run(cmd, **kwargs):
            raise FileNotFoundError("git")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert release._resolve_repo(None, tmp_path) == release.DEFAULT_REPO


# ---------------------------------------------------------------------------
# promote_changelog
# ---------------------------------------------------------------------------


class TestPromoteChangelog:
    def test_heading_renamed(self):
        out = release.promote_changelog(
            SAMPLE_CHANGELOG, "0.21.0", "deftai/directive", "2026-04-28"
        )
        assert "## [0.21.0] - 2026-04-28" in out

    def test_fresh_unreleased_block_inserted_above(self):
        out = release.promote_changelog(
            SAMPLE_CHANGELOG, "0.21.0", "deftai/directive", "2026-04-28"
        )
        # Fresh empty Unreleased block must appear ABOVE the new version heading.
        unreleased_pos = out.index("## [Unreleased]")
        version_pos = out.index("## [0.21.0]")
        assert unreleased_pos < version_pos
        # Fresh Unreleased should carry the four canonical sub-sections.
        block = out[unreleased_pos:version_pos]
        for sub in ("### Added", "### Changed", "### Fixed", "### Removed"):
            assert sub in block

    def test_existing_added_entries_preserved_under_new_version(self):
        out = release.promote_changelog(
            SAMPLE_CHANGELOG, "0.21.0", "deftai/directive", "2026-04-28"
        )
        # The "New release automation (#74)" bullet was under [Unreleased]/Added;
        # it must now live under the new [0.21.0] heading.
        version_pos = out.index("## [0.21.0]")
        next_version_pos = out.index("## [0.20.2]")
        section = out[version_pos:next_version_pos]
        assert "New release automation (#74)" in section

    def test_compare_link_appended(self):
        out = release.promote_changelog(
            SAMPLE_CHANGELOG, "0.21.0", "deftai/directive", "2026-04-28"
        )
        assert (
            "[0.21.0]: https://github.com/deftai/directive/compare/v0.20.2...v0.21.0"
            in out
        )

    def test_unreleased_compare_link_updated(self):
        out = release.promote_changelog(
            SAMPLE_CHANGELOG, "0.21.0", "deftai/directive", "2026-04-28"
        )
        assert (
            "[Unreleased]: https://github.com/deftai/directive/compare/v0.21.0...HEAD"
            in out
        )
        # The previous Unreleased link must have been replaced.
        assert (
            "[Unreleased]: https://github.com/deftai/directive/compare/v0.20.2...HEAD"
            not in out
        )

    def test_link_order_preserved(self):
        out = release.promote_changelog(
            SAMPLE_CHANGELOG, "0.21.0", "deftai/directive", "2026-04-28"
        )
        # Ensure that the new [0.21.0]: link appears before the existing [0.20.2]: link.
        idx_new = out.index("[0.21.0]: https://github.com/deftai/directive/compare")
        idx_prev = out.index("[0.20.2]: https://github.com/deftai/directive/compare")
        assert idx_new < idx_prev

    def test_greenfield_first_release_uses_releases_tag_url(self):
        out = release.promote_changelog(
            GREENFIELD_CHANGELOG, "0.1.0", "owner/repo", "2026-04-28"
        )
        assert (
            "[0.1.0]: https://github.com/owner/repo/releases/tag/v0.1.0" in out
        )
        # Unreleased link is added even when there was none originally.
        assert (
            "[Unreleased]: https://github.com/owner/repo/compare/v0.1.0...HEAD" in out
        )

    def test_missing_unreleased_raises(self):
        bad = "## [0.20.0] - 2026-04-23\n\n### Added\n- Something\n"
        with pytest.raises(ValueError):
            release.promote_changelog(bad, "0.21.0", "owner/repo", "2026-04-28")

    def test_idempotent_on_repeat(self):
        # Promoting twice with different versions yields two version headings.
        once = release.promote_changelog(
            SAMPLE_CHANGELOG, "0.21.0", "deftai/directive", "2026-04-28"
        )
        twice = release.promote_changelog(
            once, "0.22.0", "deftai/directive", "2026-04-29"
        )
        assert "## [0.21.0] - 2026-04-28" in twice
        assert "## [0.22.0] - 2026-04-29" in twice
        # Latest Unreleased compare link points at the most recent release.
        assert (
            "[Unreleased]: https://github.com/deftai/directive/compare/v0.22.0...HEAD"
            in twice
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class TestSectionForVersion:
    def test_extracts_body(self):
        out = release.promote_changelog(
            SAMPLE_CHANGELOG, "0.21.0", "deftai/directive", "2026-04-28"
        )
        body = release._section_for_version(out, "0.21.0")
        assert "New release automation (#74)" in body
        # Stops at the next heading.
        assert "Prior change" not in body

    def test_missing_version_returns_empty(self):
        body = release._section_for_version(SAMPLE_CHANGELOG, "9.9.9")
        assert body == ""


class TestSplitBodyAndLinks:
    def test_splits_at_first_link(self):
        body, footer = release._split_body_and_links(SAMPLE_CHANGELOG)
        assert "## [Unreleased]" in body
        assert footer.startswith("[Unreleased]:")
        assert "[0.20.2]:" in footer

    def test_no_links_returns_empty_footer(self):
        body, footer = release._split_body_and_links("# title\n\nbody only\n")
        assert footer == ""
        assert body.endswith("body only\n")


# ---------------------------------------------------------------------------
# task_has_target / run_ci
# ---------------------------------------------------------------------------


class TestTaskHasTarget:
    def test_target_present(self, monkeypatch, tmp_path):
        listing = (
            "task: Available tasks for this project:\n"
            "* ci:local: Run CI locally\n"
            "* check: Run checks\n"
        )

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(stdout=listing, stderr="", returncode=0)

        monkeypatch.setattr(release, "task_binary_available", lambda: True)
        monkeypatch.setattr(subprocess, "run", fake_run)
        assert release.task_has_target("ci:local", cwd=tmp_path) is True
        assert release.task_has_target("check", cwd=tmp_path) is True

    def test_target_absent(self, monkeypatch, tmp_path):
        listing = (
            "task: Available tasks for this project:\n* check: Run checks\n"
        )

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(stdout=listing, stderr="", returncode=0)

        monkeypatch.setattr(release, "task_binary_available", lambda: True)
        monkeypatch.setattr(subprocess, "run", fake_run)
        assert release.task_has_target("ci:local", cwd=tmp_path) is False

    def test_missing_task_binary(self, monkeypatch, tmp_path):
        monkeypatch.setattr(release, "task_binary_available", lambda: False)
        assert release.task_has_target("ci:local", cwd=tmp_path) is False


class TestRunCI:
    def test_prefers_ci_local(self, monkeypatch, tmp_path):
        invoked = {}

        monkeypatch.setattr(release, "task_binary_available", lambda: True)

        def fake_has(target, *, cwd):
            return target == "ci:local"

        monkeypatch.setattr(release, "task_has_target", fake_has)

        def fake_run(cmd, **kwargs):
            invoked["cmd"] = cmd
            return SimpleNamespace(returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release.run_ci(tmp_path)
        assert ok is True
        assert "ci:local" in reason
        assert invoked["cmd"] == ["task", "ci:local"]

    def test_falls_back_to_check(self, monkeypatch, tmp_path):
        invoked = {}

        monkeypatch.setattr(release, "task_binary_available", lambda: True)

        def fake_has(target, *, cwd):
            return target == "check"

        monkeypatch.setattr(release, "task_has_target", fake_has)

        def fake_run(cmd, **kwargs):
            invoked["cmd"] = cmd
            return SimpleNamespace(returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release.run_ci(tmp_path)
        assert ok is True
        assert "check" in reason
        assert invoked["cmd"] == ["task", "check"]

    def test_reports_failure_when_neither_exists(self, monkeypatch, tmp_path):
        monkeypatch.setattr(release, "task_binary_available", lambda: True)
        monkeypatch.setattr(release, "task_has_target", lambda *_a, **_kw: False)
        ok, reason = release.run_ci(tmp_path)
        assert ok is False
        assert "neither" in reason

    def test_reports_failure_when_ci_returns_nonzero(self, monkeypatch, tmp_path):
        monkeypatch.setattr(release, "task_binary_available", lambda: True)
        monkeypatch.setattr(release, "task_has_target", lambda *_a, **_kw: True)

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(returncode=2)

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release.run_ci(tmp_path)
        assert ok is False
        assert "exit 2" in reason


# ---------------------------------------------------------------------------
# Pipeline (run_pipeline / main)
# ---------------------------------------------------------------------------


class TestPipeline:
    def test_dry_run_does_not_write_or_invoke(self, temp_project, monkeypatch, capsys):
        # No CI / build / git / gh interactions allowed.
        def boom(*_a, **_kw):  # pragma: no cover - asserted not called
            raise AssertionError("subprocess.run should not be invoked in dry-run")

        # Allow git status / branch lookups inside check_git_clean? No --
        # dry-run skips them entirely.
        config = _make_config(temp_project, dry_run=True)
        original = (temp_project / "CHANGELOG.md").read_text(encoding="utf-8")
        # Patch all side-effecting helpers.
        with patch.object(subprocess, "run", boom):
            rc = release.run_pipeline(config)
        assert rc == release.EXIT_OK
        assert (temp_project / "CHANGELOG.md").read_text(encoding="utf-8") == original
        captured = capsys.readouterr()
        assert "DRYRUN" in captured.err

    def test_dirty_tree_refused_without_allow_dirty(self, temp_project):
        # Introduce an uncommitted change.
        (temp_project / "dirty.txt").write_text("dirty", encoding="utf-8")
        config = _make_config(temp_project)
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_VIOLATION

    def test_dirty_tree_accepted_with_allow_dirty(
        self, temp_project, monkeypatch
    ):
        (temp_project / "dirty.txt").write_text("dirty", encoding="utf-8")
        # Stub everything beyond the dirty-tree check.
        monkeypatch.setattr(release, "run_ci", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "refresh_roadmap", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "run_build", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "commit_release_artifacts", lambda *_a, **_kw: (True, "stub"))
        config = _make_config(temp_project, allow_dirty=True)
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_OK

    def test_wrong_branch_refused(self, temp_project, monkeypatch):
        # Switch to a feature branch.
        subprocess.run(
            ["git", "-C", str(temp_project), "checkout", "-q", "-b", "feature/x"],
            check=True,
        )
        config = _make_config(temp_project)
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_VIOLATION

    def test_skip_tag_suppresses_git_invocations(
        self, temp_project, monkeypatch, capsys
    ):
        monkeypatch.setattr(release, "run_ci", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "refresh_roadmap", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "run_build", lambda *_a, **_kw: (True, "stub"))

        def boom_commit(*_a, **_kw):  # pragma: no cover - asserted not called
            raise AssertionError(
                "commit_release_artifacts must not be called when --skip-tag"
            )

        def boom_tag(*_a, **_kw):  # pragma: no cover - asserted not called
            raise AssertionError("create_tag must not be called when --skip-tag")

        def boom_push(*_a, **_kw):  # pragma: no cover - asserted not called
            raise AssertionError(
                "push_release must not be called when --skip-tag"
            )

        monkeypatch.setattr(release, "commit_release_artifacts", boom_commit)
        monkeypatch.setattr(release, "create_tag", boom_tag)
        monkeypatch.setattr(release, "push_release", boom_push)
        config = _make_config(temp_project, skip_tag=True, skip_release=True)
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_OK
        captured = capsys.readouterr()
        assert "SKIP (--skip-tag)" in captured.err

    def test_skip_release_suppresses_gh(
        self, temp_project, monkeypatch, capsys
    ):
        monkeypatch.setattr(release, "run_ci", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "refresh_roadmap", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "run_build", lambda *_a, **_kw: (True, "stub"))

        def boom_release(*_a, **_kw):  # pragma: no cover - asserted not called
            raise AssertionError("create_github_release must not be called when --skip-release")

        # Stub the new commit step so the pipeline can run end-to-end
        # without touching the synthetic git repo.
        monkeypatch.setattr(
            release, "commit_release_artifacts", lambda *_a, **_kw: (True, "stub")
        )
        monkeypatch.setattr(release, "create_github_release", boom_release)
        config = _make_config(temp_project, skip_tag=True, skip_release=True)
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_OK
        captured = capsys.readouterr()
        assert "SKIP (--skip-release)" in captured.err

    def test_ci_failure_exits_violation(self, temp_project, monkeypatch):
        monkeypatch.setattr(
            release, "run_ci", lambda *_a, **_kw: (False, "task check failed")
        )
        config = _make_config(temp_project)
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_VIOLATION

    def test_changelog_missing_exits_config_error(self, temp_project, monkeypatch):
        (temp_project / "CHANGELOG.md").unlink()
        # Commit the deletion so the dirty-tree pre-flight does not pre-empt
        # the missing-CHANGELOG branch we are exercising here.
        subprocess.run(
            ["git", "-C", str(temp_project), "add", "-A"], check=True
        )
        subprocess.run(
            ["git", "-C", str(temp_project), "commit", "-q", "-m", "remove changelog"],
            check=True,
        )
        monkeypatch.setattr(release, "run_ci", lambda *_a, **_kw: (True, "stub"))
        config = _make_config(temp_project)
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_CONFIG_ERROR

    def test_changelog_without_unreleased_exits_config_error(
        self, temp_project, monkeypatch
    ):
        (temp_project / "CHANGELOG.md").write_text(
            "# Changelog\n\n## [0.20.0] - 2026-04-23\n\n- Something\n",
            encoding="utf-8",
        )
        # Stage and commit so the tree is clean.
        subprocess.run(
            ["git", "-C", str(temp_project), "add", "CHANGELOG.md"], check=True
        )
        subprocess.run(
            ["git", "-C", str(temp_project), "commit", "-q", "-m", "remove unreleased"],
            check=True,
        )
        monkeypatch.setattr(release, "run_ci", lambda *_a, **_kw: (True, "stub"))
        config = _make_config(temp_project)
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_CONFIG_ERROR

    def test_changelog_promoted_after_pipeline_writes(
        self, temp_project, monkeypatch
    ):
        monkeypatch.setattr(release, "run_ci", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "refresh_roadmap", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "run_build", lambda *_a, **_kw: (True, "stub"))
        # Stub the commit-release-artifacts step so we don't try to mutate
        # the synthetic git repo state during the test.
        monkeypatch.setattr(
            release, "commit_release_artifacts", lambda *_a, **_kw: (True, "stub")
        )
        config = _make_config(temp_project)
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_OK
        text = (temp_project / "CHANGELOG.md").read_text(encoding="utf-8")
        assert "## [0.21.0] - " in text
        assert (
            "[0.21.0]: https://github.com/deftai/directive/compare/v0.20.2...v0.21.0"
            in text
        )

    def test_pipeline_commits_release_artifacts_before_tag(
        self, temp_project, monkeypatch
    ):
        """Greptile P1 regression (#74): the pipeline MUST commit CHANGELOG.md
        (and ROADMAP.md when present) BEFORE invoking ``git tag``, so the
        annotated tag points at the promoted commit and the working tree is
        clean post-pipeline. We assert the call order and the final tree state.
        """
        order: list[str] = []

        def fake_commit(project_root, version):
            order.append("commit")
            # Drive the same effect as the real helper by staging + committing
            # the promoted CHANGELOG so the post-pipeline tree is clean.
            subprocess.run(
                ["git", "-C", str(project_root), "add", "CHANGELOG.md"], check=True
            )
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(project_root),
                    "commit",
                    "-q",
                    "-m",
                    f"chore(release): v{version}",
                ],
                check=True,
            )
            return True, f"committed v{version}"

        def fake_tag(project_root, version):
            order.append("tag")
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(project_root),
                    "tag",
                    "-a",
                    f"v{version}",
                    "-m",
                    f"Release v{version}",
                ],
                check=True,
            )
            return True, f"created tag v{version}"

        def fake_push(project_root, version, base_branch):
            order.append("push")
            return True, f"pushed {base_branch} + v{version}"

        monkeypatch.setattr(release, "run_ci", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "refresh_roadmap", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "run_build", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "commit_release_artifacts", fake_commit)
        monkeypatch.setattr(release, "create_tag", fake_tag)
        monkeypatch.setattr(release, "push_release", fake_push)
        # skip_release=True so we don't depend on gh CLI behavior here.
        config = _make_config(temp_project, skip_tag=False, skip_release=True)
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_OK
        assert order == ["commit", "tag", "push"], (
            "commit_release_artifacts MUST run BEFORE create_tag and push_release; "
            f"observed order: {order}"
        )
        # The release tag must resolve to a commit whose tree contains the
        # promoted CHANGELOG (the heading we just wrote).
        log = subprocess.run(
            [
                "git",
                "-C",
                str(temp_project),
                "show",
                "--no-patch",
                "--format=%s",
                "v0.21.0",
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        assert "chore(release): v0.21.0" in log.stdout
        # Working tree is clean (no leftover dirty CHANGELOG / ROADMAP).
        status = subprocess.run(
            ["git", "-C", str(temp_project), "status", "--porcelain"],
            capture_output=True,
            text=True,
            check=True,
        )
        assert status.stdout.strip() == "", (
            f"working tree is dirty post-pipeline: {status.stdout!r}"
        )


# ---------------------------------------------------------------------------
# main / argv-level
# ---------------------------------------------------------------------------


class TestMain:
    def test_invalid_version_arg_exits_2(self, capsys):
        rc = release.main(["not-a-version"])
        assert rc == release.EXIT_CONFIG_ERROR
        captured = capsys.readouterr()
        assert "Invalid version" in captured.err

    def test_missing_version_arg_errors_via_argparse(self):
        with pytest.raises(SystemExit) as exc:
            release.main([])
        # argparse exits 2 on missing required positional.
        assert exc.value.code == 2

    def test_help_exits_0(self):
        with pytest.raises(SystemExit) as exc:
            release.main(["--help"])
        assert exc.value.code == 0

    def test_main_dry_run_round_trip(self, temp_project, monkeypatch):
        monkeypatch.chdir(temp_project)
        original = (temp_project / "CHANGELOG.md").read_text(encoding="utf-8")
        rc = release.main(
            [
                "0.21.0",
                "--dry-run",
                "--skip-tag",
                "--skip-release",
                "--repo",
                "deftai/directive",
                "--project-root",
                str(temp_project),
            ]
        )
        assert rc == release.EXIT_OK
        # Dry-run leaves the file byte-identical.
        assert (temp_project / "CHANGELOG.md").read_text(encoding="utf-8") == original


# ---------------------------------------------------------------------------
# Subprocess-driven smoke test (only runs when uv + python are on PATH)
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# commit_release_artifacts / push_release
# ---------------------------------------------------------------------------


class TestCommitReleaseArtifacts:
    def test_commit_stages_changelog_and_roadmap(self, temp_project):
        # Modify CHANGELOG and add a ROADMAP so both files are in scope.
        (temp_project / "CHANGELOG.md").write_text(
            SAMPLE_CHANGELOG.replace("## [Unreleased]", "## [0.21.0] - 2026-04-28"),
            encoding="utf-8",
        )
        (temp_project / "ROADMAP.md").write_text(
            "# Roadmap\n\n## Active\n- foo\n", encoding="utf-8"
        )
        ok, reason = release.commit_release_artifacts(temp_project, "0.21.0")
        assert ok is True
        assert "committed" in reason
        # The new release commit must be on HEAD with the canonical subject.
        log = subprocess.run(
            [
                "git",
                "-C",
                str(temp_project),
                "log",
                "-1",
                "--format=%s",
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        assert "chore(release): v0.21.0" in log.stdout
        # Tree must be clean.
        status = subprocess.run(
            ["git", "-C", str(temp_project), "status", "--porcelain"],
            capture_output=True,
            text=True,
            check=True,
        )
        assert status.stdout.strip() == ""

    def test_commit_no_op_when_nothing_changed(self, temp_project):
        # Tree is already clean from the fixture.
        ok, reason = release.commit_release_artifacts(temp_project, "0.21.0")
        assert ok is True
        # The helper must NOT create an empty commit when there is nothing to
        # stage; reason should mention the no-op.
        assert (
            "already up-to-date" in reason or "no commit needed" in reason
        ), reason

    def test_commit_skips_when_no_release_artifacts_exist(self, tmp_path):
        empty = tmp_path / "empty"
        empty.mkdir()
        # Initialise git so _run_git does not blow up; no CHANGELOG.md.
        subprocess.run(
            ["git", "init", "-q", "-b", "master", str(empty)], check=True
        )
        subprocess.run(
            ["git", "-C", str(empty), "config", "user.email", "t@x"],
            check=True,
        )
        subprocess.run(
            ["git", "-C", str(empty), "config", "user.name", "T"], check=True
        )
        ok, reason = release.commit_release_artifacts(empty, "0.21.0")
        assert ok is True
        assert "none exist" in reason

    def test_release_commit_subject_format(self):
        # The commit subject must be deterministic so reviewers / grep / git log
        # filtering can find release commits without parsing variants.
        assert (
            release._release_commit_subject("0.21.0")
            == "chore(release): v0.21.0 -- promote CHANGELOG + ROADMAP"
        )


class TestPushRelease:
    def test_push_release_invokes_atomic_with_branch_and_tag(self, monkeypatch, tmp_path):
        captured = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            return SimpleNamespace(stdout="", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release.push_release(tmp_path, "0.21.0", "master")
        assert ok is True
        assert "pushed master + v0.21.0" in reason
        # Verify --atomic + branch + tag in the argv.
        assert "--atomic" in captured["cmd"]
        assert "master" in captured["cmd"]
        assert "v0.21.0" in captured["cmd"]

    def test_push_release_reports_failure(self, monkeypatch, tmp_path):
        def fake_run(cmd, **kwargs):
            return SimpleNamespace(stdout="", stderr="non-fast-forward", returncode=1)

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release.push_release(tmp_path, "0.21.0", "master")
        assert ok is False
        assert "non-fast-forward" in reason

    def test_push_tag_alias_uses_default_base_branch(self, monkeypatch, tmp_path):
        captured = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            return SimpleNamespace(stdout="", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, _ = release.push_tag(tmp_path, "0.21.0")
        assert ok is True
        # The deprecated alias delegates to push_release with the default
        # base branch -- proves backwards compatibility for any external
        # caller still importing push_tag.
        assert release.DEFAULT_BASE_BRANCH in captured["cmd"]


# ---------------------------------------------------------------------------
# Subprocess smoke
# ---------------------------------------------------------------------------


class TestSubprocessSmoke:
    def test_help_via_subprocess(self):
        if shutil.which("python") is None:
            pytest.skip("python not on PATH")
        result = subprocess.run(
            [sys.executable, str(REPO_ROOT / "scripts" / "release.py"), "--help"],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0
        assert "release" in result.stdout
        assert "--dry-run" in result.stdout
