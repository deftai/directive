#!/usr/bin/env python3
"""capacity_show.py -- offline capacity-allocation accounting (#1419 Slice 4).

Surfaced via ``task capacity:show``. Derives per-bucket tallies directly from
the vBRIEF lifecycle folders (``vbrief/{proposed,pending,active,completed,
cancelled}/``) -- filesystem-truth, fully offline, no ``gh`` / network calls.

What it reports
---------------
For every protected bucket declared in
``plan.policy.capacityAllocation.buckets`` (see ``scripts/policy.py``):

* **Forward view** -- the in-flight mix: summed kind-aware weight of
  ``pending/`` + ``active/`` vBRIEFs in the bucket.
* **Backward view** -- the trailing-window mix: summed weight of ``completed/``
  vBRIEFs whose ``plan.metadata.completedAt`` falls inside the configured
  ``window`` (days). The backward view drives the target-vs-actual *deficit*
  column (acceptance a4).
* **Outcome (rework) overlay** -- weight of completed-in-window vBRIEFs flagged
  as rework (``plan.metadata.outcome == "rework"`` or
  ``plan.metadata.rework == true``).
* **Cost overlay** -- summed grounded cost actuals (``plan.metadata.cost``) of
  completed-in-window vBRIEFs; rendered ``none/estimate-only`` when no grounded
  actuals exist.

Kind-aware counting (acceptance a2)
-----------------------------------
* ``kind == "story"`` (or unset) counts its own weight (1).
* An ``epic`` / ``phase`` that HAS children on disk (a ``plan.references[]``
  entry of ``type == "x-vbrief/plan"``) counts 0 -- its children are counted
  directly.
* An UNDECOMPOSED ``epic`` / ``phase`` (no child references) counts its
  ``plan.metadata.estimatedChildren`` (or the policy ``defaultEpicEstimate``,
  framework default 3).

Advisory guards
---------------
* **minSampleSize (acceptance a1)** -- when the number of classified
  completions in the window is below ``minSampleSize``, the engine reports
  advisory mode and defers to ordering (the deficit numbers are still printed
  but flagged as not yet load-bearing).
* **unit:cost guarded fallback (acceptance a5 / OQ2)** -- ``unit == "cost"`` is
  selectable but self-guards: when grounded cost actuals are insufficient
  (coverage below :data:`COST_COVERAGE_FLOOR`), the engine falls back to the
  advisory ``vbrief-count`` unit and warns; the cost overlay renders
  ``none/estimate-only``. The cost-sync telemetry itself is out of scope /
  upstream-blocked.

This surface is ADVISORY: it always exits 0. The companion three-state gate
``scripts/verify_capacity.py`` (``task verify:capacity``) is where an opt-in
``enforce`` posture can surface a non-zero exit.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

# Make sibling helpers importable both as __main__ and when imported by tests.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _stdio_utf8 import reconfigure_stdio  # noqa: E402
from policy import (  # noqa: E402, I001
    CAPACITY_UNIT_COST,
    DEFAULT_CAPACITY_UNIT,
    DEFAULT_PENDING_DECISIONS_THRESHOLD,
    AutonomyRecommendation,
    CapacityAllocation,
    pending_decisions_nudge_line,
    recommend_autonomy_level,
    resolve_autonomy,
    resolve_capacity_allocation,
    summarize_decision_backlog,
)

reconfigure_stdio()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Lifecycle folders that contribute to the FORWARD (in-flight) view.
FORWARD_FOLDERS: tuple[str, ...] = ("pending", "active")

#: Lifecycle folder that contributes to the BACKWARD (trailing-window) view.
BACKWARD_FOLDER: str = "completed"

#: Bucket label used when a vBRIEF carries no explicit ``capacityBucket`` and
#: the policy declares no ``defaultBucket``.
UNASSIGNED_BUCKET: str = "unassigned"

#: Minimum fraction of classified completions that must carry a positive cost
#: actual before ``unit:cost`` is treated as grounded. Below this the engine
#: falls back to advisory ``vbrief-count`` (acceptance a5 / OQ2).
COST_COVERAGE_FLOOR: float = 0.5

#: Kinds treated as parents whose undecomposed estimate is counted (a2).
_PARENT_KINDS: frozenset[str] = frozenset({"epic", "phase"})


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VbriefRecord:
    """One vBRIEF's capacity-relevant facts, derived from disk."""

    bucket: str
    kind: str
    weight: float
    folder: str
    classified: bool  # carried an explicit capacityBucket
    in_window: bool  # completed within the trailing window (backward only)
    completed_at_present: bool  # a non-empty completedAt string is on disk
    is_rework: bool
    cost: float | None


@dataclass
class BucketTally:
    """Per-bucket forward/backward/rework/cost rollup."""

    bucket_id: str
    target: float
    forward_weight: float = 0.0
    backward_weight: float = 0.0
    rework_weight: float = 0.0
    cost_actual: float | None = None


@dataclass
class CapacityReport:
    """Computed capacity report -- the testable core of ``capacity:show``."""

    configured: bool
    source: str
    unit_requested: str
    unit_effective: str
    cost_fallback: bool
    cost_fallback_reason: str | None
    window_days: int
    min_sample_size: int
    classified_completions: int
    unclassified_completions: int
    advisory_mode: bool
    advisory_reasons: list[str] = field(default_factory=list)
    buckets: list[BucketTally] = field(default_factory=list)
    total_forward: float = 0.0
    total_backward: float = 0.0
    policy_error: str | None = None
    # Pending human-clearance backlog + earned-autonomy dial (#1419 Slice 5).
    pending_decisions: int = 0
    pending_decisions_threshold: int = DEFAULT_PENDING_DECISIONS_THRESHOLD
    pending_by_kind: dict[str, int] = field(default_factory=dict)
    pending_nudge: str = ""
    autonomy_enabled: bool = True
    autonomy: AutonomyRecommendation | None = None

    def bucket_deficit(self, tally: BucketTally) -> float:
        """Backward target-vs-actual deficit (positive == under target).

        ``deficit = target_fraction * total_backward - backward_weight``. A
        positive value means the bucket received LESS than its target share of
        the trailing window's completed work -- i.e. it is being starved.
        """
        target_weight = tally.target * self.total_backward
        return round(target_weight - tally.backward_weight, 4)


# ---------------------------------------------------------------------------
# Derivation helpers
# ---------------------------------------------------------------------------


def _parse_iso(value: object) -> datetime | None:
    """Parse an ISO-8601 ``...Z`` timestamp to an aware datetime, or None."""
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed


def _plan_has_children(plan: dict) -> bool:
    """True when the plan declares an ``x-vbrief/plan`` child reference."""
    refs = plan.get("references")
    if not isinstance(refs, list):
        return False
    return any(
        isinstance(ref, dict) and ref.get("type") == "x-vbrief/plan"
        for ref in refs
    )


def _coerce_cost(value: object) -> float | None:
    """Return a positive numeric cost actual, or None when absent/invalid."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float) and value > 0:
        return float(value)
    return None


def classify_record(
    plan: dict,
    folder: str,
    allocation: CapacityAllocation,
    now: datetime,
) -> VbriefRecord:
    """Derive a :class:`VbriefRecord` from a single vBRIEF ``plan`` block."""
    metadata = plan.get("metadata") if isinstance(plan.get("metadata"), dict) else {}
    kind_raw = metadata.get("kind")
    kind = kind_raw if isinstance(kind_raw, str) and kind_raw else "story"

    explicit_bucket = metadata.get("capacityBucket")
    classified = isinstance(explicit_bucket, str) and bool(explicit_bucket.strip())
    if classified:
        bucket = explicit_bucket.strip()
    elif allocation.default_bucket:
        bucket = allocation.default_bucket
    else:
        bucket = UNASSIGNED_BUCKET

    weight = _record_weight(kind, plan, metadata, allocation)

    in_window = False
    # Mirror capacity_backfill's ``has_completed_at`` semantics: a non-empty
    # string counts as present even if it does not parse (backfill preserves it
    # and never re-stamps, so such an item can never enter the window).
    raw_completed_at = metadata.get("completedAt")
    completed_at_present = isinstance(raw_completed_at, str) and bool(
        raw_completed_at.strip()
    )
    if folder == BACKWARD_FOLDER:
        completed_at = _parse_iso(raw_completed_at)
        if completed_at is not None:
            age_days = (now - completed_at).total_seconds() / 86400.0
            in_window = 0 <= age_days <= allocation.window_days

    outcome = metadata.get("outcome")
    is_rework = (isinstance(outcome, str) and outcome.lower() == "rework") or (
        metadata.get("rework") is True
    )

    return VbriefRecord(
        bucket=bucket,
        kind=kind,
        weight=weight,
        folder=folder,
        classified=classified,
        in_window=in_window,
        completed_at_present=completed_at_present,
        is_rework=is_rework,
        cost=_coerce_cost(metadata.get("cost")),
    )


def _record_weight(
    kind: str, plan: dict, metadata: dict, allocation: CapacityAllocation
) -> float:
    """Kind-aware weight for one vBRIEF (acceptance a2)."""
    if kind in _PARENT_KINDS:
        if _plan_has_children(plan):
            # Decomposed parent -- children are counted directly.
            return 0.0
        # Undecomposed epic/phase -- count its estimated children.
        estimated = metadata.get("estimatedChildren")
        if isinstance(estimated, int) and not isinstance(estimated, bool) and estimated > 0:
            return float(estimated)
        return float(allocation.default_epic_estimate)
    # Stories (and any unknown kind) count their own single weight.
    return 1.0


def iter_vbrief_plans(vbrief_root: Path) -> list[tuple[str, dict]]:
    """Yield ``(folder, plan)`` for every readable vBRIEF in the lifecycle dirs.

    Unreadable / malformed files are skipped (offline accounting is
    best-effort over filesystem-truth, not a validator).
    """
    import json

    out: list[tuple[str, dict]] = []
    for folder in (*FORWARD_FOLDERS, BACKWARD_FOLDER):
        folder_path = vbrief_root / folder
        if not folder_path.is_dir():
            continue
        for child in sorted(folder_path.iterdir()):
            if not (child.is_file() and child.name.endswith(".vbrief.json")):
                continue
            try:
                data = json.loads(child.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            plan = data.get("plan") if isinstance(data, dict) else None
            if isinstance(plan, dict):
                out.append((folder, plan))
    return out


# ---------------------------------------------------------------------------
# Report computation
# ---------------------------------------------------------------------------


def compute_report(
    project_root: Path,
    *,
    now: datetime | None = None,
    allocation: CapacityAllocation | None = None,
) -> CapacityReport:
    """Compute the :class:`CapacityReport` for *project_root* (offline)."""
    now = now or datetime.now(UTC)
    allocation = allocation or resolve_capacity_allocation(project_root)
    vbrief_root = project_root / "vbrief"

    records = [
        classify_record(plan, folder, allocation, now)
        for folder, plan in iter_vbrief_plans(vbrief_root)
    ]

    # Seed tallies from the configured buckets (preserving declaration order),
    # then add any extra buckets discovered on disk (sorted) so unassigned /
    # mis-tagged work is still visible.
    tallies: dict[str, BucketTally] = {}
    for bucket in allocation.buckets:
        tallies[bucket.bucket_id] = BucketTally(
            bucket_id=bucket.bucket_id, target=bucket.target
        )
    for record in records:
        if record.bucket not in tallies:
            tallies[record.bucket] = BucketTally(bucket_id=record.bucket, target=0.0)

    classified_completions = 0
    # Completed vBRIEFs that carry no explicit capacityBucket AND that a backfill
    # could actually pull into the window-scoped classified set (#1606). An
    # unclassified completion with an explicit completedAt OUTSIDE the trailing
    # window is EXCLUDED: backfill would stamp its bucket but leave completedAt
    # out of window, so classified_completions never rises and advisory mode
    # would persist silently -- promising such a migration is misleading. An
    # absent completedAt is included: backfill stamps the git landing time,
    # which may land in window. A positive count while sample-short means
    # `task capacity:backfill` can classify history and cross minSampleSize.
    unclassified_completions = sum(
        1
        for record in records
        if record.folder == BACKWARD_FOLDER
        and not record.classified
        and (record.in_window or not record.completed_at_present)
    )
    cost_eligible = 0  # classified completions in window
    cost_with_actual = 0
    for record in records:
        tally = tallies[record.bucket]
        if record.folder in FORWARD_FOLDERS:
            tally.forward_weight += record.weight
        elif record.folder == BACKWARD_FOLDER and record.in_window:
            tally.backward_weight += record.weight
            if record.is_rework:
                tally.rework_weight += record.weight
            if record.classified:
                classified_completions += 1
                cost_eligible += 1
                if record.cost is not None:
                    cost_with_actual += 1
                    tally.cost_actual = (tally.cost_actual or 0.0) + record.cost

    total_forward = sum(t.forward_weight for t in tallies.values())
    total_backward = sum(t.backward_weight for t in tallies.values())
    total_rework = sum(t.rework_weight for t in tallies.values())

    # Bucket ordering: configured buckets first (declaration order), then
    # discovered extras alphabetically for deterministic output.
    configured_ids = [b.bucket_id for b in allocation.buckets]
    extras = sorted(bid for bid in tallies if bid not in configured_ids)
    ordered = [tallies[bid] for bid in (*configured_ids, *extras)]

    unit_requested = allocation.unit if allocation.unit in {
        DEFAULT_CAPACITY_UNIT,
        CAPACITY_UNIT_COST,
    } else DEFAULT_CAPACITY_UNIT
    unit_effective, cost_fallback, cost_reason = _resolve_effective_unit(
        unit_requested, cost_eligible, cost_with_actual
    )

    advisory_reasons: list[str] = []
    if not allocation.configured:
        advisory_reasons.append(
            "capacityAllocation not configured -- showing discovered buckets only"
        )
    sample_short = classified_completions < allocation.min_sample_size
    if sample_short:
        advisory_reasons.append(
            f"only {classified_completions} classified completion(s) in window "
            f"(< minSampleSize={allocation.min_sample_size}) -- deferring to ordering"
        )
        # Actionable discoverability hint (#1606): when buckets ARE configured
        # but completed history is unclassified, point the operator at the
        # one-time backfill that crosses minSampleSize.
        if allocation.configured and unclassified_completions > 0:
            advisory_reasons.append(
                f"{unclassified_completions} completed vBRIEF(s) are unclassified "
                "-- run `task capacity:backfill --apply` (one-time) to classify "
                "history and activate capacity accounting"
            )
    if cost_fallback and cost_reason:
        advisory_reasons.append(cost_reason)

    # Pending human-clearance backlog + earned-autonomy dial (#1419 Slice 5).
    # The backlog count is derived from the durable audit log; the autonomy
    # dial is computed from the override rate (primary) + rework rate
    # (guardrail) over the SAME trailing window and is ADVISORY-ONLY -- the
    # recommendation is surfaced, never auto-applied.
    backlog = summarize_decision_backlog(
        project_root, now=now, window_days=allocation.window_days
    )
    rework_rate = total_rework / total_backward if total_backward > 0 else 0.0
    autonomy_policy = resolve_autonomy(project_root)
    # Honour the enabled flag: a project that sets autonomy.enabled=false gets
    # no dial recommendation at all (autonomy stays None), so the render guard
    # below suppresses the line. Default policy is enabled.
    autonomy = (
        recommend_autonomy_level(
            autonomy_policy.default_level,
            override_rate=backlog.override_rate,
            rework_rate=rework_rate,
            sample_size=backlog.resolved_in_window,
            p0_reversal=backlog.p0_reversal_in_window,
            policy=autonomy_policy,
        )
        if autonomy_policy.enabled
        else None
    )
    pending_nudge = pending_decisions_nudge_line(backlog.pending_count)

    return CapacityReport(
        configured=allocation.configured,
        source=allocation.source,
        unit_requested=unit_requested,
        unit_effective=unit_effective,
        cost_fallback=cost_fallback,
        cost_fallback_reason=cost_reason,
        window_days=allocation.window_days,
        min_sample_size=allocation.min_sample_size,
        classified_completions=classified_completions,
        unclassified_completions=unclassified_completions,
        advisory_mode=sample_short or not allocation.configured,
        advisory_reasons=advisory_reasons,
        buckets=ordered,
        total_forward=total_forward,
        total_backward=total_backward,
        policy_error=allocation.error,
        pending_decisions=backlog.pending_count,
        pending_by_kind=dict(backlog.by_kind),
        pending_nudge=pending_nudge,
        autonomy_enabled=autonomy_policy.enabled,
        autonomy=autonomy,
    )


def _resolve_effective_unit(
    unit_requested: str, cost_eligible: int, cost_with_actual: int
) -> tuple[str, bool, str | None]:
    """Apply the unit:cost guarded fallback (acceptance a5 / OQ2).

    Returns ``(unit_effective, cost_fallback, reason)``. ``cost`` falls back to
    advisory ``vbrief-count`` when grounded actuals are insufficient (no
    eligible completions, or coverage below :data:`COST_COVERAGE_FLOOR`).
    """
    if unit_requested != CAPACITY_UNIT_COST:
        return unit_requested, False, None
    if cost_eligible == 0:
        return (
            DEFAULT_CAPACITY_UNIT,
            True,
            "unit:cost requested but no classified completions carry grounded "
            "cost actuals -- falling back to advisory vbrief-count "
            "(cost overlay: none/estimate-only)",
        )
    coverage = cost_with_actual / cost_eligible
    if coverage < COST_COVERAGE_FLOOR:
        return (
            DEFAULT_CAPACITY_UNIT,
            True,
            f"unit:cost requested but only {cost_with_actual}/{cost_eligible} "
            f"({coverage:.0%}) classified completions carry grounded cost "
            f"actuals (< {COST_COVERAGE_FLOOR:.0%} floor) -- falling back to "
            "advisory vbrief-count (cost overlay: none/estimate-only)",
        )
    return CAPACITY_UNIT_COST, False, None


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def _format_cost(value: float | None) -> str:
    """Render the cost-overlay cell."""
    if value is None:
        return "none/estimate-only"
    return f"{value:.2f}"


def _append_backlog_and_autonomy(lines: list[str], report: CapacityReport) -> None:
    """Append the pending-decisions backlog + advisory autonomy block (#1419 S5)."""
    lines.append(
        f"  Pending human decisions: {report.pending_decisions} "
        f"(threshold {report.pending_decisions_threshold})"
    )
    if report.pending_by_kind:
        kinds = ", ".join(
            f"{kind}={count}"
            for kind, count in sorted(report.pending_by_kind.items())
        )
        lines.append(f"    by kind: {kinds}")
    if report.pending_nudge:
        lines.append(f"  {report.pending_nudge}")
    if report.autonomy_enabled and report.autonomy is not None:
        rec = report.autonomy
        lines.append(
            f"  Autonomy dial (advisory-only): {rec.current_level} -> "
            f"{rec.recommended_level} [{rec.action}]"
        )
        lines.append(f"    {rec.rationale}")


def render_report(report: CapacityReport) -> str:
    """Render the :class:`CapacityReport` as a human-readable text block."""
    lines: list[str] = []
    lines.append("Capacity allocation (advisory, offline / filesystem-truth)")
    lines.append(
        f"  unit: {report.unit_effective}"
        + (
            f" (requested {report.unit_requested}; cost fallback active)"
            if report.cost_fallback
            else ""
        )
    )
    lines.append(
        f"  window: trailing {report.window_days}d | "
        f"classified completions: {report.classified_completions} "
        f"(minSampleSize {report.min_sample_size}) | source: {report.source}"
    )
    # Surface the schema error when a malformed capacityAllocation block fell
    # back to defaults (source == 'default-on-error') so the operator sees the
    # actual reason, not just a generic "not configured" advisory line.
    if report.policy_error:
        lines.append(f"  CONFIG ERROR: {report.policy_error}")

    if report.advisory_mode:
        lines.append("  MODE: ADVISORY -- deferring to selection ordering.")
    for reason in report.advisory_reasons:
        lines.append(f"    - {reason}")

    _append_backlog_and_autonomy(lines, report)

    if not report.buckets:
        lines.append("  (no buckets configured and no classified work on disk)")
        return "\n".join(lines)

    header = (
        f"  {'bucket':<16} {'target':>7} {'fwd':>7} {'back':>7} "
        f"{'deficit':>8} {'rework':>7} {'cost':>18}"
    )
    lines.append(header)
    lines.append("  " + "-" * (len(header) - 2))
    for tally in report.buckets:
        deficit = report.bucket_deficit(tally)
        lines.append(
            f"  {tally.bucket_id:<16} "
            f"{tally.target * 100:>6.1f}% "
            f"{tally.forward_weight:>7.1f} "
            f"{tally.backward_weight:>7.1f} "
            f"{deficit:>+8.2f} "
            f"{tally.rework_weight:>7.1f} "
            f"{_format_cost(tally.cost_actual):>18}"
        )
    lines.append(
        f"  {'TOTAL':<16} {'':>7} {report.total_forward:>7.1f} "
        f"{report.total_backward:>7.1f}"
    )
    if report.cost_fallback:
        lines.append(
            "  Note: cost overlay shows none/estimate-only -- no grounded cost "
            "telemetry (out of scope / upstream-blocked, OQ2)."
        )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def evaluate(
    project_root: Path, *, now: datetime | None = None
) -> tuple[int, CapacityReport | None, str]:
    """Pure entry point: returns ``(exit_code, report, rendered_text)``.

    ``capacity:show`` is a display surface, so the exit code is always 0 on a
    valid project root; only an invalid ``--project-root`` yields exit 2.
    """
    if not project_root.is_dir():
        return 2, None, (
            f"capacity_show: --project-root is not a directory: {project_root}\n"
            "  Recovery: pass an existing project root."
        )
    report = compute_report(project_root, now=now)
    return 0, report, render_report(report)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="capacity_show.py",
        description=(
            "Offline capacity-allocation accounting (#1419 Slice 4). Derives "
            "per-bucket target-vs-actual mix from the vBRIEF lifecycle folders "
            "with outcome (rework) and cost overlays. Advisory -- always exits 0 "
            "on a valid project root."
        ),
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help="Project root path (default: current working directory).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    project_root = Path(args.project_root).resolve()
    code, _report, message = evaluate(project_root)
    if code == 0:
        print(message)
    else:
        print(message, file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
