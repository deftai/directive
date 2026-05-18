"""slice_audit.py -- business logic + renderers for slice operation flags (#1132 / D13 of #1119).

The three D13 flags on ``task triage:audit`` -- ``--orphans``,
``--slice-stalled``, ``--slice-coverage`` -- live here so
``scripts/triage_queue.py`` stays under the 1000-line MUST cap
documented in ``coding/coding.md``. ``scripts/_triage_queue_cli.py``
delegates to the entry points below; the renderers are pure functions
that take pre-loaded inputs so tests can drive them with synthetic
fixtures.

Public surface
--------------

* :func:`compute_orphans` -- children whose umbrella is closed while
  they remain open.
* :func:`compute_stalled` -- cohorts where >=1 child has merged but
  >=1 sibling has not moved in N days.
* :func:`compute_coverage` -- per-umbrella ``closed/total`` rollup.
* :func:`collect_orphan_issue_numbers` -- thin wrapper returning the
  set of orphan child numbers (used by ``task triage:queue`` to wire
  the ``ORPHAN`` group via :class:`QueueBuildOptions`).
* :func:`render_orphans_plain` / :func:`render_orphans_json` -- and
  the analogous pairs for stalled / coverage. JSON renderers emit a
  stable schema that downstream consumers can script against.

The framework's slice surface is consumer-agnostic: nothing in this
module hard-codes deft-specific labels or thresholds (the
``--days`` default lives as :data:`DEFAULT_SLICE_STALLED_DAYS` on
:mod:`triage_queue`).
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class OrphanRow:
    """One row in the ``--orphans`` surface.

    ``umbrella_state`` carries the cached umbrella state (``open`` /
    ``closed``) so the renderer can confirm what the operator already
    sees -- the orphan detection joins on `closed` umbrella + `open`
    child, so this field is always ``closed`` in practice but it is
    surfaced for transparency in the JSON output.
    """

    n: int
    url: str
    wave: int
    role: str
    umbrella: int
    umbrella_url: str
    umbrella_state: str
    slice_id: str
    sliced_at: str
    actor: str


@dataclass(frozen=True)
class StalledCohortRow:
    """One row in the ``--slice-stalled`` surface.

    ``stalled_siblings`` lists the child numbers whose latest cached
    ``updated_at`` predates the cutoff. ``progressed_siblings`` lists
    the merged / closed siblings that triggered the stall detection
    (Wave-1 movement that left Wave-2 idle).
    """

    slice_id: str
    umbrella: int
    umbrella_url: str
    sliced_at: str
    progressed_siblings: tuple[int, ...]
    stalled_siblings: tuple[int, ...]


@dataclass(frozen=True)
class CoverageRow:
    """One row in the ``--slice-coverage`` surface.

    ``closed`` counts children whose cached ``state`` is ``closed``
    (covers both merged PRs and closed-without-merge issues). ``total``
    is the count of children recorded in the slices.jsonl record.
    """

    slice_id: str
    umbrella: int
    umbrella_url: str
    umbrella_state: str
    closed: int
    total: int
    last_child_activity: str | None


# ---------------------------------------------------------------------------
# Slice-record loading
# ---------------------------------------------------------------------------


def load_slice_records(
    slice_records_or_module: Any,
    *,
    path: Any = None,
) -> list[dict[str, Any]]:
    """Load slice records, tolerating a missing slice_record module.

    Accepts either:

    * The :mod:`slice_record` module itself (production wiring).
    * A list of dicts (test fixture).
    * ``None`` (slim test checkout / pre-D13 rebase) -- returns ``[]``.

    The CLI shim in ``_triage_queue_cli.py`` passes the module reference
    from :mod:`triage_queue` (``tq.slice_record``); tests pass either a
    list literal or a :class:`types.SimpleNamespace` with a ``read_all``
    callable.
    """
    if slice_records_or_module is None:
        return []
    if isinstance(slice_records_or_module, list):
        return list(slice_records_or_module)
    reader = getattr(slice_records_or_module, "read_all", None)
    if not callable(reader):
        return []
    try:
        records = reader(path=path)
    except TypeError:
        records = reader()
    return [r for r in records if isinstance(r, dict)]


# ---------------------------------------------------------------------------
# Orphan detection
# ---------------------------------------------------------------------------


def _cached_state(issue: dict[str, Any] | None) -> str:
    if not isinstance(issue, dict):
        return ""
    state = issue.get("state")
    return str(state).lower() if isinstance(state, str) else ""


def compute_orphans(
    slice_records: Iterable[dict[str, Any]],
    issues_by_number: dict[int, dict[str, Any]],
) -> list[OrphanRow]:
    """Return one :class:`OrphanRow` per orphan child.

    An orphan is a child issue whose:

    * cached ``state`` is ``open``, AND
    * umbrella's cached ``state`` is ``closed``.

    Children missing from the cache (e.g. cache not bootstrapped /
    cache fetch missed them) are skipped so the surface is not noisy
    on a fresh / partial cache.

    Sort order: by ``(umbrella, n)`` for stable output across runs.
    """
    rows: list[OrphanRow] = []
    for record in slice_records:
        if not isinstance(record, dict):
            continue
        umbrella = record.get("umbrella")
        if not isinstance(umbrella, int):
            continue
        umbrella_state = _cached_state(issues_by_number.get(umbrella))
        if umbrella_state != "closed":
            continue
        children = record.get("children")
        if not isinstance(children, list):
            continue
        for child in children:
            if not isinstance(child, dict):
                continue
            n = child.get("n")
            if not isinstance(n, int):
                continue
            child_state = _cached_state(issues_by_number.get(n))
            if child_state != "open":
                continue
            rows.append(
                OrphanRow(
                    n=n,
                    url=str(child.get("url", "")),
                    wave=int(child.get("wave", 0)) if isinstance(child.get("wave"), int) else 0,
                    role=str(child.get("role", "")),
                    umbrella=umbrella,
                    umbrella_url=str(record.get("umbrella_url", "")),
                    umbrella_state=umbrella_state,
                    slice_id=str(record.get("slice_id", "")),
                    sliced_at=str(record.get("sliced_at", "")),
                    actor=str(record.get("actor", "")),
                )
            )
    rows.sort(key=lambda r: (r.umbrella, r.n))
    return rows


def collect_orphan_issue_numbers(
    slice_records: Iterable[dict[str, Any]],
    issues_by_number: dict[int, dict[str, Any]],
) -> frozenset[int]:
    """Return the frozenset of orphan child numbers.

    Wraps :func:`compute_orphans` for queue-side consumers that only
    need the set membership (no per-row metadata).
    """
    return frozenset(r.n for r in compute_orphans(slice_records, issues_by_number))


# ---------------------------------------------------------------------------
# Stalled-cohort detection
# ---------------------------------------------------------------------------


def _parse_iso8601(value: str) -> datetime | None:
    if not value:
        return None
    try:
        if value.endswith("Z"):
            return datetime.fromisoformat(value[:-1]).replace(tzinfo=UTC)
        return datetime.fromisoformat(value).astimezone(UTC)
    except ValueError:
        return None


def compute_stalled(
    slice_records: Iterable[dict[str, Any]],
    issues_by_number: dict[int, dict[str, Any]],
    *,
    days: int,
    now: datetime | None = None,
) -> list[StalledCohortRow]:
    """Return :class:`StalledCohortRow` per cohort meeting the stall criterion.

    Criterion (matches the issue body's wording):

    * the cohort contains >=1 ``progressed`` child (cached ``state`` is
      ``closed`` -- mirrors how the queue treats a merged PR), AND
    * the cohort contains >=1 ``stalled`` child (cached ``state`` is
      ``open`` AND cached ``updated_at`` is older than ``days`` days).

    Children missing from the cache are treated as stalled (their last
    movement is unknown so we surface them as a likely-orphan candidate
    rather than silently dropping them).

    Sort order: by ``(umbrella, slice_id)`` for stable output.
    """
    moment = (now or datetime.now(UTC)).astimezone(UTC)
    cutoff_seconds = days * 86400
    rows: list[StalledCohortRow] = []
    for record in slice_records:
        if not isinstance(record, dict):
            continue
        umbrella = record.get("umbrella")
        if not isinstance(umbrella, int):
            continue
        children = record.get("children")
        if not isinstance(children, list):
            continue
        progressed: list[int] = []
        stalled: list[int] = []
        for child in children:
            if not isinstance(child, dict):
                continue
            n = child.get("n")
            if not isinstance(n, int):
                continue
            cached = issues_by_number.get(n)
            state = _cached_state(cached)
            if state == "closed":
                progressed.append(n)
                continue
            if state == "open":
                updated_at_raw = cached.get("updated_at") if isinstance(cached, dict) else None
                last = _parse_iso8601(str(updated_at_raw) if updated_at_raw else "")
                if last is None or (moment - last).total_seconds() >= cutoff_seconds:
                    stalled.append(n)
                continue
            # Cache miss for the child -- treat as stalled candidate so
            # the surface flags it rather than silently dropping.
            stalled.append(n)
        if progressed and stalled:
            rows.append(
                StalledCohortRow(
                    slice_id=str(record.get("slice_id", "")),
                    umbrella=umbrella,
                    umbrella_url=str(record.get("umbrella_url", "")),
                    sliced_at=str(record.get("sliced_at", "")),
                    progressed_siblings=tuple(sorted(progressed)),
                    stalled_siblings=tuple(sorted(stalled)),
                )
            )
    rows.sort(key=lambda r: (r.umbrella, r.slice_id))
    return rows


# ---------------------------------------------------------------------------
# Coverage rollup
# ---------------------------------------------------------------------------


def compute_coverage(
    slice_records: Iterable[dict[str, Any]],
    issues_by_number: dict[int, dict[str, Any]],
    *,
    only_open_umbrella: bool = True,
) -> list[CoverageRow]:
    """Return :class:`CoverageRow` per cohort.

    By default only open-umbrella cohorts are surfaced -- the issue
    body's example output ("for each open umbrella in slices.jsonl,
    prints <umbrella>: <closed>/<total> merged"). Pass
    ``only_open_umbrella=False`` to surface every cohort (used by JSON
    consumers + the closed-umbrella orphan cross-check).

    Sort order: by ``(umbrella, slice_id)`` for stable output.
    """
    rows: list[CoverageRow] = []
    for record in slice_records:
        if not isinstance(record, dict):
            continue
        umbrella = record.get("umbrella")
        if not isinstance(umbrella, int):
            continue
        umbrella_state = _cached_state(issues_by_number.get(umbrella))
        if only_open_umbrella and umbrella_state and umbrella_state != "open":
            continue
        children = record.get("children")
        if not isinstance(children, list):
            continue
        total = 0
        closed = 0
        last_activity: datetime | None = None
        for child in children:
            if not isinstance(child, dict):
                continue
            n = child.get("n")
            if not isinstance(n, int):
                continue
            total += 1
            cached = issues_by_number.get(n) or {}
            state = _cached_state(cached)
            if state == "closed":
                closed += 1
            updated_at_raw = cached.get("updated_at") if isinstance(cached, dict) else None
            last = _parse_iso8601(str(updated_at_raw) if updated_at_raw else "")
            if last is not None and (last_activity is None or last > last_activity):
                last_activity = last
        if total == 0:
            continue
        rows.append(
            CoverageRow(
                slice_id=str(record.get("slice_id", "")),
                umbrella=umbrella,
                umbrella_url=str(record.get("umbrella_url", "")),
                umbrella_state=umbrella_state or "unknown",
                closed=closed,
                total=total,
                last_child_activity=(
                    last_activity.strftime("%Y-%m-%dT%H:%M:%SZ")
                    if last_activity is not None
                    else None
                ),
            )
        )
    rows.sort(key=lambda r: (r.umbrella, r.slice_id))
    return rows


# ---------------------------------------------------------------------------
# Renderers
# ---------------------------------------------------------------------------


def _human_age(sliced_at: str, *, now: datetime | None = None) -> str:
    moment = (now or datetime.now(UTC)).astimezone(UTC)
    parsed = _parse_iso8601(sliced_at)
    if parsed is None:
        return ""
    delta = moment - parsed
    return f"{int(delta.total_seconds() // 86400)}d ago"


def render_orphans_plain(
    rows: Iterable[OrphanRow],
    *,
    repo: str | None,
    now: datetime | None = None,
) -> str:
    rows_list = list(rows)
    lines: list[str] = []
    header = "triage:audit --orphans"
    if repo:
        header += f" -- {repo}"
    lines.append(header)
    lines.append("")
    if not rows_list:
        lines.append("  (no orphans detected -- every open child still has an open umbrella)")
        return "\n".join(lines)
    for row in rows_list:
        age = _human_age(row.sliced_at, now=now)
        age_suffix = f", {age}" if age else ""
        lines.append(
            f"  [ORPHAN] #{row.n}  -- Wave-{row.wave} of #{row.umbrella} "
            f"({row.actor}{age_suffix}) -- status:open umbrella:closed"
        )
    return "\n".join(lines)


def render_orphans_json(
    rows: Iterable[OrphanRow],
    *,
    repo: str | None,
    generated_at: datetime | None = None,
) -> str:
    rows_list = list(rows)
    payload = {
        "generated_at": (generated_at or datetime.now(UTC))
        .astimezone(UTC)
        .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "repo": repo,
        "surface": "orphans",
        "entry_count": len(rows_list),
        "entries": [
            {
                "n": r.n,
                "url": r.url,
                "wave": r.wave,
                "role": r.role,
                "umbrella": r.umbrella,
                "umbrella_url": r.umbrella_url,
                "umbrella_state": r.umbrella_state,
                "slice_id": r.slice_id,
                "sliced_at": r.sliced_at,
                "actor": r.actor,
            }
            for r in rows_list
        ],
    }
    return json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True)


def render_stalled_plain(
    rows: Iterable[StalledCohortRow],
    *,
    repo: str | None,
    days: int,
) -> str:
    rows_list = list(rows)
    lines: list[str] = []
    header = f"triage:audit --slice-stalled --days {days}"
    if repo:
        header += f" -- {repo}"
    lines.append(header)
    lines.append("")
    if not rows_list:
        lines.append("  (no stalled cohorts detected)")
        return "\n".join(lines)
    for row in rows_list:
        prog = ", ".join(f"#{n}" for n in row.progressed_siblings) or "<none>"
        stalled = ", ".join(f"#{n}" for n in row.stalled_siblings) or "<none>"
        lines.append(
            f"  [STALLED] umbrella:#{row.umbrella} slice:{row.slice_id[:8]} "
            f"progressed=[{prog}] stalled=[{stalled}]"
        )
    return "\n".join(lines)


def render_stalled_json(
    rows: Iterable[StalledCohortRow],
    *,
    repo: str | None,
    days: int,
    generated_at: datetime | None = None,
) -> str:
    rows_list = list(rows)
    payload = {
        "generated_at": (generated_at or datetime.now(UTC))
        .astimezone(UTC)
        .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "repo": repo,
        "surface": "slice-stalled",
        "days": days,
        "entry_count": len(rows_list),
        "entries": [
            {
                "slice_id": r.slice_id,
                "umbrella": r.umbrella,
                "umbrella_url": r.umbrella_url,
                "sliced_at": r.sliced_at,
                "progressed_siblings": list(r.progressed_siblings),
                "stalled_siblings": list(r.stalled_siblings),
            }
            for r in rows_list
        ],
    }
    return json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True)


def render_coverage_plain(
    rows: Iterable[CoverageRow],
    *,
    repo: str | None,
    now: datetime | None = None,
) -> str:
    rows_list = list(rows)
    lines: list[str] = []
    header = "triage:audit --slice-coverage"
    if repo:
        header += f" -- {repo}"
    lines.append(header)
    lines.append("")
    if not rows_list:
        lines.append("  (no open-umbrella cohorts found in slices.jsonl)")
        return "\n".join(lines)
    for row in rows_list:
        last_hint = ""
        if row.last_child_activity:
            age = _human_age(row.last_child_activity, now=now)
            if age:
                last_hint = f" (last child activity: {age})"
        lines.append(
            f"  #{row.umbrella}: {row.closed}/{row.total} children merged{last_hint}"
        )
    return "\n".join(lines)


def render_coverage_json(
    rows: Iterable[CoverageRow],
    *,
    repo: str | None,
    generated_at: datetime | None = None,
) -> str:
    rows_list = list(rows)
    payload = {
        "generated_at": (generated_at or datetime.now(UTC))
        .astimezone(UTC)
        .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "repo": repo,
        "surface": "slice-coverage",
        "entry_count": len(rows_list),
        "entries": [
            {
                "slice_id": r.slice_id,
                "umbrella": r.umbrella,
                "umbrella_url": r.umbrella_url,
                "umbrella_state": r.umbrella_state,
                "closed": r.closed,
                "total": r.total,
                "last_child_activity": r.last_child_activity,
            }
            for r in rows_list
        ],
    }
    return json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True)


__all__ = [
    "CoverageRow",
    "OrphanRow",
    "StalledCohortRow",
    "collect_orphan_issue_numbers",
    "compute_coverage",
    "compute_orphans",
    "compute_stalled",
    "load_slice_records",
    "render_coverage_json",
    "render_coverage_plain",
    "render_orphans_json",
    "render_orphans_plain",
    "render_stalled_json",
    "render_stalled_plain",
]
