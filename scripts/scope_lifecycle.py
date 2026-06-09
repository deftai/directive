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


# ---------------------------------------------------------------------------
# Decomposed parent <-> child back-reference maintenance (#1485)
# ---------------------------------------------------------------------------
#
# A decomposed child vBRIEF carries a ``planRef`` (plan-level and/or item-
# level) pointing at its parent epic. The parent epic, in turn, lists the
# child via a ``plan.references[]`` entry of ``type == "x-vbrief/plan"`` whose
# ``uri`` points at the child's *current* lifecycle path. When a lifecycle
# move relocates the child between folders, that forward ``uri`` goes stale --
# it still names the child's old path -- which breaks the D4 bidirectional-
# linkage check in ``scripts/vbrief_validate.py`` (the parent references a
# non-existent path). The helpers below rewrite the parent's forward
# reference to the child's new path on every move, so ``task vbrief:validate``
# passes with no manual repair. The reference-resolution rules mirror
# ``scripts/vbrief_validate.py`` (relative-to-vbrief-dir, ``file://`` support).
#
# ``resolve_vbrief_ref``, ``collect_plan_refs``, and ``collect_child_uris``
# (below) are the PUBLIC decomposed-reference surface: cross-module consumers
# such as ``scripts/swarm_complete_cohort.py`` (#1487) call them directly, so
# they carry no leading underscore. The ``_rewrite_*`` helpers remain private.


def resolve_vbrief_ref(uri: object, vbrief_dir: Path) -> Path | None:
    """Resolve a vBRIEF reference URI to an absolute path, or None.

    Mirrors ``vbrief_validate._resolve_ref_path``: ``file://`` and bare
    relative URIs resolve against *vbrief_dir*; ``http(s)://`` / ``#``
    anchors are external and return None.
    """
    if not isinstance(uri, str) or not uri:
        return None
    if uri.startswith("file://"):
        rel = uri[len("file://") :]
    elif uri.startswith(("http://", "https://", "#")):
        return None
    else:
        rel = uri
    return (vbrief_dir / rel).resolve()


def collect_plan_refs(plan: dict) -> list[str]:
    """Collect planRef values from the plan root and top-level items.

    Matches ``vbrief_validate._collect_plan_refs``: ``planRef`` is valid at
    the plan root and top-level item levels only (subItems are not scanned).
    """
    refs: list[str] = []
    root_ref = plan.get("planRef")
    if isinstance(root_ref, str) and root_ref:
        refs.append(root_ref)
    items = plan.get("items")
    if isinstance(items, list):
        for item in items:
            if isinstance(item, dict):
                item_ref = item.get("planRef")
                if isinstance(item_ref, str) and item_ref:
                    refs.append(item_ref)
    return refs


def _rewrite_parent_child_reference(
    parent_path: Path,
    old_child_resolved: Path,
    new_child_rel: str,
    vbrief_dir: Path,
) -> bool:
    """Rewrite *parent_path*'s x-vbrief/plan ref from old to new child path.

    Loads the parent, finds every ``x-vbrief/plan`` reference whose ``uri``
    resolves to *old_child_resolved*, and rewrites it to *new_child_rel*
    (preserving a ``file://`` prefix when the original used one). Returns
    True when at least one reference was changed and the parent re-written.
    """
    try:
        parent_data = json.loads(parent_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(parent_data, dict):
        return False
    parent_plan = parent_data.get("plan")
    if not isinstance(parent_plan, dict):
        return False
    refs = parent_plan.get("references")
    if not isinstance(refs, list):
        return False

    changed = False
    for ref in refs:
        if not isinstance(ref, dict):
            continue
        if ref.get("type") != "x-vbrief/plan":
            continue
        uri = ref.get("uri")
        resolved = resolve_vbrief_ref(uri, vbrief_dir)
        if resolved is None or resolved != old_child_resolved:
            continue
        new_uri = (
            f"file://{new_child_rel}"
            if isinstance(uri, str) and uri.startswith("file://")
            else new_child_rel
        )
        if new_uri != uri:
            ref["uri"] = new_uri
            changed = True

    if changed:
        try:
            parent_path.write_text(
                json.dumps(parent_data, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
        except OSError:
            # Best-effort: the child move has already succeeded, so a parent
            # write failure (disk full, EROFS, PermissionError) MUST NOT
            # escape run_transition's tuple[bool, str] "never raises"
            # contract. Report no rewrite rather than propagating.
            return False
    return changed


def update_decomposed_parent_back_references(
    child_data: dict,
    old_child_path: Path,
    new_child_path: Path,
    vbrief_dir: Path,
) -> list[Path]:
    """Sync decomposed parents' forward references after a child move (#1485).

    If *child_data* is a decomposed child (carries a ``planRef`` to a parent
    epic), rewrite each existing parent's ``x-vbrief/plan`` reference uri from
    the child's old lifecycle path to its new path. Non-decomposed children
    (no resolvable parent on disk) are a no-op. Best-effort: the caller has
    already moved the file, so this never raises -- a malformed or missing
    parent is simply skipped.

    Returns the list of parent paths whose references were rewritten.
    """
    plan = child_data.get("plan")
    if not isinstance(plan, dict):
        return []
    old_resolved = old_child_path.resolve()
    try:
        new_rel = new_child_path.resolve().relative_to(vbrief_dir.resolve()).as_posix()
    except ValueError:
        # Child resolved outside vbrief/ -- nothing safe to rewrite.
        return []

    updated: list[Path] = []
    seen: set[Path] = set()
    for plan_ref in collect_plan_refs(plan):
        parent_path = resolve_vbrief_ref(plan_ref, vbrief_dir)
        if parent_path is None or parent_path in seen:
            continue
        seen.add(parent_path)
        if not parent_path.is_file():
            continue
        if _rewrite_parent_child_reference(parent_path, old_resolved, new_rel, vbrief_dir):
            updated.append(parent_path)
    return updated


# ---------------------------------------------------------------------------
# Decomposed child <- parent back-reference maintenance (symmetric to #1485)
# ---------------------------------------------------------------------------
#
# ``update_decomposed_parent_back_references`` (above) handles the CHILD-moved
# direction: a child relocating between folders leaves its parent's forward
# ``x-vbrief/plan`` reference stale, so we rewrite the parent. The PARENT-moved
# direction is the mirror image and is required by the swarm cohort-completion
# sweep (#1487): when a decompose-created epic parent is completed (e.g.
# ``pending/ -> active/ -> completed/`` once all its children are done), each
# child's ``planRef`` back-pointer still names the parent's OLD path. That
# breaks the D4 backward-linkage check in ``scripts/vbrief_validate.py`` (the
# child references a non-existent parent). The helpers below rewrite every
# child's ``planRef`` (plan-level and item-level) to the parent's new path on
# every move, so ``task vbrief:validate`` stays green for parent moves with no
# manual repair. Reference resolution mirrors ``scripts/vbrief_validate.py``.


def collect_child_uris(plan: dict) -> list[str]:
    """Collect ``x-vbrief/plan`` child reference uris from a parent plan.

    Matches ``vbrief_validate.validate_epic_story_links``: a forward child
    reference is any ``plan.references[]`` entry of ``type == 'x-vbrief/plan'``.
    """
    uris: list[str] = []
    refs = plan.get("references")
    if not isinstance(refs, list):
        return uris
    for ref in refs:
        if not isinstance(ref, dict):
            continue
        if ref.get("type") != "x-vbrief/plan":
            continue
        uri = ref.get("uri")
        if isinstance(uri, str) and uri:
            uris.append(uri)
    return uris


def _rewrite_one_plan_ref(
    value: object,
    old_parent_resolved: Path,
    new_parent_rel: str,
    vbrief_dir: Path,
) -> tuple[str, bool]:
    """Rewrite a single ``planRef`` value if it resolves to *old_parent_resolved*.

    Returns ``(value, changed)``. Preserves a ``file://`` prefix when the
    original used one. Non-matching / non-string values are returned
    unchanged with ``changed=False``.
    """
    if not isinstance(value, str) or not value:
        return value, False  # type: ignore[return-value]
    resolved = resolve_vbrief_ref(value, vbrief_dir)
    if resolved is None or resolved != old_parent_resolved:
        return value, False
    new_value = f"file://{new_parent_rel}" if value.startswith("file://") else new_parent_rel
    return new_value, new_value != value


def _rewrite_child_parent_reference(
    child_path: Path,
    old_parent_resolved: Path,
    new_parent_rel: str,
    vbrief_dir: Path,
) -> bool:
    """Rewrite *child_path*'s ``planRef`` back-pointers old parent -> new parent.

    Loads the child, rewrites the plan-level ``planRef`` and every top-level
    item ``planRef`` whose uri resolves to *old_parent_resolved*, and writes the
    child back. Returns True when at least one reference changed. Mirrors
    ``vbrief_validate._collect_plan_refs`` (plan root + top-level items only;
    subItems are not scanned). Best-effort: a malformed child or a write
    failure reports no rewrite rather than raising.
    """
    try:
        child_data = json.loads(child_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(child_data, dict):
        return False
    child_plan = child_data.get("plan")
    if not isinstance(child_plan, dict):
        return False

    changed = False
    root_ref = child_plan.get("planRef")
    new_root, root_changed = _rewrite_one_plan_ref(
        root_ref, old_parent_resolved, new_parent_rel, vbrief_dir
    )
    if root_changed:
        child_plan["planRef"] = new_root
        changed = True

    items = child_plan.get("items")
    if isinstance(items, list):
        for item in items:
            if not isinstance(item, dict):
                continue
            item_ref = item.get("planRef")
            new_item, item_changed = _rewrite_one_plan_ref(
                item_ref, old_parent_resolved, new_parent_rel, vbrief_dir
            )
            if item_changed:
                item["planRef"] = new_item
                changed = True

    if changed:
        try:
            child_path.write_text(
                json.dumps(child_data, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
        except OSError:
            # Best-effort: the parent move has already succeeded, so a child
            # write failure MUST NOT escape run_transition's never-raises
            # contract. Report no rewrite rather than propagating.
            return False
    return changed


def update_decomposed_child_back_references(
    parent_data: dict,
    old_parent_path: Path,
    new_parent_path: Path,
    vbrief_dir: Path,
) -> list[Path]:
    """Sync decomposed children's planRefs after a parent move (#1487).

    If *parent_data* is a decompose-created epic (carries ``x-vbrief/plan``
    forward references to child stories), rewrite each existing child's
    ``planRef`` from the parent's old lifecycle path to its new path. A file
    with no child references (an ordinary story) is a no-op. Best-effort: the
    caller has already moved the file, so this never raises -- a malformed or
    missing child is simply skipped.

    Returns the list of child paths whose planRefs were rewritten.
    """
    plan = parent_data.get("plan")
    if not isinstance(plan, dict):
        return []
    old_resolved = old_parent_path.resolve()
    try:
        new_rel = new_parent_path.resolve().relative_to(vbrief_dir.resolve()).as_posix()
    except ValueError:
        # Parent resolved outside vbrief/ -- nothing safe to rewrite.
        return []

    updated: list[Path] = []
    seen: set[Path] = set()
    for child_uri in collect_child_uris(plan):
        child_path = resolve_vbrief_ref(child_uri, vbrief_dir)
        if child_path is None or child_path in seen:
            continue
        seen.add(child_path)
        if not child_path.is_file():
            continue
        if _rewrite_child_parent_reference(child_path, old_resolved, new_rel, vbrief_dir):
            updated.append(child_path)
    return updated


# ---------------------------------------------------------------------------
# Capacity-accounting completion stamp (#1419 Delivery Slice 4)
# ---------------------------------------------------------------------------
#
# At completion, the capacity engine wants two facts recorded onto the
# completed vBRIEF so the trailing-window backward view
# (``scripts/capacity_show.py``) is filesystem-truth and offline:
#
# * ``plan.metadata.completedAt`` -- the completion timestamp, used to decide
#   whether the vBRIEF falls inside the trailing accounting window.
# * ``plan.metadata.capacityBucket`` -- which protected bucket the work
#   counts against. An explicit value already on the vBRIEF is preserved; an
#   absent value is back-filled from the project's
#   ``plan.policy.capacityAllocation.defaultBucket`` when one is configured.
#
# Stamping is best-effort: a missing / unparseable PROJECT-DEFINITION (or a
# tree that pre-dates the capacity schema) simply leaves ``capacityBucket``
# unset. The completion transition MUST NOT fail because capacity policy is
# absent -- this is advisory accounting, not a gate.


def _resolve_default_capacity_bucket(project_root: Path) -> str:
    """Return the configured ``capacityAllocation.defaultBucket`` or ``""``.

    Deferred-import of ``scripts.policy`` so a tree that pre-dates the
    #1419 capacity schema degrades cleanly (no bucket back-fill) rather
    than raising. Any resolution failure returns the empty string.
    """
    try:
        from policy import resolve_capacity_allocation
    except ImportError:
        return ""
    try:
        allocation = resolve_capacity_allocation(project_root)
    except Exception:
        return ""
    return allocation.default_bucket or ""


def _stamp_completion_metadata(plan: dict, project_root: Path, timestamp: str) -> None:
    """Stamp ``completedAt`` + ``capacityBucket`` onto a completing vBRIEF.

    ``completedAt`` is always set to *timestamp*. ``capacityBucket`` is set
    only when the vBRIEF does not already carry a non-empty explicit value;
    in that case it is back-filled from the project's configured
    ``defaultBucket`` (when one exists). Mutates *plan* in place. Never
    raises -- capacity accounting is advisory.
    """
    metadata = plan.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
        plan["metadata"] = metadata
    metadata["completedAt"] = timestamp
    existing = metadata.get("capacityBucket")
    if not (isinstance(existing, str) and existing.strip()):
        bucket = _resolve_default_capacity_bucket(project_root)
        if bucket:
            metadata["capacityBucket"] = bucket


# ---------------------------------------------------------------------------
# PROJECT-DEFINITION registry/reference synchronization (#1527)
# ---------------------------------------------------------------------------


def _scope_ids_for_filename(filename: str) -> set[str]:
    """Return registry IDs that may name *filename*.

    ``task project:render`` uses the full date-prefixed filename stem as the
    registry ID, while some consumer PROJECT-DEFINITION files carry the human
    slug without the leading ``YYYY-MM-DD-``. Accept both shapes so lifecycle
    completion can repair real-world registries without a full re-render.
    """
    if filename.endswith(".vbrief.json"):
        full_id = filename[: -len(".vbrief.json")]
    else:
        full_id = Path(filename).stem
    ids = {full_id}
    parts = full_id.split("-", 3)
    if (
        len(parts) == 4
        and len(parts[0]) == 4
        and len(parts[1]) == 2
        and len(parts[2]) == 2
        and all(part.isdigit() for part in parts[:3])
    ):
        ids.add(parts[3])
    return ids


def _relative_to_vbrief(path: Path, vbrief_root: Path) -> str | None:
    try:
        return path.resolve().relative_to(vbrief_root.resolve()).as_posix()
    except ValueError:
        return None


def _rewrite_project_definition_plan_reference(
    ref: object,
    old_resolved: Path,
    new_rel: str,
    vbrief_root: Path,
) -> bool:
    """Rewrite a PROJECT-DEFINITION x-vbrief/plan URI old path -> new path."""
    if not isinstance(ref, dict):
        return False
    if ref.get("type") != "x-vbrief/plan":
        return False
    uri = ref.get("uri")
    resolved = resolve_vbrief_ref(uri, vbrief_root)
    if resolved is None or resolved != old_resolved:
        return False
    new_uri = f"file://{new_rel}" if isinstance(uri, str) and uri.startswith("file://") else new_rel
    if new_uri == uri:
        return False
    ref["uri"] = new_uri
    return True


def _project_item_references_scope(
    item: dict,
    old_resolved: Path,
    new_resolved: Path,
    vbrief_root: Path,
) -> bool:
    """Return True when a registry item carries a local ref/source to the scope."""
    metadata = item.get("metadata")
    if isinstance(metadata, dict):
        source_path = metadata.get("source_path")
        if isinstance(source_path, str):
            resolved = resolve_vbrief_ref(source_path, vbrief_root)
            if resolved in {old_resolved, new_resolved}:
                return True

        metadata_refs = metadata.get("references")
        if isinstance(metadata_refs, list):
            for ref in metadata_refs:
                if not isinstance(ref, dict):
                    continue
                if ref.get("type") != "x-vbrief/plan":
                    continue
                resolved = resolve_vbrief_ref(ref.get("uri"), vbrief_root)
                if resolved in {old_resolved, new_resolved}:
                    return True

    refs = item.get("references")
    if isinstance(refs, list):
        for ref in refs:
            if not isinstance(ref, dict):
                continue
            if ref.get("type") != "x-vbrief/plan":
                continue
            resolved = resolve_vbrief_ref(ref.get("uri"), vbrief_root)
            if resolved in {old_resolved, new_resolved}:
                return True
    return False


def _project_item_matches_scope(
    item: dict,
    scope_data: dict,
    old_path: Path,
    new_path: Path,
    vbrief_root: Path,
) -> bool:
    """Match a PROJECT-DEFINITION plan.items[] row to a moved scope."""
    old_resolved = old_path.resolve()
    new_resolved = new_path.resolve()
    if _project_item_references_scope(item, old_resolved, new_resolved, vbrief_root):
        return True

    item_id = item.get("id")
    if isinstance(item_id, str) and item_id in _scope_ids_for_filename(new_path.name):
        return True

    scope_plan = scope_data.get("plan")
    scope_title = scope_plan.get("title") if isinstance(scope_plan, dict) else None
    item_title = item.get("title")
    return (
        isinstance(scope_title, str) and isinstance(item_title, str) and item_title == scope_title
    )


def _sync_project_definition_after_scope_move(
    scope_data: dict,
    old_path: Path,
    new_path: Path,
    vbrief_root: Path,
    target_status: str,
) -> None:
    """Best-effort sync of PROJECT-DEFINITION after a lifecycle move.

    The lifecycle transition is filesystem-first: a missing or malformed
    PROJECT-DEFINITION must not make ``scope:complete`` fail. When the file is
    present, keep local plan references and the matching registry row aligned
    with the scope's new lifecycle folder/status.
    """
    new_rel = _relative_to_vbrief(new_path, vbrief_root)
    if new_rel is None:
        return
    try:
        from _project_definition_io import (  # noqa: I001
            ProjectDefinitionIOError,
            atomic_write_project_definition,
            load_project_definition_for_mutation,
            project_definition_mutation_lock,
        )
    except ImportError:
        return

    project_root = vbrief_root.parent
    try:
        with project_definition_mutation_lock(project_root):
            project_def, project_def_path = load_project_definition_for_mutation(project_root)
            plan = project_def.get("plan")
            if not isinstance(plan, dict):
                return

            changed = False
            old_resolved = old_path.resolve()
            refs = plan.get("references")
            if isinstance(refs, list):
                for ref in refs:
                    changed = (
                        _rewrite_project_definition_plan_reference(
                            ref, old_resolved, new_rel, vbrief_root
                        )
                        or changed
                    )

            items = plan.get("items")
            if isinstance(items, list):
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    if not _project_item_matches_scope(
                        item, scope_data, old_path, new_path, vbrief_root
                    ):
                        continue
                    if item.get("status") != target_status:
                        item["status"] = target_status
                        changed = True
                    metadata = item.get("metadata")
                    if not isinstance(metadata, dict):
                        metadata = {}
                        item["metadata"] = metadata
                    target_folder = new_path.parent.name
                    if metadata.get("source_path") != new_rel:
                        metadata["source_path"] = new_rel
                        changed = True
                    if metadata.get("lifecycle_folder") != target_folder:
                        metadata["lifecycle_folder"] = target_folder
                        changed = True

            if changed:
                atomic_write_project_definition(project_def_path, project_def)
    except (OSError, ProjectDefinitionIOError):
        return


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
                f"No-op: {file_path.name} is already {target_status} " f"in {current_folder}/"
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
    now_iso = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    plan["status"] = target_status
    plan["updated"] = now_iso

    # Capacity-accounting stamp at completion (#1419 Slice 4): record
    # ``plan.metadata.completedAt`` + ``plan.metadata.capacityBucket`` so the
    # trailing-window backward view in ``scripts/capacity_show.py`` is
    # filesystem-truth. Only ``complete`` (the success terminal) is stamped --
    # ``fail`` records an attempt that could not finish and is intentionally
    # excluded from capacity accounting. ``project_root`` is the vbrief/
    # parent (file is in active/ here, so parent.parent.parent is the root).
    # Best-effort: a missing capacity policy simply leaves capacityBucket unset.
    if action == "complete":
        _stamp_completion_metadata(plan, file_path.parent.parent.parent, now_iso)

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
        # Keep decomposed parent <-> child linkage intact (#1485): a moved
        # decomposed child leaves its parent epic's x-vbrief/plan reference
        # pointing at the child's old path, which fails the D4 bidirectional-
        # linkage check. Rewrite the parent's forward reference to the new
        # path. Best-effort (never raises) -- the move has already succeeded.
        update_decomposed_parent_back_references(data, file_path, dest_path, vbrief_root)
        # Symmetric direction (#1487): a moved decompose-created epic parent
        # leaves each child's planRef back-pointer naming the parent's old
        # path, which fails the D4 backward-linkage check. Rewrite every
        # child's planRef to the parent's new path. Same best-effort contract.
        update_decomposed_child_back_references(data, file_path, dest_path, vbrief_root)
        _sync_project_definition_after_scope_move(
            data, file_path, dest_path, vbrief_root, target_status
        )
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
        f"{action_label} {file_path.name}: " f"stays in {current_folder}/ (status: {target_status})"
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
        if args.action == "promote" and cap_check is not None and cap_check.force_override:
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
