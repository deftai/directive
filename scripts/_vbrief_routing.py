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
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# Make the sibling ``_vbrief_build`` helper importable whether this module is
# imported as part of the ``scripts/`` package layout or as a top-level module.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _vbrief_build import (  # noqa: E402
    MIGRATOR_METADATA_KEY as _MIGRATOR_METADATA_KEY,
    create_scope_vbrief as _create_scope_vbrief,
)


def _migration_timestamp() -> str:
    """Return an ISO-8601 UTC timestamp for ``vBRIEFInfo.updated`` stamps.

    Emitted at second precision. This helper is ONLY the fallback used when
    ``build_scope_vbrief_from_reconciled(..., migration_timestamp=None)`` is
    called directly. Under the normal ``migrate()`` entry point the caller
    always passes ``migration_timestamp=migrate_vbrief._MIGRATION_TIMESTAMP``
    (a module-level constant stamped once per migration run), so this helper
    is effectively unreachable there.

    Test-pinning knob: deterministic migrate() tests (for example the
    byte-for-byte golden-fixture suite in ``test_migrate_vbrief.py``) MUST
    monkeypatch ``migrate_vbrief._MIGRATION_TIMESTAMP`` -- NOT this helper --
    because the full migrate() path always threads the module-level constant
    through to ``build_scope_vbrief_from_reconciled(migration_timestamp=...)``.
    Callers that invoke ``build_scope_vbrief_from_reconciled`` directly can
    either pass ``migration_timestamp=`` explicitly or monkeypatch this helper.
    """
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

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
    reconciled: dict,
    repo_url: str = "",
    migration_timestamp: str | None = None,
) -> dict:
    """Build a scope vBRIEF dict from a reconciled item (#496 + #499 + #616).

    ``reconciled`` is a dict with the following recognised keys (produced by
    ``_vbrief_reconciliation.reconcile_scope_items``):

      number, task_id, title, status, folder, description, description_source,
      status_source, title_source, phase, phase_description, tier, spec_phase,
      roadmap_summary, source_conflict, override_applied, references.

    The output preserves the ``_create_scope_vbrief`` envelope shape that
    tests already rely on. Per issue #616 (option A, scope-clamped) the
    user-visible ``plan.narratives`` is left almost EMPTY on per-issue
    scope vBRIEFs -- ROADMAP rows do not carry enough data to populate
    any canonical narrative key meaningfully. Reconciliation provenance
    (Description / Description_source / Status_source / Title_source /
    SpecPhase / RoadmapSummary / SourceConflict) is relocated to
    ``plan.metadata['x-migrator']`` so downstream tooling that cares
    about SPEC/ROADMAP lineage can still read it without the invented
    keys leaking into the user-facing summary surface.

    ``SourceSection`` is the named exception to the #616 clamp: it
    remains in ``plan.narratives`` because it is a deliberate,
    user-visible audit-trail narrative (``ROADMAP Completed section``
    vs ``ROADMAP active phase``) added by #593 so operators can audit
    the routing decision post-migration without re-running the
    migrator. Unlike the reconciler-internal provenance above (which
    really is plumbing noise), SourceSection is intentional signal.
    The Windows task-dispatch regression asserts
    ``plan.narratives.SourceSection`` specifically.
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

    # #616: migrator provenance flows into plan.metadata['x-migrator'],
    # NOT plan.narratives. The shared ``create_scope_vbrief`` helper
    # already seeded Phase / Tier / PhaseDescription under the same key
    # when populated; we extend that bucket with reconciler-specific
    # fields so a single metadata blob captures the full lineage.
    plan_meta = scope["plan"].setdefault("metadata", {})
    migrator_meta = plan_meta.setdefault(_MIGRATOR_METADATA_KEY, {})

    def _store(key: str, value: Any) -> None:
        coerced = _narrative_str(value)
        if coerced:
            migrator_meta[key] = coerced

    _store("Description", reconciled.get("description"))
    _store("Description_source", reconciled.get("description_source"))
    _store("Status_source", reconciled.get("status_source"))
    _store("Title_source", reconciled.get("title_source"))
    _store("SpecPhase", reconciled.get("spec_phase"))
    _store("RoadmapSummary", reconciled.get("roadmap_summary"))
    _store("SourceConflict", reconciled.get("source_conflict"))

    # #593: SourceSection is the named exception to the #616 narrative
    # clamp -- it is a deliberate, user-visible audit-trail narrative
    # (``ROADMAP Completed section`` vs ``ROADMAP active phase``) that
    # operators need surfaced at the narrative level so the routing
    # decision is auditable without re-running the migrator. Unlike the
    # reconciler-internal provenance above (Description_source /
    # Status_source / ...), which is plumbing noise, SourceSection is
    # intended signal. The Windows task-dispatch regression asserts
    # ``plan.narratives.SourceSection`` specifically. Single source of
    # truth: we record it in narratives only, not duplicated under
    # x-migrator metadata.
    source_section = _narrative_str(reconciled.get("source_section"))
    if source_section:
        narratives = scope["plan"].setdefault("narratives", {})
        narratives["SourceSection"] = source_section

    # Clean up an empty migrator bucket so the emitted JSON doesn't
    # carry an empty ``metadata.x-migrator`` payload on fully bare
    # reconciled items (happens in unit tests that bypass the
    # reconciler). Mirrors the clean-up path in ``create_scope_vbrief``
    # where plan.metadata is only materialised when there is something
    # to store.
    if not migrator_meta:
        plan_meta.pop(_MIGRATOR_METADATA_KEY, None)
    if not plan_meta:
        scope["plan"].pop("metadata", None)

    # #593: stamp ``vBRIEFInfo.updated`` with the migration timestamp when
    # we route an item to ``completed/``. The vBRIEF carries completion
    # provenance in its envelope so downstream tooling that sorts by
    # completion time has a non-null date to work with. Active/pending/
    # proposed items do not receive an ``updated`` stamp because the
    # scope has not yet reached a terminal state. ``migration_timestamp``
    # is pinnable by callers (tests monkeypatch it for byte-for-byte
    # fixture determinism).
    if reconciled.get("status") == "completed":
        envelope = scope.setdefault("vBRIEFInfo", {})
        if isinstance(envelope, dict):
            envelope.setdefault(
                "updated", migration_timestamp or _migration_timestamp()
            )

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
