"""Acceptance tests for ``task vbrief:reconcile:graph`` (#1287).

The cascade-unblock walker promotes proposed/ candidates whose
``plan.metadata.swarm.depends_on[]`` entries ALL resolve to a dependency
living in ``vbrief/completed/`` or ``vbrief/cancelled/``. It respects the
WIP cap, detects dependency cycles, and is idempotent (a second run is a
no-op).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "vbrief_reconcile_graph.py"

LIFECYCLE_FOLDERS = ("proposed", "pending", "active", "completed", "cancelled")

_STATUS_FOR_FOLDER = {
    "proposed": "proposed",
    "pending": "pending",
    "active": "running",
    "completed": "completed",
    "cancelled": "cancelled",
}


def _write_brief(
    project: Path,
    story_id: str,
    *,
    folder: str = "proposed",
    depends_on: list[str] | None = None,
) -> Path:
    """Write a minimal but schema-plausible story vBRIEF into *folder*."""
    path = project / "vbrief" / folder / f"2026-05-21-{story_id}.vbrief.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "id": story_id,
            "title": story_id,
            "status": _STATUS_FOR_FOLDER[folder],
            "narratives": {
                "Description": f"{story_id} description.",
                "ImplementationPlan": f"1. Do {story_id}.",
                "UserStory": f"As a user, I want {story_id}.",
                "Traces": "FR-1",
            },
            "items": [
                {
                    "id": f"{story_id}-a1",
                    "title": "Acceptance item 1",
                    "status": "pending",
                    "narrative": {"Acceptance": f"Given X when {story_id} then Y."},
                }
            ],
            "metadata": {
                "kind": "story",
                "swarm": {
                    "readiness": "ready",
                    "parallel_safe": True,
                    "file_scope": [f"src/{story_id}.py"],
                    "verify_commands": [f"pytest {story_id}"],
                    "expected_outputs": ["tests pass"],
                    "depends_on": depends_on or [],
                    "conflict_group": "reconcile-suite",
                    "size": "small",
                    "file_scope_confidence": "high",
                    "model_tier": "standard",
                },
            },
        },
    }
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return path


def _write_project_definition(project: Path, *, wip_cap: int | None = None) -> None:
    plan: dict = {"id": "proj", "title": "Project", "status": "active"}
    if wip_cap is not None:
        plan["policy"] = {"wipCap": wip_cap}
    path = project / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"vBRIEFInfo": {"version": "0.6"}, "plan": plan}, indent=2),
        encoding="utf-8",
    )


def _run(project: Path, *extra: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--project-root", str(project), *extra],
        cwd=project,
        text=True,
        capture_output=True,
        check=False,
    )


def _folder_of(project: Path, story_id: str) -> str | None:
    name = f"2026-05-21-{story_id}.vbrief.json"
    for folder in LIFECYCLE_FOLDERS:
        if (project / "vbrief" / folder / name).is_file():
            return folder
    return None


def test_single_dep_resolved_promotes(tmp_path: Path) -> None:
    _write_brief(tmp_path, "dep-a", folder="completed")
    _write_brief(tmp_path, "child-b", folder="proposed", depends_on=["dep-a"])

    result = _run(tmp_path)

    assert result.returncode == 0, result.stdout + result.stderr
    assert _folder_of(tmp_path, "child-b") == "pending"
    assert "child-b" in result.stdout


def test_single_dep_unresolved_skips(tmp_path: Path) -> None:
    _write_brief(tmp_path, "dep-a", folder="pending")
    _write_brief(tmp_path, "child-b", folder="proposed", depends_on=["dep-a"])

    result = _run(tmp_path)

    assert result.returncode == 0, result.stdout + result.stderr
    assert _folder_of(tmp_path, "child-b") == "proposed"


def test_multi_dep_all_resolved_promotes(tmp_path: Path) -> None:
    _write_brief(tmp_path, "dep-a", folder="completed")
    _write_brief(tmp_path, "dep-c", folder="cancelled")
    _write_brief(tmp_path, "child-b", folder="proposed", depends_on=["dep-a", "dep-c"])

    result = _run(tmp_path)

    assert result.returncode == 0, result.stdout + result.stderr
    assert _folder_of(tmp_path, "child-b") == "pending"


def test_multi_dep_partial_unresolved_skips(tmp_path: Path) -> None:
    _write_brief(tmp_path, "dep-a", folder="completed")
    _write_brief(tmp_path, "dep-c", folder="proposed")
    _write_brief(tmp_path, "child-b", folder="proposed", depends_on=["dep-a", "dep-c"])

    result = _run(tmp_path)

    assert result.returncode == 0, result.stdout + result.stderr
    assert _folder_of(tmp_path, "child-b") == "proposed"


def test_depfree_candidate_not_promoted(tmp_path: Path) -> None:
    _write_brief(tmp_path, "loner", folder="proposed", depends_on=[])

    result = _run(tmp_path)

    assert result.returncode == 0, result.stdout + result.stderr
    assert _folder_of(tmp_path, "loner") == "proposed"


def test_cycle_detected_exit1(tmp_path: Path) -> None:
    _write_brief(tmp_path, "cyc-x", folder="proposed", depends_on=["cyc-y"])
    _write_brief(tmp_path, "cyc-y", folder="proposed", depends_on=["cyc-x"])

    result = _run(tmp_path)

    assert result.returncode == 1, result.stdout + result.stderr
    assert _folder_of(tmp_path, "cyc-x") == "proposed"
    assert _folder_of(tmp_path, "cyc-y") == "proposed"
    assert "cycle" in result.stdout.lower()


def test_wip_cap_blocks_promotion(tmp_path: Path) -> None:
    _write_project_definition(tmp_path, wip_cap=1)
    # One brief already in pending/ fills the cap (count == 1, cap == 1).
    _write_brief(tmp_path, "occupant", folder="pending")
    _write_brief(tmp_path, "dep-a", folder="completed")
    _write_brief(tmp_path, "child-b", folder="proposed", depends_on=["dep-a"])

    result = _run(tmp_path)

    assert result.returncode == 0, result.stdout + result.stderr
    assert _folder_of(tmp_path, "child-b") == "proposed"


def test_wip_cap_force_overrides(tmp_path: Path) -> None:
    _write_project_definition(tmp_path, wip_cap=1)
    _write_brief(tmp_path, "occupant", folder="pending")
    _write_brief(tmp_path, "dep-a", folder="completed")
    _write_brief(tmp_path, "child-b", folder="proposed", depends_on=["dep-a"])

    result = _run(tmp_path, "--force")

    assert result.returncode == 0, result.stdout + result.stderr
    assert _folder_of(tmp_path, "child-b") == "pending"


def test_idempotent_second_run_noop(tmp_path: Path) -> None:
    _write_brief(tmp_path, "dep-a", folder="completed")
    _write_brief(tmp_path, "child-b", folder="proposed", depends_on=["dep-a"])

    first = _run(tmp_path)
    assert first.returncode == 0, first.stdout + first.stderr
    assert _folder_of(tmp_path, "child-b") == "pending"

    second = _run(tmp_path)
    assert second.returncode == 0, second.stdout + second.stderr
    assert _folder_of(tmp_path, "child-b") == "pending"
    assert "child-b" not in second.stdout.split("Promoted", 1)[-1].split("\n\n", 1)[0]


def test_dry_run_does_not_move(tmp_path: Path) -> None:
    _write_brief(tmp_path, "dep-a", folder="completed")
    _write_brief(tmp_path, "child-b", folder="proposed", depends_on=["dep-a"])

    result = _run(tmp_path, "--dry-run")

    assert result.returncode == 0, result.stdout + result.stderr
    assert _folder_of(tmp_path, "child-b") == "proposed"
    assert "child-b" in result.stdout


def test_json_output_lists_promotions(tmp_path: Path) -> None:
    _write_brief(tmp_path, "dep-a", folder="completed")
    _write_brief(tmp_path, "child-b", folder="proposed", depends_on=["dep-a"])

    result = _run(tmp_path, "--json")

    assert result.returncode == 0, result.stdout + result.stderr
    payload = json.loads(result.stdout)
    assert "child-b" in payload["promoted"]


def test_missing_proposed_dir_exit2(tmp_path: Path) -> None:
    # No vbrief/ tree at all -> usage/config error.
    result = _run(tmp_path)

    assert result.returncode == 2, result.stdout + result.stderr
