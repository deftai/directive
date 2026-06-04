"""Tests for scripts/capacity_show.py (#1419 Delivery Slice 4).

Covers the acceptance criteria of the capacity-accounting-engine story:

* a1 -- minSampleSize advisory fallback (fewer classified completions than
  minSampleSize reports advisory mode and defers to ordering).
* a2 -- kind-aware epic counting (undecomposed epic counts estimatedChildren /
  defaultEpicEstimate; a decomposed parent counts 0).
* a4 -- per-bucket target-vs-actual deficit math over the trailing window.
* a5 -- unit:cost guarded fallback to advisory count when grounded actuals are
  insufficient (OQ2).
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from capacity_show import (  # noqa: E402, I001
    COST_COVERAGE_FLOOR,
    compute_report,
    evaluate,
    render_report,
)

NOW = datetime(2026, 6, 4, 12, 0, 0, tzinfo=UTC)


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

LIFECYCLE = ("proposed", "pending", "active", "completed", "cancelled")


def _make_project(
    tmp_path: Path, capacity: dict | None, *, autonomy: dict | None = None
) -> Path:
    """Create a tmp project tree with optional capacityAllocation / autonomy."""
    vbrief = tmp_path / "vbrief"
    for folder in LIFECYCLE:
        (vbrief / folder).mkdir(parents=True, exist_ok=True)
    plan: dict = {"title": "Capacity test", "status": "running", "items": []}
    policy: dict = {}
    if capacity is not None:
        policy["capacityAllocation"] = capacity
    if autonomy is not None:
        policy["autonomy"] = autonomy
    if policy:
        plan["policy"] = policy
    (vbrief / "PROJECT-DEFINITION.vbrief.json").write_text(
        json.dumps({"vBRIEFInfo": {"version": "0.6"}, "plan": plan}),
        encoding="utf-8",
    )
    return tmp_path


def _write_vbrief(
    tmp_path: Path,
    folder: str,
    name: str,
    *,
    status: str,
    metadata: dict | None = None,
    references: list | None = None,
) -> Path:
    plan: dict = {"title": name, "status": status, "items": []}
    if metadata is not None:
        plan["metadata"] = metadata
    if references is not None:
        plan["references"] = references
    path = tmp_path / "vbrief" / folder / f"{name}.vbrief.json"
    path.write_text(
        json.dumps({"vBRIEFInfo": {"version": "0.6"}, "plan": plan}),
        encoding="utf-8",
    )
    return path


def _completed_at(days_ago: int) -> str:
    return (NOW - timedelta(days=days_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _capacity(**overrides: object) -> dict:
    base: dict = {
        "unit": "vbrief-count",
        "window": 30,
        "enforcement": "advise",
        "minSampleSize": 2,
        "defaultBucket": "feature",
        "buckets": [
            {"id": "debt", "target": 0.4},
            {"id": "feature", "target": 0.6},
        ],
    }
    base.update(overrides)
    return base


def _bucket(report, bucket_id):
    for tally in report.buckets:
        if tally.bucket_id == bucket_id:
            return tally
    raise AssertionError(f"bucket {bucket_id!r} not in report")


# ---------------------------------------------------------------------------
# a1 -- minSampleSize advisory fallback
# ---------------------------------------------------------------------------


def test_a1_below_min_sample_size_reports_advisory(tmp_path):
    root = _make_project(tmp_path, _capacity(minSampleSize=5))
    # Only 2 classified completions in window -- below minSampleSize=5.
    for i in range(2):
        _write_vbrief(
            tmp_path,
            "completed",
            f"done-{i}",
            status="completed",
            metadata={"capacityBucket": "feature", "completedAt": _completed_at(1)},
        )
    report = compute_report(root, now=NOW)
    assert report.classified_completions == 2
    assert report.advisory_mode is True
    assert any("minSampleSize" in reason for reason in report.advisory_reasons)
    assert "ADVISORY" in render_report(report)


def test_a1_meets_min_sample_size_not_advisory(tmp_path):
    root = _make_project(tmp_path, _capacity(minSampleSize=2))
    for i in range(2):
        _write_vbrief(
            tmp_path,
            "completed",
            f"done-{i}",
            status="completed",
            metadata={"capacityBucket": "feature", "completedAt": _completed_at(1)},
        )
    report = compute_report(root, now=NOW)
    assert report.classified_completions == 2
    assert report.advisory_mode is False


# ---------------------------------------------------------------------------
# a2 -- kind-aware epic counting
# ---------------------------------------------------------------------------


def test_a2_undecomposed_epic_counts_estimated_children(tmp_path):
    root = _make_project(tmp_path, _capacity())
    _write_vbrief(
        tmp_path,
        "pending",
        "big-epic",
        status="pending",
        metadata={"kind": "epic", "estimatedChildren": 5, "capacityBucket": "debt"},
    )
    report = compute_report(root, now=NOW)
    assert _bucket(report, "debt").forward_weight == 5.0


def test_a2_undecomposed_epic_without_estimate_uses_default(tmp_path):
    root = _make_project(tmp_path, _capacity(defaultEpicEstimate=3))
    _write_vbrief(
        tmp_path,
        "pending",
        "vague-epic",
        status="pending",
        metadata={"kind": "epic", "capacityBucket": "debt"},
    )
    report = compute_report(root, now=NOW)
    assert _bucket(report, "debt").forward_weight == 3.0


def test_a2_decomposed_epic_counts_zero(tmp_path):
    root = _make_project(tmp_path, _capacity())
    _write_vbrief(
        tmp_path,
        "pending",
        "parent-epic",
        status="pending",
        metadata={"kind": "epic", "estimatedChildren": 9, "capacityBucket": "debt"},
        references=[
            {"uri": "active/child.vbrief.json", "type": "x-vbrief/plan", "title": "child"}
        ],
    )
    report = compute_report(root, now=NOW)
    # A decomposed parent contributes 0 -- its children are counted directly.
    assert _bucket(report, "debt").forward_weight == 0.0


def test_a2_story_counts_one(tmp_path):
    root = _make_project(tmp_path, _capacity())
    _write_vbrief(
        tmp_path,
        "active",
        "a-story",
        status="running",
        metadata={"kind": "story", "capacityBucket": "feature"},
    )
    report = compute_report(root, now=NOW)
    assert _bucket(report, "feature").forward_weight == 1.0


# ---------------------------------------------------------------------------
# a4 -- per-bucket target-vs-actual deficit math
# ---------------------------------------------------------------------------


def test_a4_renders_per_bucket_deficits(tmp_path):
    root = _make_project(tmp_path, _capacity(minSampleSize=2))
    # 4 feature completions in window, 0 debt -- debt is starved.
    for i in range(4):
        _write_vbrief(
            tmp_path,
            "completed",
            f"feat-{i}",
            status="completed",
            metadata={"capacityBucket": "feature", "completedAt": _completed_at(2)},
        )
    report = compute_report(root, now=NOW)
    assert report.total_backward == 4.0
    assert report.advisory_mode is False
    # debt target 0.4 * 4 = 1.6 expected, 0 actual -> deficit +1.6 (starved).
    assert report.bucket_deficit(_bucket(report, "debt")) == 1.6
    # feature target 0.6 * 4 = 2.4 expected, 4 actual -> deficit -1.6 (over).
    assert report.bucket_deficit(_bucket(report, "feature")) == -1.6


def test_a4_completion_outside_window_excluded(tmp_path):
    root = _make_project(tmp_path, _capacity(window=30, minSampleSize=1))
    _write_vbrief(
        tmp_path,
        "completed",
        "recent",
        status="completed",
        metadata={"capacityBucket": "feature", "completedAt": _completed_at(5)},
    )
    _write_vbrief(
        tmp_path,
        "completed",
        "stale",
        status="completed",
        metadata={"capacityBucket": "feature", "completedAt": _completed_at(120)},
    )
    report = compute_report(root, now=NOW)
    # Only the in-window completion counts toward the backward view.
    assert report.classified_completions == 1
    assert report.total_backward == 1.0


# ---------------------------------------------------------------------------
# a5 -- unit:cost guarded fallback (OQ2)
# ---------------------------------------------------------------------------


def test_a5_cost_without_actuals_falls_back_to_count(tmp_path):
    root = _make_project(tmp_path, _capacity(unit="cost", minSampleSize=1))
    for i in range(3):
        _write_vbrief(
            tmp_path,
            "completed",
            f"nocost-{i}",
            status="completed",
            metadata={"capacityBucket": "feature", "completedAt": _completed_at(1)},
        )
    report = compute_report(root, now=NOW)
    assert report.unit_requested == "cost"
    assert report.unit_effective == "vbrief-count"
    assert report.cost_fallback is True
    assert any("unit:cost" in reason for reason in report.advisory_reasons)
    rendered = render_report(report)
    assert "none/estimate-only" in rendered


def test_a5_cost_below_coverage_floor_falls_back(tmp_path):
    root = _make_project(tmp_path, _capacity(unit="cost", minSampleSize=1))
    # 1 of 4 carries a grounded cost actual -> 25% coverage < floor.
    _write_vbrief(
        tmp_path,
        "completed",
        "withcost",
        status="completed",
        metadata={
            "capacityBucket": "feature",
            "completedAt": _completed_at(1),
            "cost": 12.5,
        },
    )
    for i in range(3):
        _write_vbrief(
            tmp_path,
            "completed",
            f"nocost-{i}",
            status="completed",
            metadata={"capacityBucket": "feature", "completedAt": _completed_at(1)},
        )
    report = compute_report(root, now=NOW)
    assert COST_COVERAGE_FLOOR == 0.5
    assert report.cost_fallback is True
    assert report.unit_effective == "vbrief-count"


def test_a5_cost_with_full_coverage_uses_cost(tmp_path):
    root = _make_project(tmp_path, _capacity(unit="cost", minSampleSize=1))
    for i in range(2):
        _write_vbrief(
            tmp_path,
            "completed",
            f"costed-{i}",
            status="completed",
            metadata={
                "capacityBucket": "feature",
                "completedAt": _completed_at(1),
                "cost": 10.0,
            },
        )
    report = compute_report(root, now=NOW)
    assert report.cost_fallback is False
    assert report.unit_effective == "cost"
    assert _bucket(report, "feature").cost_actual == 20.0


# ---------------------------------------------------------------------------
# Unconfigured + CLI evaluate
# ---------------------------------------------------------------------------


def test_malformed_policy_error_is_rendered(tmp_path):
    # Targets do not sum to 1.0 -> resolver source 'default-on-error' with an
    # error message that render_report must surface as a CONFIG ERROR line.
    root = _make_project(
        tmp_path,
        _capacity(
            buckets=[{"id": "debt", "target": 0.4}, {"id": "feature", "target": 0.3}]
        ),
    )
    report = compute_report(root, now=NOW)
    assert report.source == "default-on-error"
    assert report.policy_error is not None
    rendered = render_report(report)
    assert "CONFIG ERROR" in rendered


def test_unconfigured_project_reports_advisory(tmp_path):
    root = _make_project(tmp_path, None)
    _write_vbrief(
        tmp_path,
        "active",
        "lonely",
        status="running",
        metadata={"kind": "story"},
    )
    report = compute_report(root, now=NOW)
    assert report.configured is False
    assert report.advisory_mode is True


def test_evaluate_valid_root_exits_zero(tmp_path):
    root = _make_project(tmp_path, _capacity())
    code, report, message = evaluate(root, now=NOW)
    assert code == 0
    assert report is not None
    assert "Capacity allocation" in message


def test_evaluate_invalid_root_exits_two(tmp_path):
    missing = tmp_path / "does-not-exist"
    code, report, message = evaluate(missing, now=NOW)
    assert code == 2
    assert report is None
    assert "not a directory" in message


# ---------------------------------------------------------------------------
# Slice 5 -- pending-human-decisions backlog surface + nudge (#1419)
# ---------------------------------------------------------------------------

import policy as policy_mod  # noqa: E402  (after sys.path tweak above)


def _seed_decisions(
    root: Path,
    *,
    pending: int = 0,
    resolved_clean: int = 0,
    resolved_override: int = 0,
    p0_reversal: bool = False,
    now=NOW,
) -> None:
    """Seed the pending-decisions audit log with synthetic events."""
    for i in range(pending):
        policy_mod.record_pending_decision(
            root, decision_id=f"pend-{i}", kind="judgment-gate", now=now
        )
    for i in range(resolved_clean):
        did = f"clean-{i}"
        policy_mod.record_pending_decision(
            root, decision_id=did, kind="judgment-gate", now=now
        )
        policy_mod.resolve_pending_decision(
            root, decision_id=did, override=False, now=now
        )
    for i in range(resolved_override):
        did = f"ovr-{i}"
        policy_mod.record_pending_decision(
            root, decision_id=did, kind="judgment-gate", now=now
        )
        policy_mod.resolve_pending_decision(
            root,
            decision_id=did,
            override=True,
            p0_reversal=(p0_reversal and i == 0),
            now=now,
        )


def test_backlog_count_surfaced_in_report(tmp_path):
    root = _make_project(tmp_path, _capacity())
    _seed_decisions(root, pending=3)
    report = compute_report(root, now=NOW)
    assert report.pending_decisions == 3
    assert report.pending_by_kind == {"judgment-gate": 3}
    rendered = render_report(report)
    assert "Pending human decisions: 3" in rendered


def test_backlog_nudge_fires_over_threshold(tmp_path):
    root = _make_project(tmp_path, _capacity())
    # 6 pending > default threshold (5) -> Tier-1 nudge.
    _seed_decisions(root, pending=6)
    report = compute_report(root, now=NOW)
    assert report.pending_decisions == 6
    assert report.pending_nudge != ""
    rendered = render_report(report)
    assert "[TIER-1]" in rendered


def test_backlog_no_nudge_under_threshold(tmp_path):
    root = _make_project(tmp_path, _capacity())
    _seed_decisions(root, pending=2)
    report = compute_report(root, now=NOW)
    assert report.pending_nudge == ""
    assert "[TIER-1]" not in render_report(report)


# ---------------------------------------------------------------------------
# Slice 5 -- earned-autonomy dial ratchet on synthetic override-rate fixtures
# ---------------------------------------------------------------------------


def test_autonomy_advances_on_low_override_window(tmp_path):
    # minSampleSize lowered so a small synthetic sample can exercise advance.
    root = _make_project(tmp_path, _capacity(), autonomy={"minSampleSize": 2})
    _seed_decisions(root, resolved_clean=3)  # override rate 0%, no rework
    report = compute_report(root, now=NOW)
    assert report.autonomy is not None
    assert report.autonomy.action == "advance"
    assert report.autonomy.recommended_level == "execute"
    assert report.autonomy.reduces_required_clearances is True


def test_autonomy_retreats_on_high_override_window(tmp_path):
    root = _make_project(tmp_path, _capacity(), autonomy={"minSampleSize": 2})
    # 3 resolved decisions, all overridden -> 100% override > 20% retreat floor.
    _seed_decisions(root, resolved_override=3)
    report = compute_report(root, now=NOW)
    assert report.autonomy is not None
    assert report.autonomy.action == "retreat"
    assert report.autonomy.recommended_level == "observe"
    assert report.autonomy.restores_required_clearances is True


def test_autonomy_retreats_on_rework_spike(tmp_path):
    # Low override but a rework spike in the capacity window restores clearances.
    root = _make_project(
        tmp_path, _capacity(minSampleSize=1), autonomy={"minSampleSize": 2}
    )
    # One clean resolved decision (override 0%) so advance is not blocked by
    # the override signal -- the rework guardrail is what withholds advance.
    _seed_decisions(root, resolved_clean=3)
    # 2 completed-in-window vBRIEFs, both rework -> rework rate 100% > baseline.
    for i in range(2):
        _write_vbrief(
            tmp_path,
            "completed",
            f"rw-{i}",
            status="completed",
            metadata={
                "capacityBucket": "feature",
                "completedAt": _completed_at(1),
                "rework": True,
            },
        )
    report = compute_report(root, now=NOW)
    # Rework guardrail withholds the advance -> hold (not advance).
    assert report.autonomy is not None
    assert report.autonomy.action == "hold"


def test_autonomy_is_advisory_only_and_does_not_mutate_state(tmp_path):
    root = _make_project(tmp_path, _capacity(), autonomy={"minSampleSize": 2})
    _seed_decisions(root, resolved_clean=3)
    pd_path = root / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    before = pd_path.read_text(encoding="utf-8")
    report = compute_report(root, now=NOW)
    after = pd_path.read_text(encoding="utf-8")
    # An advance is recommended, but the dial is advisory-only: nothing is
    # ratcheted, no required clearances reduced, PROJECT-DEFINITION untouched.
    assert report.autonomy is not None
    assert report.autonomy.action == "advance"
    assert report.autonomy.advisory is True
    assert before == after
    # The resolved policy default level is unchanged (no auto-ratchet persisted).
    assert policy_mod.resolve_autonomy(root).default_level == "escalate"


def test_autonomy_line_rendered(tmp_path):
    root = _make_project(tmp_path, _capacity())
    rendered = render_report(compute_report(root, now=NOW))
    assert "Autonomy dial (advisory-only):" in rendered


def test_autonomy_disabled_suppresses_dial(tmp_path):
    # autonomy.enabled=false -> no recommendation computed and no dial line.
    root = _make_project(
        tmp_path,
        _capacity(),
        autonomy={"enabled": False, "minSampleSize": 2},
    )
    _seed_decisions(root, resolved_clean=3)
    report = compute_report(root, now=NOW)
    assert report.autonomy_enabled is False
    assert report.autonomy is None
    assert "Autonomy dial (advisory-only):" not in render_report(report)
