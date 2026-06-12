"""Tests for scripts/capacity_backfill.py + the capacity cold-start nudge (#1606).

Covers the brownfield-backfill story's acceptance surface:

* Bucket classification from origin-issue labels (declaration-order match wins;
  no match -> defaultBucket / low-confidence batch).
* Dry-run default (no writes) vs --apply (stamps capacityBucket +
  capacityBucketSource + git-derived completedAt).
* Idempotency (a re-run preserves explicit values and is a no-op).
* cost is never mutated.
* --window-only restricts to the activation-critical trailing-window subset.
* config error (capacityAllocation absent) -> exit 2.
* --fetch fallback for issues missing from the offline cache.
* The Tier-3 capacity cold-start nudge fires only in the cold-start state.
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import capacity_backfill  # noqa: E402
from capacity_backfill import (  # noqa: E402, I001
    BucketMatcher,
    backfill,
    classify_bucket,
    load_bucket_matchers,
)

NOW = datetime(2026, 6, 12, 12, 0, 0, tzinfo=UTC)

LIFECYCLE = ("proposed", "pending", "active", "completed", "cancelled")


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def _capacity(**overrides: object) -> dict:
    base: dict = {
        "unit": "vbrief-count",
        "window": 30,
        "enforcement": "advise",
        "minSampleSize": 2,
        "defaultBucket": "new-capability",
        "buckets": [
            {
                "id": "technical-debt",
                "target": 0.3,
                "match": {"labels": {"any-of": ["bug", "refactor"]}},
            },
            {
                "id": "new-capability",
                "target": 0.7,
                "match": {"labels": {"any-of": ["enhancement", "beta"]}},
            },
        ],
    }
    base.update(overrides)
    return base


def _make_project(tmp_path: Path, capacity: dict | None) -> Path:
    vbrief = tmp_path / "vbrief"
    for folder in LIFECYCLE:
        (vbrief / folder).mkdir(parents=True, exist_ok=True)
    plan: dict = {"title": "Capacity backfill test", "status": "running", "items": []}
    if capacity is not None:
        plan["policy"] = {"capacityAllocation": capacity}
    (vbrief / "PROJECT-DEFINITION.vbrief.json").write_text(
        json.dumps({"vBRIEFInfo": {"version": "0.6"}, "plan": plan}),
        encoding="utf-8",
    )
    return tmp_path


def _completed_at(days_ago: int) -> str:
    return (NOW - timedelta(days=days_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _write_completed(
    tmp_path: Path,
    name: str,
    *,
    issue: int | None = None,
    repo: str = "deftai/directive",
    metadata: dict | None = None,
) -> Path:
    plan: dict = {"title": name, "status": "completed", "items": []}
    if metadata is not None:
        plan["metadata"] = metadata
    if issue is not None:
        plan["references"] = [
            {
                "type": "x-vbrief/github-issue",
                "uri": f"https://github.com/{repo}/issues/{issue}",
            }
        ]
    path = tmp_path / "vbrief" / "completed" / f"{name}.vbrief.json"
    path.write_text(
        json.dumps({"vBRIEFInfo": {"version": "0.6"}, "plan": plan}),
        encoding="utf-8",
    )
    return path


def _write_cache_labels(
    tmp_path: Path, repo: str, issue: int, labels: list[str]
) -> None:
    raw = tmp_path / ".deft-cache" / "github-issue" / repo / str(issue) / "raw.json"
    raw.parent.mkdir(parents=True, exist_ok=True)
    raw.write_text(json.dumps({"number": issue, "labels": labels}), encoding="utf-8")


def _read_metadata(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    return data["plan"].get("metadata", {})


def _fixed_landing(_rel: str, _root: Path) -> str:
    return _completed_at(5)


# ---------------------------------------------------------------------------
# Bucket classification
# ---------------------------------------------------------------------------


def test_load_bucket_matchers_reads_raw_match_labels(tmp_path):
    root = _make_project(tmp_path, _capacity())
    matchers, default_bucket = load_bucket_matchers(root)
    assert default_bucket == "new-capability"
    assert matchers[0].bucket_id == "technical-debt"
    assert matchers[0].labels == frozenset({"bug", "refactor"})
    assert matchers[1].labels == frozenset({"enhancement", "beta"})


def test_classify_match_wins_by_declaration_order():
    matchers = [
        BucketMatcher("technical-debt", frozenset({"bug"})),
        BucketMatcher("new-capability", frozenset({"enhancement"})),
    ]
    # An issue carrying BOTH labels resolves to the first declared matcher.
    bucket, source = classify_bucket({"bug", "enhancement"}, matchers, "new-capability")
    assert (bucket, source) == ("technical-debt", "match")


def test_classify_no_match_falls_to_default():
    matchers = [BucketMatcher("technical-debt", frozenset({"bug"}))]
    bucket, source = classify_bucket({"docs"}, matchers, "new-capability")
    assert (bucket, source) == ("new-capability", "default")


# ---------------------------------------------------------------------------
# Dry-run / apply / idempotency
# ---------------------------------------------------------------------------


def test_dry_run_does_not_write(tmp_path, monkeypatch):
    root = _make_project(tmp_path, _capacity())
    path = _write_completed(tmp_path, "x", issue=10, metadata={"completedAt": _completed_at(3)})
    _write_cache_labels(tmp_path, "deftai/directive", 10, ["bug"])
    monkeypatch.setattr(capacity_backfill, "git_landing_time", _fixed_landing)

    result = backfill(root, dry_run=True, now=NOW)

    assert result.dry_run is True
    assert result.stamped_bucket == 1
    assert result.matched == 1
    assert "capacityBucket" not in _read_metadata(path)


def test_apply_stamps_bucket_source_and_completed_at(tmp_path, monkeypatch):
    root = _make_project(tmp_path, _capacity())
    # No completedAt on disk -> git landing time is used.
    path = _write_completed(tmp_path, "x", issue=10)
    _write_cache_labels(tmp_path, "deftai/directive", 10, ["bug"])
    monkeypatch.setattr(capacity_backfill, "git_landing_time", _fixed_landing)

    result = backfill(root, dry_run=False, now=NOW)

    assert result.stamped_bucket == 1
    assert result.stamped_completed_at == 1
    md = _read_metadata(path)
    assert md["capacityBucket"] == "technical-debt"
    assert md["capacityBucketSource"] == "match"
    assert md["completedAt"] == _completed_at(5)


def test_idempotent_rerun_is_noop(tmp_path, monkeypatch):
    root = _make_project(tmp_path, _capacity())
    _write_completed(tmp_path, "x", issue=10)
    _write_cache_labels(tmp_path, "deftai/directive", 10, ["bug"])
    monkeypatch.setattr(capacity_backfill, "git_landing_time", _fixed_landing)

    backfill(root, dry_run=False, now=NOW)
    second = backfill(root, dry_run=False, now=NOW)

    assert second.stamped_bucket == 0
    assert second.already_classified == 1


def test_existing_bucket_is_preserved(tmp_path, monkeypatch):
    root = _make_project(tmp_path, _capacity())
    path = _write_completed(
        tmp_path,
        "x",
        issue=10,
        metadata={"completedAt": _completed_at(3), "capacityBucket": "agentic-debt"},
    )
    _write_cache_labels(tmp_path, "deftai/directive", 10, ["bug"])
    monkeypatch.setattr(capacity_backfill, "git_landing_time", _fixed_landing)

    result = backfill(root, dry_run=False, now=NOW)

    assert result.already_classified == 1
    assert result.stamped_bucket == 0
    assert _read_metadata(path)["capacityBucket"] == "agentic-debt"


def test_cost_is_never_mutated(tmp_path, monkeypatch):
    root = _make_project(tmp_path, _capacity())
    path = _write_completed(tmp_path, "x", issue=10, metadata={"cost": 12.5})
    _write_cache_labels(tmp_path, "deftai/directive", 10, ["bug"])
    monkeypatch.setattr(capacity_backfill, "git_landing_time", _fixed_landing)

    backfill(root, dry_run=False, now=NOW)

    assert _read_metadata(path)["cost"] == 12.5


# ---------------------------------------------------------------------------
# Low-confidence batch / window-only / config error / fetch
# ---------------------------------------------------------------------------


def test_unmatched_issue_lands_in_low_confidence_batch(tmp_path, monkeypatch):
    root = _make_project(tmp_path, _capacity())
    _write_completed(tmp_path, "x", issue=10, metadata={"completedAt": _completed_at(3)})
    _write_cache_labels(tmp_path, "deftai/directive", 10, ["docs"])  # no bucket match
    monkeypatch.setattr(capacity_backfill, "git_landing_time", _fixed_landing)

    result = backfill(root, dry_run=True, now=NOW)

    assert result.defaulted == 1
    assert len(result.low_confidence) == 1
    assert result.low_confidence[0].bucket == "new-capability"
    assert result.low_confidence[0].source == "default"


def test_window_only_skips_out_of_window(tmp_path, monkeypatch):
    root = _make_project(tmp_path, _capacity(window=30))
    _write_completed(tmp_path, "old", issue=10, metadata={"completedAt": _completed_at(100)})
    _write_completed(tmp_path, "new", issue=11, metadata={"completedAt": _completed_at(3)})
    _write_cache_labels(tmp_path, "deftai/directive", 10, ["bug"])
    _write_cache_labels(tmp_path, "deftai/directive", 11, ["bug"])
    monkeypatch.setattr(capacity_backfill, "git_landing_time", _fixed_landing)

    result = backfill(root, dry_run=True, window_only=True, now=NOW)

    assert result.skipped_out_of_window == 1
    assert result.stamped_bucket == 1


def test_not_configured_is_config_error(tmp_path):
    root = _make_project(tmp_path, None)
    result = backfill(root, dry_run=True, now=NOW)
    assert result.exit_code == 2
    assert result.error and "not configured" in result.error


def test_fetch_fallback_for_uncached_issue(tmp_path, monkeypatch):
    root = _make_project(tmp_path, _capacity())
    _write_completed(tmp_path, "x", issue=99, metadata={"completedAt": _completed_at(3)})
    # No cache entry for #99 -> offline classification would default.
    monkeypatch.setattr(capacity_backfill, "git_landing_time", _fixed_landing)
    monkeypatch.setattr(
        capacity_backfill, "fetch_issue_labels", lambda repo, n: {"refactor"}
    )

    result = backfill(root, dry_run=True, fetch=True, now=NOW)

    assert result.fetched == 1
    assert result.matched == 1
    assert result.low_confidence == []


def test_fetch_disabled_defaults_uncached_issue(tmp_path, monkeypatch):
    root = _make_project(tmp_path, _capacity())
    _write_completed(tmp_path, "x", issue=99, metadata={"completedAt": _completed_at(3)})
    monkeypatch.setattr(capacity_backfill, "git_landing_time", _fixed_landing)

    result = backfill(root, dry_run=True, fetch=False, now=NOW)

    assert result.fetched == 0
    assert result.defaulted == 1


# ---------------------------------------------------------------------------
# Capacity cold-start nudge (#1606)
# ---------------------------------------------------------------------------


def _detect_nudge(root: Path):
    from _lifecycle_hygiene import detect_capacity_coldstart_nudge

    return detect_capacity_coldstart_nudge(root, now=NOW)


def test_coldstart_nudge_fires_when_configured_and_unclassified(tmp_path):
    root = _make_project(tmp_path, _capacity(minSampleSize=5))
    for i in range(3):
        _write_completed(
            tmp_path, f"c{i}", issue=10 + i, metadata={"completedAt": _completed_at(3)}
        )
    nudge = _detect_nudge(root)
    assert nudge is not None
    assert nudge.tier == 3
    assert "capacity:backfill" in nudge.message


def test_coldstart_nudge_suppressed_when_unconfigured(tmp_path):
    root = _make_project(tmp_path, None)
    _write_completed(tmp_path, "c", issue=10, metadata={"completedAt": _completed_at(3)})
    assert _detect_nudge(root) is None


def test_coldstart_nudge_suppressed_when_already_classified(tmp_path):
    root = _make_project(tmp_path, _capacity(minSampleSize=2))
    for i in range(3):
        _write_completed(
            tmp_path,
            f"c{i}",
            issue=10 + i,
            metadata={"completedAt": _completed_at(3), "capacityBucket": "technical-debt"},
        )
    # 3 classified >= minSampleSize=2 and nothing unclassified -> no cold-start.
    assert _detect_nudge(root) is None


def test_coldstart_nudge_suppressed_when_unclassified_out_of_window(tmp_path):
    # Unclassified completions whose explicit completedAt predates the window
    # are NOT backfill-actionable: stamping a bucket leaves completedAt out of
    # window, so classified_completions never rises. The hint/nudge must not
    # promise a no-op migration (#1606 Greptile review).
    root = _make_project(tmp_path, _capacity(window=30, minSampleSize=5))
    for i in range(3):
        _write_completed(
            tmp_path, f"old{i}", issue=10 + i, metadata={"completedAt": _completed_at(100)}
        )
    assert _detect_nudge(root) is None


def test_coldstart_nudge_fires_for_undated_unclassified(tmp_path):
    # A completion with NO completedAt IS backfill-actionable: the tool stamps
    # the git landing time, which may land in window -- so the nudge fires.
    root = _make_project(tmp_path, _capacity(window=30, minSampleSize=5))
    for i in range(3):
        _write_completed(tmp_path, f"u{i}", issue=10 + i)
    nudge = _detect_nudge(root)
    assert nudge is not None
    assert nudge.tier == 3


def test_unclassified_completions_excludes_out_of_window(tmp_path):
    # Direct compute_report coverage of the window-aware backfill-actionable
    # count: in-window + undated unclassified count; out-of-window does not.
    import capacity_show

    root = _make_project(tmp_path, _capacity(window=30, minSampleSize=5))
    _write_completed(tmp_path, "in", issue=10, metadata={"completedAt": _completed_at(3)})
    _write_completed(tmp_path, "undated", issue=11)
    _write_completed(tmp_path, "old", issue=12, metadata={"completedAt": _completed_at(100)})
    report = capacity_show.compute_report(root, now=NOW)
    assert report.unclassified_completions == 2


# ---------------------------------------------------------------------------
# Write-failure accounting + unreadable-file accounting (#1606 review)
# ---------------------------------------------------------------------------


def test_write_failure_does_not_overstate_stamped_count(tmp_path, monkeypatch):
    # On an OSError mid-run the summary must count only items that actually
    # reached disk, not the failing one (#1606 Greptile review, issue 2).
    root = _make_project(tmp_path, _capacity())
    _write_completed(tmp_path, "a", issue=10)
    _write_completed(tmp_path, "b", issue=11)
    _write_cache_labels(tmp_path, "deftai/directive", 10, ["bug"])
    _write_cache_labels(tmp_path, "deftai/directive", 11, ["bug"])
    monkeypatch.setattr(capacity_backfill, "git_landing_time", _fixed_landing)

    calls = {"n": 0}
    real_write = capacity_backfill._write_metadata

    def _flaky_write(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:  # second item (sorted: a then b) fails to write
            raise OSError("disk full")
        return real_write(*args, **kwargs)

    monkeypatch.setattr(capacity_backfill, "_write_metadata", _flaky_write)

    result = backfill(root, dry_run=False, now=NOW)

    assert result.exit_code == 1
    assert result.error is not None
    # Only the first item was written, so the summary must report 1, not 2.
    assert result.stamped_bucket == 1
    assert result.stamped_completed_at == 1


def test_unreadable_completed_file_is_counted(tmp_path, monkeypatch):
    # A corrupted / non-parseable completed vBRIEF is skipped but counted so
    # the summary's scanned figure is not silently short (#1606 review, issue 3).
    root = _make_project(tmp_path, _capacity())
    _write_completed(tmp_path, "good", issue=10, metadata={"completedAt": _completed_at(3)})
    _write_cache_labels(tmp_path, "deftai/directive", 10, ["bug"])
    bad = tmp_path / "vbrief" / "completed" / "bad.vbrief.json"
    bad.write_text("{ this is not valid json", encoding="utf-8")
    monkeypatch.setattr(capacity_backfill, "git_landing_time", _fixed_landing)

    result = backfill(root, dry_run=True, now=NOW)

    assert result.skipped_unreadable == 1
    assert result.scanned == 1
    assert "unreadable/malformed" in result.summary()
