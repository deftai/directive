"""test_release_vbrief_lifecycle.py -- release pipeline lifecycle gate (#734).

Coverage for the new ``check_vbrief_lifecycle_sync`` helper + Step 3
pipeline wiring inserted between branch guard (Step 2) and CI (Step 4),
plus the ``--allow-vbrief-drift`` escape hatch (analogous to
``--allow-dirty``):

- ``check_vbrief_lifecycle_sync`` returns clean when Section (c) is
  empty (no closed-issue mismatches).
- Returns FAIL with ``mismatch_count > 0`` when one or more closed-issue
  vBRIEFs live outside ``completed/``.
- Returns config-error (-1) when ``vbrief/`` is missing.
- ``run_pipeline`` exits ``EXIT_VIOLATION`` (1) on mismatches and emits
  the canonical fail line; SKIP under ``--allow-vbrief-drift``.
- ``--allow-vbrief-drift`` flag wires through ``main()`` to
  ``ReleaseConfig.allow_vbrief_drift``.
- ``_TOTAL_STEPS`` constant equals 12 (was 11 pre-#734).

Story: #734.
"""

from __future__ import annotations

import importlib.util
import json
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


# ---------------------------------------------------------------------------
# Fixture: synthetic project with vbrief/ tree + clean git state
# ---------------------------------------------------------------------------


SAMPLE_CHANGELOG = """\
 Changelog

## [Unreleased]

### Added
- New thing

## [0.20.2] - 2026-04-24

### Added
- Old thing

[Unreleased]: https://github.com/deftai/directive/compare/v0.20.2...HEAD
[0.20.2]: https://github.com/deftai/directive/compare/v0.20.0...v0.20.2
"""


def _write_vbrief(
    vbrief_dir: Path, folder: str, filename: str, issue_number: int
) -> Path:
    folder_path = vbrief_dir / folder
    folder_path.mkdir(parents=True, exist_ok=True)
    data = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "title": f"#{issue_number}",
            "status": "running",
            "items": [],
            "references": [
                {
                    "uri": (
                        f"https://github.com/deftai/directive/issues/"
                        f"{issue_number}"
                    ),
                    "type": "x-vbrief/github-issue",
                    "title": f"Issue #{issue_number}",
                }
            ],
        },
    }
    p = folder_path / filename
    p.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return p


@pytest.fixture
def temp_project_with_vbrief(tmp_path: Path) -> Path:
    """Synthetic project on master with CHANGELOG + an empty vbrief/ tree."""
    project = tmp_path / "proj"
    project.mkdir()
    (project / "CHANGELOG.md").write_text(SAMPLE_CHANGELOG, encoding="utf-8")
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
        # gate is the focus of this module -- DO NOT override here.
    }
    defaults.update(overrides)
    return release.ReleaseConfig(**defaults)


# ---------------------------------------------------------------------------
# check_vbrief_lifecycle_sync (#734)
# ---------------------------------------------------------------------------


class TestCheckVbriefLifecycleSyncHelper:
    def test_clean_returns_ok_zero(self, temp_project_with_vbrief, monkeypatch):
        """No vBRIEFs + no open issues -> (True, 0, 'no mismatches')."""
        # Stub fetch_open_issues so the helper does not fire gh.
        import reconcile_issues  # type: ignore

        monkeypatch.setattr(
            reconcile_issues, "fetch_open_issues", lambda _r, cwd=None: []
        )
        ok, count, reason = release.check_vbrief_lifecycle_sync(
            temp_project_with_vbrief, "deftai/directive"
        )
        assert ok is True
        assert count == 0
        assert "no mismatches" in reason

    def test_mismatch_returns_fail(self, temp_project_with_vbrief, monkeypatch):
        """Closed-issue vBRIEF in proposed/ -> (False, 1, ...)."""
        _write_vbrief(
            temp_project_with_vbrief / "vbrief",
            "proposed",
            "2026-04-29-101-closed.vbrief.json",
            issue_number=101,
        )
        import reconcile_issues  # type: ignore

        # gh reports zero open issues -> #101 is closed.
        monkeypatch.setattr(
            reconcile_issues, "fetch_open_issues", lambda _r, cwd=None: []
        )
        ok, count, reason = release.check_vbrief_lifecycle_sync(
            temp_project_with_vbrief, "deftai/directive"
        )
        assert ok is False
        assert count == 1
        assert "proposed/2026-04-29-101-closed" in reason

    def test_completed_folder_mismatch_excluded(
        self, temp_project_with_vbrief, monkeypatch
    ):
        """A vBRIEF already in completed/ does NOT count as a mismatch."""
        _write_vbrief(
            temp_project_with_vbrief / "vbrief",
            "completed",
            "2026-04-29-102-already.vbrief.json",
            issue_number=102,
        )
        import reconcile_issues  # type: ignore

        monkeypatch.setattr(
            reconcile_issues, "fetch_open_issues", lambda _r, cwd=None: []
        )
        ok, count, _reason = release.check_vbrief_lifecycle_sync(
            temp_project_with_vbrief, "deftai/directive"
        )
        assert ok is True, (
            "completed/ vBRIEFs MUST NOT be flagged as mismatches"
        )
        assert count == 0

    def test_vbrief_dir_missing_returns_config_error(self, tmp_path):
        """No vbrief/ folder -> (False, -1, 'vbrief directory not found')."""
        empty = tmp_path / "empty"
        empty.mkdir()
        ok, count, reason = release.check_vbrief_lifecycle_sync(
            empty, "deftai/directive"
        )
        assert ok is False
        assert count == -1
        assert "vbrief directory not found" in reason

    def test_gh_failure_returns_config_error(
        self, temp_project_with_vbrief, monkeypatch
    ):
        """gh fetch returns None -> (False, -1, 'failed to fetch...')."""
        import reconcile_issues  # type: ignore

        monkeypatch.setattr(
            reconcile_issues, "fetch_open_issues", lambda _r, cwd=None: None
        )
        ok, count, reason = release.check_vbrief_lifecycle_sync(
            temp_project_with_vbrief, "deftai/directive"
        )
        assert ok is False
        assert count == -1
        assert "failed to fetch" in reason


# ---------------------------------------------------------------------------
# Pipeline Step 3 wiring + escape hatch
# ---------------------------------------------------------------------------


class TestPipelineStep3:
    def test_clean_proceeds_to_step_4(
        self, temp_project_with_vbrief, monkeypatch, capsys
    ):
        """Clean lifecycle gate -> proceeds to CI step (Step 4)."""
        # Stub the gate explicitly so we don't import reconcile_issues.
        monkeypatch.setattr(
            release,
            "check_vbrief_lifecycle_sync",
            lambda *_a, **_kw: (True, 0, "no mismatches"),
        )
        monkeypatch.setattr(release, "run_ci", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(
            release, "refresh_roadmap", lambda *_a, **_kw: (True, "stub")
        )
        monkeypatch.setattr(release, "run_build", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(
            release, "commit_release_artifacts", lambda *_a, **_kw: (True, "stub")
        )
        config = _make_config(temp_project_with_vbrief, skip_tag=True, skip_release=True)
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_OK
        out = capsys.readouterr().err
        # Step 3 line emits the canonical OK token.
        assert "[3/12] Pre-flight vBRIEF lifecycle sync... OK" in out
        # Step 4 (CI) ran (proves we did not bail at Step 3).
        assert "[4/12]" in out

    def test_mismatch_returns_violation(
        self, temp_project_with_vbrief, monkeypatch, capsys
    ):
        """Mismatch -> EXIT_VIOLATION (1) with operator-actionable message."""
        monkeypatch.setattr(
            release,
            "check_vbrief_lifecycle_sync",
            lambda *_a, **_kw: (
                False,
                3,
                "3 closed-issue vBRIEF(s) not in completed/: ...",
            ),
        )
        # Should never reach run_ci.
        monkeypatch.setattr(
            release,
            "run_ci",
            lambda *_a, **_kw: pytest.fail(
                "run_ci must NOT be called when the lifecycle gate fails"
            ),
        )
        config = _make_config(temp_project_with_vbrief)
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_VIOLATION
        out = capsys.readouterr().err
        assert "[3/12] Pre-flight vBRIEF lifecycle sync... FAIL" in out
        # Operator-actionable: the canonical recovery command MUST appear.
        assert "task reconcile:issues -- --apply-lifecycle-fixes" in out
        assert "--allow-vbrief-drift" in out
        # Mismatch count is surfaced.
        assert "3 mismatches" in out

    def test_config_error_returns_exit_2(
        self, temp_project_with_vbrief, monkeypatch
    ):
        """vbrief dir missing / gh unavailable -> EXIT_CONFIG_ERROR (2)."""
        monkeypatch.setattr(
            release,
            "check_vbrief_lifecycle_sync",
            lambda *_a, **_kw: (False, -1, "vbrief directory not found at /nope"),
        )
        config = _make_config(temp_project_with_vbrief)
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_CONFIG_ERROR

    def test_allow_vbrief_drift_skips_gate(
        self, temp_project_with_vbrief, monkeypatch, capsys
    ):
        """--allow-vbrief-drift -> Step 3 SKIP, gate helper NOT invoked."""
        def boom(*_a, **_kw):  # pragma: no cover - asserted not called
            raise AssertionError(
                "check_vbrief_lifecycle_sync MUST NOT fire when "
                "--allow-vbrief-drift is set"
            )

        monkeypatch.setattr(release, "check_vbrief_lifecycle_sync", boom)
        monkeypatch.setattr(release, "run_ci", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(
            release, "refresh_roadmap", lambda *_a, **_kw: (True, "stub")
        )
        monkeypatch.setattr(release, "run_build", lambda *_a, **_kw: (True, "stub"))
        monkeypatch.setattr(
            release, "commit_release_artifacts", lambda *_a, **_kw: (True, "stub")
        )
        config = _make_config(
            temp_project_with_vbrief, allow_vbrief_drift=True
        )
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_OK
        out = capsys.readouterr().err
        assert "[3/12] Pre-flight vBRIEF lifecycle sync... SKIP (--allow-vbrief-drift)" in out

    def test_dry_run_emits_step3_dryrun_label(
        self, temp_project_with_vbrief, capsys
    ):
        """Dry-run never invokes the gate; emits a DRYRUN line."""
        config = _make_config(temp_project_with_vbrief, dry_run=True)
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_OK
        out = capsys.readouterr().err
        assert "[3/12] Pre-flight vBRIEF lifecycle sync... DRYRUN" in out


# ---------------------------------------------------------------------------
# argparse / main wiring + _TOTAL_STEPS constant
# ---------------------------------------------------------------------------


class TestArgparseAndConstants:
    def test_total_steps_constant_is_12(self):
        """_TOTAL_STEPS bumped from 11 to 12 for the new lifecycle gate."""
        assert release._TOTAL_STEPS == 12

    def test_allow_vbrief_drift_flag_lands_in_config(self, monkeypatch, tmp_path):
        captured = {}

        def fake_run_pipeline(config):
            captured["allow_vbrief_drift"] = config.allow_vbrief_drift
            return release.EXIT_OK

        monkeypatch.setattr(release, "run_pipeline", fake_run_pipeline)
        rc = release.main(
            [
                "0.21.0",
                "--allow-vbrief-drift",
                "--skip-tag",
                "--skip-release",
                "--repo",
                "deftai/directive",
                "--project-root",
                str(tmp_path),
            ]
        )
        assert rc == release.EXIT_OK
        assert captured["allow_vbrief_drift"] is True

    def test_default_allow_vbrief_drift_false(self, monkeypatch, tmp_path):
        captured = {}

        def fake_run_pipeline(config):
            captured["allow_vbrief_drift"] = config.allow_vbrief_drift
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
        assert captured["allow_vbrief_drift"] is False
