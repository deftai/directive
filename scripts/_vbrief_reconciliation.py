"""Reconciliation of SPEC and ROADMAP sources during migrate:vbrief (Agent B, #496).

Implements the role-based reconciliation strategy mandated by master tracking
issue #506 (Decisions D3, D4) and by issue #496's Acceptance Criteria:

* Identity (body / acceptance / traces) is SPEC-owned. IDs pass through
  unchanged -- this module never renumbers tasks.
* Status is ROADMAP-owned when ROADMAP carries an explicit completion signal
  (``[done]`` in an active list or entry in a ``## Completed`` section).
  Otherwise SPEC ``[done]`` (or ``plan.items[*].status == "completed"``)
  wins as tiebreaker. The module never defaults to ``pending`` for tasks
  that have any completion signal from either source.
* Grouping preserves both: ``narrative.Phase`` = ROADMAP milestone;
  ``narrative.SpecPhase`` = SPEC phase heading. The ROADMAP one-liner is
  preserved in ``narrative.RoadmapSummary`` only when it differs from the
  SPEC title.
* Orphan ROADMAP items (no matching SPEC task) route to ``vbrief/proposed/``
  with ``narrative.SourceConflict = "missing-from-spec"``. When SPEC has no
  items at all, orphan detection is disabled and ROADMAP items fall through
  to ``pending/`` -- this preserves the degenerate case where a project has
  a ROADMAP but no structured SPEC.
* Each narrative key gets a sibling ``*_source`` field ("SPECIFICATION.md" /
  "ROADMAP.md" / "migration-overrides.yaml") so post-migration drift is
  auditable without re-running the migrator.

Overrides (``vbrief/migration-overrides.yaml``) are applied BEFORE defaults
so operators can pin known resolutions. Every override that triggered is
logged to the RECONCILIATION.md report. A tiny purpose-built parser covers
the documented schema shape -- PyYAML is not a hard dependency for the
framework and we do not want to force consumers to install it for an
optional feature.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Status signal detection
# ---------------------------------------------------------------------------

_DONE_MARKERS: tuple[str, ...] = ("[done]", "[x]", "[X]", "\u2713", "\u2705")
_WIP_MARKERS: tuple[str, ...] = (
    "[wip]", "[in progress]", "[in-progress]", "[running]", "[active]",
)
_BLOCKED_MARKERS: tuple[str, ...] = ("[blocked]",)
_CANCELLED_MARKERS: tuple[str, ...] = ("[cancelled]", "[canceled]")


def _detect_status_marker(text: str) -> str | None:
    """Return a schema-native status inferred from a markdown marker in ``text``.

    Scans for ``[done]`` / ``[wip]`` / ``[blocked]`` / ``[cancelled]`` style
    markers that operators commonly sprinkle on SPECIFICATION.md task lines.
    Returns ``None`` if no recognised marker is present.
    """
    if not text:
        return None
    lower = text.lower()
    if any(m.lower() in lower for m in _CANCELLED_MARKERS):
        return "cancelled"
    if any(m.lower() in lower for m in _BLOCKED_MARKERS):
        return "blocked"
    if any(m in text or m.lower() in lower for m in _DONE_MARKERS):
        return "completed"
    if any(m.lower() in lower for m in _WIP_MARKERS):
        return "running"
    return None


# ---------------------------------------------------------------------------
# Overrides loader (vbrief/migration-overrides.yaml)
# ---------------------------------------------------------------------------

OVERRIDES_FILENAME = "migration-overrides.yaml"


def _strip_quotes(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def _coerce_scalar(value: str) -> Any:
    v = _strip_quotes(value)
    lower = v.lower()
    if lower in ("true", "yes", "on"):
        return True
    if lower in ("false", "no", "off"):
        return False
    if lower in ("null", "none", "~", ""):
        return None
    return v


def parse_overrides_yaml(text: str) -> dict[str, dict[str, Any]]:
    """Parse the documented migration-overrides.yaml schema shape.

    Recognised shape (mirrors #496 Proposed design component 4)::

        overrides:
          t2.4.1:
            status: completed
            body_source: spec
          t3.1.2:
            status: pending
            body_source: roadmap
          roadmap-9:
            drop: true

    Parser intentionally accepts a conservative subset: top-level
    ``overrides:`` mapping, one level of task-id keys, leaf scalar values.
    Lines starting with ``#`` are comments. Returns an empty mapping when
    no ``overrides:`` key is present.
    """
    result: dict[str, dict[str, Any]] = {}
    current_task: str | None = None
    in_overrides = False

    for raw_line in text.splitlines():
        # Preserve indentation; strip only trailing whitespace and full-line
        # comments. In-line ``#`` comments are left alone because the override
        # values can legitimately contain ``#`` (e.g. issue references).
        line = raw_line.rstrip()
        stripped = line.lstrip()
        if not stripped or stripped.startswith("#"):
            continue

        indent = len(line) - len(stripped)

        if indent == 0:
            # Top-level key -- only ``overrides:`` is meaningful.
            key = stripped.split(":", 1)[0].strip()
            in_overrides = key == "overrides"
            current_task = None
            continue

        if not in_overrides:
            continue

        # Task-id row (nested under ``overrides:``), e.g. ``  t2.4.1:``.
        if stripped.endswith(":") and indent >= 2 and indent < 4:
            current_task = stripped[:-1].strip()
            result.setdefault(current_task, {})
            continue

        # Field row, e.g. ``    status: completed``.
        if current_task is not None and ":" in stripped and indent >= 4:
            key, _, value = stripped.partition(":")
            result[current_task][key.strip()] = _coerce_scalar(value)

    return result


def load_overrides(vbrief_dir: Path) -> dict[str, dict[str, Any]]:
    """Load ``vbrief/migration-overrides.yaml`` if present. Returns {} if absent."""
    path = vbrief_dir / OVERRIDES_FILENAME
    if not path.is_file():
        return {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    return parse_overrides_yaml(text)


# ---------------------------------------------------------------------------
# SPEC task index
# ---------------------------------------------------------------------------


def _normalize_task_id(task_id: str) -> str:
    """Canonicalise a task id for cross-source matching.

    Strips a leading ``t`` / ``T`` before a digit or dot (so SPEC's ``t1.1.1``
    matches ROADMAP's ``1.1.1``), trims whitespace, and returns the rest
    verbatim. Empty / falsy input returns ``""``.
    """
    if not task_id:
        return ""
    s = task_id.strip()
    if len(s) >= 2 and s[0] in ("t", "T") and (s[1].isdigit() or s[1] == "."):
        return s[1:].lstrip("-.").strip()
    return s


def _collect_issue_numbers(item: dict) -> list[str]:
    """Extract GitHub issue numbers referenced by a SPEC item."""
    numbers: list[str] = []
    refs = item.get("references") or []
    if isinstance(refs, list):
        for ref in refs:
            if not isinstance(ref, dict):
                continue
            if ref.get("type") == "github-issue":
                rid = str(ref.get("id", "")).lstrip("#")
                if rid:
                    numbers.append(rid)
    return numbers


@dataclass
class SpecTaskEntry:
    """A flattened SPEC task with enough context for reconciliation."""

    item: dict = field(default_factory=dict)
    spec_phase: str = ""
    source_line: str = ""


def build_spec_task_index(spec_vbrief: dict | None) -> dict[str, SpecTaskEntry]:
    """Flatten ``spec_vbrief.plan.items`` (+ subItems) into an index.

    Keys include both the raw ``item.id`` and the normalised form (so
    ``t1.1.1`` <-> ``1.1.1``) plus any referenced GitHub issue numbers
    (both ``#123`` and ``123`` forms). Values carry the closest parent
    phase label for later narrative.SpecPhase emission.
    """
    index: dict[str, SpecTaskEntry] = {}
    if not isinstance(spec_vbrief, dict):
        return index
    plan = spec_vbrief.get("plan", {})
    if not isinstance(plan, dict):
        return index

    def _walk(items: object, parent_phase: str) -> None:
        if not isinstance(items, list):
            return
        for item in items:
            if not isinstance(item, dict):
                continue
            title = str(item.get("title", "") or "")
            # A SPEC item that represents a phase contributes its own title
            # as the phase label for its descendants.
            if re.match(r"^(Phase\s+\d|IP[-\s]\d|Milestone\s+\d)", title,
                        flags=re.IGNORECASE):
                child_phase = title
            else:
                child_phase = parent_phase

            item_id = str(item.get("id", "") or "")
            entry = SpecTaskEntry(item=item, spec_phase=parent_phase)
            if item_id:
                index.setdefault(item_id, entry)
                normalised = _normalize_task_id(item_id)
                if normalised and normalised != item_id:
                    index.setdefault(normalised, entry)

            for num in _collect_issue_numbers(item):
                index.setdefault(num, entry)
                index.setdefault(f"#{num}", entry)

            _walk(item.get("subItems", []), child_phase)

    _walk(plan.get("items", []), parent_phase="")
    return index


# ---------------------------------------------------------------------------
# SPEC body / acceptance / traces extraction
# ---------------------------------------------------------------------------


def _pick_narrative(item: dict, *keys: str) -> str:
    """Return the first non-empty narrative value for any of ``keys``."""
    narrative = item.get("narrative") or {}
    if not isinstance(narrative, dict):
        return ""
    for key in keys:
        value = narrative.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _spec_body(item: dict, default: str) -> str:
    """Return the SPEC-derived Description for a spec item, or ``default``."""
    body = _pick_narrative(item, "Description", "Summary", "Body", "Overview")
    if body:
        return body
    # Fallback to the item title so callers always get a non-empty body.
    return str(item.get("title", "") or "").strip() or default


# ---------------------------------------------------------------------------
# Reconciliation report
# ---------------------------------------------------------------------------


@dataclass
class ConflictEntry:
    task_id: str
    title: str
    dimensions: list[dict[str, str]] = field(default_factory=list)
    overrides_applied: list[str] = field(default_factory=list)


@dataclass
class ReconciliationReport:
    conflicts: list[ConflictEntry] = field(default_factory=list)
    orphans: list[dict[str, str]] = field(default_factory=list)
    overrides_triggered: list[dict[str, str]] = field(default_factory=list)
    overrides_unused: list[str] = field(default_factory=list)

    def has_disagreement(self) -> bool:
        return bool(
            self.conflicts
            or self.orphans
            or self.overrides_triggered
        )


# ---------------------------------------------------------------------------
# Core reconciliation
# ---------------------------------------------------------------------------


def _status_from_spec(entry: SpecTaskEntry) -> str | None:
    """Return a schema-native status derived from SPEC data, or None."""
    item = entry.item
    status = item.get("status")
    if isinstance(status, str) and status in {
        "draft", "proposed", "approved", "pending",
        "running", "completed", "blocked", "cancelled",
    }:
        return status
    # Inline [done] marker on the title is also a signal.
    return _detect_status_marker(str(item.get("title", "") or ""))


def _roadmap_status(roadmap_item: dict, completed: bool) -> str | None:
    """Return a status signal carried by the ROADMAP row, or None.

    ``completed`` is ``True`` when the row comes from ROADMAP's Completed
    section. Otherwise status is derived from inline markers on the title.
    """
    if completed:
        return "completed"
    title = str(roadmap_item.get("title", "") or "")
    return _detect_status_marker(title)


def _choose_status(
    task_id: str,
    title: str,
    spec_entry: SpecTaskEntry | None,
    roadmap_status: str | None,
    override_status: str | None,
) -> tuple[str, str, str | None]:
    """Return ``(status, status_source, conflict_note)`` per D3 policy.

    * Override wins when present.
    * ROADMAP wins when it carries an explicit completion signal.
    * SPEC ``[done]`` / SPEC ``status: completed`` is tiebreaker otherwise.
    * Default is ``pending`` when nothing else applies.
    """
    if override_status:
        return override_status, "migration-overrides.yaml", None

    spec_status = _status_from_spec(spec_entry) if spec_entry else None

    # ROADMAP wins for explicit signals.
    if roadmap_status:
        if spec_status and spec_status != roadmap_status:
            conflict = (
                f"SPEC status = {spec_status!r}; "
                f"ROADMAP status = {roadmap_status!r}; "
                f"ROADMAP wins (D3 role policy)."
            )
            return roadmap_status, "ROADMAP.md", conflict
        return roadmap_status, "ROADMAP.md", None

    # SPEC tiebreaker.
    if spec_status:
        return spec_status, "SPECIFICATION.md (tiebreaker)", None

    return "pending", "default", None


def _title_conflict(
    spec_entry: SpecTaskEntry | None, roadmap_title: str,
) -> tuple[str, str, str | None, str]:
    """Return ``(title, title_source, conflict_note, roadmap_summary)``.

    SPEC title wins over ROADMAP one-liner per D3. When SPEC is absent, the
    ROADMAP title becomes the scope title and no RoadmapSummary is emitted.
    When titles differ, the ROADMAP one-liner is preserved in
    ``RoadmapSummary``.
    """
    roadmap_title = (roadmap_title or "").strip()
    if not spec_entry:
        return roadmap_title, "ROADMAP.md", None, ""

    spec_title = str(spec_entry.item.get("title", "") or "").strip()
    if not spec_title:
        return roadmap_title, "ROADMAP.md", None, ""

    if spec_title == roadmap_title:
        return spec_title, "SPECIFICATION.md", None, ""

    # Drift: both titles present but differ.
    conflict = (
        f"SPEC title = {spec_title!r}; ROADMAP title = {roadmap_title!r}; "
        f"SPEC wins; ROADMAP preserved in narrative.RoadmapSummary."
    )
    return spec_title, "SPECIFICATION.md", conflict, roadmap_title


def _description(
    spec_entry: SpecTaskEntry | None, roadmap_title: str, body_source_override: str | None,
) -> tuple[str, str]:
    """Pick description and source per body_source override or default D3 policy."""
    if body_source_override == "roadmap":
        return (roadmap_title or "").strip(), "ROADMAP.md (override)"
    if body_source_override == "spec":
        if spec_entry:
            return _spec_body(spec_entry.item, roadmap_title), "SPECIFICATION.md (override)"
        return (roadmap_title or "").strip(), "ROADMAP.md (override fallback: no SPEC match)"

    if spec_entry:
        body = _spec_body(spec_entry.item, roadmap_title)
        return body, "SPECIFICATION.md"
    return (roadmap_title or "").strip(), "ROADMAP.md"


def _override_status(override: dict[str, Any] | None) -> str | None:
    if not override:
        return None
    status = override.get("status")
    if isinstance(status, str) and status:
        return status
    return None


def _override_body_source(override: dict[str, Any] | None) -> str | None:
    if not override:
        return None
    body_source = override.get("body_source")
    if isinstance(body_source, str) and body_source in ("spec", "roadmap"):
        return body_source
    return None


def _override_drop(override: dict[str, Any] | None) -> bool:
    if not override:
        return False
    return bool(override.get("drop"))


def _task_id_for_item(item: dict, is_completed: bool) -> str:
    """Return the canonical key the overrides file uses for this ROADMAP row."""
    number = item.get("number", "")
    if number:
        return f"#{number}"
    task_id = item.get("task_id", "")
    if task_id:
        return task_id
    synthetic = item.get("synthetic_id", "")
    if synthetic:
        return synthetic
    # Last resort -- deterministic fallback based on title (completed vs active
    # so an ambiguous collision can't silently merge across states).
    suffix = "completed" if is_completed else "active"
    return f"{suffix}:{item.get('title', 'untitled')}"


def _lookup_override(
    item: dict, canonical_key: str, overrides: dict[str, dict[str, Any]],
) -> tuple[dict[str, Any] | None, str | None]:
    """Return ``(override, matched_key)`` for any key shape the overrides file uses.

    Operators tend to write ``t1.1.1`` in migration-overrides.yaml even when the
    ROADMAP row renders as ``1.1.1`` (bare). We try each plausible form so a
    single override line can drive either form of row.
    """
    if not overrides:
        return None, None
    candidates: list[str] = [canonical_key]
    task_id = str(item.get("task_id", "") or "")
    if task_id:
        normalised = _normalize_task_id(task_id)
        candidates.extend([task_id, normalised, f"t{task_id}", f"t{normalised}"])
    number = str(item.get("number", "") or "")
    if number:
        candidates.extend([number, f"#{number}"])
    synthetic = str(item.get("synthetic_id", "") or "")
    if synthetic:
        candidates.append(synthetic)
    for key in candidates:
        if key and key in overrides:
            return overrides[key], key
    return None, None


def _match_spec_entry(
    item: dict, spec_index: dict[str, SpecTaskEntry],
) -> SpecTaskEntry | None:
    """Best-effort SPEC lookup for a ROADMAP row."""
    if not spec_index:
        return None
    number = str(item.get("number", "") or "")
    if number:
        for key in (number, f"#{number}"):
            entry = spec_index.get(key)
            if entry:
                return entry
    task_id = str(item.get("task_id", "") or "")
    if task_id:
        for key in (task_id, _normalize_task_id(task_id), f"t{task_id}"):
            entry = spec_index.get(key)
            if entry:
                return entry
    return None


def reconcile_scope_items(
    *,
    roadmap_active: list[dict],
    roadmap_completed: list[dict],
    spec_vbrief: dict | None,
    phase_descriptions: dict[str, str] | None = None,
    overrides: dict[str, dict[str, Any]] | None = None,
) -> tuple[list[dict], ReconciliationReport]:
    """Reconcile ROADMAP and SPEC into a list of routed scope items.

    Returns ``(reconciled_items, report)`` where each reconciled item has the
    shape consumed by ``_vbrief_routing.build_scope_vbrief_from_reconciled``.
    The caller is responsible for writing the scope vBRIEFs to disk and
    dispatching the report (``write_reconciliation_report``).
    """
    overrides = overrides or {}
    phase_descriptions = phase_descriptions or {}
    spec_index = build_spec_task_index(spec_vbrief)
    spec_has_items = bool(spec_index)

    reconciled: list[dict] = []
    report = ReconciliationReport()
    used_override_keys: set[str] = set()

    def _handle(item: dict, *, is_completed: bool) -> None:
        task_key = _task_id_for_item(item, is_completed=is_completed)
        override, matched_key = _lookup_override(item, task_key, overrides)
        if override is not None and matched_key is not None:
            used_override_keys.add(matched_key)

        if _override_drop(override):
            report.overrides_triggered.append({
                "task_id": task_key,
                "title": str(item.get("title", "") or ""),
                "action": "dropped from migration",
            })
            return

        spec_entry = _match_spec_entry(item, spec_index)
        title, title_source, title_conflict, roadmap_summary = _title_conflict(
            spec_entry, str(item.get("title", "") or ""),
        )

        description, description_source = _description(
            spec_entry,
            roadmap_title=str(item.get("title", "") or ""),
            body_source_override=_override_body_source(override),
        )

        roadmap_status = _roadmap_status(item, completed=is_completed)
        status, status_source, status_conflict = _choose_status(
            task_id=task_key,
            title=title,
            spec_entry=spec_entry,
            roadmap_status=roadmap_status,
            override_status=_override_status(override),
        )

        # Orphan: ROADMAP item with no SPEC match, but SPEC had items.
        # #496 acceptance: "route to vbrief/proposed/ with
        # narrative.SourceConflict = 'missing-from-spec' so it surfaces for
        # triage rather than silently joining the backlog." Operators
        # evaluate orphans individually, so we force status=proposed even
        # when ROADMAP carried a completion signal. Without this override,
        # ROADMAP-Completed orphans would emit to proposed/ with
        # plan.status="completed" and fail Agent D's D2 folder/status
        # validator (proposed/ only permits draft|proposed). The inbound
        # completion signal is preserved in the RoadmapSummary narrative so
        # nothing is lost during triage.
        source_conflict = ""
        folder: str
        if spec_has_items and spec_entry is None:
            source_conflict = "missing-from-spec"
            folder = "proposed"
            status = "proposed"
            status_source = "orphan: proposed default"
            report.orphans.append({
                "task_id": task_key,
                "title": title or str(item.get("title", "") or ""),
            })
        else:
            # Lifecycle routing happens outside this module, but we need the
            # folder here to ensure the status we emit is permitted in it.
            folder = _folder_from_status(status)

        phase = item.get("phase", "") or ""
        tier = item.get("tier", "") or ""
        phase_desc = phase_descriptions.get(phase, "") if phase else ""
        spec_phase = spec_entry.spec_phase if spec_entry else ""

        reconciled.append({
            "task_id": task_key,
            "number": str(item.get("number", "") or ""),
            "title": title,
            "title_source": title_source if title_conflict else "",
            "description": description,
            "description_source": description_source,
            "status": status,
            "status_source": status_source,
            "folder": folder,
            "phase": phase,
            "phase_description": phase_desc,
            "tier": tier,
            "spec_phase": spec_phase if spec_phase != phase else "",
            "roadmap_summary": roadmap_summary,
            "source_conflict": source_conflict,
            "override_applied": override is not None,
            "synthetic_id": item.get("synthetic_id", ""),
            "original_task_id": item.get("task_id", ""),
        })

        # Record conflicts and override triggers.
        dims: list[dict[str, str]] = []
        if title_conflict:
            dims.append({
                "dimension": "TITLE drift",
                "spec": str(spec_entry.item.get("title", "") if spec_entry else ""),
                "roadmap": str(item.get("title", "") or ""),
                "resolution": title_conflict,
            })
        if status_conflict:
            dims.append({
                "dimension": "STATUS conflict",
                "spec": _status_from_spec(spec_entry) or "(none)" if spec_entry else "(no match)",
                "roadmap": roadmap_status or "(none)",
                "resolution": status_conflict,
            })

        triggered_fields: list[str] = []
        if override is not None:
            for key in ("status", "body_source"):
                if key in override:
                    triggered_fields.append(key)
            # drop:false is a no-op that explicitly records "do NOT drop this
            # task" and must not trip --strict.  Only drop:true is a triggered
            # action (Greptile #524 P1).
            if override.get("drop"):
                triggered_fields.append("drop")
            # Only record overrides that actually triggered a field change.
            # A no-op override (e.g. drop:false with no other keys) still gets
            # counted as used (so unused-override surfacing is accurate) but
            # must not make has_disagreement() return True.
            if triggered_fields:
                report.overrides_triggered.append({
                    "task_id": task_key,
                    "title": title,
                    "fields": ", ".join(triggered_fields),
                })

        if dims or triggered_fields:
            report.conflicts.append(ConflictEntry(
                task_id=task_key,
                title=title or str(item.get("title", "") or ""),
                dimensions=dims,
                overrides_applied=triggered_fields,
            ))

    for item in roadmap_active:
        _handle(item, is_completed=False)
    for item in roadmap_completed:
        _handle(item, is_completed=True)

    # Overrides that never triggered -- surface so operators notice stale pins.
    for key in overrides:
        if key not in used_override_keys:
            report.overrides_unused.append(key)

    return reconciled, report


def _folder_from_status(status: str) -> str:
    """Local copy of ``_vbrief_routing.folder_for_status`` to avoid an import cycle."""
    mapping = {
        "draft": "proposed", "proposed": "proposed",
        "approved": "pending", "pending": "pending",
        "running": "active", "blocked": "active",
        "completed": "completed",
        "cancelled": "cancelled",
    }
    return mapping.get(status, "pending")


# ---------------------------------------------------------------------------
# RECONCILIATION.md emitter
# ---------------------------------------------------------------------------


def _format_conflict_entry(entry: ConflictEntry) -> str:
    lines = [f"## {entry.task_id} -- {entry.title}", ""]
    for dim in entry.dimensions:
        lines.append(f"- {dim['dimension']}")
        if dim.get("spec"):
            lines.append(f"  - SPEC: {dim['spec']}")
        if dim.get("roadmap"):
            lines.append(f"  - ROADMAP: {dim['roadmap']}")
        lines.append(f"  - Resolution: {dim['resolution']}")
    if entry.overrides_applied:
        lines.append(
            f"- Overrides applied: {', '.join(entry.overrides_applied)} "
            "(migration-overrides.yaml)"
        )
    lines.append("")
    return "\n".join(lines)


def format_reconciliation_markdown(report: ReconciliationReport) -> str:
    """Render the report as the markdown emitted to RECONCILIATION.md."""
    timestamp = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    parts: list[str] = [
        "# Migration reconciliation report",
        "",
        f"Generated: {timestamp}",
        "",
        "Per #496 this file is emitted whenever SPECIFICATION.md and ROADMAP.md "
        "disagreed on any dimension during `task migrate:vbrief`, or when any "
        "override from `vbrief/migration-overrides.yaml` triggered.",
        "",
    ]

    if report.conflicts:
        parts.append("## Per-task conflicts")
        parts.append("")
        for entry in report.conflicts:
            parts.append(_format_conflict_entry(entry))
    else:
        parts.append("## Per-task conflicts")
        parts.append("")
        parts.append("(none)")
        parts.append("")

    parts.append("## Orphans in ROADMAP (no matching SPEC task)")
    parts.append("")
    if report.orphans:
        for orph in report.orphans:
            parts.append(
                f"- `{orph['task_id']}` -- {orph['title']}\n"
                f"  - Resolution: emitted to vbrief/proposed/ with "
                f"narrative.SourceConflict = \"missing-from-spec\"."
            )
    else:
        parts.append("(none)")
    parts.append("")

    parts.append("## Overrides applied (vbrief/migration-overrides.yaml)")
    parts.append("")
    if report.overrides_triggered:
        for ov in report.overrides_triggered:
            fields = ov.get("fields", "") or ov.get("action", "")
            parts.append(
                f"- `{ov['task_id']}` -- {ov.get('title', '')}: {fields}"
            )
    else:
        parts.append("(none)")
    parts.append("")

    if report.overrides_unused:
        parts.append("## Overrides defined but not triggered")
        parts.append("")
        for key in report.overrides_unused:
            parts.append(f"- `{key}`")
        parts.append("")

    return "\n".join(parts).rstrip() + "\n"


def write_reconciliation_report(
    report: ReconciliationReport, vbrief_dir: Path,
) -> Path | None:
    """Write ``vbrief/migration/RECONCILIATION.md`` when the report has content.

    Returns the path written, or ``None`` when no disagreement was recorded.
    """
    if not report.has_disagreement():
        return None
    target_dir = vbrief_dir / "migration"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / "RECONCILIATION.md"
    target.write_text(format_reconciliation_markdown(report), encoding="utf-8")
    return target


__all__ = [
    "OVERRIDES_FILENAME",
    "ConflictEntry",
    "ReconciliationReport",
    "SpecTaskEntry",
    "build_spec_task_index",
    "format_reconciliation_markdown",
    "load_overrides",
    "parse_overrides_yaml",
    "reconcile_scope_items",
    "write_reconciliation_report",
]
