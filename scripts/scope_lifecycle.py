#!/usr/bin/env python3
"""
scope_lifecycle.py -- Deterministic vBRIEF scope lifecycle transitions.

Usage:
    uv run python scripts/scope_lifecycle.py <action> <file>

Actions:
    promote   -- proposed/ -> pending/ (status: pending)
    activate  -- pending/ -> active/ (status: running)
    complete  -- active/ -> completed/ (status: completed)
    cancel    -- any folder -> cancelled/ (status: cancelled)
    restore   -- cancelled/ -> proposed/ (status: proposed)
    block     -- stays in active/ (status: blocked)
    unblock   -- stays in active/ (status: running)

Each action:
    - Validates the transition is legal (source folder + current status)
    - Updates plan.status and plan.updated in the vBRIEF file
    - Moves the file to the target lifecycle folder (where applicable)
    - Reports the transition performed

Exit codes:
    0 -- transition successful
    1 -- invalid transition or validation error
    2 -- usage error

RFC #309 decision D16. Story #324.
"""

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

LIFECYCLE_FOLDERS = ("proposed", "pending", "active", "completed", "cancelled")

# action -> (allowed_source_folders, target_folder, target_status)
# None for target_folder means file stays in place.
TRANSITIONS: dict[str, tuple[tuple[str, ...], str | None, str]] = {
    "promote": (("proposed",), "pending", "pending"),
    "activate": (("pending",), "active", "running"),
    "complete": (("active",), "completed", "completed"),
    "cancel": (LIFECYCLE_FOLDERS, "cancelled", "cancelled"),
    "restore": (("cancelled",), "proposed", "proposed"),
    "block": (("active",), None, "blocked"),
    "unblock": (("active",), None, "running"),
}

# Status preconditions for actions that stay in place.
# block requires status=running, unblock requires status=blocked.
STATUS_PRECONDITIONS: dict[str, str] = {
    "block": "running",
    "unblock": "blocked",
}


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------


def detect_lifecycle_folder(file_path: Path) -> str | None:
    """Return the lifecycle folder name the file resides in, or None."""
    parent_name = file_path.parent.name
    if parent_name in LIFECYCLE_FOLDERS:
        return parent_name
    return None


def run_transition(action: str, file_path: Path) -> tuple[bool, str]:
    """Execute a lifecycle transition on a vBRIEF file.

    Returns:
        (True, success_message) on success.
        (False, error_message) on failure.
    """
    if action not in TRANSITIONS:
        valid = ", ".join(sorted(TRANSITIONS))
        return False, f"Unknown action '{action}'. Valid actions: {valid}"

    if not file_path.exists():
        return False, f"File not found: {file_path}"

    if not file_path.name.endswith(".vbrief.json"):
        return False, f"Not a vBRIEF file (expected .vbrief.json): {file_path.name}"

    # Determine current folder
    current_folder = detect_lifecycle_folder(file_path)
    if current_folder is None:
        return False, (
            f"File is not inside a lifecycle folder ({', '.join(LIFECYCLE_FOLDERS)}): "
            f"{file_path}"
        )

    allowed_sources, target_folder, target_status = TRANSITIONS[action]

    # Validate source folder
    if current_folder not in allowed_sources:
        allowed_str = ", ".join(f"{s}/" for s in allowed_sources)
        return False, (
            f"Invalid transition: '{action}' requires file in "
            f"{allowed_str}. File is in {current_folder}/."
        )

    # Load and validate JSON
    try:
        text = file_path.read_text(encoding="utf-8")
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        return False, f"Invalid JSON in {file_path}: {exc}"

    plan = data.get("plan")
    if not isinstance(plan, dict):
        return False, f"Missing or invalid 'plan' object in {file_path}"

    current_status = plan.get("status", "")

    # Check status preconditions (block/unblock)
    if action in STATUS_PRECONDITIONS:
        required_status = STATUS_PRECONDITIONS[action]
        if current_status == target_status:
            # Idempotent: already in the target state
            return True, (
                f"No-op: {file_path.name} is already {target_status} "
                f"in {current_folder}/"
            )
        if current_status != required_status:
            return False, (
                f"Invalid transition: '{action}' requires status='{required_status}', "
                f"but {file_path.name} has status='{current_status}'."
            )

    # Update status and timestamp
    plan["status"] = target_status
    plan["updated"] = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Write updated JSON
    updated_json = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    file_path.write_text(updated_json, encoding="utf-8")

    # Move file if target folder differs from current
    if target_folder is not None and target_folder != current_folder:
        vbrief_root = file_path.parent.parent
        dest_dir = vbrief_root / target_folder
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest_path = dest_dir / file_path.name
        file_path.rename(dest_path)
        action_label = action.capitalize()
        if action == "activate":
            action_label = "Activated"
        elif action == "promote":
            action_label = "Promoted"
        elif action == "complete":
            action_label = "Completed"
        elif action == "cancel":
            action_label = "Cancelled"
        elif action == "restore":
            action_label = "Restored"
        return True, (
            f"{action_label} {file_path.name}: "
            f"{current_folder}/ -> {target_folder}/ (status: {target_status})"
        )

    # File stays in place (block/unblock)
    action_label = "Blocked" if action == "block" else "Unblocked"
    return True, (
        f"{action_label} {file_path.name}: "
        f"stays in {current_folder}/ (status: {target_status})"
    )


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def main() -> int:
    if len(sys.argv) < 3:
        print(
            "Usage: scope_lifecycle.py <action> <file>\n"
            f"Actions: {', '.join(sorted(TRANSITIONS))}",
            file=sys.stderr,
        )
        return 2

    action = sys.argv[1]
    file_path = Path(sys.argv[2]).resolve()

    ok, message = run_transition(action, file_path)
    if ok:
        print(message)
        return 0
    print(f"Error: {message}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
