from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "scope_decompose.py"


def _write_json(path: Path, data: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return path


def _parent(project: Path, folder: str = "pending") -> Path:
    return _write_json(
        project / "vbrief" / folder / "2026-05-12-ip001-auth.vbrief.json",
        {
            "vBRIEFInfo": {"version": "0.6"},
            "plan": {
                "id": "ip-1",
                "title": "IP-1: Auth",
                "status": "pending" if folder == "pending" else "running",
                "narratives": {
                    "Acceptance": "Auth epic acceptance remains as context.",
                    "Traces": "FR-1, IP-1",
                },
                "items": [],
                "metadata": {"kind": "phase", "dependencies": []},
                "references": [
                    {
                        "uri": "./specification.vbrief.json",
                        "type": "x-vbrief/plan",
                        "title": "Specification",
                    }
                ],
            },
        },
    )


def _draft(project: Path, *, cycle: bool = False, output_dir: str | None = None) -> Path:
    stories = [
        {
            "id": "story-auth-model",
            "title": "Auth model",
            "acceptance": ["Auth model persists users"],
            "traces": ["FR-1"],
            "swarm": {
                "readiness": "ready",
                "parallel_safe": True,
                "file_scope": ["src/auth/model.ts", "tests/auth/model.test.ts"],
                "verify_commands": ["npm test -- auth/model"],
                "expected_outputs": ["auth model tests pass"],
                "depends_on": ["story-auth-routes"] if cycle else [],
                "conflict_group": "auth",
                "size": "small",
                "file_scope_confidence": "high",
                "model_tier": "medium",
            },
        },
        {
            "id": "story-auth-routes",
            "title": "Auth routes",
            "acceptance": ["Auth routes return tokens"],
            "traces": ["FR-2"],
            "swarm": {
                "readiness": "ready",
                "parallel_safe": True,
                "file_scope": ["src/auth/routes.ts", "tests/auth/routes.test.ts"],
                "verify_commands": ["npm test -- auth/routes"],
                "expected_outputs": ["auth route tests pass"],
                "depends_on": ["story-auth-model"],
                "conflict_group": "auth",
                "size": "small",
                "file_scope_confidence": "high",
                "model_tier": "medium",
            },
        },
    ]
    draft = {"stories": stories}
    if output_dir:
        draft["output_dir"] = output_dir
        draft["status"] = "running"
    return _write_json(project / "decomposition.json", draft)


def _run(project: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args, "--project-root", str(project)],
        cwd=project,
        text=True,
        capture_output=True,
        check=False,
    )


def test_scope_decompose_creates_child_stories_and_updates_parent_refs(tmp_path: Path) -> None:
    parent = _parent(tmp_path)
    draft = _draft(tmp_path)

    result = _run(
        tmp_path,
        str(parent.relative_to(tmp_path)),
        "--draft",
        str(draft.relative_to(tmp_path)),
        "--date",
        "2026-05-12",
    )

    assert result.returncode == 0, result.stderr
    child_paths = sorted((tmp_path / "vbrief" / "pending").glob("2026-05-12-auth-*.vbrief.json"))
    assert len(child_paths) == 2
    child = json.loads(child_paths[0].read_text(encoding="utf-8"))
    assert child["plan"]["planRef"] == "./pending/2026-05-12-ip001-auth.vbrief.json"
    assert child["plan"]["metadata"]["kind"] == "story"
    assert child["plan"]["metadata"]["swarm"]["readiness"] == "ready"
    assert child["plan"]["items"]
    assert child["plan"]["references"][0]["uri"] == "./specification.vbrief.json"

    updated_parent = json.loads(parent.read_text(encoding="utf-8"))
    child_uris = {
        f"./pending/{path.name}"
        for path in child_paths
    }
    child_refs = [
        ref
        for ref in updated_parent["plan"]["references"]
        if ref.get("type") == "x-vbrief/plan" and ref.get("uri") in child_uris
    ]
    assert len(child_refs) == 2
    assert updated_parent["plan"]["narratives"]["Acceptance"].startswith("Auth epic")


def test_scope_decompose_check_rejects_dependency_cycles(tmp_path: Path) -> None:
    parent = _parent(tmp_path)
    draft = _draft(tmp_path, cycle=True)

    result = _run(
        tmp_path,
        str(parent.relative_to(tmp_path)),
        "--draft",
        str(draft.relative_to(tmp_path)),
        "--check",
    )

    assert result.returncode == 1
    assert "dependency cycle" in result.stderr


def test_scope_decompose_rejects_ready_story_missing_required_fields(tmp_path: Path) -> None:
    parent = _parent(tmp_path)
    draft = _write_json(
        tmp_path / "bad-decomposition.json",
        {
            "stories": [
                {
                    "id": "story-bad",
                    "title": "Bad story",
                    "swarm": {"readiness": "ready", "parallel_safe": True},
                }
            ]
        },
    )

    result = _run(
        tmp_path,
        str(parent.relative_to(tmp_path)),
        "--draft",
        str(draft.relative_to(tmp_path)),
        "--check",
    )

    assert result.returncode == 1
    assert "plan.items" in result.stderr
    assert "file_scope" in result.stderr
    assert "verify_commands" in result.stderr


def test_scope_decompose_to_active_stories_passes_readiness(tmp_path: Path) -> None:
    parent = _parent(tmp_path, folder="active")
    draft = _draft(tmp_path, output_dir="vbrief/active")

    result = _run(
        tmp_path,
        str(parent.relative_to(tmp_path)),
        "--draft",
        str(draft.relative_to(tmp_path)),
        "--date",
        "2026-05-12",
    )

    assert result.returncode == 0, result.stderr
    story_paths = [
        path
        for path in sorted((tmp_path / "vbrief" / "active").glob("*.vbrief.json"))
        if path.name != parent.name
    ]
    readiness = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "swarm_readiness.py"),
            *(str(path.relative_to(tmp_path)) for path in story_paths),
            "--project-root",
            str(tmp_path),
        ],
        cwd=tmp_path,
        text=True,
        capture_output=True,
        check=False,
    )
    assert readiness.returncode == 0, readiness.stdout + readiness.stderr
    assert "Ready stories:" in readiness.stdout
    assert "story-auth-model" in readiness.stdout
    assert "story-auth-routes" in readiness.stdout
