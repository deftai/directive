"""Content contracts for the #1595 codeStructure profile."""

from __future__ import annotations

import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SCRIPTS = _REPO_ROOT / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import code_structure_validate as csv_validate  # noqa: E402


def test_schema_required_keys_match_pr2_profile() -> None:
    schema = json.loads(
        (_REPO_ROOT / "vbrief/schemas/vbrief-core.schema.json").read_text(encoding="utf-8")
    )
    code_structure_schema = schema["$defs"]["CodeStructure"]
    assert code_structure_schema["properties"]["version"]["const"] == (
        csv_validate.CODE_STRUCTURE_VERSION
    )
    assert code_structure_schema["required"] == [
        "version",
        "modules",
        "pathOwnership",
        "allowedPatterns",
        "projectionManifest",
    ]
    assert code_structure_schema["additionalProperties"] is True
    assert (
        schema["$defs"]["Architecture"]["properties"]["codeStructure"]["$ref"]
        == "#/$defs/CodeStructure"
    )


def test_directive_dogfood_code_structure_validates() -> None:
    path = _REPO_ROOT / "vbrief/PROJECT-DEFINITION.vbrief.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    assert "codeStructure" in data["plan"]["architecture"]
    assert csv_validate.DIRECTIVE_HOME.split(".", maxsplit=1)[0] not in data
    result = csv_validate.validate_file(
        path, project_root=_REPO_ROOT, allow_standalone=False
    )
    assert result.ok, [finding.message for finding in result.errors]


def test_codebase_task_is_registered() -> None:
    taskfile = (_REPO_ROOT / "Taskfile.yml").read_text(encoding="utf-8")
    codebase_tasks = (_REPO_ROOT / "tasks/codebase.yml").read_text(encoding="utf-8")
    assert "codebase:" in taskfile
    assert "tasks/codebase.yml" in taskfile
    assert "validate-structure:" in codebase_tasks
    assert "extract-default:" in codebase_tasks
    assert "provider-map:" in codebase_tasks
    assert "projection-registry:" in codebase_tasks
    assert "packages/cli/dist/bin.js" in codebase_tasks
    assert "code-structure-validate" in codebase_tasks


def test_profile_doc_names_physical_home_and_later_slices() -> None:
    doc = (_REPO_ROOT / "docs/code-structure-profile.md").read_text(encoding="utf-8")
    assert "PROJECT-DEFINITION.vbrief.json" in doc
    assert "plan.architecture.codeStructure" in doc
    assert "vbrief-core.schema.json" in doc
    assert "No standalone canonical" in doc
    assert "vbrief/schemas/codebase-map.schema.json" in doc
    assert "tests/fixtures/codebase-map.v1.golden.json" in doc
    assert "normative contract" in doc
    assert "codebase-provider.v1" in doc
    assert "MAP rendering, generated headers" in doc
