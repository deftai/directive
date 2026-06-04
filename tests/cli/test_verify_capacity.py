"""Tests for scripts/verify_capacity.py (#1419 Delivery Slice 4).

The gate is ADVISORY by construction: in the default ``advise`` posture it
ALWAYS exits 0, so it can never fail-closed on the framework's own tree (it is
deliberately absent from the ``task check`` aggregate). The non-zero deficit
exit (1) only fires under an explicit ``enforce`` posture with a load-bearing
sample; config errors exit 2.
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from verify_capacity import evaluate  # noqa: E402, I001

NOW = datetime(2026, 6, 4, 12, 0, 0, tzinfo=UTC)
LIFECYCLE = ("proposed", "pending", "active", "completed", "cancelled")


def _make_project(tmp_path: Path, capacity: dict | None) -> Path:
    vbrief = tmp_path / "vbrief"
    for folder in LIFECYCLE:
        (vbrief / folder).mkdir(parents=True, exist_ok=True)
    plan: dict = {"title": "Capacity gate test", "status": "running", "items": []}
    if capacity is not None:
        plan["policy"] = {"capacityAllocation": capacity}
    (vbrief / "PROJECT-DEFINITION.vbrief.json").write_text(
        json.dumps({"vBRIEFInfo": {"version": "0.6"}, "plan": plan}),
        encoding="utf-8",
    )
    return tmp_path


def _completed_feature(tmp_path: Path, n: int) -> None:
    completed_at = (NOW - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    for i in range(n):
        plan = {
            "title": f"feat-{i}",
            "status": "completed",
            "items": [],
            "metadata": {"capacityBucket": "feature", "completedAt": completed_at},
        }
        path = tmp_path / "vbrief" / "completed" / f"feat-{i}.vbrief.json"
        path.write_text(
            json.dumps({"vBRIEFInfo": {"version": "0.6"}, "plan": plan}),
            encoding="utf-8",
        )


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


def test_advise_posture_exits_zero_even_with_deficit(tmp_path):
    # debt is fully starved (0 of 4) but advise posture never fails closed.
    root = _make_project(tmp_path, _capacity(enforcement="advise", minSampleSize=2))
    _completed_feature(tmp_path, 4)
    code, message = evaluate(root, now=NOW)
    assert code == 0
    assert "advisory posture" in message


def test_enforce_with_sampled_deficit_exits_one(tmp_path):
    root = _make_project(tmp_path, _capacity(enforcement="enforce", minSampleSize=2))
    _completed_feature(tmp_path, 4)  # debt deficit = 0.4*4 = 1.6 > tolerance 1.0
    code, message = evaluate(root, now=NOW)
    assert code == 1
    assert "DEFICIT" in message
    assert "debt" in message


def test_enforce_below_sample_stays_advisory(tmp_path):
    root = _make_project(tmp_path, _capacity(enforcement="enforce", minSampleSize=10))
    _completed_feature(tmp_path, 4)  # only 4 classified < minSampleSize 10
    code, message = evaluate(root, now=NOW)
    assert code == 0
    assert "below minSampleSize" in message


def test_enforce_within_tolerance_exits_zero(tmp_path):
    # Balanced mix: 2 debt + 3 feature over 5 completions ~ matches 0.4/0.6.
    root = _make_project(tmp_path, _capacity(enforcement="enforce", minSampleSize=2))
    completed_at = (NOW - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    layout = [("debt", 2), ("feature", 3)]
    for bucket, count in layout:
        for i in range(count):
            plan = {
                "title": f"{bucket}-{i}",
                "status": "completed",
                "items": [],
                "metadata": {"capacityBucket": bucket, "completedAt": completed_at},
            }
            path = tmp_path / "vbrief" / "completed" / f"{bucket}-{i}.vbrief.json"
            path.write_text(
                json.dumps({"vBRIEFInfo": {"version": "0.6"}, "plan": plan}),
                encoding="utf-8",
            )
    code, message = evaluate(root, now=NOW)
    # debt target 0.4*5=2.0, actual 2 -> deficit 0; within tolerance.
    assert code == 0
    assert "within target tolerance" in message


def test_unconfigured_exits_zero(tmp_path):
    root = _make_project(tmp_path, None)
    code, message = evaluate(root, now=NOW)
    assert code == 0


def test_invalid_root_exits_two(tmp_path):
    missing = tmp_path / "nope"
    code, message = evaluate(missing, now=NOW)
    assert code == 2
    assert "not a directory" in message
