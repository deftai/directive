#!/usr/bin/env python3
"""
vbrief_validate.py -- Validate the vBRIEF-centric document model.

Replaces and extends spec_validate.py for the vBRIEF lifecycle folder model.
Validates individual scope vBRIEFs, PROJECT-DEFINITION.vbrief.json, and
cross-file consistency.

Usage:
    uv run python scripts/vbrief_validate.py [--vbrief-dir <path>]

Exit codes:
    0 -- valid (may have warnings)
    1 -- validation errors found
    2 -- usage error

Story: #333 (RFC #309)
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

VALID_STATUSES = frozenset({
    "draft", "proposed", "approved", "pending",
    "running", "completed", "blocked", "cancelled",
})

# D13: status-to-folder mapping
FOLDER_ALLOWED_STATUSES: dict[str, frozenset[str]] = {
    "proposed": frozenset({"draft", "proposed"}),
    "pending": frozenset({"approved", "pending"}),
    "active": frozenset({"running", "blocked"}),
    "completed": frozenset({"completed"}),
    "cancelled": frozenset({"cancelled"}),
}

LIFECYCLE_FOLDERS = tuple(FOLDER_ALLOWED_STATUSES.keys())

# D7: filename convention YYYY-MM-DD-descriptive-slug.vbrief.json
FILENAME_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.vbrief\.json$"
)

# D3: expected narrative keys for PROJECT-DEFINITION
PROJECT_DEF_EXPECTED_NARRATIVES = frozenset({
    "overview", "tech stack",
})

# D11: origin reference type patterns
ORIGIN_TYPES = frozenset({
    "github-issue", "jira-ticket", "user-request",
})


# ---------------------------------------------------------------------------
# Schema validation (reuses spec_validate.py logic, extended)
# ---------------------------------------------------------------------------

def validate_vbrief_schema(data: dict, filepath: str) -> list[str]:
    """Validate vBRIEF v0.5 structural requirements. Returns error list."""
    errors: list[str] = []

    # Top-level envelope
    if "vBRIEFInfo" not in data:
        errors.append(f"{filepath}: missing required top-level key 'vBRIEFInfo'")
    else:
        info = data["vBRIEFInfo"]
        if not isinstance(info, dict):
            errors.append(f"{filepath}: 'vBRIEFInfo' must be an object")
        elif info.get("version") != "0.5":
            errors.append(
                f"{filepath}: 'vBRIEFInfo.version' must be '0.5', "
                f"got {info.get('version')!r}"
            )

    if "plan" not in data:
        errors.append(f"{filepath}: missing required top-level key 'plan'")
    else:
        plan = data["plan"]
        if not isinstance(plan, dict):
            errors.append(f"{filepath}: 'plan' must be an object")
        else:
            for field in ("title", "status", "items"):
                if field not in plan:
                    errors.append(
                        f"{filepath}: 'plan' missing required field '{field}'"
                    )

            if "title" in plan and (
                not isinstance(plan["title"], str) or not plan["title"]
            ):
                errors.append(f"{filepath}: 'plan.title' must be a non-empty string")

            if "status" in plan and plan["status"] not in VALID_STATUSES:
                errors.append(
                    f"{filepath}: 'plan.status' invalid: {plan['status']!r} "
                    f"(expected one of {sorted(VALID_STATUSES)})"
                )

            # Validate narratives values are strings
            if "narratives" in plan:
                _validate_narratives(
                    plan["narratives"], f"{filepath}: plan.narratives", errors
                )

            if "items" in plan:
                if not isinstance(plan["items"], list):
                    errors.append(f"{filepath}: 'plan.items' must be an array")
                else:
                    for i, item in enumerate(plan["items"]):
                        if not isinstance(item, dict):
                            errors.append(
                                f"{filepath}: plan.items[{i}] must be an object"
                            )
                            continue
                        _validate_plan_item(item, f"{filepath}: plan.items", errors)

    return errors


def _validate_narratives(
    narratives: object, path: str, errors: list[str]
) -> None:
    """Validate that all values in a narratives object are strings."""
    if not isinstance(narratives, dict):
        errors.append(f"{path} must be an object")
        return
    for key, value in narratives.items():
        if not isinstance(value, str):
            errors.append(
                f"{path}.{key} must be a string, got {type(value).__name__}"
            )


def _validate_plan_item(
    item: dict, path: str, errors: list[str]
) -> None:
    """Recursively validate a PlanItem and its subItems."""
    item_id = item.get("id", "<no-id>")
    item_path = f"{path}[{item_id}]"

    if "title" not in item:
        errors.append(f"{item_path} missing 'title'")
    if "status" not in item:
        errors.append(f"{item_path} missing 'status'")
    elif item["status"] not in VALID_STATUSES:
        errors.append(f"{item_path} invalid status: {item['status']!r}")

    if "narrative" in item:
        _validate_narratives(item["narrative"], f"{item_path}.narrative", errors)

    if "items" in item:
        errors.append(
            f"{item_path} uses 'items' for children -- use 'subItems' instead "
            "('items' is only valid at plan level)"
        )

    if "subItems" in item:
        if not isinstance(item["subItems"], list):
            errors.append(f"{item_path}.subItems must be an array")
        else:
            for j, sub in enumerate(item["subItems"]):
                if not isinstance(sub, dict):
                    errors.append(f"{item_path}.subItems[{j}] must be an object")
                    continue
                _validate_plan_item(sub, f"{item_path}.subItems", errors)


# ---------------------------------------------------------------------------
# D7: Filename convention
# ---------------------------------------------------------------------------

def validate_filename(filepath: Path) -> list[str]:
    """Check filename matches YYYY-MM-DD-descriptive-slug.vbrief.json."""
    name = filepath.name
    if name == "PROJECT-DEFINITION.vbrief.json":
        return []  # PROJECT-DEFINITION has its own convention
    if not FILENAME_PATTERN.match(name):
        return [
            f"{filepath}: filename '{name}' does not match convention "
            "YYYY-MM-DD-descriptive-slug.vbrief.json (D7)"
        ]
    return []


# ---------------------------------------------------------------------------
# D2: Folder/status consistency
# ---------------------------------------------------------------------------

def validate_folder_status(
    filepath: Path, data: dict, vbrief_dir: Path
) -> list[str]:
    """Verify plan.status matches the lifecycle folder the file is in."""
    errors: list[str] = []
    try:
        rel = filepath.relative_to(vbrief_dir)
    except ValueError:
        return []

    parts = rel.parts
    if len(parts) < 2:
        return []  # file is at vbrief/ root (e.g. PROJECT-DEFINITION)

    folder = parts[0]
    if folder not in FOLDER_ALLOWED_STATUSES:
        return []  # not in a lifecycle folder

    plan = data.get("plan", {})
    status = plan.get("status")
    if status is None:
        return []  # schema validator already catches missing status

    allowed = FOLDER_ALLOWED_STATUSES[folder]
    if status not in allowed:
        errors.append(
            f"{filepath}: plan.status is '{status}' but file is in "
            f"'{folder}/' (allowed statuses: {sorted(allowed)}) (D2)"
        )

    return errors


# ---------------------------------------------------------------------------
# D3: PROJECT-DEFINITION.vbrief.json validator
# ---------------------------------------------------------------------------

def validate_project_definition(
    filepath: Path, data: dict, vbrief_dir: Path
) -> list[str]:
    """Validate PROJECT-DEFINITION.vbrief.json specific requirements."""
    errors: list[str] = []

    # Check narratives contains expected keys
    plan = data.get("plan", {})
    narratives = plan.get("narratives", {})
    if isinstance(narratives, dict):
        narrative_keys_lower = {k.lower() for k in narratives}
        for expected in PROJECT_DEF_EXPECTED_NARRATIVES:
            if expected not in narrative_keys_lower:
                errors.append(
                    f"{filepath}: narratives missing expected key "
                    f"'{expected}' (D3)"
                )

    # Check items registry entries reference existing scope vBRIEF files
    items = plan.get("items", [])
    if isinstance(items, list):
        for i, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            refs = item.get("references", [])
            if not isinstance(refs, list):
                refs = []
            for ref in refs:
                if not isinstance(ref, dict):
                    continue
                uri = ref.get("uri", "")
                if uri and uri.startswith("file://"):
                    ref_path = uri.replace("file://", "")
                    full_path = (vbrief_dir / ref_path).resolve()
                    if not full_path.exists():
                        errors.append(
                            f"{filepath}: items[{i}] references "
                            f"'{ref_path}' which does not exist (D3)"
                        )
                elif uri and not uri.startswith(("http://", "https://", "#")):
                    # Treat as relative path
                    full_path = (vbrief_dir / uri).resolve()
                    if not full_path.exists():
                        errors.append(
                            f"{filepath}: items[{i}] references "
                            f"'{uri}' which does not exist (D3)"
                        )

    return errors


# ---------------------------------------------------------------------------
# D4: Epic-story bidirectional link validation
# ---------------------------------------------------------------------------

def validate_epic_story_links(
    all_vbriefs: dict[Path, dict], vbrief_dir: Path
) -> list[str]:
    """Validate bidirectional references between epic and story vBRIEFs."""
    errors: list[str] = []

    for filepath, data in all_vbriefs.items():
        plan = data.get("plan", {})

        # Check forward references (epic -> children)
        refs = plan.get("references", [])
        if isinstance(refs, list):
            for ref in refs:
                if not isinstance(ref, dict):
                    continue
                uri = ref.get("uri", "")
                ref_type = ref.get("type", "")
                if not uri or not ref_type:
                    continue
                # Resolve the child path
                child_path = _resolve_ref_path(uri, vbrief_dir)
                if child_path is None:
                    continue
                if child_path not in all_vbriefs:
                    if child_path.exists():
                        continue  # file exists but wasn't loaded (edge case)
                    errors.append(
                        f"{filepath}: references child '{uri}' "
                        "which does not exist (D4)"
                    )
                    continue
                # Verify child has planRef back
                child_data = all_vbriefs[child_path]
                child_plan = child_data.get("plan", {})
                # Check planRef at plan level or in items
                if not _has_plan_ref_to(child_plan, filepath, vbrief_dir):
                    errors.append(
                        f"{child_path}: missing planRef back to parent "
                        f"'{filepath.name}' (D4)"
                    )

        # Check backward references (story -> parent via planRef)
        plan_ref = plan.get("planRef")
        if plan_ref:
            parent_path = _resolve_ref_path(plan_ref, vbrief_dir)
            if parent_path and parent_path in all_vbriefs:
                parent_data = all_vbriefs[parent_path]
                parent_plan = parent_data.get("plan", {})
                parent_refs = parent_plan.get("references", [])
                if isinstance(parent_refs, list):
                    child_uris = set()
                    for pref in parent_refs:
                        if isinstance(pref, dict):
                            child_uris.add(pref.get("uri", ""))
                    if not _path_in_refs(filepath, child_uris, vbrief_dir):
                        errors.append(
                            f"{filepath}: has planRef to "
                            f"'{parent_path.name}' but parent does not "
                            f"list this file in references (D4)"
                        )
            elif parent_path and not parent_path.exists():
                errors.append(
                    f"{filepath}: planRef references '{plan_ref}' "
                    "which does not exist (D4)"
                )

    return errors


def _resolve_ref_path(uri: str, vbrief_dir: Path) -> Path | None:
    """Resolve a reference URI to a filesystem path."""
    if uri.startswith("file://"):
        rel = uri.replace("file://", "")
        return (vbrief_dir / rel).resolve()
    if uri.startswith(("http://", "https://", "#")):
        return None
    # Treat as relative path
    return (vbrief_dir / uri).resolve()


def _has_plan_ref_to(
    child_plan: dict, parent_path: Path, vbrief_dir: Path
) -> bool:
    """Check if a plan has a planRef pointing back to parent_path."""
    plan_ref = child_plan.get("planRef")
    if plan_ref:
        resolved = _resolve_ref_path(plan_ref, vbrief_dir)
        if resolved and resolved == parent_path.resolve():
            return True
    # Also check items for planRef
    for item in child_plan.get("items", []):
        if isinstance(item, dict):
            item_ref = item.get("planRef")
            if item_ref:
                resolved = _resolve_ref_path(item_ref, vbrief_dir)
                if resolved and resolved == parent_path.resolve():
                    return True
    return False


def _path_in_refs(
    filepath: Path, uris: set[str], vbrief_dir: Path
) -> bool:
    """Check if filepath is referenced by any URI in the set."""
    resolved_file = filepath.resolve()
    for uri in uris:
        resolved = _resolve_ref_path(uri, vbrief_dir)
        if resolved and resolved == resolved_file:
            return True
    return False


# ---------------------------------------------------------------------------
# D11: Origin provenance check
# ---------------------------------------------------------------------------

def validate_origin_provenance(
    filepath: Path, data: dict, vbrief_dir: Path
) -> list[str]:
    """Warn if a scope vBRIEF in pending/ or active/ has no origin reference."""
    warnings: list[str] = []

    try:
        rel = filepath.relative_to(vbrief_dir)
    except ValueError:
        return []

    parts = rel.parts
    if len(parts) < 2:
        return []

    folder = parts[0]
    if folder not in ("pending", "active"):
        return []

    plan = data.get("plan", {})
    refs = plan.get("references", [])
    has_origin = False
    if isinstance(refs, list):
        for ref in refs:
            if not isinstance(ref, dict):
                continue
            ref_type = ref.get("type", "")
            # Check for origin types (github-issue, jira-ticket, etc.)
            if ref_type in ORIGIN_TYPES:
                has_origin = True
                break
            # Also accept any type that looks like an origin
            if any(origin in ref_type for origin in ORIGIN_TYPES):
                has_origin = True
                break

    if not has_origin:
        warnings.append(
            f"{filepath}: scope vBRIEF in '{folder}/' has no references "
            "with an origin type (D11)"
        )

    return warnings


# ---------------------------------------------------------------------------
# Main orchestrator
# ---------------------------------------------------------------------------

def load_vbrief(filepath: Path) -> tuple[dict | None, str | None]:
    """Load and parse a .vbrief.json file. Returns (data, error)."""
    try:
        with open(filepath, encoding="utf-8") as fh:
            data = json.load(fh)
        return data, None
    except json.JSONDecodeError as exc:
        return None, f"{filepath}: invalid JSON: {exc}"
    except OSError as exc:
        return None, f"{filepath}: cannot read: {exc}"


def discover_vbriefs(vbrief_dir: Path) -> list[Path]:
    """Find all .vbrief.json files in lifecycle folders."""
    files: list[Path] = []
    for folder in LIFECYCLE_FOLDERS:
        folder_path = vbrief_dir / folder
        if folder_path.is_dir():
            files.extend(sorted(folder_path.glob("*.vbrief.json")))
    return files


def validate_all(vbrief_dir: Path) -> tuple[list[str], list[str]]:
    """Run all validators. Returns (errors, warnings)."""
    errors: list[str] = []
    warnings: list[str] = []
    all_vbriefs: dict[Path, dict] = {}

    # Discover scope vBRIEFs in lifecycle folders
    scope_files = discover_vbriefs(vbrief_dir)

    # Validate each scope vBRIEF
    for filepath in scope_files:
        data, load_err = load_vbrief(filepath)
        if load_err:
            errors.append(load_err)
            continue

        if data is None:
            continue

        all_vbriefs[filepath.resolve()] = data

        # Schema validation
        errors.extend(validate_vbrief_schema(data, str(filepath)))

        # Filename convention (D7)
        errors.extend(validate_filename(filepath))

        # Folder/status consistency (D2)
        errors.extend(validate_folder_status(filepath, data, vbrief_dir))

        # Origin provenance (D11) -- warnings only
        warnings.extend(validate_origin_provenance(filepath, data, vbrief_dir))

    # Validate PROJECT-DEFINITION.vbrief.json if it exists
    project_def = vbrief_dir / "PROJECT-DEFINITION.vbrief.json"
    if project_def.exists():
        data, load_err = load_vbrief(project_def)
        if load_err:
            errors.append(load_err)
        elif data is not None:
            all_vbriefs[project_def.resolve()] = data
            errors.extend(validate_vbrief_schema(data, str(project_def)))
            errors.extend(
                validate_project_definition(project_def, data, vbrief_dir)
            )

    # Epic-story bidirectional link validation (D4)
    if all_vbriefs:
        errors.extend(validate_epic_story_links(all_vbriefs, vbrief_dir))

    return errors, warnings


def main() -> int:
    """CLI entry point."""
    vbrief_dir = Path("vbrief")

    # Parse args
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--vbrief-dir" and i + 1 < len(args):
            vbrief_dir = Path(args[i + 1])
            i += 2
        else:
            print(f"Unknown argument: {args[i]}", file=sys.stderr)
            print(
                "Usage: vbrief_validate.py [--vbrief-dir <path>]",
                file=sys.stderr,
            )
            return 2

    if not vbrief_dir.is_dir():
        # No vbrief directory -- nothing to validate, pass silently
        print(f"OK: No vbrief directory at {vbrief_dir} -- skipping validation")
        return 0

    errors, warnings = validate_all(vbrief_dir)

    # Print warnings
    for w in warnings:
        print(f"WARN: {w}")

    # Print errors
    for e in errors:
        print(f"FAIL: {e}")

    if errors:
        print(f"\nFAIL: {len(errors)} error(s) found")
        return 1

    scope_count = len(discover_vbriefs(vbrief_dir))
    project_def = vbrief_dir / "PROJECT-DEFINITION.vbrief.json"
    parts = []
    if scope_count:
        parts.append(f"{scope_count} scope vBRIEF(s)")
    if project_def.exists():
        parts.append("PROJECT-DEFINITION")
    summary = ", ".join(parts) if parts else "no vBRIEF files"

    warning_note = f" ({len(warnings)} warning(s))" if warnings else ""
    print(f"OK: vBRIEF validation passed: {summary}{warning_note}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
