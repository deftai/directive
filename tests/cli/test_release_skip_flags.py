"""test_release_skip_flags.py -- #720 --skip-ci / --skip-build flag tests.

Split from tests/cli/test_release.py to keep that file under the
1000-line MUST limit (AGENTS.md). Covers the two new escape hatches
introduced by #720 so the e2e rehearsal can run `task release` against
the auto-created temp repo without burning wall-clock on `task ci:local`
or `task build` (both are covered by the unit-test suite at every
commit on master).

Coverage:
- run_pipeline emits ``SKIP (--skip-ci)`` / ``SKIP (--skip-build)`` and
  does NOT invoke ``run_ci`` / ``run_build`` when the corresponding
  config field is True.
- argparse round-trip: ``--skip-ci`` / ``--skip-build`` set
  ``ReleaseConfig.skip_ci`` / ``ReleaseConfig.skip_build`` to True.
- Default values (no flags): both fields are False, preserving
  pre-#720 behaviour.
- Direct dataclass instantiation defaults to False on both fields.

Refs #720, #716, #74.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

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


SAMPLE_CHANGELOG = """\
 Changelog

## [Unreleased]

### Added
- New release automation (#74)

## [0.20.2] - 2026-04-24

### Added
- Prior change

[Unreleased]: https://github.com/deftai/directive/compare/v0.20.2...HEAD
[0.20.2]: https://github.com/deftai/directive/compare/v0.20.0...v0.20.2
"""


@pytest.fixture
def temp_project(tmp_path: Path) -> Path:
    """Initialise a synthetic project with CHANGELOG.md and a clean git tree."""
    project = tmp_path / "proj"
    project.mkdir()
    (project / "CHANGELOG.md").write_text(SAMPLE_CHANGELOG, encoding="utf-8")
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


class TestSkipCiAndSkipBuildFlags:
    """#720 e2e-rehearsal escape hatches."""

    def test_skip_ci_emits_skip_label_and_does_not_invoke_run_ci(
        self, temp_project, monkeypatch, capsys
    ):
        def boom(*_a, **_kw):  # pragma: no cover - asserted not called
            raise AssertionError(
                "run_ci MUST NOT be called when config.skip_ci is True"
            )

        monkeypatch.setattr(release, "run_ci", boom)
        # Stub out everything past Step 3 so the pipeline runs end-to-end
        # without touching real CI / build / git.
        monkeypatch.setattr(
            release, "refresh_roadmap", lambda *_a, **_kw: (True, "stub")
        )
        monkeypatch.setattr(
            release, "run_build", lambda *_a, **_kw: (True, "stub")
        )
        monkeypatch.setattr(
            release, "commit_release_artifacts",
            lambda *_a, **_kw: (True, "stub"),
        )
        config = _make_config(
            temp_project, skip_ci=True, skip_tag=True, skip_release=True
        )
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_OK
        captured = capsys.readouterr()
        assert "SKIP (--skip-ci)" in captured.err

    def test_skip_build_emits_skip_label_and_does_not_invoke_run_build(
        self, temp_project, monkeypatch, capsys
    ):
        def boom(*_a, **_kw):  # pragma: no cover - asserted not called
            raise AssertionError(
                "run_build MUST NOT be called when config.skip_build is True"
            )

        monkeypatch.setattr(release, "run_build", boom)
        monkeypatch.setattr(
            release, "run_ci", lambda *_a, **_kw: (True, "stub")
        )
        monkeypatch.setattr(
            release, "refresh_roadmap", lambda *_a, **_kw: (True, "stub")
        )
        monkeypatch.setattr(
            release, "commit_release_artifacts",
            lambda *_a, **_kw: (True, "stub"),
        )
        config = _make_config(
            temp_project, skip_build=True, skip_tag=True, skip_release=True
        )
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_OK
        captured = capsys.readouterr()
        assert "SKIP (--skip-build)" in captured.err

    def test_skip_ci_argparse_flag_sets_config_field(self, monkeypatch, tmp_path):
        captured = {}

        def fake_run_pipeline(config):
            captured["skip_ci"] = config.skip_ci
            captured["skip_build"] = config.skip_build
            return release.EXIT_OK

        monkeypatch.setattr(release, "run_pipeline", fake_run_pipeline)
        rc = release.main(
            [
                "0.21.0",
                "--skip-ci",
                "--skip-build",
                "--skip-tag",
                "--skip-release",
                "--repo",
                "deftai/directive",
                "--project-root",
                str(tmp_path),
            ]
        )
        assert rc == release.EXIT_OK
        assert captured["skip_ci"] is True
        assert captured["skip_build"] is True

    def test_default_argparse_flags_default_to_false(
        self, monkeypatch, tmp_path
    ):
        """Without the flags both default to False (current behaviour)."""
        captured = {}

        def fake_run_pipeline(config):
            captured["skip_ci"] = config.skip_ci
            captured["skip_build"] = config.skip_build
            return release.EXIT_OK

        monkeypatch.setattr(release, "run_pipeline", fake_run_pipeline)
        rc = release.main(
            [
                "0.21.0",
                "--skip-tag",
                "--skip-release",
                "--repo",
                "deftai/directive",
                "--project-root",
                str(tmp_path),
            ]
        )
        assert rc == release.EXIT_OK
        assert captured["skip_ci"] is False
        assert captured["skip_build"] is False

    def test_release_config_default_skip_ci_and_skip_build_false(
        self, tmp_path
    ):
        """Direct dataclass construction defaults match the argparse defaults."""
        config = release.ReleaseConfig(
            version="0.21.0",
            repo="deftai/directive",
            base_branch="master",
            project_root=tmp_path,
            dry_run=False,
            skip_tag=False,
            skip_release=False,
            allow_dirty=False,
        )
        assert config.skip_ci is False
        assert config.skip_build is False
