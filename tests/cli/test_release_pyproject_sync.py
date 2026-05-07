"""test_release_pyproject_sync.py -- pyproject [project].version sync (#771).

Coverage for the Phase A integration of #771 in ``scripts/release.py``:

- Pure ``update_pyproject_version(text, version)`` helper:
    * happy-path rewrite under ``[project]``;
    * idempotent no-op when the line is already at the target version;
    * preserves surrounding whitespace + comments + sub-tables;
    * does NOT clobber ``version`` keys in ``[tool.*]`` sub-tables;
    * raises ``ValueError`` when no ``[project].version`` exists;
    * raises ``ValueError`` on non-string / empty input.

- ``_sync_pyproject_for_release(path, version, *, dry_run)`` outcome
  helper:
    * happy path returns the updated text + a ``-> X.Y.Z`` note;
    * idempotent no-op returns ``None`` text + ``already at`` note;
    * non-publishable tags (``v0.0.0-test.1``) skip the sync cleanly;
    * missing pyproject.toml skips the sync cleanly;
    * malformed pyproject (no ``[project]``) returns a ``FAIL (...)`` note;
    * dry-run never returns mutating text.

- ``run_pipeline`` Step 5 integration:
    * pyproject.toml is rewritten when present;
    * Step 5 OK line surfaces the pyproject sync outcome;
    * non-publishable test tags pass the pipeline but skip the file write
      (covered via direct call to ``_sync_pyproject_for_release`` since
      the pipeline's strict ``_validate_version`` rejects ``test.N`` at
      the argparse layer; the helper-level skip is the contract for
      future pre-release flows that bypass the strict guard);
    * ``pyproject.toml`` is included in ``_RELEASE_ARTIFACTS`` so the
      commit step stages it alongside CHANGELOG / ROADMAP.

Regression scope (#771).
"""

from __future__ import annotations

import importlib.util
import re
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module():
    """Load scripts/release.py in-process (mirrors test_release.py)."""
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "release",
        scripts_dir / "release.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["release"] = module
    spec.loader.exec_module(module)
    return module


release = _load_module()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


SAMPLE_PYPROJECT = """\
[project]
name = "deft-directive"
version = "0.5.0"
description = "A layered framework for AI-assisted development"
requires-python = ">=3.11"

[tool.pytest.ini_options]
testpaths = ["tests"]

[tool.poetry]
# Sub-table version key MUST be left untouched.
version = "0.0.0-poetry-only"
name = "deft-directive"

[tool.ruff]
line-length = 100
"""


SAMPLE_CHANGELOG = """\
 Changelog

## [Unreleased]

### Added
- New release automation (#771)

## [0.20.2] - 2026-04-24

### Added
- Prior change

[Unreleased]: https://github.com/deftai/directive/compare/v0.20.2...HEAD
[0.20.2]: https://github.com/deftai/directive/compare/v0.20.0...v0.20.2
"""


@pytest.fixture
def temp_project(tmp_path: Path) -> Path:
    """Synthetic project with CHANGELOG.md, pyproject.toml, and clean git."""
    project = tmp_path / "proj"
    project.mkdir()
    (project / "CHANGELOG.md").write_text(SAMPLE_CHANGELOG, encoding="utf-8")
    (project / "pyproject.toml").write_text(SAMPLE_PYPROJECT, encoding="utf-8")
    subprocess.run(
        ["git", "init", "-q", "-b", "master", str(project)], check=True
    )
    subprocess.run(
        ["git", "-C", str(project), "config", "user.email", "t@x"], check=True
    )
    subprocess.run(
        ["git", "-C", str(project), "config", "user.name", "T"], check=True
    )
    subprocess.run(
        ["git", "-C", str(project), "add", "-A"], check=True
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
        "allow_vbrief_drift": True,
    }
    defaults.update(overrides)
    return release.ReleaseConfig(**defaults)


# ---------------------------------------------------------------------------
# update_pyproject_version (pure helper)
# ---------------------------------------------------------------------------


class TestUpdatePyprojectVersion:
    def test_rewrites_project_version(self):
        out = release.update_pyproject_version(SAMPLE_PYPROJECT, "0.21.0")
        assert 'version = "0.21.0"' in out
        # The original 0.5.0 is gone from the [project] section.
        assert 'version = "0.5.0"' not in out

    def test_idempotent_when_already_at_version(self):
        # First rewrite to a known target.
        once = release.update_pyproject_version(SAMPLE_PYPROJECT, "0.21.0")
        # Second rewrite to the same target is byte-for-byte identical.
        twice = release.update_pyproject_version(once, "0.21.0")
        assert twice == once

    def test_does_not_clobber_subtable_version(self):
        # The ``[tool.poetry]`` sub-table carries a deliberately distinct
        # ``version = "0.0.0-poetry-only"`` line that MUST survive the
        # rewrite untouched. The pyproject sync targets only ``[project]``.
        out = release.update_pyproject_version(SAMPLE_PYPROJECT, "0.21.0")
        assert '"0.0.0-poetry-only"' in out, (
            "sub-table [tool.poetry] version key was clobbered"
        )

    def test_preserves_surrounding_lines(self):
        out = release.update_pyproject_version(SAMPLE_PYPROJECT, "0.21.0")
        # description / requires-python / sub-tables / comments preserved.
        assert "A layered framework for AI-assisted development" in out
        assert 'requires-python = ">=3.11"' in out
        assert "[tool.pytest.ini_options]" in out
        assert "[tool.poetry]" in out
        assert "[tool.ruff]" in out
        assert "Sub-table version key MUST be left untouched." in out

    def test_raises_on_missing_project_section(self):
        bad = "[tool.ruff]\nline-length = 100\n"
        with pytest.raises(ValueError):
            release.update_pyproject_version(bad, "0.21.0")

    def test_raises_when_project_section_has_no_version(self):
        bad = '[project]\nname = "deft-directive"\nrequires-python = ">=3.11"\n'
        with pytest.raises(ValueError):
            release.update_pyproject_version(bad, "0.21.0")

    def test_raises_on_empty_version(self):
        with pytest.raises(ValueError):
            release.update_pyproject_version(SAMPLE_PYPROJECT, "")
        with pytest.raises(ValueError):
            release.update_pyproject_version(SAMPLE_PYPROJECT, "   ")

    def test_raises_on_non_string_input(self):
        with pytest.raises(ValueError):
            release.update_pyproject_version(None, "0.21.0")  # type: ignore[arg-type]
        with pytest.raises(ValueError):
            release.update_pyproject_version(SAMPLE_PYPROJECT, None)  # type: ignore[arg-type]

    def test_pep440_pre_release_format(self):
        # The helper accepts whatever the caller passes -- the pipeline is
        # responsible for normalizing via to_pep440 first. We assert that
        # PEP 440 pre-release strings round-trip cleanly.
        out = release.update_pyproject_version(SAMPLE_PYPROJECT, "0.20.0rc3")
        assert 'version = "0.20.0rc3"' in out

    def test_handles_alternative_quoting_styles(self):
        text = '[project]\nname = "deft"\nversion="0.5.0"\n'
        out = release.update_pyproject_version(text, "0.21.0")
        assert 'version = "0.21.0"' in out


# ---------------------------------------------------------------------------
# _sync_pyproject_for_release (outcome helper)
# ---------------------------------------------------------------------------


class TestSyncPyprojectForRelease:
    def test_happy_path_returns_text(self, tmp_path: Path):
        path = tmp_path / "pyproject.toml"
        path.write_text(SAMPLE_PYPROJECT, encoding="utf-8")
        note, new_text = release._sync_pyproject_for_release(
            path, "0.21.0", dry_run=False
        )
        assert note == "pyproject [project].version -> 0.21.0"
        assert new_text is not None
        assert 'version = "0.21.0"' in new_text

    def test_idempotent_already_at_version(self, tmp_path: Path):
        path = tmp_path / "pyproject.toml"
        path.write_text(
            SAMPLE_PYPROJECT.replace('version = "0.5.0"', 'version = "0.21.0"'),
            encoding="utf-8",
        )
        note, new_text = release._sync_pyproject_for_release(
            path, "0.21.0", dry_run=False
        )
        assert "already at 0.21.0" in note
        assert new_text is None, (
            "idempotent path MUST NOT return mutating text -- the pipeline "
            "uses None to signal no write is needed"
        )

    def test_missing_pyproject_skips(self, tmp_path: Path):
        # File does not exist on disk.
        path = tmp_path / "missing-pyproject.toml"
        note, new_text = release._sync_pyproject_for_release(
            path, "0.21.0", dry_run=False
        )
        assert "no pyproject.toml" in note
        assert "skipping sync" in note
        assert new_text is None

    def test_non_publishable_skips(self, tmp_path: Path):
        # ``v0.0.0-test.1`` triggers NonPublishableVersionError and the
        # pipeline MUST treat the case as a clean skip rather than a fail.
        path = tmp_path / "pyproject.toml"
        path.write_text(SAMPLE_PYPROJECT, encoding="utf-8")
        note, new_text = release._sync_pyproject_for_release(
            path, "0.0.0-test.1", dry_run=False
        )
        assert note.startswith("non-publishable tag"), note
        assert "skipping pyproject sync" in note
        assert new_text is None
        # And the actual file is NOT touched.
        assert path.read_text(encoding="utf-8") == SAMPLE_PYPROJECT

    def test_malformed_pyproject_returns_fail(self, tmp_path: Path):
        path = tmp_path / "pyproject.toml"
        path.write_text("[tool.ruff]\nline-length = 100\n", encoding="utf-8")
        note, new_text = release._sync_pyproject_for_release(
            path, "0.21.0", dry_run=False
        )
        assert note.startswith("FAIL"), note
        assert new_text is None

    def test_dry_run_does_not_return_text(self, tmp_path: Path):
        path = tmp_path / "pyproject.toml"
        path.write_text(SAMPLE_PYPROJECT, encoding="utf-8")
        note, new_text = release._sync_pyproject_for_release(
            path, "0.21.0", dry_run=True
        )
        # The note still surfaces the planned change so operators can see
        # it during ``--dry-run`` review, but no mutating text is returned.
        assert "0.21.0" in note
        assert new_text is None

    def test_pep440_normalizes_pre_release(self, tmp_path: Path):
        path = tmp_path / "pyproject.toml"
        path.write_text(SAMPLE_PYPROJECT, encoding="utf-8")
        # The helper normalizes via to_pep440, so an rc tag arrives in
        # PEP 440 form (rc.3 -> rc3) when the pyproject is rewritten.
        # NOTE: scripts/release.py validates strict X.Y.Z at argparse, so
        # this code path is exercised by future / programmatic callers.
        note, new_text = release._sync_pyproject_for_release(
            path, "0.20.0-rc.3", dry_run=False
        )
        assert "0.20.0rc3" in note
        assert new_text is not None
        assert 'version = "0.20.0rc3"' in new_text


# ---------------------------------------------------------------------------
# Pipeline Step 5 integration
# ---------------------------------------------------------------------------


class TestPipelineStep5PyprojectIntegration:
    def test_pipeline_writes_pyproject_version(
        self, temp_project, monkeypatch, capsys
    ):
        """Step 5 writes pyproject.toml [project].version when present."""
        monkeypatch.setattr(
            release,
            "check_tag_available",
            lambda *_a, **_kw: (True, "stub"),
        )
        monkeypatch.setattr(release, "run_ci", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "refresh_roadmap", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "run_build", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(
            release, "commit_release_artifacts", lambda *_a, **_kw: (True, "stub")
        )
        config = _make_config(temp_project)
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_OK
        post = (temp_project / "pyproject.toml").read_text(encoding="utf-8")
        assert 'version = "0.21.0"' in post, (
            "#771: pipeline Step 5 MUST sync pyproject.toml [project].version"
        )
        # The sub-table version is preserved.
        assert '"0.0.0-poetry-only"' in post

        # Step 5 OK line surfaces the pyproject outcome inline.
        out = capsys.readouterr().err
        assert "pyproject [project].version -> 0.21.0" in out

    def test_dry_run_does_not_write_pyproject(
        self, temp_project, monkeypatch, capsys
    ):
        """Dry-run preview includes the pyproject plan but writes nothing."""
        # Allow git status -- dry_run skips it anyway via the run_pipeline path.
        original = (temp_project / "pyproject.toml").read_text(encoding="utf-8")

        def boom(*_a, **_kw):  # pragma: no cover - asserted not called
            raise AssertionError("subprocess MUST NOT run during dry-run")

        config = _make_config(temp_project, dry_run=True)
        with patch.object(subprocess, "run", boom):
            rc = release.run_pipeline(config)
        assert rc == release.EXIT_OK
        # File is byte-identical post dry-run.
        assert (temp_project / "pyproject.toml").read_text(encoding="utf-8") == original
        out = capsys.readouterr().err
        # The DRYRUN body MUST surface the pyproject sync plan so the
        # operator can validate it in Phase 2.
        assert "pyproject [project].version -> 0.21.0" in out

    def test_idempotent_pipeline_pyproject_sync(
        self, temp_project, monkeypatch, capsys
    ):
        """Running the pipeline twice with the same target yields identical pyproject."""
        # Pre-set the file at the target so the first run is already idempotent.
        (temp_project / "pyproject.toml").write_text(
            SAMPLE_PYPROJECT.replace('version = "0.5.0"', 'version = "0.21.0"'),
            encoding="utf-8",
        )
        subprocess.run(
            ["git", "-C", str(temp_project), "add", "pyproject.toml"], check=True
        )
        subprocess.run(
            ["git", "-C", str(temp_project), "commit", "-q", "-m", "pre-sync"],
            check=True,
        )

        monkeypatch.setattr(
            release,
            "check_tag_available",
            lambda *_a, **_kw: (True, "stub"),
        )
        monkeypatch.setattr(release, "run_ci", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "refresh_roadmap", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "run_build", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(
            release, "commit_release_artifacts", lambda *_a, **_kw: (True, "stub")
        )
        config = _make_config(temp_project)
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_OK
        out = capsys.readouterr().err
        # Step 5 surfaces the no-op outcome.
        assert "pyproject already at 0.21.0" in out

    def test_pipeline_skips_pyproject_when_missing(
        self, tmp_path: Path, monkeypatch, capsys
    ):
        """The pipeline runs cleanly when the project has no pyproject.toml.

        The synthetic ``temp_project`` fixture in test_release.py omits
        pyproject.toml; this test guards that behaviour explicitly so
        future pipeline edits cannot regress projects that intentionally
        ship without ``pyproject.toml`` (e.g. pure-Go / pure-shell trees).
        """
        project = tmp_path / "proj"
        project.mkdir()
        (project / "CHANGELOG.md").write_text(SAMPLE_CHANGELOG, encoding="utf-8")
        subprocess.run(
            ["git", "init", "-q", "-b", "master", str(project)], check=True
        )
        subprocess.run(
            ["git", "-C", str(project), "config", "user.email", "t@x"], check=True
        )
        subprocess.run(
            ["git", "-C", str(project), "config", "user.name", "T"], check=True
        )
        subprocess.run(
            ["git", "-C", str(project), "add", "-A"], check=True
        )
        subprocess.run(
            ["git", "-C", str(project), "commit", "-q", "-m", "init"], check=True
        )

        monkeypatch.setattr(
            release,
            "check_tag_available",
            lambda *_a, **_kw: (True, "stub"),
        )
        monkeypatch.setattr(release, "run_ci", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "refresh_roadmap", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "run_build", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(
            release, "commit_release_artifacts", lambda *_a, **_kw: (True, "stub")
        )
        config = _make_config(project, allow_vbrief_drift=True)
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_OK
        out = capsys.readouterr().err
        assert "no pyproject.toml; skipping sync" in out

    def test_pipeline_fail_on_malformed_pyproject(
        self, temp_project, monkeypatch, capsys
    ):
        """Malformed pyproject.toml halts the pipeline with EXIT_CONFIG_ERROR."""
        (temp_project / "pyproject.toml").write_text(
            "[tool.ruff]\nline-length = 100\n", encoding="utf-8"
        )
        # Re-commit so the dirty-tree gate doesn't pre-empt the failure.
        subprocess.run(
            ["git", "-C", str(temp_project), "add", "pyproject.toml"], check=True
        )
        subprocess.run(
            [
                "git",
                "-C",
                str(temp_project),
                "commit",
                "-q",
                "-m",
                "malformed pyproject",
            ],
            check=True,
        )
        monkeypatch.setattr(
            release,
            "check_tag_available",
            lambda *_a, **_kw: (True, "stub"),
        )
        monkeypatch.setattr(release, "run_ci", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "refresh_roadmap", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "run_build", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(
            release, "commit_release_artifacts", lambda *_a, **_kw: (True, "stub")
        )
        config = _make_config(temp_project)
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_CONFIG_ERROR
        out = capsys.readouterr().err
        assert "FAIL" in out
        assert "pyproject.toml" in out


# ---------------------------------------------------------------------------
# _RELEASE_ARTIFACTS includes pyproject.toml
# ---------------------------------------------------------------------------


class TestReleaseArtifactsConstant:
    def test_pyproject_toml_in_release_artifacts(self):
        # The commit step stages this set; pyproject.toml MUST be present
        # so the Step 5 sync lands in the same release commit as the
        # CHANGELOG promotion (otherwise the working tree would be dirty
        # post-pipeline and the annotated tag would predate the sync).
        assert "pyproject.toml" in release._RELEASE_ARTIFACTS, (
            "#771: pyproject.toml MUST be in _RELEASE_ARTIFACTS so the "
            "commit step stages it alongside CHANGELOG.md / ROADMAP.md"
        )

    def test_existing_release_artifacts_preserved(self):
        # Defensive guard against accidental removal of CHANGELOG / ROADMAP.
        assert "CHANGELOG.md" in release._RELEASE_ARTIFACTS
        assert "ROADMAP.md" in release._RELEASE_ARTIFACTS

    def test_commit_release_artifacts_stages_pyproject(self, tmp_path: Path):
        """commit_release_artifacts MUST stage pyproject.toml when present."""
        project = tmp_path / "proj"
        project.mkdir()
        # Initialise git repo with all three release artifacts present.
        (project / "CHANGELOG.md").write_text("changelog\n", encoding="utf-8")
        (project / "ROADMAP.md").write_text("roadmap\n", encoding="utf-8")
        (project / "pyproject.toml").write_text(
            SAMPLE_PYPROJECT, encoding="utf-8"
        )
        subprocess.run(
            ["git", "init", "-q", "-b", "master", str(project)], check=True
        )
        subprocess.run(
            ["git", "-C", str(project), "config", "user.email", "t@x"], check=True
        )
        subprocess.run(
            ["git", "-C", str(project), "config", "user.name", "T"], check=True
        )
        subprocess.run(
            ["git", "-C", str(project), "add", "-A"], check=True
        )
        subprocess.run(
            ["git", "-C", str(project), "commit", "-q", "-m", "init"], check=True
        )

        # Mutate all three so they're stage-able.
        (project / "CHANGELOG.md").write_text("changelog v2\n", encoding="utf-8")
        (project / "ROADMAP.md").write_text("roadmap v2\n", encoding="utf-8")
        (project / "pyproject.toml").write_text(
            SAMPLE_PYPROJECT.replace('version = "0.5.0"', 'version = "0.21.0"'),
            encoding="utf-8",
        )
        ok, reason = release.commit_release_artifacts(project, "0.21.0")
        assert ok is True
        assert "committed" in reason

        # All three files must appear in the resulting commit.
        names = subprocess.run(
            [
                "git",
                "-C",
                str(project),
                "show",
                "--no-patch",
                "--stat",
                "HEAD",
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        assert "CHANGELOG.md" in names.stdout
        assert "ROADMAP.md" in names.stdout
        assert "pyproject.toml" in names.stdout


# ---------------------------------------------------------------------------
# uv.lock regeneration (#774 Greptile P1)
# ---------------------------------------------------------------------------


# A minimal uv.lock fixture: only the [[package]] entry for the root project
# carries a ``version = "..."`` line we can compare to pyproject.toml. Real
# uv.lock files are ~hundreds of KB but the rewrite-to-match-pyproject
# behaviour is identical, and a fixture this small keeps the test fast.
SAMPLE_UV_LOCK = """\
version = 1
requires-python = ">=3.11"

[[package]]
name = "deft-directive"
version = "0.5.0"
source = { editable = "." }
"""


def _stub_uv_lock_writer(version: str):
    """Build a stub for ``release.run_uv_lock`` that rewrites uv.lock.

    The real ``uv lock`` invocation rewrites the lockfile so the root
    project's ``[[package]]`` ``version`` matches pyproject.toml. The
    stub mimics that single observable side effect so the regression
    test can assert pyproject.toml and uv.lock end up at the same
    version after a synthetic release flow -- without requiring the
    ``uv`` binary at test time (CI may not have a Python toolchain
    installed in every environment, and even when it does the real
    ``uv lock`` resolves the full dependency graph, which is several
    seconds of wall clock per test).
    """

    def _stub(project_root):
        lockfile = project_root / "uv.lock"
        if not lockfile.is_file():
            return True, "uv.lock unchanged (no lockfile present)"
        text = lockfile.read_text(encoding="utf-8")
        # Rewrite the FIRST version line (the root [[package]] entry --
        # transitive dep entries come later in real lockfiles, but the
        # SAMPLE_UV_LOCK fixture has only one ``version = "..."``).
        rewritten = re.sub(
            r'^version = "[^"]*"',
            f'version = "{version}"',
            text,
            count=1,
            flags=re.MULTILINE,
        )
        lockfile.write_text(rewritten, encoding="utf-8")
        return True, "uv.lock regenerated"

    return _stub


class TestUvLockReleaseIntegration:
    """#774 Greptile P1: uv.lock MUST be staged + regenerated."""

    def test_uv_lock_in_release_artifacts(self):
        """uv.lock MUST appear in _RELEASE_ARTIFACTS so commit step stages it."""
        assert "uv.lock" in release._RELEASE_ARTIFACTS, (
            "#774: uv.lock MUST be in _RELEASE_ARTIFACTS so the commit step "
            "stages the freshly-regenerated lockfile in the release commit "
            "-- otherwise pyproject.toml and uv.lock versions diverge in "
            "the released tag and `uv lock --check` fails post-pipeline."
        )

    def test_pipeline_versions_match_after_release(
        self, temp_project, monkeypatch, capsys
    ):
        """Synthetic release flow: uv.lock + pyproject.toml MUST agree.

        This is the regression assertion for #774: every run of the
        release pipeline against a project with both ``pyproject.toml``
        and ``uv.lock`` MUST end up with the lockfile recording the
        same ``version`` as pyproject.toml. Without the ``uv lock``
        invocation in Step 5 (#774 fix) the pyproject would advance to
        ``0.21.0`` while uv.lock stayed at ``0.5.0``.
        """
        # Drop a uv.lock fixture next to pyproject.toml.
        lock_path = temp_project / "uv.lock"
        lock_path.write_text(SAMPLE_UV_LOCK, encoding="utf-8")
        subprocess.run(
            ["git", "-C", str(temp_project), "add", "uv.lock"], check=True
        )
        subprocess.run(
            ["git", "-C", str(temp_project), "commit", "-q", "-m", "add uv.lock"],
            check=True,
        )

        monkeypatch.setattr(
            release,
            "check_tag_available",
            lambda *_a, **_kw: (True, "stub"),
        )
        monkeypatch.setattr(release, "run_ci", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "refresh_roadmap", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "run_build", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(
            release, "commit_release_artifacts", lambda *_a, **_kw: (True, "stub")
        )
        # Stub run_uv_lock so the test does not depend on a uv binary or
        # a resolvable dependency graph -- the stub mimics the single
        # observable side effect (lockfile version = pyproject version).
        monkeypatch.setattr(release, "run_uv_lock", _stub_uv_lock_writer("0.21.0"))

        config = _make_config(temp_project)
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_OK

        # The PRIMARY regression assertion: pyproject.toml and uv.lock
        # MUST record the same version after a synthetic release flow.
        pyproject_text = (temp_project / "pyproject.toml").read_text(encoding="utf-8")
        uv_lock_text = lock_path.read_text(encoding="utf-8")
        assert 'version = "0.21.0"' in pyproject_text, (
            "pyproject.toml [project].version MUST advance to 0.21.0"
        )
        assert 'version = "0.21.0"' in uv_lock_text, (
            "#774: uv.lock root [[package]] version MUST match pyproject.toml "
            "(0.21.0) after the release pipeline runs -- the bug Greptile "
            "P1 caught was that uv.lock stayed at the old version and "
            "`uv lock --check` failed on every released tag."
        )
        # Sanity: the OLD version is gone from the lockfile too.
        assert 'version = "0.5.0"' not in uv_lock_text

        # Step 5 OK line surfaces the uv.lock outcome.
        out = capsys.readouterr().err
        assert "uv.lock regenerated" in out

    def test_pipeline_skips_uv_lock_when_pyproject_unchanged(
        self, temp_project, monkeypatch, capsys
    ):
        """Idempotent path: pyproject already at target -> no uv lock invocation.

        When the pyproject sync is a no-op (already at the target version),
        running ``uv lock`` would only churn -- the lockfile is already
        consistent. Skipping the call keeps the pipeline fast and avoids
        unnecessary network resolution on idempotent re-runs.
        """
        # Pre-set pyproject at the target version so the sync is a no-op.
        (temp_project / "pyproject.toml").write_text(
            SAMPLE_PYPROJECT.replace('version = "0.5.0"', 'version = "0.21.0"'),
            encoding="utf-8",
        )
        # Drop a uv.lock fixture too so the no-op path can be observed.
        lock_path = temp_project / "uv.lock"
        lock_path.write_text(
            SAMPLE_UV_LOCK.replace('version = "0.5.0"', 'version = "0.21.0"'),
            encoding="utf-8",
        )
        subprocess.run(
            ["git", "-C", str(temp_project), "add", "-A"], check=True
        )
        subprocess.run(
            [
                "git",
                "-C",
                str(temp_project),
                "commit",
                "-q",
                "-m",
                "pre-sync at target",
            ],
            check=True,
        )

        called = {"count": 0}

        def _spy(*_a, **_kw):  # pragma: no cover - asserted not called
            called["count"] += 1
            return True, "uv.lock regenerated"

        monkeypatch.setattr(
            release,
            "check_tag_available",
            lambda *_a, **_kw: (True, "stub"),
        )
        monkeypatch.setattr(release, "run_ci", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "refresh_roadmap", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "run_build", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(
            release, "commit_release_artifacts", lambda *_a, **_kw: (True, "stub")
        )
        monkeypatch.setattr(release, "run_uv_lock", _spy)

        config = _make_config(temp_project)
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_OK
        assert called["count"] == 0, (
            "run_uv_lock MUST NOT be called when pyproject.toml is already "
            "at the target version -- the lockfile is already consistent."
        )

        out = capsys.readouterr().err
        assert "pyproject already at 0.21.0" in out
        assert "uv.lock unchanged" in out

    def test_pipeline_fails_when_uv_lock_errors(
        self, temp_project, monkeypatch, capsys
    ):
        """`uv lock` non-zero exit MUST halt the pipeline with EXIT_VIOLATION."""
        lock_path = temp_project / "uv.lock"
        lock_path.write_text(SAMPLE_UV_LOCK, encoding="utf-8")
        subprocess.run(
            ["git", "-C", str(temp_project), "add", "uv.lock"], check=True
        )
        subprocess.run(
            ["git", "-C", str(temp_project), "commit", "-q", "-m", "add uv.lock"],
            check=True,
        )

        monkeypatch.setattr(
            release,
            "check_tag_available",
            lambda *_a, **_kw: (True, "stub"),
        )
        monkeypatch.setattr(release, "run_ci", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "refresh_roadmap", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(release, "run_build", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(
            release, "commit_release_artifacts", lambda *_a, **_kw: (True, "stub")
        )
        monkeypatch.setattr(
            release,
            "run_uv_lock",
            lambda *_a, **_kw: (False, "uv lock failed (exit 1): conflict"),
        )

        config = _make_config(temp_project)
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_VIOLATION
        out = capsys.readouterr().err
        assert "FAIL" in out
        assert "uv lock failed" in out


class TestRunUvLock:
    """Direct-call coverage for ``release.run_uv_lock`` (#774)."""

    def test_skips_when_no_pyproject(self, tmp_path: Path):
        ok, reason = release.run_uv_lock(tmp_path)
        assert ok is True
        assert "no pyproject.toml" in reason

    def test_skips_when_uv_not_on_path(self, tmp_path: Path, monkeypatch, capsys):
        (tmp_path / "pyproject.toml").write_text(SAMPLE_PYPROJECT, encoding="utf-8")
        monkeypatch.setattr(release.shutil, "which", lambda _name: None)
        ok, reason = release.run_uv_lock(tmp_path)
        assert ok is True, (
            "missing uv binary is a non-fatal skip; the pyproject sync "
            "already landed and the operator can run uv lock manually"
        )
        assert "uv binary not on PATH" in reason
        # Warning is surfaced on stderr so operators see the skip.
        out = capsys.readouterr().err
        assert "WARNING" in out
        assert "uv.lock" in out

    def test_returns_failure_on_non_zero_exit(self, tmp_path: Path, monkeypatch):
        (tmp_path / "pyproject.toml").write_text(SAMPLE_PYPROJECT, encoding="utf-8")
        monkeypatch.setattr(release.shutil, "which", lambda _name: "/fake/uv")

        class _CompletedProcess:
            returncode = 1
            stderr = "resolution failed"
            stdout = ""

        monkeypatch.setattr(
            release.subprocess, "run", lambda *_a, **_kw: _CompletedProcess()
        )
        ok, reason = release.run_uv_lock(tmp_path)
        assert ok is False
        assert "uv lock failed" in reason
        assert "exit 1" in reason
