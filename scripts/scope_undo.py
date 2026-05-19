#!/usr/bin/env python3
"""scope_undo.py -- ``task scope:undo`` driver (#1134 / D15 of #1119).

Reverses a single scope-lifecycle audit entry referenced by ``decision_id``
or every entry tagged with a shared ``batch-id``. Mirrors the
``scripts/scope_demote.py`` shape from D1 (#1121) and consumes the
``scripts/scope_audit_log.py`` append-only audit-log surface.

Two operating modes
-------------------

1. Single-entry undo::

       scope_undo.py <decision_id> [--dry-run] [--project-root PATH]
       scope_undo.py --decision-id <decision_id> [--dry-run] [--project-root PATH]

   The positional form is shorthand for ``--decision-id``; both forms
   are mutually exclusive with ``--batch-id``.

2. Batch undo::

       scope_undo.py --batch-id <uuid> [--dry-run] [--project-root PATH]

   Reverses every audit entry tagged with the given ``batch_id``. The
   undo cohort itself is tagged with a fresh ``undo_batch_id`` so a
   subsequent ``scope:undo --batch-id=<undo_batch_id>`` reverses the
   undo cohort (re-applying the original effect).

Action vocabulary
-----------------

* ``demote``  -> re-promote: file in ``proposed/`` moves back to
  ``pending/`` with ``plan.status='pending'``.
* ``cancel``  -> restore from ``cancelled/`` to the original folder
  recorded on the cancel audit entry's ``cancel_meta.cancelled_from``
  field (or ``cancelled_from`` at the top level for legacy shapes).
* ``restore`` -> re-cancel: file in ``proposed/`` moves back to
  ``cancelled/`` with ``plan.status='cancelled'``.
* ``undo``    -> re-apply: look up the original entry referenced by the
  undo's ``undo_meta.original_decision_id`` and replay the original
  action's effect (so undoing an undo lands the brief where it was
  immediately after the original action).
* ``complete`` / ``fail`` -- REFUSED with a clear error (exit 1). The
  operator must `git revert` or hand-edit per existing conventions.
* Any other / unknown action -- REFUSED with exit 1.

Idempotency
-----------

An audit entry is "already undone" when the log contains a later
``undo`` entry whose ``undo_meta.original_decision_id`` references it.
Re-running undo on an already-undone entry is a no-op with exit 0 and
an informational stderr line. Batch undo skips already-undone members
and continues; the overall exit remains 0 unless EVERY member is
unprocessable (terminal / unknown action).

D18 (#1136) `scope:promote --from-issue=<N>` fallback
-----------------------------------------------------

D15 deliberately uses the existing scope-lifecycle move surfaces
(file `.replace()` + JSON write) rather than dispatching to
``task scope:promote`` or ``task scope:restore`` -- audit-log
reversibility is a pure file-system / JSON edit and does not need
the higher-level lifecycle verbs. TODO(#1136): when the
``scope:promote --from-issue`` form lands, consider routing the
``demote -> re-promote`` branch through it for consistency with
the cache-side reset verb pattern (umbrella section "Layer 5 --
Reversibility everywhere", sibling to ``scripts/triage_actions.py::reset``).

Exit codes
----------

* 0 -- undo succeeded, or no-op (idempotent re-run), or dry-run preview.
* 1 -- target entry not found / terminal action / file missing /
  validation error.
* 2 -- usage error (mutex flags, missing args, undetectable project root).

Refs: #1119 (umbrella), #1121 (D1 -- audit-log surface this consumes),
#845 (cache-side reset verb pattern this mirrors).
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
    new_decision_id,
    read_all,
)

reconfigure_stdio()


# ---------------------------------------------------------------------------
# Action vocabulary
# ---------------------------------------------------------------------------

# Actions whose undo is supported. Each entry maps to the inverse-target
# (folder, status) pair the brief returns to.
REVERSIBLE_ACTIONS: frozenset[str] = frozenset({"demote", "cancel", "restore", "undo"})
TERMINAL_ACTIONS: frozenset[str] = frozenset({"complete", "fail"})


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _utc_now_iso(now: datetime | None = None) -> str:
    if now is None:
        now = datetime.now(UTC)
    return now.strftime("%Y-%m-%dT%H:%M:%SZ")


def _resolve_project_root_strict(
    cli_project_root: str | None,
) -> tuple[Path | None, str | None]:
    project_root = resolve_project_root(cli_project_root)
    if project_root is None:
        return None, (
            "Cannot determine project root. Pass --project-root PATH, "
            "set $DEFT_PROJECT_ROOT, or run from inside a directory tree "
            "that contains vbrief/ or .git/ (#535)."
        )
    return project_root, None


def _vbrief_root(project_root: Path) -> Path:
    return project_root / "vbrief"


def _abs_for_entry_path(project_root: Path, vbrief_path: str) -> Path:
    """Resolve an audit entry's project-root-relative ``vbrief_path``.

    Forward-slash form is the canonical write-time shape so we just
    join under ``project_root`` and let Path normalise the separator.
    """
    return (project_root / vbrief_path).resolve()


def _is_already_undone(decision_id: str, log_entries: list[dict]) -> bool:
    """Return True if any later ``undo`` entry references *decision_id*."""
    for entry in log_entries:
        if entry.get("action") != "undo":
            continue
        meta = entry.get("undo_meta")
        if isinstance(meta, dict) and meta.get("original_decision_id") == decision_id:
            return True
    return False


def _find_by_decision_id(decision_id: str, log_entries: list[dict]) -> dict | None:
    for entry in log_entries:
        if entry.get("decision_id") == decision_id:
            return entry
    return None


def _find_by_batch_id(batch_id: str, log_entries: list[dict]) -> list[dict]:
    """Return every entry whose ``demote_meta.batch_id`` (or top-level
    ``batch_id`` for forward-compat) matches *batch_id*.
    """
    out: list[dict] = []
    for entry in log_entries:
        meta = entry.get("demote_meta")
        bid = None
        if isinstance(meta, dict):
            bid = meta.get("batch_id")
        if bid is None:
            bid = entry.get("batch_id")
        if bid == batch_id:
            out.append(entry)
    return out


# ---------------------------------------------------------------------------
# Inverse transitions
# ---------------------------------------------------------------------------


def _move_and_flip(
    src_file: Path,
    dest_folder: Path,
    new_status: str,
    timestamp: str,
) -> tuple[bool, str, Path | None]:
    """Move *src_file* into *dest_folder* and flip ``plan.status`` /
    ``plan.updated``. Returns ``(ok, message, dest_path)``.
    """
    if not src_file.exists():
        return False, f"File not found: {src_file}", None
    try:
        data = json.loads(src_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return False, f"Invalid JSON in {src_file}: {exc}", None
    plan = data.get("plan") if isinstance(data, dict) else None
    if not isinstance(plan, dict):
        return False, f"Missing or invalid 'plan' object in {src_file}", None
    plan["status"] = new_status
    plan["updated"] = timestamp
    src_file.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    dest_folder.mkdir(parents=True, exist_ok=True)
    dest_path = dest_folder / src_file.name
    src_file.replace(dest_path)
    return True, "ok", dest_path


def _inverse_plan(entry: dict, log_entries: list[dict]) -> dict | None:
    """Return the planned inverse-transition for *entry*.

    The returned dict carries:
        * ``src_relpath``  -- project-root-relative current location.
        * ``dest_folder``  -- target lifecycle folder name.
        * ``new_status``   -- target ``plan.status``.
        * ``from_status``  -- reported on the new audit entry.
        * ``to_status``    -- reported on the new audit entry.

    Returns ``None`` for un-undoable / unknown actions.
    """
    action = entry.get("action")
    if action == "demote":
        return {
            "src_relpath": entry.get("vbrief_path", ""),
            "dest_folder": "pending",
            "new_status": "pending",
            "from_status": "proposed",
            "to_status": "pending",
        }
    if action == "cancel":
        meta = entry.get("cancel_meta")
        cancelled_from = None
        if isinstance(meta, dict):
            cancelled_from = meta.get("cancelled_from")
        if not cancelled_from:
            cancelled_from = entry.get("cancelled_from")
        if not cancelled_from:
            cancelled_from = entry.get("from_status")
        if not isinstance(cancelled_from, str) or not cancelled_from:
            return None
        # The cancelled_from value can be either a folder name
        # (``proposed`` / ``pending`` / ``active``) or a plan-status
        # synonym. We map plan-status synonyms to their canonical folder.
        folder_map = {
            "running": "active",
            "blocked": "active",
            "completed": "completed",
            "failed": "completed",
            "cancelled": "cancelled",
            "proposed": "proposed",
            "pending": "pending",
            "active": "active",
        }
        dest_folder = folder_map.get(cancelled_from, cancelled_from)
        status_map = {
            "proposed": "proposed",
            "pending": "pending",
            "active": "running",
            "completed": "completed",
            "cancelled": "cancelled",
        }
        new_status = status_map.get(dest_folder, dest_folder)
        return {
            "src_relpath": entry.get("vbrief_path", ""),
            "dest_folder": dest_folder,
            "new_status": new_status,
            "from_status": "cancelled",
            "to_status": new_status,
        }
    if action == "restore":
        return {
            "src_relpath": entry.get("vbrief_path", ""),
            "dest_folder": "cancelled",
            "new_status": "cancelled",
            "from_status": "proposed",
            "to_status": "cancelled",
        }
    if action == "undo":
        # Re-apply the original action's effect.
        meta = entry.get("undo_meta")
        if not isinstance(meta, dict):
            return None
        original_id = meta.get("original_decision_id")
        if not isinstance(original_id, str):
            return None
        original = _find_by_decision_id(original_id, log_entries)
        if original is None:
            return None
        # The brief is currently where the undo placed it (entry.to_status
        # / vbrief_path), and we want it back where the original action
        # left it (original.to_status / original.vbrief_path). The undo
        # also rewrote vbrief_path to point at the brief's new home, so
        # the brief is currently at ``entry.vbrief_path``.
        original_action = original.get("action")
        if original_action == "demote":
            return {
                "src_relpath": entry.get("vbrief_path", ""),
                "dest_folder": "proposed",
                "new_status": "proposed",
                "from_status": "pending",
                "to_status": "proposed",
            }
        if original_action == "cancel":
            return {
                "src_relpath": entry.get("vbrief_path", ""),
                "dest_folder": "cancelled",
                "new_status": "cancelled",
                "from_status": entry.get("to_status", "proposed"),
                "to_status": "cancelled",
            }
        if original_action == "restore":
            return {
                "src_relpath": entry.get("vbrief_path", ""),
                "dest_folder": "proposed",
                "new_status": "proposed",
                "from_status": "cancelled",
                "to_status": "proposed",
            }
        return None
    return None


# ---------------------------------------------------------------------------
# Undo engine
# ---------------------------------------------------------------------------


def undo_one(
    entry: dict,
    project_root: Path,
    *,
    actor: str = "operator",
    now: datetime | None = None,
    log_path: Path | None = None,
    dry_run: bool = False,
    undo_batch_id: str | None = None,
    log_entries: list[dict] | None = None,
) -> tuple[bool, str, dict | None]:
    """Reverse a single audit *entry*.

    Returns ``(ok, message, audit_entry)``. ``audit_entry`` is the new
    ``undo`` entry that was appended (or that would have been appended
    on ``dry_run=True``); ``None`` on failure / no-op.
    """
    action = entry.get("action", "")
    decision_id = entry.get("decision_id", "")
    if action in TERMINAL_ACTIONS:
        return (
            False,
            (
                f"Refusing to undo terminal action '{action}' "
                f"(decision_id={decision_id}). Use git revert or hand-edit."
            ),
            None,
        )
    if action not in REVERSIBLE_ACTIONS:
        return (
            False,
            (
                f"Refusing to undo unknown action '{action}' "
                f"(decision_id={decision_id})."
            ),
            None,
        )

    if log_path is None:
        log_path = canonical_log_path(project_root)
    if log_entries is None:
        log_entries = read_all(log_path=log_path)

    if _is_already_undone(decision_id, log_entries):
        return (
            True,
            (
                f"No-op: entry {decision_id} is already undone "
                f"(idempotent re-run)."
            ),
            None,
        )

    plan = _inverse_plan(entry, log_entries)
    if plan is None:
        return (
            False,
            (
                f"Cannot derive inverse transition for entry {decision_id} "
                f"(action='{action}'). Missing required metadata."
            ),
            None,
        )

    src_path = _abs_for_entry_path(project_root, plan["src_relpath"])
    dest_folder = _vbrief_root(project_root) / plan["dest_folder"]
    new_status = plan["new_status"]
    timestamp = _utc_now_iso(now)

    if dry_run:
        try:
            src_display = src_path.relative_to(project_root).as_posix()
        except ValueError:
            src_display = str(src_path)
        msg = (
            f"DRY-RUN: would undo {action} (decision_id={decision_id}) -- "
            f"{src_display} -> vbrief/{plan['dest_folder']}/ "
            f"(status: {new_status})"
        )
        # Preview the entry we WOULD write so callers can introspect.
        dest_relpath = f"vbrief/{plan['dest_folder']}/{src_path.name}"
        preview = _build_undo_entry(
            entry=entry,
            timestamp=timestamp,
            actor=actor,
            from_status=plan["from_status"],
            to_status=plan["to_status"],
            new_relpath=dest_relpath,
            undo_batch_id=undo_batch_id,
        )
        return True, msg, preview

    ok, fs_msg, dest_path = _move_and_flip(
        src_path, dest_folder, new_status, timestamp
    )
    if not ok or dest_path is None:
        return False, fs_msg, None

    try:
        dest_relpath = dest_path.relative_to(project_root.resolve()).as_posix()
    except ValueError:
        dest_relpath = dest_path.as_posix()

    undo_entry = _build_undo_entry(
        entry=entry,
        timestamp=timestamp,
        actor=actor,
        from_status=plan["from_status"],
        to_status=plan["to_status"],
        new_relpath=dest_relpath,
        undo_batch_id=undo_batch_id,
    )
    audit_append(undo_entry, log_path=log_path)

    msg = (
        f"Undid {action} (decision_id={decision_id}): {dest_path.name} -> "
        f"vbrief/{plan['dest_folder']}/ (status: {new_status})"
    )
    return True, msg, undo_entry


def _build_undo_entry(
    *,
    entry: dict,
    timestamp: str,
    actor: str,
    from_status: str,
    to_status: str,
    new_relpath: str,
    undo_batch_id: str | None,
) -> dict:
    """Construct the new ``undo`` audit entry."""
    undo_meta: dict = {
        "original_decision_id": entry["decision_id"],
        "original_action": entry.get("action", ""),
    }
    if undo_batch_id is not None:
        undo_meta["undo_batch_id"] = undo_batch_id
    return {
        "decision_id": new_decision_id(),
        "timestamp": timestamp,
        "action": "undo",
        "vbrief_path": new_relpath,
        "from_status": from_status,
        "to_status": to_status,
        "actor": actor,
        "undo_meta": undo_meta,
    }


def undo_batch(
    batch_id: str,
    project_root: Path,
    *,
    actor: str = "operator",
    now: datetime | None = None,
    log_path: Path | None = None,
    dry_run: bool = False,
) -> tuple[int, list[dict], list[str], list[str]]:
    """Reverse every audit entry tagged with *batch_id*.

    Returns ``(undone_count, audit_entries, skipped_messages, previews)``.
    ``skipped`` carries informational messages for already-undone entries
    (idempotent re-runs) plus error messages for terminal-action members
    and file-level failures. ``previews`` is populated only on
    ``dry_run=True`` and carries the per-entry ``would-undo`` message for
    each member that would have been reversed in a real run -- emitted as
    a separate list (rather than folded into ``skipped``) so callers can
    surface preview-vs-error states distinctly. On ``dry_run=False`` the
    list is always empty.

    Greptile #1219 (D15 / #1134) P1 regression guard: prior shape
    returned a 3-tuple that silently dropped per-entry dry-run preview
    messages; the 4-tuple shape surfaces them so
    ``task scope:undo --batch-id=<uuid> --dry-run`` produces actionable
    per-entry output for an operator previewing the cohort.
    """
    if log_path is None:
        log_path = canonical_log_path(project_root)
    log_entries = read_all(log_path=log_path)
    members = _find_by_batch_id(batch_id, log_entries)
    if not members:
        return 0, [], [f"No audit entries found for batch_id={batch_id}."], []

    undo_batch_id = new_decision_id() if not dry_run else f"DRY-RUN-{new_decision_id()}"
    audit_entries: list[dict] = []
    skipped: list[str] = []
    previews: list[str] = []
    undone = 0
    # Sort for deterministic test output / replay.
    members.sort(key=lambda e: e.get("timestamp", ""))
    for member in members:
        ok, msg, entry = undo_one(
            member,
            project_root,
            actor=actor,
            now=now,
            log_path=log_path,
            dry_run=dry_run,
            undo_batch_id=undo_batch_id,
            log_entries=log_entries,
        )
        if ok:
            if entry is not None:
                audit_entries.append(entry)
                if dry_run:
                    # Surface the per-entry preview line so the caller
                    # can render "would-undo X -> Y" for every member.
                    previews.append(msg)
                else:
                    # Re-read log_entries so idempotency check on
                    # subsequent members in the same batch sees the
                    # newly-appended undo entry.
                    log_entries = read_all(log_path=log_path)
                undone += 1
            else:
                # No-op (already-undone); record as informational skip.
                skipped.append(msg)
        else:
            skipped.append(msg)
    return undone, audit_entries, skipped, previews


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="scope_undo.py",
        description=(
            "Reverse a scope-lifecycle audit entry by decision_id or "
            "batch_id (#1134 / D15). Mirrors scope:demote shape."
        ),
    )
    parser.add_argument(
        "decision_id_positional",
        nargs="?",
        metavar="<decision_id>",
        help=(
            "Decision id of the audit entry to undo (shorthand for "
            "--decision-id). Mutually exclusive with --batch-id."
        ),
    )
    parser.add_argument(
        "--decision-id",
        default=None,
        help="Decision id of a single audit entry to undo.",
    )
    parser.add_argument(
        "--batch-id",
        default=None,
        help=(
            "Reverse every audit entry tagged with this batch_id "
            "(demote_meta.batch_id from scope:demote --batch)."
        ),
    )
    parser.add_argument(
        "--latest",
        action="store_true",
        help=(
            "Reverse the most-recent reversible audit entry (demote / "
            "cancel / restore / undo) that has not already been undone. "
            "Consumed by the N6 / #1146 triage:smoketest contract "
            "(stage 8) so the smoketest can exercise scope:undo "
            "idempotency without threading a decision_id through. "
            "Mutually exclusive with --decision-id, --batch-id, and "
            "the positional <decision_id>."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview the reversals without writing.",
    )
    parser.add_argument(
        "--actor",
        default="operator",
        help="Actor identity recorded on the new undo audit entry.",
    )
    parser.add_argument(
        "--project-root",
        default=None,
        help="Consumer project root. Overrides $DEFT_PROJECT_ROOT.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:  # noqa: PLR0911,PLR0912
    # N10 (#1150): structured --help via scripts/triage_help.REGISTRY.
    from triage_help import intercept_help

    rc = intercept_help("scope_undo", argv)
    if rc is not None:
        return rc
    parser = _build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code) if isinstance(exc.code, int) else 2

    # Coalesce positional + --decision-id; reject mutex with --batch-id / --latest.
    decision_id = args.decision_id or args.decision_id_positional
    if decision_id and args.batch_id:
        print(
            "Error: --decision-id (or positional <decision_id>) is mutually "
            "exclusive with --batch-id.",
            file=sys.stderr,
        )
        return 2
    if args.decision_id_positional and args.decision_id and (
        args.decision_id_positional != args.decision_id
    ):
        print(
            "Error: positional <decision_id> conflicts with --decision-id "
            f"({args.decision_id_positional!r} vs {args.decision_id!r}).",
            file=sys.stderr,
        )
        return 2
    if args.latest and (decision_id or args.batch_id):
        print(
            "Error: --latest is mutually exclusive with --decision-id, "
            "--batch-id, and the positional <decision_id>.",
            file=sys.stderr,
        )
        return 2
    if not decision_id and not args.batch_id and not args.latest:
        print(
            "Error: provide a <decision_id> (positional or --decision-id), "
            "--batch-id, or --latest.",
            file=sys.stderr,
        )
        return 2

    project_root, error = _resolve_project_root_strict(args.project_root)
    if error is not None or project_root is None:
        print(f"Error: {error}", file=sys.stderr)
        return 2

    log_path = canonical_log_path(project_root)
    if not log_path.exists():
        print(
            f"Error: audit log not found at {log_path}. "
            "Nothing to undo.",
            file=sys.stderr,
        )
        return 1

    if args.batch_id:
        undone, _entries, skipped, previews = undo_batch(
            args.batch_id,
            project_root,
            actor=args.actor,
            log_path=log_path,
            dry_run=args.dry_run,
        )
        if undone == 0 and skipped and skipped[0].startswith("No audit entries"):
            print(skipped[0], file=sys.stderr)
            return 1
        prefix = "DRY-RUN: " if args.dry_run else ""
        print(
            f"{prefix}Batch undo: {undone} reversed, {len(skipped)} skipped "
            f"(batch_id={args.batch_id})."
        )
        # Per-entry previews (only populated under --dry-run).
        for line in previews:
            print(f"  preview: {line}")
        for line in skipped:
            print(f"  skipped: {line}")
        return 0

    # --latest: resolve to the most-recent reversible audit entry that
    # hasn't already been undone. Used by N6 / #1146 triage:smoketest.
    log_entries = read_all(log_path=log_path)
    if args.latest:
        candidate: dict | None = None
        for entry in reversed(log_entries):
            action = entry.get("action")
            if action not in REVERSIBLE_ACTIONS:
                continue
            entry_id = entry.get("decision_id")
            if not isinstance(entry_id, str):
                continue
            if _is_already_undone(entry_id, log_entries):
                continue
            candidate = entry
            break
        if candidate is None:
            print(
                "Error: --latest found no reversible audit entry "
                "(demote / cancel / restore / undo) that has not already "
                "been undone.",
                file=sys.stderr,
            )
            return 1
        decision_id = candidate.get("decision_id")
        if not isinstance(decision_id, str):
            print(
                "Error: --latest candidate is missing a decision_id.",
                file=sys.stderr,
            )
            return 1

    # Single-entry undo.
    entry = _find_by_decision_id(decision_id, log_entries)
    if entry is None:
        print(
            f"Error: no audit entry found with decision_id={decision_id}.",
            file=sys.stderr,
        )
        return 1
    ok, msg, _new = undo_one(
        entry,
        project_root,
        actor=args.actor,
        log_path=log_path,
        dry_run=args.dry_run,
        log_entries=log_entries,
    )
    if ok:
        if args.dry_run:
            print(msg)
        else:
            print(msg)
        return 0
    print(f"Error: {msg}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
