#!/usr/bin/env python3
"""
vbrief_validate.py -- Validate the vBRIEF-centric document model.

Replaces and extends spec_validate.py for the vBRIEF lifecycle folder model.
Validates individual scope vBRIEFs, PROJECT-DEFINITION.vbrief.json, and
cross-file consistency.

Usage:
    uv run python scripts/vbrief_validate.py [--vbrief-dir <path>]
                                             [--strict-origin-types]
                                             [--warnings-as-errors]

Exit codes:
    0 -- valid (may have warnings); also valid with warnings unless
         --warnings-as-errors is set
    1 -- validation errors found (or warnings with --warnings-as-errors)
    2 -- usage error

Story: #333 (RFC #309), #536 (validator CLI flags, schema-trusting D11),
       #533 (full v0.6 transition -- strict 0.6-only acceptance)
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# v0.6 Status enum from the canonical schema
# (https://github.com/deftai/vBRIEF/blob/master/schemas/vbrief-core-0.6.schema.json).
VALID_STATUSES = frozenset(
    {
        "draft",
        "proposed",
        "approved",
        "pending",
        "running",
        "completed",
        "blocked",
        "failed",
        "cancelled",
    }
)

# Strict v0.6-only acceptance (#533). The canonical schema at
# vbrief/schemas/vbrief-core.schema.json pins vBRIEFInfo.version to
# const "0.6"; this validator rejects every other version. Pre-existing
# v0.5 vBRIEFs are automatically bumped to v0.6 during ``task
# migrate:vbrief`` (#571); operators who see the error should re-run
# the migrator on the affected project.
VALID_VBRIEF_VERSIONS = frozenset({"0.6"})

# D13: status-to-folder mapping. v0.6 adds ``failed`` as a terminal status
# (#533 / refinement skill Phase 4 ``task scope:fail``); it belongs in
# ``completed/`` because the scope has reached a terminal state (#537).
FOLDER_ALLOWED_STATUSES: dict[str, frozenset[str]] = {
    "proposed": frozenset({"draft", "proposed"}),
    "pending": frozenset({"approved", "pending"}),
    "active": frozenset({"running", "blocked"}),
    "completed": frozenset({"completed", "failed"}),
    "cancelled": frozenset({"cancelled"}),
}

LIFECYCLE_FOLDERS = tuple(FOLDER_ALLOWED_STATUSES.keys())

# D7: filename convention YYYY-MM-DD-descriptive-slug.vbrief.json
FILENAME_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.vbrief\.json$")

# D3: expected narrative keys for PROJECT-DEFINITION (per #506 D3).
# Values are normalized (lowercase, whitespace collapsed) so both the
# historic lowercase-space ``tech stack`` and the #506 D3 PascalCase
# ``TechStack`` shapes satisfy the validator.  Comparison normalizes the
# candidate key the same way.
PROJECT_DEF_EXPECTED_NARRATIVES = frozenset(
    {
        "overview",
        "techstack",
    }
)


def _normalize_narrative_key(key: str) -> str:
    """Normalize a narrative key for D3 comparison.

    Lowercases, strips whitespace, and collapses word separators so
    ``TechStack`` / ``Tech Stack`` / ``tech stack`` / ``tech-stack`` all
    compare equal to the canonical ``techstack`` key (#506 D3 / D5).
    Uses the module-level ``re`` already imported at the top of the file
    (PR #525 Greptile P2 review).
    """
    low = (key or "").lower()
    return re.sub(r"[\s_\-]+", "", low)


# D11: origin reference type patterns.
#
# Default behavior (schema-trusting, Option A from #536): ANY reference whose
# `type` matches `^x-vbrief/` counts as an origin. This matches the v0.6
# schema pattern and aligns with the shape documented in
# conventions/references.md and the refinement skill.
#
# Strict behavior (opt-in via --strict-origin-types): only the registered
# allow-list below counts. Teams who want zero tolerance for ad-hoc
# `x-vbrief/*` values pass --strict-origin-types in CI.
ORIGIN_TYPE_PATTERN = re.compile(r"^x-vbrief/")

STRICT_ORIGIN_ALLOWLIST = frozenset(
    {
        "x-vbrief/plan",
        "x-vbrief/github-issue",
        "x-vbrief/github-pr",
        "x-vbrief/jira-ticket",
        "x-vbrief/user-request",
        "x-vbrief/spec-section",
    }
)

# Legacy bare origin types accepted for backward compatibility with
# pre-v0.20 vBRIEFs that pre-date the x-vbrief/* prefix convention.
# These are accepted unconditionally (independent of --strict-origin-types)
# so pre-migration vBRIEFs do not regress.
LEGACY_ORIGIN_TYPES = frozenset(
    {
        "github-issue",
        "jira-ticket",
        "user-request",
    }
)

# Story S (#334): deprecation redirect sentinel
DEPRECATED_REDIRECT_SENTINEL = "<!-- deft:deprecated-redirect -->"

# Files that should contain the redirect sentinel after migration
DEPRECATED_FILES = ("SPECIFICATION.md", "PROJECT.md")


# ---------------------------------------------------------------------------
# Schema validation (reuses spec_validate.py logic, extended)
# ---------------------------------------------------------------------------


def validate_vbrief_schema(data: dict, filepath: str) -> list[str]:
    """Validate vBRIEF structural requirements (v0.6). Returns errors.

    Strictly requires ``vBRIEFInfo.version == "0.6"`` to match the canonical
    v0.6 schema vendored at ``vbrief/schemas/vbrief-core.schema.json`` (#533).
    Any v0.5 vBRIEF is auto-bumped to v0.6 during ``task migrate:vbrief``
    (#571); operators who hit the error should re-run the migrator.
    """
    errors: list[str] = []

    # Top-level envelope
    if "vBRIEFInfo" not in data:
        errors.append(f"{filepath}: missing required top-level key 'vBRIEFInfo'")
    else:
        info = data["vBRIEFInfo"]
        if not isinstance(info, dict):
            errors.append(f"{filepath}: 'vBRIEFInfo' must be an object")
        elif info.get("version") not in VALID_VBRIEF_VERSIONS:
            # #571: replaced the non-existent "migrator sweep" recovery
            # pointer with the real command -- the migrator now auto-
            # bumps v0.5 -> v0.6 on every pre-existing
            # ``specification.vbrief.json`` / ``plan.vbrief.json`` it
            # encounters.
            errors.append(
                f"{filepath}: 'vBRIEFInfo.version' must be '0.6' "
                f"(canonical v0.6 schema, #533), got "
                f"{info.get('version')!r}. Run `task migrate:vbrief` to "
                f"upgrade pre-existing v0.5 vBRIEFs in-place."
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
                    errors.append(f"{filepath}: 'plan' missing required field '{field}'")

            if "title" in plan and (not isinstance(plan["title"], str) or not plan["title"]):
                errors.append(f"{filepath}: 'plan.title' must be a non-empty string")

            if "status" in plan and plan["status"] not in VALID_STATUSES:
                errors.append(
                    f"{filepath}: 'plan.status' invalid: {plan['status']!r} "
                    f"(expected one of {sorted(VALID_STATUSES)})"
                )

            # Validate narratives values are strings
            if "narratives" in plan:
                _validate_narratives(plan["narratives"], f"{filepath}: plan.narratives", errors)

            if "items" in plan:
                if not isinstance(plan["items"], list):
                    errors.append(f"{filepath}: 'plan.items' must be an array")
                else:
                    for i, item in enumerate(plan["items"]):
                        if not isinstance(item, dict):
                            errors.append(f"{filepath}: plan.items[{i}] must be an object")
                            continue
                        _validate_plan_item(item, f"{filepath}: plan.items", errors)

    return errors


def _validate_narratives(narratives: object, path: str, errors: list[str]) -> None:
    """Validate that all values in a narratives object are strings."""
    if not isinstance(narratives, dict):
        errors.append(f"{path} must be an object")
        return
    for key, value in narratives.items():
        if not isinstance(value, str):
            errors.append(f"{path}.{key} must be a string, got {type(value).__name__}")


def _validate_plan_item(item: dict, path: str, errors: list[str]) -> None:
    """Recursively validate a PlanItem and its nested children.

    Per the canonical v0.6 schema, ``PlanItem.items`` is the PREFERRED
    nested field and ``PlanItem.subItems`` is the deprecated legacy alias
    kept for backward compatibility (#533 / Greptile P1). Both are accepted
    here and recursively validated; neither is treated as an error.
    """
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

    # v0.6 preferred nested field.
    if "items" in item:
        if not isinstance(item["items"], list):
            errors.append(f"{item_path}.items must be an array")
        else:
            for j, sub in enumerate(item["items"]):
                if not isinstance(sub, dict):
                    errors.append(f"{item_path}.items[{j}] must be an object")
                    continue
                _validate_plan_item(sub, f"{item_path}.items", errors)

    # Deprecated legacy alias -- still accepted for backward compatibility.
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


def validate_folder_status(filepath: Path, data: dict, vbrief_dir: Path) -> list[str]:
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


def validate_project_definition(filepath: Path, data: dict, vbrief_dir: Path) -> list[str]:
    """Validate PROJECT-DEFINITION.vbrief.json specific requirements."""
    errors: list[str] = []
    resolved_root = vbrief_dir.resolve()

    # Check narratives contains expected keys.  Normalization collapses
    # word separators so both the historic ``tech stack`` spelling and the
    # #506 D3 canonical ``TechStack`` shape satisfy the check.
    plan = data.get("plan", {})
    narratives = plan.get("narratives", {})
    if isinstance(narratives, dict):
        present = {_normalize_narrative_key(k) for k in narratives}
        for expected in PROJECT_DEF_EXPECTED_NARRATIVES:
            if expected not in present:
                errors.append(f"{filepath}: narratives missing expected key '{expected}' (D3)")

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
                    if not full_path.is_relative_to(resolved_root):
                        errors.append(
                            f"{filepath}: items[{i}] references "
                            f"'{ref_path}' outside vbrief directory (D3)"
                        )
                        continue
                    if not full_path.exists():
                        errors.append(
                            f"{filepath}: items[{i}] references "
                            f"'{ref_path}' which does not exist (D3)"
                        )
                elif uri and not uri.startswith(("http://", "https://", "#")):
                    # Treat as relative path
                    full_path = (vbrief_dir / uri).resolve()
                    if not full_path.is_relative_to(resolved_root):
                        errors.append(
                            f"{filepath}: items[{i}] references "
                            f"'{uri}' outside vbrief directory (D3)"
                        )
                        continue
                    if not full_path.exists():
                        errors.append(
                            f"{filepath}: items[{i}] references '{uri}' which does not exist (D3)"
                        )

    return errors


# ---------------------------------------------------------------------------
# D4: Epic-story bidirectional link validation
# ---------------------------------------------------------------------------


def validate_epic_story_links(
    all_vbriefs: dict[Path, dict],
    vbrief_dir: Path,
    resolved_to_original: dict[Path, Path] | None = None,
) -> list[str]:
    """Validate bidirectional references between epic and story vBRIEFs."""
    errors: list[str] = []
    path_map = resolved_to_original or {}

    def _display(p: Path) -> str:
        """Return original path for display if available."""
        return str(path_map.get(p, p))

    for filepath, data in all_vbriefs.items():
        plan = data.get("plan", {})
        fp_display = _display(filepath)

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
                # D4 only applies to child plan references
                if ref_type != "x-vbrief/plan":
                    continue
                # Resolve the child path
                child_path = _resolve_ref_path(uri, vbrief_dir)
                if child_path is None:
                    continue
                if child_path not in all_vbriefs:
                    if child_path.exists():
                        continue  # file exists but wasn't loaded
                    errors.append(
                        f"{fp_display}: references child '{uri}' which does not exist (D4)"
                    )
                    continue
                # Verify child has planRef back
                child_data = all_vbriefs[child_path]
                child_plan = child_data.get("plan", {})
                if not _has_plan_ref_to(child_plan, filepath, vbrief_dir):
                    errors.append(
                        f"{_display(child_path)}: missing planRef back "
                        f"to parent '{filepath.name}' (D4)"
                    )

        # Check backward references (story -> parent via planRef)
        # Scan both plan-level and item-level planRef values
        for plan_ref in _collect_plan_refs(plan):
            parent_path = _resolve_ref_path(plan_ref, vbrief_dir)
            if parent_path and parent_path in all_vbriefs:
                parent_data = all_vbriefs[parent_path]
                parent_plan = parent_data.get("plan", {})
                parent_refs = parent_plan.get("references", [])
                if isinstance(parent_refs, list):
                    child_uris = set()
                    for pref in parent_refs:
                        if isinstance(pref, dict) and pref.get("type") == "x-vbrief/plan":
                            child_uris.add(pref.get("uri", ""))
                    if not _path_in_refs(filepath, child_uris, vbrief_dir):
                        errors.append(
                            f"{fp_display}: has planRef to "
                            f"'{parent_path.name}' but parent "
                            "does not list this file in "
                            "references (D4)"
                        )
            elif parent_path and not parent_path.exists():
                errors.append(
                    f"{fp_display}: planRef references '{plan_ref}' which does not exist (D4)"
                )

    return errors


def _collect_plan_refs(plan: dict) -> list[str]:
    """Collect all planRef values from plan root and top-level items.

    Note: subItems are intentionally not scanned -- planRef is only valid
    at the plan root and top-level item levels per vBRIEF convention.
    """
    refs: list[str] = []
    root_ref = plan.get("planRef")
    if isinstance(root_ref, str) and root_ref:
        refs.append(root_ref)
    for item in plan.get("items", []):
        if isinstance(item, dict):
            item_ref = item.get("planRef")
            if isinstance(item_ref, str) and item_ref:
                refs.append(item_ref)
    return refs


def _resolve_ref_path(uri: str, vbrief_dir: Path) -> Path | None:
    """Resolve a reference URI to a filesystem path."""
    if not isinstance(uri, str):
        return None
    if uri.startswith("file://"):
        rel = uri.replace("file://", "")
        return (vbrief_dir / rel).resolve()
    if uri.startswith(("http://", "https://", "#")):
        return None
    # Treat as relative path
    return (vbrief_dir / uri).resolve()


def _has_plan_ref_to(child_plan: dict, parent_path: Path, vbrief_dir: Path) -> bool:
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


def _path_in_refs(filepath: Path, uris: set[str], vbrief_dir: Path) -> bool:
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
    filepath: Path,
    data: dict,
    vbrief_dir: Path,
    strict_origin_types: bool = False,
) -> list[str]:
    """Warn if a scope vBRIEF in pending/ or active/ has no origin reference.

    Default behavior (schema-trusting): ANY reference whose ``type`` matches
    ``^x-vbrief/`` counts as an origin. Legacy bare origin types
    (``github-issue``, ``jira-ticket``, ``user-request``) are also accepted
    unconditionally for pre-migration vBRIEFs (#536).

    Strict behavior (``strict_origin_types=True``): only values in
    :data:`STRICT_ORIGIN_ALLOWLIST` count. Legacy bare types continue to be
    accepted so pre-migration vBRIEFs do not regress.
    """
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
            if not isinstance(ref_type, str):
                continue

            # Legacy bare origin types always count (pre-migration vBRIEFs).
            if ref_type in LEGACY_ORIGIN_TYPES:
                has_origin = True
                break
            # Legacy extended types (e.g. "github-issue-v2") also count for
            # backward compatibility with pre-v0.20 tooling.
            if any(
                ref_type.startswith((f"{legacy}-", f"{legacy}/")) for legacy in LEGACY_ORIGIN_TYPES
            ):
                has_origin = True
                break

            if strict_origin_types:
                # Allow-list mode: only registered x-vbrief/* values count.
                if ref_type in STRICT_ORIGIN_ALLOWLIST:
                    has_origin = True
                    break
            else:
                # Schema-trusting default: any x-vbrief/* value counts.
                if ORIGIN_TYPE_PATTERN.match(ref_type):
                    has_origin = True
                    break

    if not has_origin:
        if strict_origin_types:
            warnings.append(
                f"{filepath}: scope vBRIEF in '{folder}/' has no references "
                "with an allow-listed origin type (D11; "
                "--strict-origin-types)"
            )
        else:
            warnings.append(
                f"{filepath}: scope vBRIEF in '{folder}/' has no references "
                "with an origin type (D11)"
            )

    return warnings


# ---------------------------------------------------------------------------
# #398: Render staleness detection (PRD.md / SPECIFICATION.md)
# ---------------------------------------------------------------------------


def check_render_staleness(vbrief_dir: Path) -> list[str]:
    """Warn if PRD.md or SPECIFICATION.md are stale relative to specification.vbrief.json.

    Compares source narratives/items from specification.vbrief.json against
    the rendered export files.  Returns warning strings for stale files.
    Skips silently if export files don't exist (#398).
    """
    warnings: list[str] = []
    project_root = vbrief_dir.parent
    spec_path = vbrief_dir / "specification.vbrief.json"

    if not spec_path.is_file():
        return warnings

    try:
        with open(spec_path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (json.JSONDecodeError, OSError):
        return warnings

    plan = data.get("plan", {})
    if not isinstance(plan, dict):
        return warnings

    narratives = plan.get("narratives", {})
    items = plan.get("items", [])
    title = plan.get("title", "")

    # --- PRD.md ---
    prd_path = project_root / "PRD.md"
    if prd_path.is_file():
        warnings.extend(_check_prd_staleness(prd_path, narratives, title))

    # --- SPECIFICATION.md ---
    # Note: validate_deprecated_placeholders (called earlier in validate_all)
    # may also warn about SPECIFICATION.md if it lacks the deprecation redirect
    # sentinel.  The staleness check here is complementary -- it fires for
    # rendered exports that have drifted, while the deprecated check fires for
    # files missing the redirect sentinel.  Both can appear in the same run
    # during transitional states (e.g. a user ran `task spec:render` after
    # migration); this is intentional -- the deprecated warning takes priority
    # for the user's attention.
    spec_md_path = project_root / "SPECIFICATION.md"
    if spec_md_path.is_file():
        warnings.extend(_check_spec_staleness(spec_md_path, narratives, items, title))

    return warnings


def _check_prd_staleness(
    prd_path: Path,
    narratives: dict,
    title: str,
) -> list[str]:
    """Return a warning if PRD.md does not reflect current source narratives."""
    try:
        content = prd_path.read_text(encoding="utf-8")
    except OSError:
        return []

    if not isinstance(narratives, dict) or not narratives:
        return []

    for value in narratives.values():
        if isinstance(value, str) and value.strip() and value.strip() not in content:
            return [
                "PRD.md may be stale relative to "
                "vbrief/specification.vbrief.json -- "
                "run `task prd:render` to refresh"
            ]

    if title and title not in content:
        return [
            "PRD.md may be stale relative to "
            "vbrief/specification.vbrief.json -- "
            "run `task prd:render` to refresh"
        ]

    return []


def _check_spec_staleness(
    spec_md_path: Path,
    narratives: dict,
    items: list,
    title: str,
) -> list[str]:
    """Return a warning if SPECIFICATION.md does not reflect current source."""
    try:
        content = spec_md_path.read_text(encoding="utf-8")
    except OSError:
        return []

    # Skip deprecation redirects
    if DEPRECATED_REDIRECT_SENTINEL in content:
        return []

    msg = (
        "SPECIFICATION.md may be stale relative to "
        "vbrief/specification.vbrief.json -- "
        "run `task spec:render` to refresh"
    )

    # Check item titles
    if isinstance(items, list):
        for item in items:
            if not isinstance(item, dict):
                continue
            item_title = item.get("title", "")
            if isinstance(item_title, str) and item_title and item_title not in content:
                return [msg]

    # Check all narrative values (mirrors _check_prd_staleness)
    if isinstance(narratives, dict):
        for value in narratives.values():
            if isinstance(value, str) and value.strip() and value.strip() not in content:
                return [msg]

    # Check title
    if title and title not in content:
        return [msg]

    return []


# ---------------------------------------------------------------------------
# Story S (#334): Post-migration placeholder integrity
# ---------------------------------------------------------------------------


def validate_deprecated_placeholders(
    vbrief_dir: Path,
) -> list[str]:
    """Check that SPECIFICATION.md and PROJECT.md contain the deprecation
    redirect sentinel if they exist.

    After migration, these files are replaced with redirect stubs containing
    ``<!-- deft:deprecated-redirect -->``.  If a user or agent replaces the
    redirect with real content, flag it as a warning.

    Returns a list of warning strings.
    """
    warnings: list[str] = []
    project_root = vbrief_dir.parent

    for filename in DEPRECATED_FILES:
        filepath = project_root / filename
        if not filepath.is_file():
            continue
        try:
            content = filepath.read_text(encoding="utf-8")
        except OSError:
            continue

        if DEPRECATED_REDIRECT_SENTINEL not in content:
            warnings.append(
                f"{filename} contains non-redirect content -- "
                "this file is deprecated; use scope vBRIEFs "
                "in vbrief/ instead"
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


def validate_all(
    vbrief_dir: Path,
    strict_origin_types: bool = False,
) -> tuple[list[str], list[str], int]:
    """Run all validators. Returns (errors, warnings, scope_count)."""
    errors: list[str] = []
    warnings: list[str] = []
    all_vbriefs: dict[Path, dict] = {}
    # Map resolved -> original path for consistent error messages
    resolved_to_original: dict[Path, Path] = {}

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

        resolved = filepath.resolve()
        all_vbriefs[resolved] = data
        resolved_to_original[resolved] = filepath

        # Schema validation
        errors.extend(validate_vbrief_schema(data, str(filepath)))

        # Filename convention (D7)
        errors.extend(validate_filename(filepath))

        # Folder/status consistency (D2)
        errors.extend(validate_folder_status(filepath, data, vbrief_dir))

        # Origin provenance (D11) -- warnings only
        warnings.extend(
            validate_origin_provenance(
                filepath,
                data,
                vbrief_dir,
                strict_origin_types=strict_origin_types,
            )
        )

    # Validate PROJECT-DEFINITION.vbrief.json if it exists
    project_def = vbrief_dir / "PROJECT-DEFINITION.vbrief.json"
    if project_def.exists():
        data, load_err = load_vbrief(project_def)
        if load_err:
            errors.append(load_err)
        elif data is not None:
            resolved_pd = project_def.resolve()
            all_vbriefs[resolved_pd] = data
            resolved_to_original[resolved_pd] = project_def
            errors.extend(validate_vbrief_schema(data, str(project_def)))
            errors.extend(validate_project_definition(project_def, data, vbrief_dir))

    # Epic-story bidirectional link validation (D4)
    if all_vbriefs:
        errors.extend(validate_epic_story_links(all_vbriefs, vbrief_dir, resolved_to_original))

    # Post-migration placeholder integrity (Story S #334)
    warnings.extend(validate_deprecated_placeholders(vbrief_dir))

    # Render staleness check (#398)
    warnings.extend(check_render_staleness(vbrief_dir))

    return errors, warnings, len(scope_files)


USAGE = (
    "Usage: vbrief_validate.py [--vbrief-dir <path>] [--strict-origin-types] [--warnings-as-errors]"
)


def main(argv: list[str] | None = None) -> int:
    """CLI entry point.

    Exit codes (#536):
        0 -- no errors (warnings tolerated unless --warnings-as-errors is set)
        1 -- errors, or warnings when --warnings-as-errors is set
        2 -- usage error (unknown flag / missing argument)
    """
    vbrief_dir = Path("vbrief")
    strict_origin_types = False
    warnings_as_errors = False

    # Parse args
    args = list(sys.argv[1:] if argv is None else argv)
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--vbrief-dir" and i + 1 < len(args):
            vbrief_dir = Path(args[i + 1])
            i += 2
        elif arg == "--strict-origin-types":
            strict_origin_types = True
            i += 1
        elif arg == "--warnings-as-errors":
            warnings_as_errors = True
            i += 1
        elif arg in ("-h", "--help"):
            print(USAGE)
            return 0
        else:
            print(f"Unknown argument: {arg}", file=sys.stderr)
            print(USAGE, file=sys.stderr)
            return 2

    if not vbrief_dir.is_dir():
        # No vbrief directory -- nothing to validate, pass silently
        print(f"OK: No vbrief directory at {vbrief_dir} -- skipping validation")
        return 0

    errors, warnings, scope_count = validate_all(
        vbrief_dir, strict_origin_types=strict_origin_types
    )

    # Print warnings first, then errors
    for w in warnings:
        print(f"WARN: {w}")
    for e in errors:
        print(f"FAIL: {e}")

    # Determine exit code up-front so the summary banner reflects it.
    warnings_escalated = bool(warnings) and warnings_as_errors
    exit_code = 1 if errors or warnings_escalated else 0

    # Only emit the "OK" banner when we will actually exit 0 (#536 Defect 2).
    if exit_code == 0:
        project_def = vbrief_dir / "PROJECT-DEFINITION.vbrief.json"
        parts = []
        if scope_count:
            parts.append(f"{scope_count} scope vBRIEF(s)")
        if project_def.exists():
            parts.append("PROJECT-DEFINITION")
        summary = ", ".join(parts) if parts else "no vBRIEF files"
        warning_note = f" ({len(warnings)} warning(s))" if warnings else ""
        print(f"OK: vBRIEF validation passed: {summary}{warning_note}")
    else:
        if errors:
            print(f"\nFAIL: {len(errors)} error(s) found")
        if warnings_escalated and not errors:
            print(f"\nFAIL: {len(warnings)} warning(s) treated as errors (--warnings-as-errors)")

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
