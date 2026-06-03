"""
test_swarm_complete_cohort.py -- Tests for scripts/swarm_complete_cohort.py.

Covers the deterministic swarm cohort completion sweep (#1487):

* Stage 1 sweeps cohort stories ``active/`` -> ``completed/``.
* Stage 2 completes decompose-created epic parents once all their children
  are settled, bridging ``pending/`` via ``activate``.
* A parent with an unsettled (still-active) sibling is left alone.
* Nested decomposition (phase -> epic -> story) collapses to a fixpoint.
* ``task vbrief:validate`` stays green after the sweep -- no D4 regressions,
  relying on scope_lifecycle's #1485 / #1487 reference maintenance.
* ``--dry-run`` mutates nothing; ``--json`` emits a structured verdict; an
  empty cohort is a config error.

Issue #1487.
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import swarm_complete_cohort as scc  # noqa: E402, I001

# ---------------------------------------------------------------------------
# Fixtures / builders
# ---------------------------------------------------------------------------

LIFECYCLE_FOLDERS = ("proposed", "pending", "active", "completed", "cancelled")

ORIGIN_REF = {
    "uri": "https://github.com/deftai/directive/issues/1487",
    "type": "x-vbrief/github-issue",
    "title": "Issue #1487",
}


def _make_tree(tmp_path: Path) -> Path:
    """Create the five lifecycle folders and return the vbrief root."""
    vbrief_root = tmp_path / "vbrief"
    for folder in LIFECYCLE_FOLDERS:
        (vbrief_root / folder).mkdir(parents=True, exist_ok=True)
    return vbrief_root


def _write(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def make_story(
    vbrief_root: Path,
    *,
    name: str,
    folder: str = "active",
    status: str = "running",
    parent_rel: str | None = None,
) -> Path:
    """Create a story vBRIEF (optionally with a planRef back to a parent)."""
    plan: dict = {
        "title": f"Story {name}",
        "status": status,
        "items": [],
        "metadata": {"kind": "story"},
        "references": [ORIGIN_REF],
    }
    if parent_rel is not None:
        plan["planRef"] = parent_rel
    path = vbrief_root / folder / name
    _write(path, {"vBRIEFInfo": {"version": "0.6"}, "plan": plan})
    return path


def make_epic(
    vbrief_root: Path,
    *,
    name: str,
    folder: str = "pending",
    status: str = "pending",
    child_rels: list[str],
    parent_rel: str | None = None,
) -> Path:
    """Create an epic vBRIEF listing children via x-vbrief/plan references."""
    references = [ORIGIN_REF]
    for child_rel in child_rels:
        references.append(
            {"uri": child_rel, "type": "x-vbrief/plan", "title": "child"}
        )
    plan: dict = {
        "title": f"Epic {name}",
        "status": status,
        "items": [],
        "metadata": {"kind": "epic"},
        "references": references,
    }
    if parent_rel is not None:
        plan["planRef"] = parent_rel
    path = vbrief_root / folder / name
    _write(path, {"vBRIEFInfo": {"version": "0.6"}, "plan": plan})
    return path


def read_plan(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))["plan"]


def validate_errors(tmp_path: Path) -> list[str]:
    import vbrief_validate

    errors, _warnings, _count = vbrief_validate.validate_all(tmp_path / "vbrief")
    return errors


# ---------------------------------------------------------------------------
# Stage 1 -- story completion
# ---------------------------------------------------------------------------


class TestStorySweep:
    def test_single_story_active_to_completed(self, tmp_path):
        vroot = _make_tree(tmp_path)
        story = make_story(vroot, name="2026-06-03-s1.vbrief.json")

        result = scc.sweep_cohort([story], tmp_path, dry_run=False)

        assert result.ok
        assert not (vroot / "active" / "2026-06-03-s1.vbrief.json").exists()
        dest = vroot / "completed" / "2026-06-03-s1.vbrief.json"
        assert dest.exists()
        assert read_plan(dest)["status"] == "completed"
        assert len(result.stories) == 1
        assert result.stories[0].action == "complete"

    def test_already_completed_story_is_noop(self, tmp_path):
        vroot = _make_tree(tmp_path)
        story = make_story(
            vroot,
            name="2026-06-03-done.vbrief.json",
            folder="completed",
            status="completed",
        )

        result = scc.sweep_cohort([story], tmp_path, dry_run=False)

        assert result.ok
        assert result.stories[0].action == "noop"
        # File stays put.
        assert story.exists()

    def test_pending_story_is_skipped(self, tmp_path):
        vroot = _make_tree(tmp_path)
        story = make_story(
            vroot,
            name="2026-06-03-pend.vbrief.json",
            folder="pending",
            status="pending",
        )

        result = scc.sweep_cohort([story], tmp_path, dry_run=False)

        assert result.ok
        assert result.stories[0].action == "skip"
        assert story.exists()  # untouched


# ---------------------------------------------------------------------------
# Stage 2 -- epic parent completion
# ---------------------------------------------------------------------------


class TestEpicParentSweep:
    def _decomposed_cohort(self, tmp_path):
        """Epic in pending/ with two children in active/."""
        vroot = _make_tree(tmp_path)
        epic_name = "2026-06-03-epic.vbrief.json"
        epic = make_epic(
            vroot,
            name=epic_name,
            child_rels=[
                "active/2026-06-03-c1.vbrief.json",
                "active/2026-06-03-c2.vbrief.json",
            ],
        )
        c1 = make_story(
            vroot,
            name="2026-06-03-c1.vbrief.json",
            parent_rel=f"pending/{epic_name}",
        )
        c2 = make_story(
            vroot,
            name="2026-06-03-c2.vbrief.json",
            parent_rel=f"pending/{epic_name}",
        )
        return vroot, epic, c1, c2

    def test_baseline_validates(self, tmp_path):
        self._decomposed_cohort(tmp_path)
        assert validate_errors(tmp_path) == []

    def test_parent_completed_when_all_children_settled(self, tmp_path):
        vroot, epic, c1, c2 = self._decomposed_cohort(tmp_path)

        result = scc.sweep_cohort([c1, c2], tmp_path, dry_run=False)

        assert result.ok
        # Children swept.
        assert (vroot / "completed" / "2026-06-03-c1.vbrief.json").exists()
        assert (vroot / "completed" / "2026-06-03-c2.vbrief.json").exists()
        # Epic parent completed (pending -> completed via activate+complete).
        assert not (vroot / "pending" / "2026-06-03-epic.vbrief.json").exists()
        epic_done = vroot / "completed" / "2026-06-03-epic.vbrief.json"
        assert epic_done.exists()
        assert read_plan(epic_done)["status"] == "completed"
        assert len(result.parents) == 1
        assert result.parents[0].action == "activate+complete"

    def test_validate_green_after_sweep(self, tmp_path):
        vroot, epic, c1, c2 = self._decomposed_cohort(tmp_path)
        scc.sweep_cohort([c1, c2], tmp_path, dry_run=False)
        # No D4 regression: parent moved AND children planRefs followed (#1487).
        assert validate_errors(tmp_path) == []

    def test_parent_not_completed_when_sibling_still_active(self, tmp_path):
        vroot, epic, c1, c2 = self._decomposed_cohort(tmp_path)

        # Only sweep c1; c2 stays active (not part of this dispatch).
        result = scc.sweep_cohort([c1], tmp_path, dry_run=False)

        assert result.ok
        assert (vroot / "completed" / "2026-06-03-c1.vbrief.json").exists()
        # Parent must NOT have completed -- a child is still active.
        assert (vroot / "pending" / "2026-06-03-epic.vbrief.json").exists()
        assert result.parents == []
        # Linkage still green (c1 completed, parent ref to c1 followed).
        assert validate_errors(tmp_path) == []

    def test_active_parent_completed_directly(self, tmp_path):
        vroot = _make_tree(tmp_path)
        epic_name = "2026-06-03-epic.vbrief.json"
        make_epic(
            vroot,
            name=epic_name,
            folder="active",
            status="running",
            child_rels=["active/2026-06-03-c1.vbrief.json"],
        )
        c1 = make_story(
            vroot,
            name="2026-06-03-c1.vbrief.json",
            parent_rel=f"active/{epic_name}",
        )

        result = scc.sweep_cohort([c1], tmp_path, dry_run=False)

        assert result.ok
        assert (vroot / "completed" / epic_name).exists()
        assert result.parents[0].action == "complete"
        assert validate_errors(tmp_path) == []

    def test_idempotent_rerun(self, tmp_path):
        vroot, epic, c1, c2 = self._decomposed_cohort(tmp_path)
        scc.sweep_cohort([c1, c2], tmp_path, dry_run=False)

        # Re-run pointing at the now-completed children.
        rerun_children = [
            vroot / "completed" / "2026-06-03-c1.vbrief.json",
            vroot / "completed" / "2026-06-03-c2.vbrief.json",
        ]
        result = scc.sweep_cohort(rerun_children, tmp_path, dry_run=False)

        assert result.ok
        assert all(r.action == "noop" for r in result.stories)
        assert validate_errors(tmp_path) == []


# ---------------------------------------------------------------------------
# Nested decomposition fixpoint (phase -> epic -> story)
# ---------------------------------------------------------------------------


class TestNestedFixpoint:
    def test_phase_epic_story_collapse(self, tmp_path):
        vroot = _make_tree(tmp_path)
        phase_name = "2026-06-03-phase.vbrief.json"
        epic_name = "2026-06-03-epic.vbrief.json"
        story_name = "2026-06-03-story.vbrief.json"

        # phase (pending) -> epic (pending) -> story (active)
        make_epic(
            vroot,
            name=phase_name,
            child_rels=[f"pending/{epic_name}"],
        )
        make_epic(
            vroot,
            name=epic_name,
            child_rels=[f"active/{story_name}"],
            parent_rel=f"pending/{phase_name}",
        )
        story = make_story(
            vroot, name=story_name, parent_rel=f"pending/{epic_name}"
        )

        assert validate_errors(tmp_path) == []

        result = scc.sweep_cohort([story], tmp_path, dry_run=False)

        assert result.ok
        # All three collapsed to completed/.
        assert (vroot / "completed" / story_name).exists()
        assert (vroot / "completed" / epic_name).exists()
        assert (vroot / "completed" / phase_name).exists()
        # Two parents completed (epic + phase).
        assert len(result.parents) == 2
        assert validate_errors(tmp_path) == []


# ---------------------------------------------------------------------------
# Dry-run / JSON / CLI
# ---------------------------------------------------------------------------


class TestDryRun:
    def test_dry_run_mutates_nothing(self, tmp_path):
        vroot = _make_tree(tmp_path)
        epic_name = "2026-06-03-epic.vbrief.json"
        make_epic(
            vroot,
            name=epic_name,
            child_rels=["active/2026-06-03-c1.vbrief.json"],
        )
        c1 = make_story(
            vroot,
            name="2026-06-03-c1.vbrief.json",
            parent_rel=f"pending/{epic_name}",
        )

        result = scc.sweep_cohort([c1], tmp_path, dry_run=True)

        assert result.ok
        # Nothing moved.
        assert c1.exists()
        assert (vroot / "pending" / epic_name).exists()
        assert not (vroot / "completed" / "2026-06-03-c1.vbrief.json").exists()
        # But the plan is reported.
        assert result.stories[0].action == "complete"
        assert result.parents[0].action == "activate+complete"


class TestCLI:
    def test_empty_cohort_is_config_error(self, tmp_path):
        _make_tree(tmp_path)
        rc = scc.main(["--project-root", str(tmp_path)])
        assert rc == scc.EXIT_CONFIG_ERROR

    def test_missing_vbrief_dir_is_config_error(self, tmp_path):
        rc = scc.main(["--project-root", str(tmp_path), "x.vbrief.json"])
        assert rc == scc.EXIT_CONFIG_ERROR

    def test_json_output(self, tmp_path, capsys):
        vroot = _make_tree(tmp_path)
        make_story(vroot, name="2026-06-03-s1.vbrief.json")

        rc = scc.main(
            [
                "--cohort",
                "vbrief/active/*.vbrief.json",
                "--project-root",
                str(tmp_path),
                "--json",
            ]
        )
        assert rc == scc.EXIT_OK
        payload = json.loads(capsys.readouterr().out)
        assert payload["ok"] is True
        assert payload["dry_run"] is False
        assert len(payload["stories"]) == 1
        assert payload["stories"][0]["action"] == "complete"

    def test_cohort_glob_resolution(self, tmp_path):
        vroot = _make_tree(tmp_path)
        make_story(vroot, name="2026-06-03-a.vbrief.json")
        make_story(vroot, name="2026-06-03-b.vbrief.json")

        paths, errors = scc.resolve_cohort_paths(
            [], ["vbrief/active/*.vbrief.json"], tmp_path
        )
        assert errors == []
        assert len(paths) == 2

    def test_glob_no_match_is_soft_error(self, tmp_path):
        _make_tree(tmp_path)
        paths, errors = scc.resolve_cohort_paths(
            [], ["vbrief/active/nope-*.vbrief.json"], tmp_path
        )
        assert paths == []
        assert errors and "matched no files" in errors[0]

    def test_subprocess_smoke(self, tmp_path):
        vroot = _make_tree(tmp_path)
        make_story(vroot, name="2026-06-03-s1.vbrief.json")
        result = subprocess.run(
            [
                sys.executable,
                str(REPO_ROOT / "scripts" / "swarm_complete_cohort.py"),
                "vbrief/active/2026-06-03-s1.vbrief.json",
                "--project-root",
                str(tmp_path),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert result.returncode == 0
        assert "SWEEP CLEAN" in result.stdout
        assert (vroot / "completed" / "2026-06-03-s1.vbrief.json").exists()


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-v"]))
