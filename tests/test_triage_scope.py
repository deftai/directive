"""Tests for scripts/triage_scope.py (#1131 / D12).

Covers the typed ``plan.policy.triageScope[]`` contract:

* Schema validation -- accept default-empty, each rule type, reject
  ``milestone`` with #1181 pointer, reject malformed rules.
* Default behaviour -- PROJECT-DEFINITION with no ``triageScope[]``
  field resolves to ``[{"rule":"all-open"}]``.
* Rule evaluators -- each rule type against a small synthetic upstream
  fixture.
* Denominator cache lifecycle -- write, read, TTL expiry,
  subscription-hash invalidation, stale ``?`` render contract.
* ``triage:scope --list`` output snapshot.
"""

from __future__ import annotations

import importlib
import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

_SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

triage_scope = importlib.import_module("triage_scope")


# ---------------------------------------------------------------------------
# Synthetic upstream fixture
# ---------------------------------------------------------------------------


def _issue(
    n: int,
    *,
    state: str = "open",
    labels: list[str] | None = None,
    created_at: str | None = None,
    updated_at: str | None = None,
) -> dict:
    """Return a minimal GitHub-issue-shaped dict for the evaluator tests."""
    return {
        "number": n,
        "state": state,
        "labels": [{"name": label} for label in (labels or [])],
        "created_at": created_at or "2026-01-01T00:00:00Z",
        "updated_at": updated_at or "2026-01-01T00:00:00Z",
    }


def _now() -> datetime:
    return datetime(2026, 5, 17, 20, 0, 0, tzinfo=UTC)


@pytest.fixture
def upstream() -> list[dict]:
    """A tiny but diverse synthetic upstream issue set."""
    return [
        _issue(
            1,
            labels=["bug", "regression"],
            created_at="2026-05-15T00:00:00Z",
            updated_at="2026-05-17T00:00:00Z",
        ),
        _issue(
            2,
            labels=["epic", "phase-0"],
            created_at="2026-05-10T00:00:00Z",
            updated_at="2026-05-12T00:00:00Z",
        ),
        _issue(
            3,
            labels=["docs"],
            created_at="2026-04-01T00:00:00Z",
            updated_at="2026-04-02T00:00:00Z",
        ),
        _issue(
            4,
            state="closed",
            labels=["bug"],
            created_at="2026-05-16T00:00:00Z",
            updated_at="2026-05-16T00:00:00Z",
        ),
        _issue(
            5,
            labels=[],
            created_at="2026-05-17T00:00:00Z",
            updated_at="2026-05-17T00:00:00Z",
        ),
    ]


# ---------------------------------------------------------------------------
# Schema validation
# ---------------------------------------------------------------------------


def test_validate_accepts_none_as_default_unset():
    errors, warnings = triage_scope.validate_scope_rules(None)
    assert errors == []
    assert warnings == []


def test_validate_accepts_empty_list():
    errors, _ = triage_scope.validate_scope_rules([])
    assert errors == []


def test_validate_rejects_non_list():
    errors, _ = triage_scope.validate_scope_rules({"rule": "all-open"})
    assert errors
    assert "must be a list" in errors[0]


def test_validate_accepts_each_rule_type():
    rules = [
        {"rule": "all-open"},
        {"rule": "labels", "any-of": ["bug"]},
        {"rule": "labels", "all-of": ["epic", "phase-0"]},
        {"rule": "opened-since", "duration": "7d"},
        {"rule": "updated-since", "duration": "24h"},
        {"rule": "referenced-by-vbrief", "scope": "any"},
        {"rule": "referenced-by-vbrief", "scope": "active"},
        {"rule": "sliced-from", "scope": "any-umbrella-in-cache"},
        {"rule": "explicit-watch", "issues": [{"n": 42, "note": "pinned"}]},
    ]
    errors, _ = triage_scope.validate_scope_rules(rules)
    assert errors == [], errors


def test_validate_rejects_milestone_with_1181_pointer():
    errors, _ = triage_scope.validate_scope_rules([{"rule": "milestone", "name": "v1.0"}])
    assert errors
    assert "#1181" in errors[0]
    assert "deferred" in errors[0].lower()


def test_validate_rejects_unknown_rule_type():
    errors, _ = triage_scope.validate_scope_rules([{"rule": "bogus-type"}])
    assert errors
    assert "not a valid rule type" in errors[0]


def test_validate_rejects_labels_with_both_any_and_all():
    errors, _ = triage_scope.validate_scope_rules(
        [{"rule": "labels", "any-of": ["a"], "all-of": ["b"]}]
    )
    assert any("mutually exclusive" in e for e in errors)


def test_validate_rejects_labels_with_neither():
    errors, _ = triage_scope.validate_scope_rules([{"rule": "labels"}])
    assert any("requires 'any-of' or 'all-of'" in e for e in errors)


def test_validate_rejects_explicit_watch_without_note():
    errors, _ = triage_scope.validate_scope_rules(
        [{"rule": "explicit-watch", "issues": [{"n": 1}]}]
    )
    assert any("note" in e.lower() for e in errors)


def test_validate_rejects_opened_since_bad_duration():
    errors, _ = triage_scope.validate_scope_rules(
        [{"rule": "opened-since", "duration": "not-a-duration"}]
    )
    assert any("invalid duration" in e for e in errors)


def test_validate_warns_extra_keys_on_all_open():
    _, warnings = triage_scope.validate_scope_rules(
        [{"rule": "all-open", "extra": "ignored"}]
    )
    assert any("ignoring extra keys" in w for w in warnings)


# ---------------------------------------------------------------------------
# Default behaviour
# ---------------------------------------------------------------------------


def _write_project_definition(tmp_path: Path, plan: dict) -> Path:
    vbrief_dir = tmp_path / "vbrief"
    vbrief_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": plan,
    }
    pd = vbrief_dir / "PROJECT-DEFINITION.vbrief.json"
    pd.write_text(json.dumps(payload), encoding="utf-8")
    return pd


def test_default_when_triage_scope_unset(tmp_path: Path):
    _write_project_definition(tmp_path, {"title": "x", "status": "running", "items": []})
    rules = triage_scope.resolve_scope_rules(project_root=tmp_path)
    assert rules == [{"rule": "all-open"}]


def test_default_when_policy_missing(tmp_path: Path):
    _write_project_definition(tmp_path, {"title": "x", "status": "running", "items": []})
    rules = triage_scope.resolve_scope_rules(project_root=tmp_path)
    assert rules == [{"rule": "all-open"}]


def test_default_when_triage_scope_empty_list(tmp_path: Path):
    _write_project_definition(
        tmp_path,
        {
            "title": "x",
            "status": "running",
            "items": [],
            "policy": {"triageScope": []},
        },
    )
    rules = triage_scope.resolve_scope_rules(project_root=tmp_path)
    assert rules == [{"rule": "all-open"}]


def test_custom_triage_scope_returned_as_is(tmp_path: Path):
    custom = [
        {"rule": "labels", "any-of": ["bug"]},
        {"rule": "explicit-watch", "issues": [{"n": 5, "note": "pinned"}]},
    ]
    _write_project_definition(
        tmp_path,
        {
            "title": "x",
            "status": "running",
            "items": [],
            "policy": {"triageScope": custom},
        },
    )
    rules = triage_scope.resolve_scope_rules(project_root=tmp_path)
    assert rules == custom


def test_missing_project_definition_returns_default(tmp_path: Path):
    rules = triage_scope.resolve_scope_rules(project_root=tmp_path)
    assert rules == [{"rule": "all-open"}]


# ---------------------------------------------------------------------------
# Rule evaluators
# ---------------------------------------------------------------------------


def test_evaluate_all_open_returns_open_issues(upstream):
    matched = triage_scope.evaluate_rules([{"rule": "all-open"}], upstream, now=_now())
    nums = sorted(m["number"] for m in matched)
    assert nums == [1, 2, 3, 5]


def test_evaluate_labels_any_of(upstream):
    matched = triage_scope.evaluate_rules(
        [{"rule": "labels", "any-of": ["bug", "docs"]}], upstream, now=_now()
    )
    assert sorted(m["number"] for m in matched) == [1, 3]


def test_evaluate_labels_all_of(upstream):
    matched = triage_scope.evaluate_rules(
        [{"rule": "labels", "all-of": ["bug", "regression"]}], upstream, now=_now()
    )
    assert [m["number"] for m in matched] == [1]


def test_evaluate_opened_since_filters_by_age(upstream):
    matched = triage_scope.evaluate_rules(
        [{"rule": "opened-since", "duration": "7d"}], upstream, now=_now()
    )
    assert sorted(m["number"] for m in matched) == [1, 5]


def test_evaluate_updated_since_filters_by_age(upstream):
    matched = triage_scope.evaluate_rules(
        [{"rule": "updated-since", "duration": "3d"}], upstream, now=_now()
    )
    assert sorted(m["number"] for m in matched) == [1, 5]


def test_evaluate_referenced_by_vbrief(upstream):
    matched = triage_scope.evaluate_rules(
        [{"rule": "referenced-by-vbrief", "scope": "any"}],
        upstream,
        now=_now(),
        vbrief_referenced={2, 3, 99},
    )
    assert sorted(m["number"] for m in matched) == [2, 3]


def test_evaluate_referenced_by_vbrief_active_only(upstream):
    matched = triage_scope.evaluate_rules(
        [{"rule": "referenced-by-vbrief", "scope": "active"}],
        upstream,
        now=_now(),
        vbrief_referenced={1, 2, 3},
        vbrief_active_referenced={2},
    )
    assert [m["number"] for m in matched] == [2]


def test_evaluate_sliced_from(upstream):
    matched = triage_scope.evaluate_rules(
        [{"rule": "sliced-from", "scope": "any-umbrella-in-cache"}],
        upstream,
        now=_now(),
        umbrella_slices={3, 5},
    )
    assert sorted(m["number"] for m in matched) == [3, 5]


def test_evaluate_explicit_watch_includes_closed(upstream):
    """explicit-watch pins by issue number, including closed issues."""
    matched = triage_scope.evaluate_rules(
        [
            {
                "rule": "explicit-watch",
                "issues": [{"n": 4, "note": "regression watch"}],
            }
        ],
        upstream,
        now=_now(),
    )
    assert [m["number"] for m in matched] == [4]


def test_evaluate_unions_multiple_rules(upstream):
    matched = triage_scope.evaluate_rules(
        [
            {"rule": "labels", "any-of": ["bug"]},
            {"rule": "labels", "any-of": ["epic"]},
        ],
        upstream,
        now=_now(),
    )
    assert sorted(m["number"] for m in matched) == [1, 2]


# ---------------------------------------------------------------------------
# Subscription hash
# ---------------------------------------------------------------------------


def test_subscription_hash_is_stable_across_key_order():
    h1 = triage_scope.subscription_hash(
        [{"rule": "labels", "any-of": ["bug", "regression"]}]
    )
    h2 = triage_scope.subscription_hash(
        [{"any-of": ["regression", "bug"], "rule": "labels"}]
    )
    assert h1 == h2


def test_subscription_hash_changes_when_rules_change():
    h1 = triage_scope.subscription_hash([{"rule": "all-open"}])
    h2 = triage_scope.subscription_hash([{"rule": "labels", "any-of": ["bug"]}])
    assert h1 != h2


def test_subscription_hash_truncated():
    h = triage_scope.subscription_hash([{"rule": "all-open"}])
    assert len(h) == triage_scope.SUBSCRIPTION_HASH_LEN
    assert all(c in "0123456789abcdef" for c in h)


# ---------------------------------------------------------------------------
# Coverage denominator cache lifecycle
# ---------------------------------------------------------------------------


def test_coverage_write_then_read(tmp_path: Path):
    path = triage_scope.coverage_path(
        "github-issue", "owner/repo", cache_root=tmp_path
    )
    h = triage_scope.subscription_hash([{"rule": "all-open"}])
    record = triage_scope.write_coverage_denominator(
        path, count=247, subscription_hash_value=h
    )
    assert record.count == 247
    assert record.stale is False

    read = triage_scope.read_coverage_denominator(path, current_hash=h)
    assert read is not None
    assert read.count == 247
    assert read.stale is False


def test_coverage_read_missing_returns_none(tmp_path: Path):
    path = triage_scope.coverage_path("github-issue", "owner/repo", cache_root=tmp_path)
    h = triage_scope.subscription_hash([{"rule": "all-open"}])
    assert triage_scope.read_coverage_denominator(path, current_hash=h) is None


def test_coverage_ttl_expiry_marks_stale(tmp_path: Path):
    path = triage_scope.coverage_path("github-issue", "owner/repo", cache_root=tmp_path)
    h = triage_scope.subscription_hash([{"rule": "all-open"}])
    old_time = datetime.now(UTC) - timedelta(hours=48)
    triage_scope.write_coverage_denominator(
        path, count=247, subscription_hash_value=h, fetched_at=old_time
    )
    record = triage_scope.read_coverage_denominator(
        path, current_hash=h, ttl_hours=24
    )
    assert record is not None
    assert record.stale is True


def test_coverage_subscription_hash_change_invalidates(tmp_path: Path):
    path = triage_scope.coverage_path("github-issue", "owner/repo", cache_root=tmp_path)
    old_hash = triage_scope.subscription_hash([{"rule": "all-open"}])
    new_hash = triage_scope.subscription_hash(
        [{"rule": "labels", "any-of": ["bug"]}]
    )
    triage_scope.write_coverage_denominator(
        path, count=247, subscription_hash_value=old_hash
    )
    record = triage_scope.read_coverage_denominator(path, current_hash=new_hash)
    assert record is not None
    assert record.stale is True


def test_coverage_display_renders_question_mark_when_stale(tmp_path: Path):
    """Decision 3: stale records render literal '?' in the denominator."""
    path = triage_scope.coverage_path("github-issue", "owner/repo", cache_root=tmp_path)
    h = triage_scope.subscription_hash([{"rule": "all-open"}])
    old_time = datetime.now(UTC) - timedelta(hours=48)
    triage_scope.write_coverage_denominator(
        path, count=247, subscription_hash_value=h, fetched_at=old_time
    )
    record = triage_scope.read_coverage_denominator(
        path, current_hash=h, ttl_hours=24
    )
    assert triage_scope.format_coverage_display(125, record) == "125/?"


def test_coverage_display_renders_question_mark_when_missing():
    assert triage_scope.format_coverage_display(125, None) == "125/?"


def test_coverage_display_renders_fresh_count(tmp_path: Path):
    path = triage_scope.coverage_path("github-issue", "owner/repo", cache_root=tmp_path)
    h = triage_scope.subscription_hash([{"rule": "all-open"}])
    record = triage_scope.write_coverage_denominator(
        path, count=247, subscription_hash_value=h
    )
    assert triage_scope.format_coverage_display(125, record) == "125/247"


def test_coverage_ttl_env_override(monkeypatch, tmp_path: Path):
    monkeypatch.setenv(triage_scope.ENV_COVERAGE_TTL_HOURS, "12")
    assert triage_scope.coverage_ttl_hours() == 12


# ---------------------------------------------------------------------------
# --list render
# ---------------------------------------------------------------------------


def test_render_list_default_annotation():
    rules = [{"rule": "all-open"}]
    out = triage_scope.render_list(rules, is_default=True)
    assert "default applied" in out
    assert "subscription-hash:" in out
    assert "1. all-open" in out


def test_render_list_includes_explicit_watch_notes():
    """Decision 4: explicit-watch notes appear in --list output."""
    rules = [
        {
            "rule": "explicit-watch",
            "issues": [
                {"n": 1234, "note": "blocks release"},
                {"n": 5678, "note": "regression watch"},
            ],
        }
    ]
    out = triage_scope.render_list(rules)
    assert "#1234" in out
    assert "blocks release" in out
    assert "#5678" in out
    assert "regression watch" in out


def test_render_list_full_snapshot():
    """Stable snapshot of the --list output format for the canonical mix."""
    rules = [
        {"rule": "all-open"},
        {"rule": "labels", "any-of": ["bug", "regression"]},
        {"rule": "explicit-watch", "issues": [{"n": 99, "note": "pinned"}]},
    ]
    out = triage_scope.render_list(rules, is_default=False)
    expected_head = (
        "triage:scope effective rules (3):\n"
        "  1. all-open\n"
        "  2. labels any-of=['bug', 'regression']\n"
        "  3. explicit-watch:\n"
        "       - #99  (pinned)\n"
        "subscription-hash: "
    )
    assert out.startswith(expected_head), f"got:\n{out!r}"


# ---------------------------------------------------------------------------
# Duration parser
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("7d", timedelta(days=7)),
        ("24h", timedelta(hours=24)),
        ("30m", timedelta(minutes=30)),
        ("45s", timedelta(seconds=45)),
        ("2w", timedelta(weeks=2)),
        ("P7D", timedelta(days=7)),
        ("PT24H", timedelta(hours=24)),
        ("P1DT12H", timedelta(days=1, hours=12)),
        ("0d", timedelta(0)),
    ],
)
def test_parse_duration_accepts(raw, expected):
    assert triage_scope.parse_duration(raw) == expected


@pytest.mark.parametrize("raw", ["", "abc", "7x", "P", "PT", "7"])
def test_parse_duration_rejects(raw):
    with pytest.raises(ValueError):
        triage_scope.parse_duration(raw)


# ---------------------------------------------------------------------------
# vbrief_validate integration hook
# ---------------------------------------------------------------------------


def test_validate_triage_scope_on_plan_empty_returns_no_errors():
    out = triage_scope.validate_triage_scope_on_plan(
        {"title": "x", "status": "running"}, "vbrief/PROJECT-DEFINITION.vbrief.json"
    )
    assert out == []


def test_validate_triage_scope_on_plan_surfaces_milestone_rejection():
    plan = {"policy": {"triageScope": [{"rule": "milestone", "name": "v1"}]}}
    out = triage_scope.validate_triage_scope_on_plan(plan, "x.vbrief.json")
    assert out
    assert any("#1181" in e for e in out)
    assert all("(#1131)" in e for e in out)
