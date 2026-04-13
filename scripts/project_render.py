#!/usr/bin/env python3
"""
project_render.py — Regenerate PROJECT-DEFINITION.vbrief.json from lifecycle folders.

Deterministic layer (RFC #309, Decision D14):
- Scans all lifecycle folders (proposed/, pending/, active/, completed/, cancelled/)
- Updates the items registry with scope entries (title, status, file path, references)
- Timestamps freshness (vBRIEFInfo.updated)
- Flags narratives that may be stale based on completed scope topics
- Creates skeleton PROJECT-DEFINITION.vbrief.json if none exists

Agent-assisted layer (documented convention, not implemented as code):
    During sync or refinement sessions, the agent reviews flagged narratives and
    proposes updates to project identity (overview, capabilities, risks, tech stack)
    based on completed work.  The user approves -- never fully automatic for content
    requiring judgment.

    Workflow:
    1. Run `task project:render` to refresh the items registry and staleness flags.
    2. The agent reads staleness_flags from plan.metadata.staleness_flags.
    3. For each flagged narrative, the agent drafts a proposed update reflecting
       the completed scopes (e.g. if a "tech stack" scope completed, update the
       TechStack narrative with the new technology choices).
    4. The user reviews and approves each narrative change.
    5. The agent writes approved changes back to PROJECT-DEFINITION.vbrief.json.

Usage:
    uv run python scripts/project_render.py [vbrief_dir]

    vbrief_dir — path to vbrief/ directory (default: ./vbrief)

Exit codes:
    0 — rendered successfully
    1 — error occurred
    2 — usage error
"""

import json
import re
import sys
from datetime import UTC, datetime
from pathlib import Path

LIFECYCLE_FOLDERS = ("proposed", "pending", "active", "completed", "cancelled")

SKELETON_NARRATIVES = {
    "Overview": "",
    "TechStack": "",
    "Architecture": "",
    "RisksAndUnknowns": "",
    "Configuration": "",
}


def _split_camel(name: str) -> list[str]:
    """Split a camelCase or PascalCase string into lowercase words.

    >>> _split_camel("TechStack")
    ['tech', 'stack']
    >>> _split_camel("RisksAndUnknowns")
    ['risks', 'and', 'unknowns']
    """
    parts = re.sub(r"([a-z])([A-Z])", r"\1 \2", name)
    return [w.lower() for w in parts.split()]


def scan_lifecycle_folders(vbrief_dir: Path) -> list[dict]:
    """Scan all lifecycle folders for *.vbrief.json files and return items.

    Scans folders in a fixed order (proposed, pending, active, completed,
    cancelled) and files alphabetically within each folder, producing
    deterministic output for the same folder contents.
    """
    items: list[dict] = []
    for folder_name in LIFECYCLE_FOLDERS:
        folder = vbrief_dir / folder_name
        if not folder.is_dir():
            continue
        for vbrief_file in sorted(folder.glob("*.vbrief.json")):
            try:
                with open(vbrief_file, encoding="utf-8") as fh:
                    data = json.load(fh)
                plan = data.get("plan", {})
                title = plan.get("title", vbrief_file.stem)
                status = plan.get("status", folder_name)
                references = plan.get("references", [])

                item: dict = {
                    "id": vbrief_file.stem.replace(".vbrief", ""),
                    "title": title,
                    "status": status,
                    "metadata": {
                        "source_path": f"{folder_name}/{vbrief_file.name}",
                        "lifecycle_folder": folder_name,
                    },
                }
                if references:
                    item["metadata"]["references"] = references
                items.append(item)
            except (json.JSONDecodeError, OSError):
                items.append(
                    {
                        "id": vbrief_file.stem.replace(".vbrief", ""),
                        "title": f"[unreadable] {vbrief_file.name}",
                        "status": "draft",
                        "metadata": {
                            "source_path": f"{folder_name}/{vbrief_file.name}",
                            "lifecycle_folder": folder_name,
                            "error": "Failed to read or parse file",
                        },
                    }
                )
    return items


def flag_stale_narratives(
    narratives: dict[str, str],
    completed_items: list[dict],
) -> list[str]:
    """Flag narratives that may need review based on completed scope topics.

    Algorithm (deterministic):
    1. Split each narrative key into words (camelCase-aware).
    2. For each completed scope, extract title words.
    3. If any narrative-key word (>3 chars) appears in a completed scope title,
       flag that narrative with the matching scope.
    4. If >=3 completed scopes exist and no specific flags fired, emit a general
       review recommendation.

    Returns a sorted list of staleness warning strings.
    """
    if not completed_items or not narratives:
        if completed_items and len(completed_items) >= 3:
            return [
                f"{len(completed_items)} scopes completed since last narrative update"
                " -- review recommended"
            ]
        return []

    flags: list[str] = []
    flagged_narratives: set[str] = set()

    for narrative_key in sorted(narratives.keys()):
        key_words = {w for w in _split_camel(narrative_key) if len(w) > 3}
        if not key_words:
            continue
        for item in completed_items:
            title_lower = item.get("title", "").lower()
            title_words = set(re.split(r"\W+", title_lower))
            overlap = key_words & title_words
            if overlap:
                flags.append(
                    f"Narrative '{narrative_key}' may be stale: "
                    f"completed scope '{item.get('title', '')}' "
                    f"shares topics ({', '.join(sorted(overlap))})"
                )
                flagged_narratives.add(narrative_key)

    # General flag if many completed scopes but no specific matches
    if len(completed_items) >= 3 and not flagged_narratives:
        flags.append(
            f"{len(completed_items)} scopes completed since last narrative update"
            " -- review recommended"
        )

    return sorted(flags)


def create_skeleton(items: list[dict], now: str) -> dict:
    """Create a skeleton PROJECT-DEFINITION.vbrief.json structure."""
    completed_items = [i for i in items if i.get("status") == "completed"]
    staleness_flags = flag_stale_narratives(dict(SKELETON_NARRATIVES), completed_items)

    return {
        "vBRIEFInfo": {
            "version": "0.5",
            "description": "Project definition -- synthesized gestalt of the project",
            "created": now,
            "updated": now,
        },
        "plan": {
            "title": "PROJECT-DEFINITION",
            "status": "running",
            "narratives": dict(SKELETON_NARRATIVES),
            "items": items,
            "metadata": {
                "staleness_flags": staleness_flags,
            },
        },
    }


def render_project_definition(vbrief_dir: str) -> tuple[bool, str]:
    """Regenerate PROJECT-DEFINITION.vbrief.json from lifecycle folder contents.

    Returns:
        (True, success_message) on success.
        (False, error_message) on failure.
    """
    vbrief_path = Path(vbrief_dir)
    project_def_path = vbrief_path / "PROJECT-DEFINITION.vbrief.json"

    # Scan lifecycle folders (handles missing folders gracefully)
    items = scan_lifecycle_folders(vbrief_path)

    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    created_new = not project_def_path.exists()

    if project_def_path.exists():
        # Update existing PROJECT-DEFINITION
        try:
            with open(project_def_path, encoding="utf-8") as fh:
                project_def = json.load(fh)
        except (json.JSONDecodeError, OSError) as exc:
            return False, f"✗ Failed to read {project_def_path}: {exc}"

        plan = project_def.get("plan", {})

        # Update items registry (deterministic)
        plan["items"] = items

        # Timestamp freshness
        project_def.setdefault("vBRIEFInfo", {})
        project_def["vBRIEFInfo"]["updated"] = now

        # Flag stale narratives
        narratives = plan.get("narratives", {})
        completed_items = [i for i in items if i.get("status") == "completed"]
        flags = flag_stale_narratives(narratives, completed_items)
        plan.setdefault("metadata", {})
        plan["metadata"]["staleness_flags"] = flags

        project_def["plan"] = plan
    else:
        # Create skeleton
        project_def = create_skeleton(items, now)

    # Ensure parent directory exists
    project_def_path.parent.mkdir(parents=True, exist_ok=True)

    # Write deterministic output
    with open(project_def_path, "w", encoding="utf-8") as fh:
        json.dump(project_def, fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    # Report
    item_count = len(items)
    flag_count = len(project_def["plan"].get("metadata", {}).get("staleness_flags", []))
    action = "created" if created_new else "updated"

    parts = [f"✓ PROJECT-DEFINITION.vbrief.json {action} ({item_count} scope items)"]
    if flag_count:
        parts.append(f"⚠ {flag_count} staleness flag(s) -- agent review recommended")

    return True, "\n".join(parts)


def main() -> int:
    if len(sys.argv) > 2:
        print("Usage: project_render.py [vbrief_dir]", file=sys.stderr)
        return 2

    vbrief_dir = sys.argv[1] if len(sys.argv) == 2 else "vbrief"

    ok, message = render_project_definition(vbrief_dir)
    print(message)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
