#!/usr/bin/env python3
"""
spec_render.py — Render a vbrief specification JSON file to SPECIFICATION.md.

Usage:
    uv run python scripts/spec_render.py <spec_file> [out_file]

    spec_file — path to vbrief/specification.vbrief.json
    out_file  — output path (default: <spec_file's grandparent>/SPECIFICATION.md)

Exit codes:
    0 — rendered successfully
    1 — validation failed or status not 'approved'
    2 — usage error (no argument provided)

Implementation: IMPLEMENTATION.md Phase 5.2
"""

import json
import sys
from pathlib import Path

# Allow co-located import of spec_validate when run as a script
sys.path.insert(0, str(Path(__file__).parent))
from spec_validate import validate_spec  # noqa: E402


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

    status = spec.get("status", "")
    if status != "approved":
        return (
            False,
            f"⚠ specification.vbrief.json status is '{status}' (expected 'approved')\n"
            "  Have the user review and set status to 'approved' before rendering.",
        )

    lines: list[str] = []

    title = spec.get("title") or spec.get("plan") or "Specification"
    lines.append(f"# {title}\n")

    if overview := spec.get("overview") or spec.get("description"):
        lines.append(f"{overview}\n")

    for task in spec.get("tasks", []):
        task_id = task.get("id", "")
        do = task.get("do") or task.get("title") or ""
        task_status = task.get("status", "")
        lines.append(f"## {task_id}: {do}  `[{task_status}]`\n")
        for key in ("narrative", "acceptance", "why"):
            if val := task.get(key):
                if isinstance(val, list):
                    for item in val:
                        lines.append(f"- {item}")
                    lines.append("")
                else:
                    lines.append(f"{val}\n")

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
