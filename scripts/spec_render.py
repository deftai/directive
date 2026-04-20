#!/usr/bin/env python3
"""
spec_render.py — Render a vbrief specification JSON file to SPECIFICATION.md.

Usage:
    uv run python scripts/spec_render.py <spec_file> [out_file]

    spec_file — path to vbrief/specification.vbrief.json
    out_file  — output path (default: <spec_file's grandparent>/SPECIFICATION.md)

Exit codes:
    0 — rendered successfully
    1 — validation failed or status not in ('approved', 'running', 'completed')
    2 — usage error (no argument provided)

Implementation: IMPLEMENTATION.md Phase 5.2
"""

import json
import sys
from pathlib import Path

# Allow co-located import of spec_validate when run as a script
sys.path.insert(0, str(Path(__file__).parent))
from spec_validate import validate_spec  # noqa: E402

# Declared narrative ordering for SPECIFICATION.md. Covers both the
# interview/light key set (Overview, ProblemStatement, Goals, UserStories,
# Requirements, SuccessMetrics, Architecture) and the speckit Phase 2/3 key
# set (EdgeCases, TechDecisions, ImplementationPhases, PreImplementationGates).
# Narratives present on the spec render in this declared order; any other
# narrative keys render after these, sorted alphabetically. See #434.
SPECIFICATION_NARRATIVE_KEY_ORDER = [
    "Overview",
    "ProblemStatement",
    "Goals",
    "UserStories",
    "Requirements",
    "SuccessMetrics",
    "EdgeCases",
    "Architecture",
    "TechDecisions",
    "ImplementationPhases",
    "PreImplementationGates",
]


def render_spec(spec_path: str, out_path: str) -> tuple[bool, str]:
    """
    Render the approved spec at *spec_path* to markdown at *out_path*.

    Returns:
        (True, success_message) on success.
        (False, error_message)  on failure.
    """
    # Validate first
    ok, msg = validate_spec(spec_path)
    if not ok:
        return False, msg

    with open(spec_path, encoding="utf-8") as fh:
        spec = json.load(fh)

    # Support vBRIEF v0.5 envelope structure
    plan = spec.get("plan", {})
    status = plan.get("status", "") if isinstance(plan, dict) else spec.get("status", "")

    renderable_statuses = ("approved", "running", "completed")
    if status not in renderable_statuses:
        return (
            False,
            f"⚠ specification.vbrief.json status is '{status}' "
            f"(expected one of {renderable_statuses})\n"
            "  Have the user review and set status to one of the"
            " renderable statuses before rendering.",
        )

    lines: list[str] = []

    if isinstance(plan, dict):
        title = plan.get("title", "Specification")
    else:
        title = plan or spec.get("title", "Specification")
    lines.append(f"# {title}\n")

    # Render narratives in declared order, then remaining keys alphabetically.
    # Mirrors prd_render.py behavior -- speckit-shaped specs (ProblemStatement,
    # Goals, Requirements, etc.) must not be silently dropped (#434).
    if isinstance(plan, dict):
        narratives = plan.get("narratives", {})
        if not isinstance(narratives, dict):
            narratives = {}
    else:
        # Legacy flat-format specs may carry overview/description at top level.
        legacy_overview = spec.get("overview") or spec.get("description") or ""
        narratives = {"Overview": legacy_overview} if legacy_overview else {}

    rendered_keys: set[str] = set()
    for key in SPECIFICATION_NARRATIVE_KEY_ORDER:
        if key in narratives and narratives[key]:
            lines.append(f"## {key}\n")
            lines.append(f"{narratives[key]}\n")
            rendered_keys.add(key)

    for key in sorted(narratives.keys()):
        if key in rendered_keys or not narratives.get(key):
            continue
        lines.append(f"## {key}\n")
        lines.append(f"{narratives[key]}\n")

    # Extract items from plan.items (v0.5) or spec.tasks (legacy). Items render
    # after narratives so hybrid/legacy specs (items + narratives) still produce
    # complete output.
    items = plan.get("items", []) if isinstance(plan, dict) else spec.get("tasks", [])
    for item in items:
        item_id = item.get("id", "")
        title_text = item.get("title", "")
        item_status = item.get("status", "")
        lines.append(f"## {item_id}: {title_text}  `[{item_status}]`\n")

        # Dependencies from metadata (v0.5) or inline (legacy)
        deps = None
        if metadata := item.get("metadata"):
            deps = metadata.get("dependencies")
        if not deps:
            deps = item.get("dependencies")
        if deps:
            dep_list = ", ".join(deps)
            lines.append(f"**Depends on**: {dep_list}\n")

        # Narrative is an object in v0.5, string/list in legacy
        narrative = item.get("narrative")
        if isinstance(narrative, dict):
            for key, val in narrative.items():
                if key == "Traces":
                    lines.append(f"**Traces**: {val}\n")
                elif key == "Acceptance":
                    if isinstance(val, list):
                        criteria = val
                    else:
                        criteria = [c for c in str(val).split("; ") if c]
                    for criterion in criteria:
                        lines.append(f"- {criterion}")
                    lines.append("")
                else:
                    lines.append(f"{val}\n")
        elif isinstance(narrative, list):
            for entry in narrative:
                lines.append(f"- {entry}")
            lines.append("")
        elif narrative:
            lines.append(f"{narrative}\n")

    Path(out_path).write_text("\n".join(lines), encoding="utf-8")
    return True, f"✓ Rendered to {out_path}"


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: spec_render.py <spec_file> [out_file]", file=sys.stderr)
        return 2

    spec_path = sys.argv[1]
    if len(sys.argv) >= 3:
        out_path = sys.argv[2]
    else:
        # Default: place SPECIFICATION.md at the grandparent of the spec file
        # e.g. vbrief/specification.vbrief.json → SPECIFICATION.md
        out_path = str(Path(spec_path).resolve().parent.parent / "SPECIFICATION.md")

    ok, message = render_spec(spec_path, out_path)
    print(message)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
