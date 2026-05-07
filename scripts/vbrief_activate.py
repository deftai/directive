#!/usr/bin/env python3
"""vbrief_activate.py -- structural lifecycle move pending/ -> active/ (#810).

Companion to ``scripts/preflight_implementation.py``. The preflight gate
asserts a vBRIEF is eligible for implementation; this helper is the
ONLY supported way to satisfy it. Behavior:

- Already-active vBRIEFs (folder == ``active`` AND status ==
  ``running``): print a no-op message and exit 0. Idempotent.
- Pending vBRIEFs (folder == ``pending``): flip ``plan.status`` from
  ``pending`` / ``approved`` to ``running``, stamp ``vBRIEFInfo.updated``
  to current ISO 8601 UTC, atomically move to ``vbrief/active/``.
- Any other source folder (``proposed``, ``completed``, ``cancelled``,
  ``active`` with non-running status, foreign folder): reject with an
  actionable message. Exit 1.
- Malformed JSON, missing ``plan``, unreadable file: reject. Exit 1.

The atomic move uses :func:`pathlib.Path.replace` (POSIX rename
semantics on Linux/macOS, MoveFileEx on Windows) so concurrent reads
never see a half-written destination.

Mirrors the shape of ``scripts/scope_lifecycle.py`` (the existing
lifecycle tooling) and ``scripts/preflight_implementation.py`` (the
preflight companion). Pure stdlib.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

#: Folders the lifecycle move flows BETWEEN. Source-folder allow-list
#: defends against silent data loss from accidentally activating a
#: ``completed/`` or ``cancelled/`` vBRIEF.
SOURCE_FOLDERS = frozenset({"pending"})
ACTIVE_FOLDER = "active"
ELIGIBLE_STATUSES_FOR_FLIP = frozenset({"pending", "approved"})
TARGET_STATUS = "running"


def _utc_now_iso() -> str:
    """Return an ISO 8601 UTC timestamp with ``Z`` suffix.

    Matches the existing ``vBRIEFInfo.updated`` format used elsewhere
    in the framework (see ``vbrief/schemas/vbrief-core.schema.json``
    examples and ``scripts/scope_lifecycle.py``).
    """
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _load_vbrief(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    """Load and validate the vBRIEF payload.

    Returns ``(payload, None)`` on success or ``(None, error_msg)`` on
    failure. Never raises -- malformed input is reported via the
    structured error message.
    """
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return None, f"Could not read vBRIEF at {path}: {exc}."
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        return None, f"vBRIEF at {path} is not valid JSON: {exc.msg} (line {exc.lineno})."
    if not isinstance(payload, dict):
        return None, f"vBRIEF at {path} top-level value is not a JSON object."
    return payload, None


def activate(vbrief_path: Path) -> tuple[int, str]:
    """Pure activator -- returns ``(exit_code, human_message)``.

    Performs the lifecycle move + status flip + timestamp stamp
    atomically (load -> validate -> mutate in memory -> write to
    target -> remove source). Idempotent on already-active inputs.
    """
    if not vbrief_path.exists():
        return 1, f"vBRIEF not found at {vbrief_path}."
    if not vbrief_path.is_file():
        return 1, f"vBRIEF path {vbrief_path} is not a regular file."

    payload, err = _load_vbrief(vbrief_path)
    if err is not None or payload is None:
        return 1, err or "vBRIEF could not be loaded."

    plan = payload.get("plan")
    if not isinstance(plan, dict):
        return 1, f"vBRIEF at {vbrief_path} lacks a `plan` object -- malformed."

    status = plan.get("status")
    if not isinstance(status, str) or not status:
        return (
            1,
            f"vBRIEF at {vbrief_path} lacks `plan.status` -- malformed.",
        )

    folder = vbrief_path.parent.name

    # Idempotent no-op: already in the eligible state.
    if folder == ACTIVE_FOLDER and status == TARGET_STATUS:
        return 0, f"No-op: {vbrief_path} already active."

    # Reject any other ``active/`` state -- e.g. status ``blocked`` or
    # ``completed``. These are NOT activations; the operator should use
    # ``task scope:unblock`` / ``task scope:complete`` etc.
    if folder == ACTIVE_FOLDER:
        return (
            1,
            f"vBRIEF is already in active/ but plan.status is '{status}', "
            f"not '{TARGET_STATUS}'. Use the appropriate task (e.g. "
            f"`task scope:unblock`) instead of `task vbrief:activate`.",
        )

    # Reject sources outside the allow-list. ``proposed/`` must promote
    # to ``pending/`` first via ``task scope:promote``; ``completed/``
    # and ``cancelled/`` are terminal.
    if folder not in SOURCE_FOLDERS:
        return (
            1,
            f"vBRIEF is in {folder}/ -- only pending/ vBRIEFs can be activated. "
            f"Use the lifecycle tasks (`task scope:promote`, etc.) to move it "
            f"into pending/ first.",
        )

    # Status sanity-check on the source. The schema's enum allows
    # several pre-implementation states; only those documented as
    # eligible for the flip are honored here.
    if status not in ELIGIBLE_STATUSES_FOR_FLIP:
        return (
            1,
            f"plan.status is '{status}' -- only "
            f"{sorted(ELIGIBLE_STATUSES_FOR_FLIP)} can be flipped to "
            f"'{TARGET_STATUS}'.",
        )

    # --- Mutate in memory --------------------------------------------------
    plan["status"] = TARGET_STATUS
    info = payload.setdefault("vBRIEFInfo", {})
    if not isinstance(info, dict):
        return (
            1,
            f"vBRIEF at {vbrief_path} has a non-object `vBRIEFInfo` -- malformed.",
        )
    info["updated"] = _utc_now_iso()

    # --- Resolve destination ----------------------------------------------
    # Walk up two levels from <root>/vbrief/pending/<file>.json to find
    # the ``vbrief/`` parent, then descend into ``active/``.
    vbrief_dir = vbrief_path.parent.parent
    active_dir = vbrief_dir / ACTIVE_FOLDER
    try:
        active_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        return 1, f"Could not create {active_dir}: {exc}."

    dest = active_dir / vbrief_path.name
    if dest.exists():
        return (
            1,
            f"Refusing to overwrite existing destination {dest}. Resolve the "
            f"collision manually before re-running `task vbrief:activate`.",
        )

    # --- Atomic write + source removal ------------------------------------
    # Write to a sibling temp file in the destination directory so
    # ``Path.replace`` is a same-filesystem rename (atomic on POSIX +
    # Windows). The source file is removed only after the destination
    # is durable, so a mid-flight crash leaves the original in place.
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    try:
        tmp.write_text(
            json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        tmp.replace(dest)
    except OSError as exc:
        # Best-effort cleanup of the partial temp file.
        with contextlib.suppress(OSError):
            tmp.unlink(missing_ok=True)
        return 1, f"Could not write {dest}: {exc}."

    try:
        vbrief_path.unlink()
    except OSError as exc:
        return (
            1,
            f"Wrote {dest} but could not remove source {vbrief_path}: {exc}. "
            f"Manual cleanup required.",
        )

    return 0, f"Activated {vbrief_path.name}: pending/ -> active/ (status: {TARGET_STATUS})."


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="vbrief_activate.py",
        description=(
            "Activate a pending vBRIEF: flip plan.status to 'running', "
            "stamp vBRIEFInfo.updated, atomically move to vbrief/active/. "
            "Idempotent on already-active inputs (#810)."
        ),
    )
    parser.add_argument(
        "vbrief_path",
        help="Path to the candidate vBRIEF JSON file (in vbrief/pending/).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    code, message = activate(Path(args.vbrief_path))
    if code == 0:
        print(message)
    else:
        print(message, file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
