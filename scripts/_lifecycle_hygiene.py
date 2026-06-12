#!/usr/bin/env python3
"""_lifecycle_hygiene.py -- stranded-slice + epic-staleness detector (#1419 Slice 6).

Filesystem-truth, fully offline detector that reads epic + child status straight
from the vBRIEF lifecycle folders (``vbrief/{proposed,pending,active,completed,
cancelled}/``) and surfaces two session-start lifecycle-hygiene nudges:

* **Stranded slice (Tier 1)** -- a *partially-completed* epic (>= 1 completed
  child, at least one child not yet complete) that has been dormant longer than
  ``epicStrandedDays`` (default 30). The completed slice keeps its bucket; the
  debt is forward-recognized via a **trichotomy**: ``finish`` /
  ``cancel-and-remove`` / ``accept-as-tech-debt``.
* **Stale epic (Tier 2)** -- an *undecomposed* epic (no child references on
  disk) that has been dormant longer than ``epicStalenessDays`` (default 14).
  Surfaces a ``needs estimation/decomposition`` nudge.

Accepting a stranded epic as tech-debt records a follow-up reference in the
durable ledger ``vbrief/.audit/epic-tech-debt-accepted.jsonl`` and the detector
then stops re-nudging for that epic.

Thresholds are read from ``plan.policy.capacityAllocation`` (the #1419 Slice 4
surface owned by ``scripts/policy.py``). ``policy.resolve_capacity_allocation``
does not expose ``epicStrandedDays`` and uses a different framework default for
``epicStalenessDays`` (its capacity-estimate-staleness hint), so this module
reads the raw block via ``policy.load_project_definition`` and applies the
RFC OQ4 defaults (stranded 30 / staleness 14) when a field is absent.

Pure-stdlib library module (no CLI, no ``gh``/network). Consumed by
``scripts/triage_welcome.py`` via the shared session-start nudge ranking.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# Make sibling helpers importable both as a direct import and under pytest.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import policy  # noqa: E402  (sibling import after sys.path tweak)

# ---------------------------------------------------------------------------
# Public constants
# ---------------------------------------------------------------------------

#: Default dormancy (days) past which a partially-completed epic is stranded.
#: RFC #1419 schema / Decisions Log: ``epicStrandedDays`` default 30.
EPIC_STRANDED_DAYS_DEFAULT: int = 30

#: Default dormancy (days) past which an undecomposed epic is stale and wants
#: estimation/decomposition. RFC #1419 OQ4: ``epicStalenessDays`` default 14.
EPIC_STALENESS_DAYS_DEFAULT: int = 14

#: vBRIEF ``plan.metadata.kind`` values treated as epic-like parents.
PARENT_KINDS: frozenset[str] = frozenset({"epic", "phase"})

#: Lifecycle folders scanned for epics + children (filesystem-truth view).
LIFECYCLE_FOLDERS: tuple[str, ...] = (
    "proposed",
    "pending",
    "active",
    "completed",
    "cancelled",
)

#: ``plan.status`` values that make an epic terminal -- a completed / cancelled
#: epic never nudges (the work is closed, not stranded).
TERMINAL_STATUSES: frozenset[str] = frozenset({"completed", "cancelled", "failed"})

#: Child reference type that marks an epic as decomposed (mirrors
#: ``scripts/capacity_show.py::_plan_has_children``).
CHILD_REF_TYPE: str = "x-vbrief/plan"

#: Durable tech-debt acceptance ledger (#1419 Receipts & Audit -- the
#: authority-bearing ``vbrief/.audit/`` tier, append-only, must survive).
TECH_DEBT_LEDGER_RELPATH: tuple[str, ...] = (
    "vbrief",
    ".audit",
    "epic-tech-debt-accepted.jsonl",
)

#: Session-start nudge tiers (rate-of-harm ranking, #1419 Nudge Budgeting).
TIER_STRANDED: int = 1
TIER_STALE_EPIC: int = 2
#: Capacity classification cold-start (#1606) -- lowest rate-of-harm: the data
#: exists, accounting is just dormant until a one-time backfill runs.
TIER_CAPACITY_COLDSTART: int = 3

#: Stable nudge id for the singleton capacity cold-start nudge.
CAPACITY_COLDSTART_NUDGE_ID: str = "capacity-coldstart"

#: Default actor recorded in the tech-debt ledger.
DEFAULT_ACTOR: str = "lifecycle-hygiene"


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EpicThresholds:
    """Resolved dormancy thresholds (days) for the two lifecycle nudges."""

    stranded_days: int
    staleness_days: int


@dataclass(frozen=True)
class _VbriefOnDisk:
    """One vBRIEF's lifecycle-relevant facts, derived from disk."""

    name: str  # basename (immutable per the filename convention)
    folder: str
    rel_path: str  # e.g. "active/2026-...-foo.vbrief.json"
    plan: dict[str, Any]
    updated: datetime | None


@dataclass(frozen=True)
class LifecycleNudge:
    """One ranked session-start lifecycle-hygiene nudge."""

    nudge_id: str  # epic basename -- the stable tech-debt ledger key
    kind: str  # "stranded" | "stale-epic"
    tier: int  # TIER_STRANDED | TIER_STALE_EPIC
    title: str
    epic_rel_path: str
    dormant_days: int
    completed_children: int
    total_children: int
    magnitude: int  # ranking magnitude (dormancy days)
    message: str  # rendered one-line nudge (ASCII-only)


# ---------------------------------------------------------------------------
# Threshold resolution (reads the #1419 Slice 4 capacityAllocation surface)
# ---------------------------------------------------------------------------


def _positive_int(value: Any, default: int) -> int:
    """Return *value* when it is a positive ``int`` (``bool`` excluded), else *default*."""
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return value
    return default


def resolve_epic_thresholds(project_root: Path) -> EpicThresholds:
    """Resolve ``epicStrandedDays`` / ``epicStalenessDays`` from PROJECT-DEFINITION.

    Reads the raw ``plan.policy.capacityAllocation`` block (the Slice 4 surface)
    via :func:`policy.load_project_definition`. Missing / malformed fields fall
    back to the RFC defaults (30 / 14). Never raises -- a missing or unreadable
    PROJECT-DEFINITION resolves to the framework defaults.
    """
    data, _err = policy.load_project_definition(project_root)
    raw: dict[str, Any] = {}
    if isinstance(data, dict):
        plan = data.get("plan")
        if isinstance(plan, dict):
            pol = plan.get("policy")
            if isinstance(pol, dict):
                cap = pol.get("capacityAllocation")
                if isinstance(cap, dict):
                    raw = cap
    return EpicThresholds(
        stranded_days=_positive_int(raw.get("epicStrandedDays"), EPIC_STRANDED_DAYS_DEFAULT),
        staleness_days=_positive_int(raw.get("epicStalenessDays"), EPIC_STALENESS_DAYS_DEFAULT),
    )


# ---------------------------------------------------------------------------
# Filesystem scan helpers
# ---------------------------------------------------------------------------


def _parse_iso(value: Any) -> datetime | None:
    """Parse an ISO-8601 ``...Z`` timestamp to an aware datetime, or None."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _updated_at(plan: dict[str, Any], path: Path) -> datetime | None:
    """Best-effort last-activity timestamp: ``plan.updated`` then file mtime."""
    stamp = _parse_iso(plan.get("updated"))
    if stamp is not None:
        return stamp
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)
    except OSError:
        return None


def _kind(plan: dict[str, Any]) -> str:
    metadata = plan.get("metadata")
    if isinstance(metadata, dict):
        raw = metadata.get("kind")
        if isinstance(raw, str) and raw:
            return raw
    return "story"


def _status(record: _VbriefOnDisk) -> str:
    """Resolved status -- ``plan.status`` is source of truth, folder is fallback."""
    raw = record.plan.get("status")
    if isinstance(raw, str) and raw:
        return raw
    # Folder-derived fallback (vbrief.md status-driven moves).
    if record.folder == "completed":
        return "completed"
    if record.folder == "cancelled":
        return "cancelled"
    return ""


def _is_completed(record: _VbriefOnDisk) -> bool:
    return _status(record) == "completed" or record.folder == "completed"


def _child_ref_names(plan: dict[str, Any]) -> list[str]:
    """Basenames of ``x-vbrief/plan`` child references declared on *plan*."""
    refs = plan.get("references")
    if not isinstance(refs, list):
        return []
    names: list[str] = []
    for ref in refs:
        if not isinstance(ref, dict) or ref.get("type") != CHILD_REF_TYPE:
            continue
        uri = ref.get("uri")
        if isinstance(uri, str) and uri.strip():
            names.append(Path(uri.strip()).name)
    return names


def _iter_vbriefs(project_root: Path) -> list[_VbriefOnDisk]:
    """Scan every lifecycle folder once. Malformed files are skipped."""
    out: list[_VbriefOnDisk] = []
    vroot = project_root / "vbrief"
    for folder in LIFECYCLE_FOLDERS:
        fdir = vroot / folder
        if not fdir.is_dir():
            continue
        for child in sorted(fdir.glob("*.vbrief.json")):
            if not child.is_file():
                continue
            try:
                data = json.loads(child.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                continue
            plan = data.get("plan") if isinstance(data, dict) else None
            if not isinstance(plan, dict):
                continue
            out.append(
                _VbriefOnDisk(
                    name=child.name,
                    folder=folder,
                    rel_path=f"{folder}/{child.name}",
                    plan=plan,
                    updated=_updated_at(plan, child),
                )
            )
    return out


def _dormancy_days(stamps: list[datetime | None], now: datetime) -> int | None:
    """Whole days since the most-recent activity across *stamps* (None when unknown)."""
    known = [s for s in stamps if s is not None]
    if not known:
        return None
    most_recent = max(known)
    delta = now - most_recent
    return max(0, int(delta.total_seconds() // 86400))


# ---------------------------------------------------------------------------
# Tech-debt acceptance ledger (durable vbrief/.audit/ receipts)
# ---------------------------------------------------------------------------


def tech_debt_ledger_path(project_root: Path) -> Path:
    """Absolute path to ``vbrief/.audit/epic-tech-debt-accepted.jsonl``."""
    return project_root.joinpath(*TECH_DEBT_LEDGER_RELPATH)


def _utc_iso(dt: datetime | None = None) -> str:
    return (dt or datetime.now(UTC)).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def record_tech_debt_acceptance(
    project_root: Path,
    epic: str,
    *,
    follow_up_ref: str,
    actor: str = DEFAULT_ACTOR,
    now: datetime | None = None,
) -> Path:
    """Append a tech-debt acceptance record and stop re-nudging the epic.

    *epic* may be a basename or a lifecycle-relative path; the immutable
    basename is stored as the ledger key. *follow_up_ref* records where the
    accepted debt is tracked (a tech-debt vBRIEF path or issue reference) so
    the acceptance is auditable. Append-only JSONL write (mkdir + open ``a``)
    mirrors the durable-audit convention in ``scripts/triage_welcome.py``.
    """
    epic_key = Path(epic.strip()).name
    if not epic_key:
        raise ValueError("epic must be a non-empty basename or path")
    if not isinstance(follow_up_ref, str) or not follow_up_ref.strip():
        raise ValueError("follow_up_ref must be a non-empty reference string")
    path = tech_debt_ledger_path(project_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "epic": epic_key,
        "follow_up_ref": follow_up_ref.strip(),
        "accepted_at": _utc_iso(now),
        "actor": actor,
    }
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")
    return path


def load_accepted_debt_keys(project_root: Path) -> set[str]:
    """Return the set of epic basenames already accepted as tech-debt."""
    path = tech_debt_ledger_path(project_root)
    if not path.is_file():
        return set()
    keys: set[str] = set()
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return keys
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            obj = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            epic = obj.get("epic")
            if isinstance(epic, str) and epic:
                keys.add(epic)
    return keys


# ---------------------------------------------------------------------------
# Nudge rendering
# ---------------------------------------------------------------------------


def _render_stranded(
    *, title: str, dormant: int, threshold: int, completed: int, total: int
) -> str:
    return (
        f'[TIER-1] stranded slice: epic "{title}" dormant {dormant}d '
        f"(> epicStrandedDays {threshold}) with {completed}/{total} children "
        "completed -- finish | cancel-and-remove | accept-as-tech-debt "
        "(see `task capacity:show`)"
    )


def _render_stale_epic(*, title: str, dormant: int, threshold: int) -> str:
    return (
        f'[TIER-2] stale epic: undecomposed epic "{title}" dormant {dormant}d '
        f"(> epicStalenessDays {threshold}) -- needs estimation/decomposition"
    )


def _render_capacity_coldstart(*, unclassified: int, classified: int, minimum: int) -> str:
    return (
        f"[TIER-3] capacity cold-start: {unclassified} completed vBRIEF(s) "
        f"unclassified (classified {classified}/{minimum} in window) -- run "
        "`task capacity:backfill --apply` to classify history and activate "
        "capacity accounting (#1606)"
    )


# ---------------------------------------------------------------------------
# Detector
# ---------------------------------------------------------------------------


def detect_lifecycle_nudges(
    project_root: Path, *, now: datetime | None = None
) -> list[LifecycleNudge]:
    """Detect stranded-slice (Tier 1) + stale-epic (Tier 2) nudges.

    Filesystem-truth, offline. Epics already accepted as tech-debt are skipped
    (no re-nudging). Results are ranked by ``(tier, -magnitude, nudge_id)`` so
    the most harmful nudge sorts first for the budgeted session-start surface.
    """
    now_dt = now or datetime.now(UTC)
    thresholds = resolve_epic_thresholds(project_root)
    accepted = load_accepted_debt_keys(project_root)

    records = _iter_vbriefs(project_root)
    index: dict[str, _VbriefOnDisk] = {r.name: r for r in records}

    nudges: list[LifecycleNudge] = []
    for record in records:
        if _kind(record.plan) not in PARENT_KINDS:
            continue
        if _status(record) in TERMINAL_STATUSES:
            continue
        if record.name in accepted:
            continue

        child_names = _child_ref_names(record.plan)
        resolved = [index[name] for name in child_names if name in index]
        if resolved:
            nudge = _stranded_nudge(record, child_names, resolved, thresholds, now_dt)
        else:
            # Two cases route here: a truly undecomposed epic (no child refs at
            # all) AND an epic whose declared children are ALL unresolvable on
            # disk (e.g. child vBRIEFs deleted without updating the parent's
            # references). Both surface as a stale-epic nudge so a stranded epic
            # cannot fall silently through every path (#1508 review).
            nudge = _stale_epic_nudge(record, thresholds, now_dt)
        if nudge is not None:
            nudges.append(nudge)

    capacity_nudge = detect_capacity_coldstart_nudge(project_root, now=now_dt)
    if capacity_nudge is not None:
        nudges.append(capacity_nudge)

    nudges.sort(key=lambda n: (n.tier, -n.magnitude, n.nudge_id))
    return nudges


def detect_capacity_coldstart_nudge(
    project_root: Path, *, now: datetime | None = None
) -> LifecycleNudge | None:
    """Capacity classification cold-start (Tier 3) nudge (#1606).

    Fires only when capacity buckets ARE configured yet the completed history
    is classification-cold: ``classified_completions`` is below
    ``minSampleSize`` AND at least one completed vBRIEF carries no explicit
    ``capacityBucket``. In that state ``task capacity:backfill`` is the one-time
    action that crosses ``minSampleSize`` and lifts the engine out of advisory
    mode. Suppressed when capacity is unconfigured (nothing to classify
    against) or already classified past the sample floor (no cold-start).

    ``capacity_show`` is imported lazily so the common nudge path (epic
    hygiene only) does not pay the import cost, and so this module stays
    import-cycle-free for callers that only need the epic detectors.
    """
    allocation = policy.resolve_capacity_allocation(project_root)
    if not allocation.configured:
        return None

    import capacity_show  # noqa: PLC0415 -- lazy; avoids import cost / cycle

    report = capacity_show.compute_report(project_root, now=now, allocation=allocation)
    if report.classified_completions >= report.min_sample_size:
        return None
    if report.unclassified_completions <= 0:
        return None

    message = _render_capacity_coldstart(
        unclassified=report.unclassified_completions,
        classified=report.classified_completions,
        minimum=report.min_sample_size,
    )
    return LifecycleNudge(
        nudge_id=CAPACITY_COLDSTART_NUDGE_ID,
        kind="capacity-coldstart",
        tier=TIER_CAPACITY_COLDSTART,
        title="capacity cold-start",
        epic_rel_path="",
        dormant_days=0,
        completed_children=0,
        total_children=0,
        magnitude=report.unclassified_completions,
        message=message,
    )


def _stranded_nudge(
    epic: _VbriefOnDisk,
    child_names: list[str],
    resolved: list[_VbriefOnDisk],
    thresholds: EpicThresholds,
    now: datetime,
) -> LifecycleNudge | None:
    """Stranded-slice (Tier 1) nudge for a partially-completed dormant epic.

    *resolved* is the subset of the epic's declared children that exist on disk
    (the caller routes an all-unresolvable epic to the stale-epic path instead).
    """
    completed = [c for c in resolved if _is_completed(c)]
    total = len(child_names)
    # Partially-completed: at least one child done AND not every child done
    # (unresolved / removed refs count as not-done -- the stranded case).
    if not completed or len(completed) >= total:
        return None

    stamps = [epic.updated, *(c.updated for c in resolved)]
    dormant = _dormancy_days(stamps, now)
    if dormant is None or dormant <= thresholds.stranded_days:
        return None

    title = _title(epic)
    return LifecycleNudge(
        nudge_id=epic.name,
        kind="stranded",
        tier=TIER_STRANDED,
        title=title,
        epic_rel_path=epic.rel_path,
        dormant_days=dormant,
        completed_children=len(completed),
        total_children=total,
        magnitude=dormant,
        message=_render_stranded(
            title=title,
            dormant=dormant,
            threshold=thresholds.stranded_days,
            completed=len(completed),
            total=total,
        ),
    )


def _stale_epic_nudge(
    epic: _VbriefOnDisk, thresholds: EpicThresholds, now: datetime
) -> LifecycleNudge | None:
    """Stale-epic (Tier 2) nudge for an undecomposed dormant epic."""
    dormant = _dormancy_days([epic.updated], now)
    if dormant is None or dormant <= thresholds.staleness_days:
        return None

    title = _title(epic)
    return LifecycleNudge(
        nudge_id=epic.name,
        kind="stale-epic",
        tier=TIER_STALE_EPIC,
        title=title,
        epic_rel_path=epic.rel_path,
        dormant_days=dormant,
        completed_children=0,
        total_children=0,
        magnitude=dormant,
        message=_render_stale_epic(
            title=title, dormant=dormant, threshold=thresholds.staleness_days
        ),
    )


def _title(record: _VbriefOnDisk) -> str:
    raw = record.plan.get("title")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    return record.name
