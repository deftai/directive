from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "swarm_readiness.py"


def _write_json(path: Path, data: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return path


def _story(
    project: Path,
    story_id: str,
    *,
    file_scope: list[str] | None = None,
    verify_commands: list[str] | None = None,
    acceptance: str = "Story acceptance passes",
    depends_on: list[str] | None = None,
    size: str = "small",
    confidence: str = "high",
) -> Path:
    return _write_json(
        project / "vbrief" / "active" / f"2026-05-12-{story_id}.vbrief.json",
        {
            "vBRIEFInfo": {"version": "0.6"},
            "plan": {
                "id": story_id,
                "title": story_id,
                "status": "running",
                "narratives": {"Traces": "FR-1"},
                "items": [
                    {
                        "id": f"{story_id}-a1",
                        "title": "Acceptance item",
                        "status": "pending",
                        "narrative": {"Acceptance": acceptance, "Traces": "FR-1"},
                    }
                ],
                "metadata": {
                    "kind": "story",
                    "swarm": {
                        "readiness": "ready",
                        "parallel_safe": True,
                        "file_scope": [f"src/{story_id}.ts"] if file_scope is None else file_scope,
                        "verify_commands": (
                            [f"npm test -- {story_id}"]
                            if verify_commands is None
                            else verify_commands
                        ),
                        "expected_outputs": ["focused tests pass"],
                        "depends_on": depends_on or [],
                        "conflict_group": "auth",
                        "size": size,
                        "file_scope_confidence": confidence,
                        "model_tier": "medium",
                    },
                },
            },
        },
    )


def _run(project: Path, *paths: Path) -> subprocess.CompletedProcess[str]:
    args = [str(path.relative_to(project)) for path in paths]
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args, "--project-root", str(project)],
        cwd=project,
        text=True,
        capture_output=True,
        check=False,
    )


def test_readiness_passes_for_ready_story(tmp_path: Path) -> None:
    story = _story(tmp_path, "story-ready")

    result = _run(tmp_path, story)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "Ready stories:" in result.stdout
    assert "story-ready" in result.stdout
    assert "Blocked stories:\n- none" in result.stdout


def test_readiness_fails_missing_acceptance_file_scope_and_verify_commands(tmp_path: Path) -> None:
    story = _story(tmp_path, "story-missing", file_scope=[], verify_commands=[], acceptance="")

    result = _run(tmp_path, story)

    assert result.returncode == 1
    assert "plan.items[].narrative.Acceptance" in result.stdout
    assert "plan.metadata.swarm.file_scope" in result.stdout
    assert "plan.metadata.swarm.verify_commands" in result.stdout


def test_readiness_reports_epic_phase_as_decomposition_needed(tmp_path: Path) -> None:
    phase = _write_json(
        tmp_path / "vbrief" / "active" / "2026-05-12-ip001-auth.vbrief.json",
        {
            "vBRIEFInfo": {"version": "0.6"},
            "plan": {
                "id": "ip-1",
                "title": "IP-1: Auth",
                "status": "running",
                "narratives": {"Acceptance": "Broad epic acceptance", "Traces": "FR-1"},
                "items": [],
                "metadata": {"kind": "phase"},
            },
        },
    )

    result = _run(tmp_path, phase)

    assert result.returncode == 1
    assert "Decomposition-needed epics/phases:" in result.stdout
    assert "kind=phase" in result.stdout


def test_readiness_detects_unsafe_file_overlap(tmp_path: Path) -> None:
    left = _story(tmp_path, "story-left", file_scope=["src/shared.ts"])
    right = _story(tmp_path, "story-right", file_scope=["src/shared.ts"])

    result = _run(tmp_path, left, right)

    assert result.returncode == 1
    assert "File overlap matrix:" in result.stdout
    assert "src/shared.ts" in result.stdout
    assert "story-left" in result.stdout
    assert "story-right" in result.stdout


def test_readiness_rejects_large_parallel_safe_story(tmp_path: Path) -> None:
    story = _story(tmp_path, "story-large", size="large")

    result = _run(tmp_path, story)

    assert result.returncode == 1
    assert "size=large cannot be parallel_safe=true" in result.stdout


def test_readiness_rejects_low_confidence_parallel_safe_story(tmp_path: Path) -> None:
    story = _story(tmp_path, "story-low-confidence", confidence="low")

    result = _run(tmp_path, story)

    assert result.returncode == 1
    assert "low-confidence file scope cannot be parallel-safe by default" in result.stdout
