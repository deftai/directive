#!/usr/bin/env python3
"""
scope_lifecycle.py -- Deterministic vBRIEF scope lifecycle transitions.

Usage:
    uv run python scripts/scope_lifecycle.py <action> <file> [--project-root PATH]

Actions:
    promote   -- proposed/ -> pending/ (status: pending)
                  Subject to the WIP cap (#1124 / D4 of #1119):
                  refused when ``pending/ + active/`` >= cap; pass
                  ``--force`` to override (stderr warning + audit-log
                  entry tagged ``wip_cap_override``).
    activate  -- pending/ -> active/ (status: running)
    complete  -- active/ -> completed/ (status: completed)
    fail      -- active/ -> completed/ (status: failed)
    cancel    -- any folder -> cancelled/ (status: cancelled)
    restore   -- cancelled/ -> proposed/ (status: proposed)
    block     -- stays in active/ (status: blocked)
    unblock   -- stays in active/ (status: running)

Note: ``complete`` and ``fail`` share the active/ -> completed/ move;
they differ only in terminal status (``completed`` vs ``failed``). The
semantic distinction (#614) is:

* ``complete`` -- the scope succeeded.
* ``cancel`` -- decision: the scope is no longer wanted (superseded,
  obsolete); moves to cancelled/.
* ``fail`` -- attempt: the scope was tried but could not complete
  (external blocker, infeasibility discovered mid-flight, deadline hit,
  agent exhausted retries). Records a failure terminal state when the
  work should NOT be cancelled.

Collapsing ``failed`` into ``cancelled`` would lose this information
and leave ``active/`` as a zombie graveyard when agents hit
unrecoverable blockers.

Each action:
    - Validates the transition is legal (source folder + current status)
    - Updates plan.status and plan.updated in the vBRIEF file
    - Moves the file to the target lifecycle folder (where applicable)
    - Reports the transition performed

Path resolution (#535):
    Relative ``<file>`` arguments resolve against the consumer project
    root (highest precedence flag beats environment beats sentinel walk),
    NEVER against ``deft/``. If no project root can be detected the script
    fails loudly with exit 2 instead of silently falling back.

Exit codes:
    0 -- transition successful
    1 -- invalid transition or validation error
    2 -- usage error (including: undetectable project root for relative path)

RFC #309 decision D16. Story #324.
"""

import argparse
import contextlib
import json
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

# Make sibling ``_stdio_utf8`` / ``_project_context`` importable both when
# run as ``__main__`` and when imported by tests that preload sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _project_context import resolve_project_root  # noqa: E402
from _stdio_utf8 import reconfigure_stdio  # noqa: E402

reconfigure_stdio()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

LIFECYCLE_FOLDERS = ("proposed", "pending", "active", "completed", "cancelled")

# action -> (allowed_source_folders, target_folder, target_status)
# None for target_folder means file stays in place.
#
# ``fail`` parallels ``complete`` exactly on folder movement (both move
# active/ -> completed/); they differ only in the terminal status
# stamped onto ``plan.status`` (``failed`` vs ``completed``). See the
# module docstring for the cancel/fail semantic distinction (#614).
TRANSITIONS: dict[str, tuple[tuple[str, ...], str | None, str]] = {
    "promote": (("proposed",), "pending", "pending"),
    "activate": (("pending",), "active", "running"),
    "complete": (("active",), "completed", "completed"),
    "fail": (("active",), "completed", "failed"),
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
# WIP cap enforcement (#1124 / D4 of #1119)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class WipCapCheck:
    """Result of the pre-promote WIP cap check.

    * ``allowed`` -- True if promotion can proceed (count < cap, OR
      ``--force`` was passed).
    * ``cap`` -- resolved cap value (default 10 per the shared
      :data:`scripts.policy.DEFAULT_WIP_CAP`).
    * ``count`` -- current ``pending/ + active/`` count.
    * ``source`` -- ``scripts.policy.WipCapResult.source`` carry-through.
    * ``force_override`` -- True when ``allowed`` was granted via
      ``--force`` (the caller MUST emit a warning + audit-log entry).
    """

    allowed: bool
    cap: int
    count: int
    source: str
    force_override: bool = False


def check_wip_cap(
    project_root: Path,
    *,
    force: bool = False,
) -> WipCapCheck:
    """Resolve the WIP cap and current count; decide if promotion is allowed.

    Pure-stdlib helper. Deferred-import of ``scripts.policy`` so a
    consumer running this verb against a tree that pre-dates D4
    (#1124) degrades to ``allowed=True`` (cap unknown -> do not block).
    """
    try:
        from policy import (  # noqa: I001
            count_vbrief_wip,
            resolve_wip_cap,
        )
    except ImportError:  # pragma: no cover -- D4 not present on rolling-merge tolerance branch
        return WipCapCheck(
            allowed=True,
            cap=10,
            count=0,
            source="d4-not-available",
            force_override=force,
        )

    cap_result = resolve_wip_cap(project_root)
    cap = cap_result.cap
    count = count_vbrief_wip(project_root)
    # ``pending/ + active/`` >= cap refuses; ``--force`` overrides.
    over_cap = count >= cap
    if not over_cap:
        return WipCapCheck(
            allowed=True,
            cap=cap,
            count=count,
            source=cap_result.source,
            force_override=False,
        )
    if force:
        return WipCapCheck(
            allowed=True,
            cap=cap,
            count=count,
            source=cap_result.source,
            force_override=True,
        )
    return WipCapCheck(
        allowed=False,
        cap=cap,
        count=count,
        source=cap_result.source,
        force_override=False,
    )


def format_wip_cap_refusal(check: WipCapCheck) -> str:
    """Format the cap-reached error message (#1124 acceptance criterion).

    Names the cap, the current count, and the canonical relief verbs
    (single-file demote, batch demote, ``--force`` override). Mirrors
    the issue body's demoability block verbatim so downstream operators
    learn the same recovery surface as the spec describes.
    """
    # noqa: E501 -- the alignment columns are part of the verbatim demoability
    # block from the #1124 issue body and MUST NOT be reflowed.
    return (
        f"ERROR: WIP cap reached ({check.count}/{check.cap} in pending/+active/). "
        "Either:\n"
        "  task scope:demote <existing>                              # return one to proposed/\n"  # noqa: E501
        "  task scope:demote --batch --older-than-days 30            # bulk relief (D9 folded into D1)\n"  # noqa: E501
        "  task scope:promote <file> --force                          # override (logged)"
    )


def _record_wip_cap_override(
    file_path: Path,
    project_root: Path,
    check: WipCapCheck,
) -> None:
    """Append a ``wip_cap_override`` audit entry to the scope-lifecycle log.

    Uses :mod:`scripts.scope_audit_log` (shared with D1 / #1121) so the
    override is on the same canonical timeline as ``demote`` entries.
    The audit-log validator does NOT require any action-specific block
    for ``action='promote'`` -- only ``demote`` mandates ``demote_meta``
    -- so this entry passes validation while carrying its own forward-
    compat ``wip_cap_override`` block. Best-effort: any audit failure
    is swallowed (the promote itself MUST succeed when ``--force`` was
    passed; the audit-log surface is observability).
    """
    with contextlib.suppress(Exception):
        from scope_audit_log import (  # noqa: I001
            append as audit_append,
            canonical_log_path,
            new_decision_id,
        )

        try:
            rel = file_path.resolve().relative_to(project_root.resolve())
            canonical = rel.as_posix()
        except ValueError:
            canonical = file_path.resolve().as_posix()
        entry = {
            "decision_id": new_decision_id(),
            "timestamp": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "action": "promote",
            "vbrief_path": canonical,
            "from_status": "proposed",
            "to_status": "pending",
            "actor": "operator",
            "wip_cap_override": {
                "cap": check.cap,
                "count_at_promote": check.count,
                "source": check.source,
                "reason": "--force",
            },
        }
        audit_append(entry, log_path=canonical_log_path(project_root))


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

    # Idempotent: same-folder move with matching status is a no-op
    # (e.g. cancel on a file already in cancelled/)
    if target_folder is not None and target_folder == current_folder:
        return True, (
            f"No-op: {file_path.name} is already in {current_folder}/ "
            f"(status: {current_status})"
        )

    # Update status and timestamp
    plan["status"] = target_status
    plan["updated"] = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Write updated JSON
    updated_json = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    file_path.write_text(updated_json, encoding="utf-8")

    # Move file if target folder differs from current
    if target_folder is not None:
        vbrief_root = file_path.parent.parent
        dest_dir = vbrief_root / target_folder
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest_path = dest_dir / file_path.name
        # Path.replace() is portable; Path.rename() raises FileExistsError on Windows
        file_path.replace(dest_path)
        _move_labels = {
            "promote": "Promoted",
            "activate": "Activated",
            "complete": "Completed",
            "fail": "Failed",
            "cancel": "Cancelled",
            "restore": "Restored",
        }
        action_label = _move_labels.get(action, action.capitalize())
        return True, (
            f"{action_label} {file_path.name}: "
            f"{current_folder}/ -> {target_folder}/ (status: {target_status})"
        )

    # File stays in place (block/unblock)
    _stay_labels = {"block": "Blocked", "unblock": "Unblocked"}
    action_label = _stay_labels.get(action, action.capitalize())
    return True, (
        f"{action_label} {file_path.name}: "
        f"stays in {current_folder}/ (status: {target_status})"
    )


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="scope_lifecycle.py",
        description=(
            "Deterministic vBRIEF scope lifecycle transitions. "
            "Relative <file> paths resolve against --project-root / "
            "$DEFT_PROJECT_ROOT / the nearest vbrief|.git ancestor -- "
            "never deft/ (#535)."
        ),
    )
    parser.add_argument(
        "action",
        choices=sorted(TRANSITIONS),
        help="Lifecycle transition to perform.",
    )
    parser.add_argument(
        "file",
        help=(
            "Path to the vBRIEF file. Absolute paths are used as-is; "
            "relative paths resolve against --project-root / "
            "$DEFT_PROJECT_ROOT / the detected consumer project root."
        ),
    )
    parser.add_argument(
        "--project-root",
        default=None,
        help=(
            "Consumer project root. Overrides $DEFT_PROJECT_ROOT and the "
            "sentinel search. Required when the invocation CWD is not "
            "inside a project tree (falls back to a loud error instead "
            "of silently using deft/)."
        ),
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help=(
            "Override the WIP cap on ``promote`` (#1124 / D4 of #1119). "
            "Emits a stderr warning naming the breached cap + current "
            "count, and records an audit-log entry tagged "
            "``wip_cap_override`` to vbrief/.eval/scope-lifecycle.jsonl. "
            "No-op on any other action."
        ),
    )
    return parser


def _resolve_file_path(raw: str, cli_project_root: str | None) -> tuple[Path | None, str | None]:
    """Resolve *raw* to an absolute Path using the project-root rules.

    Returns ``(path, None)`` on success, ``(None, error_message)`` on
    failure. ``error_message`` is a single actionable line ready for
    stderr.
    """
    # Some invocations (e.g. ``task scope:promote`` with no CLI_ARGS) end
    # up passing a trailing "/" to this script -- reject that cleanly.
    stripped = raw.strip().rstrip("\\/") if raw else ""
    if not stripped:
        return None, (
            "No vBRIEF file path provided. "
            "Usage: scope_lifecycle.py <action> <file> [--project-root PATH]"
        )
    candidate = Path(stripped)
    if candidate.is_absolute():
        return candidate.resolve(), None

    project_root = resolve_project_root(cli_project_root)
    if project_root is None:
        return None, (
            f"Cannot resolve relative path {stripped!r}: no project root "
            "detected. Pass --project-root PATH, set $DEFT_PROJECT_ROOT, "
            "or run from inside a directory tree that contains vbrief/ or "
            ".git/ (#535)."
        )
    return (project_root / stripped).resolve(), None


def main(argv: list[str] | None = None) -> int:
    # N10 (#1150): structured --help via scripts/triage_help.REGISTRY.
    from triage_help import intercept_help

    rc = intercept_help("scope_lifecycle", argv)
    if rc is not None:
        return rc
    parser = _build_parser()
    # argparse prints its own usage; convert its SystemExit(2) into our
    # documented usage-error exit code (2).
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code) if isinstance(exc.code, int) else 2

    file_path, error = _resolve_file_path(args.file, args.project_root)
    if error is not None:
        print(f"Error: {error}", file=sys.stderr)
        return 2

    # WIP cap enforcement on ``promote`` (#1124 / D4 of #1119). Other
    # actions are unaffected. The check is gated on a resolvable
    # project root -- without one we degrade safely to legacy behaviour
    # (no cap enforcement, mirrors the D4-absent rolling-merge
    # tolerance branch).
    cap_check: WipCapCheck | None = None
    if args.action == "promote":
        project_root_for_cap = resolve_project_root(args.project_root)
        if project_root_for_cap is not None:
            cap_check = check_wip_cap(project_root_for_cap, force=args.force)
            if not cap_check.allowed:
                print(format_wip_cap_refusal(cap_check), file=sys.stderr)
                return 1

    ok, message = run_transition(args.action, file_path)  # type: ignore[arg-type]
    if ok:
        # Post-promote: surface the --force override on stderr + audit-log
        # entry. Done after the transition succeeds so the audit entry
        # references the brief in its new home.
        if (
            args.action == "promote"
            and cap_check is not None
            and cap_check.force_override
        ):
            project_root_for_audit = resolve_project_root(args.project_root)
            if project_root_for_audit is not None:
                # File has moved to ``pending/`` -- locate the new path.
                new_path = project_root_for_audit / "vbrief" / "pending" / file_path.name  # type: ignore[union-attr]
                _record_wip_cap_override(new_path, project_root_for_audit, cap_check)
            print(
                (
                    f"\u26a0  WIP cap exceeded (count={cap_check.count}, "
                    f"cap={cap_check.cap}); promote allowed via --force. "
                    "audit: vbrief/.eval/scope-lifecycle.jsonl entry tagged "
                    "wip_cap_override (#1124)."
                ),
                file=sys.stderr,
            )
        print(message)
        return 0
    print(f"Error: {message}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
