"""Tests for the #1595 codebase MAP freshness gate."""

from __future__ import annotations

import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SCRIPTS = _REPO_ROOT / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import codebase_map  # noqa: E402
import codebase_map_fresh as fresh  # noqa: E402


def _write_project(project_root: Path) -> None:
    project_def = project_root / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    project_def.parent.mkdir(parents=True)
    project_def.write_text(
        json.dumps(
            {
                "vBRIEFInfo": {"version": "0.6"},
                "plan": {
                    "title": "Fixture",
                    "status": "running",
                    "items": [],
                    "architecture": {
                        "codeStructure": {
                            "version": "0.1",
                            "modules": [
                                {
                                    "id": "app",
                                    "name": "App",
                                    "purpose": "Application entry points.",
                                    "pathGlobs": ["app/**/*.py"],
                                }
                            ],
                            "pathOwnership": [],
                            "allowedPatterns": [],
                            "projectionManifest": [
                                {
                                    "path": ".planning/codebase/MAP.md",
                                    "kind": "codebase-map",
                                    "source": "plan.architecture.codeStructure",
                                    "generated": True,
                                }
                            ],
                        }
                    },
                },
            }
        ),
        encoding="utf-8",
    )


def _write_code(project_root: Path, body: str = "print('hello')\n") -> None:
    (project_root / "app").mkdir(exist_ok=True)
    (project_root / "app" / "main.py").write_text(body, encoding="utf-8")


def test_freshness_passes_after_generation(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_code(tmp_path)
    assert codebase_map.main(["--project-root", str(tmp_path)]) == 0

    assert fresh.main(["--project-root", str(tmp_path)]) == 0


def test_freshness_fails_when_projection_is_tampered(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_code(tmp_path)
    assert codebase_map.main(["--project-root", str(tmp_path)]) == 0
    output = tmp_path / ".planning" / "codebase" / "MAP.md"
    output.write_text(output.read_text(encoding="utf-8") + "\nmanual drift\n", encoding="utf-8")

    errors = fresh.check_codebase_map_fresh(
        tmp_path,
        output_path=Path(".planning/codebase/MAP.md"),
    )

    assert errors == [
        "generated codebase MAP is stale; run `task codebase:map` " f"to refresh {output}"
    ]


def test_freshness_fails_when_source_digest_changes(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_code(tmp_path)
    assert codebase_map.main(["--project-root", str(tmp_path)]) == 0
    _write_code(tmp_path, "print('changed')\n")

    assert fresh.main(["--project-root", str(tmp_path)]) == 1


def test_freshness_treats_missing_projection_as_fresh(tmp_path: Path) -> None:
    # #1932: the generated MAP is an on-demand, gitignored artifact, so an absent
    # projection is OK (advisory) rather than an error.
    _write_project(tmp_path)
    _write_code(tmp_path)

    errors = fresh.check_codebase_map_fresh(
        tmp_path,
        output_path=Path(".planning/codebase/MAP.md"),
    )

    assert errors == []
