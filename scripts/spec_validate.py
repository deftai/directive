#!/usr/bin/env python3
"""
spec_validate.py — Validate a vbrief specification JSON file.

Usage:
    uv run python scripts/spec_validate.py <spec_file>

Exit codes:
    0 — valid
    1 — invalid (file missing, bad JSON, or schema violation)
    2 — usage error (no argument provided)

Implementation: IMPLEMENTATION.md Phase 5.1
"""

import json
import sys
from pathlib import Path

VALID_STATUSES = frozenset({
    "draft", "proposed", "approved", "pending",
    "running", "completed", "blocked", "cancelled",
})


def _validate_narratives(narratives: object, path: str, errors: list[str]) -> None:
    """Validate that all values in a narratives/narrative object are strings."""
    if not isinstance(narratives, dict):
        errors.append(f"{path} must be an object")
        return
    for key, value in narratives.items():
        if not isinstance(value, str):
            errors.append(
                f"{path}.{key} must be a string, got {type(value).__name__}"
            )


def _validate_plan_item(
    item: dict, path: str, errors: list[str],
) -> None:
    """Recursively validate a PlanItem and its subItems."""
    item_id = item.get("id", "<no-id>")
    item_path = f"{path}[{item_id}]"

    if "title" not in item:
        errors.append(f"{item_path} missing 'title'")
    if "status" not in item:
        errors.append(f"{item_path} missing 'status'")
    elif item["status"] not in VALID_STATUSES:
        errors.append(
            f"{item_path} invalid status: {item['status']!r}"
        )

    # Narrative values must be strings
    if "narrative" in item:
        _validate_narratives(item["narrative"], f"{item_path}.narrative", errors)

    # Detect items misuse inside PlanItem (should be subItems)
    if "items" in item:
        errors.append(
            f"{item_path} uses 'items' for children — use 'subItems' instead "
            "('items' is only valid at plan level)"
        )

    # Recurse into subItems
    if "subItems" in item:
        if not isinstance(item["subItems"], list):
            errors.append(f"{item_path}.subItems must be an array")
        else:
            for j, sub in enumerate(item["subItems"]):
                if not isinstance(sub, dict):
                    errors.append(f"{item_path}.subItems[{j}] must be an object")
                    continue
                _validate_plan_item(sub, f"{item_path}.subItems", errors)


def _validate_schema(data: dict, path: str) -> list[str]:
    """Validate vBRIEF v0.5 structural requirements. Returns a list of errors."""
    errors: list[str] = []

    # Top-level envelope
    if "vBRIEFInfo" not in data:
        errors.append("missing required top-level key 'vBRIEFInfo'")
    else:
        info = data["vBRIEFInfo"]
        if not isinstance(info, dict):
            errors.append("'vBRIEFInfo' must be an object")
        elif info.get("version") != "0.5":
            errors.append(
                f"'vBRIEFInfo.version' must be '0.5', got {info.get('version')!r}"
            )

    if "plan" not in data:
        errors.append("missing required top-level key 'plan'")
    else:
        plan = data["plan"]
        if not isinstance(plan, dict):
            errors.append("'plan' must be an object, not a string or other type")
        else:
            for field in ("title", "status", "items"):
                if field not in plan:
                    errors.append(f"'plan' missing required field '{field}'")

            if "title" in plan and (not isinstance(plan["title"], str) or not plan["title"]):
                errors.append("'plan.title' must be a non-empty string")

            if "status" in plan and plan["status"] not in VALID_STATUSES:
                errors.append(
                    f"'plan.status' invalid: {plan['status']!r} "
                    f"(expected one of {sorted(VALID_STATUSES)})"
                )

            # Validate plan-level narratives
            if "narratives" in plan:
                _validate_narratives(
                    plan["narratives"], "plan.narratives", errors
                )

            if "items" in plan:
                if not isinstance(plan["items"], list):
                    errors.append("'plan.items' must be an array")
                else:
                    for i, item in enumerate(plan["items"]):
                        if not isinstance(item, dict):
                            errors.append(f"plan.items[{i}] must be an object")
                            continue
                        _validate_plan_item(item, "plan.items", errors)

    # Detect legacy flat format
    legacy_keys = {"vbrief", "tasks", "overview", "architecture"}
    found_legacy = legacy_keys & set(data.keys())
    if found_legacy:
        errors.append(
            f"legacy flat-format keys found at top level: {sorted(found_legacy)}. "
            "Migrate to vBRIEF v0.5 envelope (vBRIEFInfo + plan)"
        )

    return errors


def validate_spec(spec_path: str) -> tuple[bool, str]:
    """
    Validate the spec file at *spec_path*.

    Returns:
        (True, success_message) on success.
        (False, error_message)  on failure.
    """
    path = Path(spec_path)
    if not path.exists():
        return (
            False,
            f"✗ {spec_path} not found\n"
            "  Create it by running the interview process "
            "(see deft/templates/make-spec.md)",
        )
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except json.JSONDecodeError as exc:
        return False, f"✗ {spec_path} is not valid JSON: {exc}"

    errors = _validate_schema(data, spec_path)
    if errors:
        detail = "\n".join(f"  • {e}" for e in errors)
        return False, f"✗ {path.name} has schema violations:\n{detail}"

    return True, f"✓ {path.name} is valid vBRIEF v0.5"


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: spec_validate.py <spec_file>", file=sys.stderr)
        return 2

    ok, message = validate_spec(sys.argv[1])
    print(message)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
