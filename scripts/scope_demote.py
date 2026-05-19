#!/usr/bin/env python3
"""scope_demote.py -- ``task scope:demote`` driver (#1121).

Demotes a vBRIEF scope from ``pending/`` back to ``proposed/`` and records
a structured audit entry with a ``demote_meta`` block. Two modes:

1. Single demote::

       scope_demote.py <file> [--reason TEXT] [--project-root PATH]

2. Batch demote (all ``pending/`` vBRIEFs older than N days)::

       scope_demote.py --batch [--older-than-days N] [--project-root PATH]

   Default ``--older-than-days`` is **45** per Current Shape decision
   (deep-pass §A1 bump from the original 30; see Current Shape comment
   4471271992 on #1121).

Every demote (single or batch) appends one entry to
``<project_root>/vbrief/.eval/scope-lifecycle.jsonl`` with the
``demote_meta`` instrumentation block defined in
:mod:`scripts.scope_audit_log`:

* ``was_promoted`` -- bool, true if source folder was ``pending/``.
* ``original_promotion_decision_id`` -- UUID of prior promote audit entry
  on the same path, ``null`` when no prior entry exists (forward-compat;
  emitters that record promote entries in the future will populate this
  field automatically).
* ``days_in_pending`` -- non-negative int, ``floor((now - plan.updated).days)``
  with a fallback to file mtime when ``plan.updated`` is absent or unparseable.
* ``demote_reason`` -- free-form text (operator) or batch-rule name
  (``"batch:older-than-days:<N>"``).
* ``demoted_from`` -- source folder name (``"pending"`` for the supported
  path; left in place for future expansion to other source folders).

Out of scope (per Current Shape):

- 30%-threshold falsification gate / D17 (Decision 2: dropped).
- Lightweight metrics over the audit log (Decision 3: deferred to #1180).

Path resolution mirrors ``scope_lifecycle.py``: relative ``<file>``
arguments resolve against ``--project-root`` / ``$DEFT_PROJECT_ROOT`` / the
nearest ``vbrief|.git`` ancestor, never against ``deft/``.

Exit codes:
    0 -- demote succeeded (single) or batch completed (even with 0 demotes).
    1 -- single-demote validation or transition error.
    2 -- usage error (including undetectable project root for relative path).

Refs: #1119 (umbrella), #1121 (D1).
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

# Make sibling helpers importable both when run as ``__main__`` and when
# imported by tests that preload sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _project_context import resolve_project_root  # noqa: E402
from _stdio_utf8 import reconfigure_stdio  # noqa: E402
from scope_audit_log import (  # noqa: E402
    append as audit_append,
    canonical_log_path,
    latest_for_path,
    new_decision_id,
)

reconfigure_stdio()


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_OLDER_THAN_DAYS = 45
SOURCE_FOLDER = "pending"
TARGET_FOLDER = "proposed"
TARGET_STATUS = "proposed"


# ---------------------------------------------------------------------------
# Core helpers
# ---------------------------------------------------------------------------


def _canonical_relpath(file_path: Path, project_root: Path) -> str:
    """Return a forward-slash, project-root-relative form for audit entries.

    Falls back to the resolved absolute path string when the file is not
    under *project_root* (e.g. a test fixture under tmp_path with a different
    root). Forward-slash form keeps cross-platform string equality stable
    against the audit log on Windows.
    """
    try:
        rel = file_path.resolve().relative_to(project_root.resolve())
    except ValueError:
        return file_path.resolve().as_posix()
    return rel.as_posix()


def _parse_plan_updated(text: str) -> datetime | None:
    """Parse an ISO-8601 ``plan.updated`` string to a UTC datetime.

    Accepts both ``YYYY-MM-DDTHH:MM:SSZ`` (the format ``scope_lifecycle``
    writes) and ``YYYY-MM-DDTHH:MM:SS+00:00`` (older fixtures). Returns
    ``None`` on unparseable input so the caller can fall back to file mtime.
    """
    if not text:
        return None
    candidate = text
    if candidate.endswith("Z"):
        candidate = candidate[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def _days_in_pending(file_path: Path, plan_updated: str | None, now: datetime) -> int:
    """Compute integer days between *now* and the file's last-pending stamp.

    Preference order:
    1. ``plan.updated`` parsed as ISO-8601 UTC (set by ``scope:promote``).
    2. File modification time.

    The result is clamped to a non-negative int to keep
    ``demote_meta.days_in_pending`` schema-valid even under minor clock skew.
    """
    parsed = _parse_plan_updated(plan_updated) if plan_updated else None
    if parsed is None:
        mtime = file_path.stat().st_mtime
        parsed = datetime.fromtimestamp(mtime, tz=UTC)
    delta = now - parsed
    return max(0, delta.days)


def _resolve_file_path(
    raw: str, cli_project_root: str | None
) -> tuple[Path | None, str | None]:
    """Resolve a possibly-relative *raw* path to an absolute Path.

    Mirrors ``scope_lifecycle._resolve_file_path`` so the two surfaces share
    a consistent path-resolution story (#535). Returns ``(path, None)`` on
    success, ``(None, error_message)`` on failure.
    """
    stripped = raw.strip().rstrip("\\/") if raw else ""
    if not stripped:
        return None, (
            "No vBRIEF file path provided. "
            "Usage: scope_demote.py <file> [--reason TEXT] [--project-root PATH]"
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


def _resolve_project_root_strict(
    cli_project_root: str | None,
) -> tuple[Path | None, str | None]:
    """Resolve --project-root for batch mode; both must succeed."""
    project_root = resolve_project_root(cli_project_root)
    if project_root is None:
        return None, (
            "Cannot determine project root for batch demote. Pass "
            "--project-root PATH, set $DEFT_PROJECT_ROOT, or run from inside "
            "a directory tree that contains vbrief/ or .git/ (#535)."
        )
    return project_root, None


# ---------------------------------------------------------------------------
# Single-demote engine
# ---------------------------------------------------------------------------


def demote_one(
    file_path: Path,
    project_root: Path,
    reason: str,
    *,
    actor: str = "operator",
    now: datetime | None = None,
    log_path: Path | None = None,
    batch_id: str | None = None,
) -> tuple[bool, str, dict | None]:
    """Demote a single vBRIEF file from ``pending/`` to ``proposed/``.

    Returns ``(ok, message, audit_entry)``. ``audit_entry`` is the dict that
    was appended to the audit log (so callers / tests can introspect it
    without re-reading the file).
    """
    if not file_path.exists():
        return False, f"File not found: {file_path}", None
    if not file_path.name.endswith(".vbrief.json"):
        return False, f"Not a vBRIEF file (expected .vbrief.json): {file_path.name}", None

    parent = file_path.parent.name
    if parent != SOURCE_FOLDER:
        return (
            False,
            (
                f"Invalid transition: 'demote' requires file in "
                f"{SOURCE_FOLDER}/. File is in {parent}/."
            ),
            None,
        )

    try:
        data = json.loads(file_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return False, f"Invalid JSON in {file_path}: {exc}", None

    plan = data.get("plan")
    if not isinstance(plan, dict):
        return False, f"Missing or invalid 'plan' object in {file_path}", None

    current_now = now or datetime.now(UTC)
    plan_updated_before = plan.get("updated")
    days = _days_in_pending(file_path, plan_updated_before, current_now)

    # Determine canonical project-root-relative path used both for the audit
    # entry write and for the prior-promote lookup. Lookup MUST happen before
    # we move the file so the path we hash matches whatever a future emitter
    # would have written when this brief was promoted.
    canonical_path = _canonical_relpath(file_path, project_root)
    if log_path is None:
        log_path = canonical_log_path(project_root)
    prior_promote = latest_for_path(canonical_path, action="promote", log_path=log_path)
    original_promotion_decision_id: str | None = (
        prior_promote.get("decision_id") if prior_promote else None
    )

    # Update plan + move file.
    timestamp = current_now.strftime("%Y-%m-%dT%H:%M:%SZ")
    plan["status"] = TARGET_STATUS
    plan["updated"] = timestamp
    file_path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    target_dir = file_path.parent.parent / TARGET_FOLDER
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / file_path.name
    file_path.replace(target_path)

    # Recompute canonical path AFTER the move so the audit entry references
    # the brief's new home (``vbrief/proposed/...``). This makes future
    # forward-trace lookups by current path naturally correct.
    canonical_path_after = _canonical_relpath(target_path, project_root)

    demote_meta: dict = {
        "was_promoted": parent == SOURCE_FOLDER,
        "original_promotion_decision_id": original_promotion_decision_id,
        "days_in_pending": days,
        "demote_reason": reason,
        "demoted_from": parent,
    }
    # `batch_id` is recorded only in batch mode so the D15 scope:undo
    # --batch-id verb can reverse the cohort by tag (#1134).
    if batch_id is not None:
        demote_meta["batch_id"] = batch_id
    entry = {
        "decision_id": new_decision_id(),
        "timestamp": timestamp,
        "action": "demote",
        "vbrief_path": canonical_path_after,
        "from_status": "pending",
        "to_status": TARGET_STATUS,
        "actor": actor,
        "demote_meta": demote_meta,
    }
    audit_append(entry, log_path=log_path)

    msg = (
        f"Demoted {target_path.name}: {SOURCE_FOLDER}/ -> {TARGET_FOLDER}/ "
        f"(status: {TARGET_STATUS}, days_in_pending: {days})"
    )
    return True, msg, entry


# ---------------------------------------------------------------------------
# Batch-demote engine
# ---------------------------------------------------------------------------


def batch_demote(
    project_root: Path,
    older_than_days: int,
    *,
    actor: str = "operator",
    now: datetime | None = None,
    log_path: Path | None = None,
) -> tuple[int, list[dict], list[str]]:
    """Demote every ``pending/`` vBRIEF older than *older_than_days*.

    Returns ``(demoted_count, audit_entries, skipped_messages)``. Skipped
    items include both ineligible-by-age and any file-level errors caught
    during processing (the batch is best-effort; one bad file does not
    abort the entire run).
    """
    if older_than_days < 0:
        raise ValueError(
            f"--older-than-days must be >= 0, got {older_than_days}"
        )
    current_now = now or datetime.now(UTC)
    pending_dir = project_root / "vbrief" / SOURCE_FOLDER
    if not pending_dir.exists():
        return 0, [], []

    reason = f"batch:older-than-days:{older_than_days}"
    # Cohort-wide tag the D15 scope:undo --batch-id verb consumes (#1134).
    # Lazy: only mint a UUID when we actually have something eligible to
    # demote; tests + callers that need to reference the batch_id can
    # introspect the returned entries.
    batch_id: str | None = None
    audit_entries: list[dict] = []
    skipped: list[str] = []
    demoted = 0

    # Sort for deterministic test output / replay.
    for candidate in sorted(pending_dir.glob("*.vbrief.json")):
        try:
            data = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            skipped.append(f"{candidate.name}: read error: {exc}")
            continue
        plan = data.get("plan") if isinstance(data, dict) else None
        plan_updated = plan.get("updated") if isinstance(plan, dict) else None
        days = _days_in_pending(candidate, plan_updated, current_now)
        if days < older_than_days:
            skipped.append(
                f"{candidate.name}: {days} day(s) in pending (< {older_than_days})"
            )
            continue
        if batch_id is None:
            # Mint the cohort UUID on the first eligible candidate so a
            # no-op batch never pollutes the audit log with a unused tag.
            batch_id = new_decision_id()
        ok, msg, entry = demote_one(
            candidate,
            project_root,
            reason,
            actor=actor,
            now=current_now,
            log_path=log_path,
            batch_id=batch_id,
        )
        if ok and entry is not None:
            audit_entries.append(entry)
            demoted += 1
        else:
            skipped.append(f"{candidate.name}: {msg}")
    return demoted, audit_entries, skipped


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="scope_demote.py",
        description=(
            "Demote a vBRIEF scope from vbrief/pending/ back to "
            "vbrief/proposed/ (#1121). Single-file or --batch."
        ),
    )
    parser.add_argument(
        "file",
        nargs="?",
        help=(
            "Path to a vBRIEF file (single-demote mode). Absolute paths are "
            "used as-is; relative paths resolve against --project-root / "
            "$DEFT_PROJECT_ROOT / the detected consumer project root."
        ),
    )
    parser.add_argument(
        "--batch",
        action="store_true",
        help=(
            "Batch mode: demote every vbrief/pending/*.vbrief.json older "
            "than --older-than-days. Mutually exclusive with a positional "
            "<file>."
        ),
    )
    parser.add_argument(
        "--older-than-days",
        type=int,
        default=DEFAULT_OLDER_THAN_DAYS,
        help=(
            "Batch-mode age threshold in days (default: "
            f"{DEFAULT_OLDER_THAN_DAYS}; see Current Shape Decision 4)."
        ),
    )
    parser.add_argument(
        "--reason",
        default="operator-requested",
        help=(
            "Free-text reason recorded in demote_meta.demote_reason for "
            "single-demote mode (ignored in --batch; batch uses "
            "'batch:older-than-days:<N>')."
        ),
    )
    parser.add_argument(
        "--actor",
        default="operator",
        help="Actor identity recorded in the audit entry (default: operator).",
    )
    parser.add_argument(
        "--project-root",
        default=None,
        help="Consumer project root. Overrides $DEFT_PROJECT_ROOT.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    # N10 (#1150): structured --help via scripts/triage_help.REGISTRY.
    from triage_help import intercept_help

    rc = intercept_help("scope_demote", argv)
    if rc is not None:
        return rc
    parser = _build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code) if isinstance(exc.code, int) else 2

    if args.batch and args.file:
        print(
            "Error: --batch is mutually exclusive with a positional <file>.",
            file=sys.stderr,
        )
        return 2
    if not args.batch and not args.file:
        print(
            "Error: provide a vBRIEF <file> or pass --batch.",
            file=sys.stderr,
        )
        return 2
    if args.older_than_days < 0:
        print(
            f"Error: --older-than-days must be >= 0, got {args.older_than_days}.",
            file=sys.stderr,
        )
        return 2

    if args.batch:
        project_root, error = _resolve_project_root_strict(args.project_root)
        if error is not None or project_root is None:
            print(f"Error: {error}", file=sys.stderr)
            return 2
        demoted, _entries, skipped = batch_demote(
            project_root,
            args.older_than_days,
            actor=args.actor,
        )
        print(
            f"Batch demote: {demoted} demoted, {len(skipped)} skipped "
            f"(--older-than-days {args.older_than_days})."
        )
        for line in skipped:
            print(f"  skipped: {line}")
        return 0

    # Single-file mode.
    file_path, error = _resolve_file_path(args.file, args.project_root)
    if error is not None or file_path is None:
        print(f"Error: {error}", file=sys.stderr)
        return 2
    project_root, root_error = _resolve_project_root_strict(args.project_root)
    if root_error is not None or project_root is None:
        print(f"Error: {root_error}", file=sys.stderr)
        return 2
    ok, message, _entry = demote_one(
        file_path,
        project_root,
        args.reason,
        actor=args.actor,
    )
    if ok:
        print(message)
        return 0
    print(f"Error: {message}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
