"""Lifecycle folder routing for reconciled scope items (Agent B, #499).

Single source of truth for the lifecycle <-> status mapping used by
``migrate:vbrief``. The mapping mirrors the authoritative table in master
tracking issue #506 (Shared conventions) and the schema vocabulary in
``vbrief/schemas/vbrief-core.schema.json``:

    proposed/  <->  draft     | proposed
    pending/   <->  approved  | pending
    active/    <->  running   | blocked
    completed/ <->  completed
    cancelled/ <->  cancelled

The migrator MUST NOT emit the legacy value ``in_progress`` -- this was the
critical correction to the original #499 issue body. Use ``running``.

Exposes:
  * FOLDER_TO_STATUSES / STATUS_TO_FOLDER
  * folder_for_status(status) -> folder
  * default_status_for_folder(folder) -> status
  * plan_status_matches_folder(status, folder) -> bool
  * build_scope_vbrief_from_reconciled(reconciled, repo_url) -> dict
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

# Make the sibling ``_vbrief_build`` helper importable whether this module is
# imported as part of the ``scripts/`` package layout or as a top-level module.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _vbrief_build import create_scope_vbrief as _create_scope_vbrief  # noqa: E402

# ---------------------------------------------------------------------------
# Lifecycle <-> status mapping (#506 Shared conventions, schema-locked)
# ---------------------------------------------------------------------------

FOLDER_TO_STATUSES: dict[str, tuple[str, ...]] = {
    "proposed": ("draft", "proposed"),
    "pending": ("approved", "pending"),
    "active": ("running", "blocked"),
    "completed": ("completed",),
    "cancelled": ("cancelled",),
}

STATUS_TO_FOLDER: dict[str, str] = {
    status: folder
    for folder, statuses in FOLDER_TO_STATUSES.items()
    for status in statuses
}

LIFECYCLE_FOLDERS: tuple[str, ...] = tuple(FOLDER_TO_STATUSES.keys())

# Canonical default status the migrator emits when a folder is chosen but no
# sharper signal exists (e.g. orphans routed to proposed/ use ``proposed`` not
# ``draft``; reconciled-active with no explicit blocked signal uses ``running``).
DEFAULT_STATUS_FOR_FOLDER: dict[str, str] = {
    "proposed": "proposed",
    "pending": "pending",
    "active": "running",
    "completed": "completed",
    "cancelled": "cancelled",
}


def folder_for_status(status: str) -> str:
    """Return the canonical lifecycle folder for a schema status.

    Raises ``ValueError`` for unknown statuses so callers can surface the
    corruption early rather than silently routing to ``pending/``.
    """
    try:
        return STATUS_TO_FOLDER[status]
    except KeyError as exc:  # pragma: no cover - defensive
        raise ValueError(
            f"No lifecycle folder defined for status {status!r}; "
            f"expected one of {sorted(STATUS_TO_FOLDER)}."
        ) from exc


def default_status_for_folder(folder: str) -> str:
    """Return the canonical default status the migrator uses for a folder."""
    try:
        return DEFAULT_STATUS_FOR_FOLDER[folder]
    except KeyError as exc:  # pragma: no cover - defensive
        raise ValueError(
            f"Unknown lifecycle folder {folder!r}; expected one of "
            f"{sorted(DEFAULT_STATUS_FOR_FOLDER)}."
        ) from exc


def plan_status_matches_folder(status: str, folder: str) -> bool:
    """Return True if ``status`` is permitted inside ``folder/`` per #506."""
    return status in FOLDER_TO_STATUSES.get(folder, ())


# ---------------------------------------------------------------------------
# Scope vBRIEF construction from reconciled item
# ---------------------------------------------------------------------------


def _narrative_str(value: Any) -> str:
    """Coerce a narrative field to a stripped string (schema requires strings)."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def build_scope_vbrief_from_reconciled(
    reconciled: dict, repo_url: str = "",
) -> dict:
    """Build a scope vBRIEF dict from a reconciled item (#496 + #499).

    ``reconciled`` is a dict with the following recognised keys (produced by
    ``_vbrief_reconciliation.reconcile_scope_items``):

      number, task_id, title, status, folder, description, description_source,
      status_source, title_source, phase, phase_description, tier, spec_phase,
      roadmap_summary, source_conflict, override_applied, references.

    The output preserves the ``_create_scope_vbrief`` envelope shape that
    tests already rely on and extends ``plan.narratives`` with reconciliation
    provenance fields:

      Description          <- SPEC body when available, ROADMAP title otherwise
      Description_source   <- origin ref (e.g. "SPECIFICATION.md" / "ROADMAP.md")
      Status_source        <- which source decided the status
      Title_source         <- which source decided the title (if drifted)
      Phase                <- ROADMAP milestone (#496 D1)
      SpecPhase            <- SPEC phase heading (#496 D1, preserved alongside)
      RoadmapSummary       <- ROADMAP one-liner (only when it differs from SPEC)
      PhaseDescription     <- ROADMAP phase description text
      Tier                 <- ROADMAP sub-phase tier
      SourceConflict       <- e.g. "missing-from-spec" for orphan ROADMAP items
    """
    status = reconciled.get("status") or default_status_for_folder(
        reconciled.get("folder", "pending")
    )

    # Seed with the shared helper so origin-provenance (references) and the
    # vBRIEFInfo envelope stay consistent with non-reconciled scope vBRIEFs.
    seed_item = {
        "number": reconciled.get("number", ""),
        "title": reconciled.get("title", "Untitled"),
        "phase": reconciled.get("phase", ""),
        "tier": reconciled.get("tier", ""),
    }
    scope = _create_scope_vbrief(
        seed_item,
        repo_url=repo_url,
        status=status,
        phase_description=reconciled.get("phase_description", ""),
    )

    narratives = scope["plan"].setdefault("narratives", {})

    description = _narrative_str(reconciled.get("description"))
    if description:
        narratives["Description"] = description

    description_source = _narrative_str(reconciled.get("description_source"))
    if description_source:
        narratives["Description_source"] = description_source

    status_source = _narrative_str(reconciled.get("status_source"))
    if status_source:
        narratives["Status_source"] = status_source

    title_source = _narrative_str(reconciled.get("title_source"))
    if title_source:
        narratives["Title_source"] = title_source

    spec_phase = _narrative_str(reconciled.get("spec_phase"))
    if spec_phase:
        narratives["SpecPhase"] = spec_phase

    roadmap_summary = _narrative_str(reconciled.get("roadmap_summary"))
    if roadmap_summary:
        narratives["RoadmapSummary"] = roadmap_summary

    source_conflict = _narrative_str(reconciled.get("source_conflict"))
    if source_conflict:
        narratives["SourceConflict"] = source_conflict

    # Preserve any explicitly supplied references (e.g. spec back-link) on top
    # of the origin-provenance reference set by ``_create_scope_vbrief``.
    extra_refs = reconciled.get("references") or []
    if extra_refs:
        existing = scope["plan"].setdefault("references", [])
        for ref in extra_refs:
            if isinstance(ref, dict) and ref not in existing:
                existing.append(ref)

    return scope


__all__ = [
    "DEFAULT_STATUS_FOR_FOLDER",
    "FOLDER_TO_STATUSES",
    "LIFECYCLE_FOLDERS",
    "STATUS_TO_FOLDER",
    "build_scope_vbrief_from_reconciled",
    "default_status_for_folder",
    "folder_for_status",
    "plan_status_matches_folder",
]
