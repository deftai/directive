"""
test_vbrief_schema.py — vBRIEF schema consistency checks.

Ensures the Status enum defined in vbrief-core.schema.json stays in sync
with the documented values in vbrief/vbrief.md. This guards against the
kind of drift that Issue #28 fixed (deft using non-conforming status values).

Author: Scott Adams (msadams) — 2026-03-11
"""

import json
import re
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_SCHEMA_PATH = _REPO_ROOT / "vbrief/schemas/vbrief-core.schema.json"
_VBRIEF_MD_PATH = _REPO_ROOT / "vbrief/vbrief.md"
_SPEC_PATH = _REPO_ROOT / "vbrief/specification.vbrief.json"
_PLAN_PATH = _REPO_ROOT / "vbrief/plan.vbrief.json"

_VALID_STATUSES = {
    "draft", "proposed", "approved", "pending",
    "running", "completed", "blocked", "cancelled",
}
_LEGACY_TOP_LEVEL_KEYS = {"vbrief", "tasks", "overview", "architecture"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _schema_status_enum() -> set[str]:
    """Extract the Status enum values from vbrief-core.schema.json."""
    schema = json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))
    return set(schema["$defs"]["Status"]["enum"])


def _documented_status_enum() -> set[str]:
    """Extract the Status enum values from the code-fenced line in vbrief.md.

    Looks for the pipe-delimited list inside the first ``` block under
    '### Status Enum', e.g.:
        draft | proposed | approved | pending | running | completed | blocked | cancelled
    """
    text = _VBRIEF_MD_PATH.read_text(encoding="utf-8")
    in_status_section = False
    in_code_block = False
    for line in text.splitlines():
        if line.strip().startswith("### Status Enum"):
            in_status_section = True
            continue
        if in_status_section and line.strip().startswith("```") and not in_code_block:
            in_code_block = True
            continue
        if in_code_block and line.strip().startswith("```"):
            break
        if in_code_block:
            # Parse "draft | proposed | approved | ..."
            values = {v.strip() for v in line.split("|") if v.strip()}
            if values:
                return values
    return set()


def _status_values_used_in_prose() -> set[str]:
    """Collect status values used in lifecycle lines and tool-mapping rows.

    Scans for backtick-quoted words that match the schema enum, ensuring
    no non-conforming values like `todo`, `doing`, `done`, `skip`, or
    `deferred` have crept back in.
    """
    text = _VBRIEF_MD_PATH.read_text(encoding="utf-8")
    schema_values = _schema_status_enum()
    # Old non-conforming values that must NOT appear as status references
    non_conforming = {"todo", "doing", "done", "skip", "deferred"}
    # Find all backtick-quoted words in status-relevant lines
    found: set[str] = set()
    status_line_re = re.compile(r"status.lifecycle|status.*→|`status`", re.IGNORECASE)
    backtick_re = re.compile(r"`(\w+)`")
    for line in text.splitlines():
        if not status_line_re.search(line):
            continue
        for match in backtick_re.finditer(line):
            word = match.group(1)
            if word in schema_values or word in non_conforming:
                found.add(word)
    return found


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_schema_file_is_valid_json() -> None:
    """vbrief-core.schema.json must be parseable JSON."""
    data = json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))
    assert "$defs" in data, "Schema missing $defs — not a valid vBRIEF core schema"


def test_documented_status_matches_schema() -> None:
    """The Status enum in vbrief.md must exactly match the schema."""
    schema_values = _schema_status_enum()
    doc_values = _documented_status_enum()
    assert doc_values, "Could not parse Status enum from vbrief.md"
    assert doc_values == schema_values, (
        f"Status enum mismatch:\n"
        f"  schema:     {sorted(schema_values)}\n"
        f"  vbrief.md:  {sorted(doc_values)}"
    )


def test_no_non_conforming_status_in_prose() -> None:
    """Status lifecycle lines must not contain old non-conforming values."""
    non_conforming = {"todo", "doing", "done", "skip", "deferred"}
    prose_values = _status_values_used_in_prose()
    violations = prose_values & non_conforming
    assert not violations, (
        f"Non-conforming status values found in vbrief.md lifecycle prose: {sorted(violations)}\n"
        f"Use spec-conforming values: pending, running, completed, blocked, cancelled"
    )


# ---------------------------------------------------------------------------
# vBRIEF file validation tests
# ---------------------------------------------------------------------------

def _validate_vbrief_structure(data: dict, path: str) -> list[str]:
    """Validate vBRIEF v0.5 structural requirements. Returns a list of errors."""
    errors: list[str] = []

    if "vBRIEFInfo" not in data:
        errors.append(f"{path}: missing required top-level key 'vBRIEFInfo'")
    else:
        info = data["vBRIEFInfo"]
        if not isinstance(info, dict):
            errors.append(f"{path}: 'vBRIEFInfo' must be an object")
        elif info.get("version") != "0.5":
            errors.append(f"{path}: 'vBRIEFInfo.version' must be '0.5'")

    if "plan" not in data:
        errors.append(f"{path}: missing required top-level key 'plan'")
    else:
        plan = data["plan"]
        if not isinstance(plan, dict):
            errors.append(f"{path}: 'plan' must be an object")
        else:
            for field in ("title", "status", "items"):
                if field not in plan:
                    errors.append(f"{path}: 'plan' missing required field '{field}'")
            if "status" in plan and plan["status"] not in _VALID_STATUSES:
                errors.append(
                    f"{path}: invalid plan.status '{plan['status']}'"
                )
            if "items" in plan and isinstance(plan["items"], list):
                for i, item in enumerate(plan["items"]):
                    if not isinstance(item, dict):
                        continue
                    item_id = item.get("id", f"index {i}")
                    if "title" not in item:
                        errors.append(f"{path}: item {item_id} missing 'title'")
                    if "status" not in item:
                        errors.append(f"{path}: item {item_id} missing 'status'")
                    elif item["status"] not in _VALID_STATUSES:
                        errors.append(
                            f"{path}: item {item_id} invalid status '{item['status']}'"
                        )

    # Detect legacy flat format
    found_legacy = _LEGACY_TOP_LEVEL_KEYS & set(data.keys())
    if found_legacy:
        errors.append(
            f"{path}: legacy top-level keys found: {sorted(found_legacy)}"
        )

    return errors


@pytest.mark.parametrize(
    "vbrief_path",
    [_SPEC_PATH, _PLAN_PATH],
    ids=["specification.vbrief.json", "plan.vbrief.json"],
)
def test_vbrief_file_is_valid_json(vbrief_path: Path) -> None:
    """Each .vbrief.json file in the repo must be parseable JSON."""
    assert vbrief_path.exists(), f"{vbrief_path.name} not found"
    json.loads(vbrief_path.read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    "vbrief_path",
    [_SPEC_PATH, _PLAN_PATH],
    ids=["specification.vbrief.json", "plan.vbrief.json"],
)
def test_vbrief_file_conforms_to_schema(vbrief_path: Path) -> None:
    """Each .vbrief.json file must conform to vBRIEF v0.5 structure."""
    data = json.loads(vbrief_path.read_text(encoding="utf-8"))
    errors = _validate_vbrief_structure(data, vbrief_path.name)
    assert not errors, "\n".join(errors)


def test_spec_has_required_top_level_keys() -> None:
    """specification.vbrief.json must have exactly vBRIEFInfo and plan at top level."""
    data = json.loads(_SPEC_PATH.read_text(encoding="utf-8"))
    assert "vBRIEFInfo" in data, "Missing 'vBRIEFInfo' key"
    assert "plan" in data, "Missing 'plan' key"
    assert isinstance(data["plan"], dict), "'plan' must be an object, not a string"


def test_spec_has_no_legacy_top_level_fields() -> None:
    """specification.vbrief.json must not have legacy flat-format keys at top level."""
    data = json.loads(_SPEC_PATH.read_text(encoding="utf-8"))
    found = _LEGACY_TOP_LEVEL_KEYS & set(data.keys())
    assert not found, (
        f"Legacy flat-format keys found at top level: {sorted(found)}. "
        "File should use vBRIEF v0.5 envelope (vBRIEFInfo + plan)"
    )


def test_plan_has_no_legacy_top_level_fields() -> None:
    """plan.vbrief.json must not have legacy flat-format keys at top level."""
    data = json.loads(_PLAN_PATH.read_text(encoding="utf-8"))
    found = _LEGACY_TOP_LEVEL_KEYS & set(data.keys())
    assert not found, (
        f"Legacy flat-format keys found at top level: {sorted(found)}. "
        "File should use vBRIEF v0.5 envelope (vBRIEFInfo + plan)"
    )


def test_spec_plan_has_title_status_items() -> None:
    """The plan object must have title, status, and items."""
    data = json.loads(_SPEC_PATH.read_text(encoding="utf-8"))
    plan = data["plan"]
    assert "title" in plan, "plan missing 'title'"
    assert "status" in plan, "plan missing 'status'"
    assert "items" in plan, "plan missing 'items'"
    assert isinstance(plan["items"], list), "plan.items must be an array"
