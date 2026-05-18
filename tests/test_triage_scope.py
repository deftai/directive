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


def test_validate_accepts_milestone_exact_match_d14():
    """D14 / #1133 ships the milestone rule with the v1 exact-match shape.

    Previously this test asserted REJECTION with a #1181 pointer (D12 era);
    D14 promotes ``milestone`` into the VALID_RULE_TYPES set.
    """
    errors, warnings = triage_scope.validate_scope_rules(
        [{"rule": "milestone", "name": "v2.0-blocker"}]
    )
    assert errors == [], errors
    assert warnings == [], warnings


def test_validate_rejects_milestone_missing_variant():
    """D14b (#1181): an empty milestone rule must reject pointing at the matrix."""
    errors, _ = triage_scope.validate_scope_rules([{"rule": "milestone"}])
    assert errors
    assert "requires one of" in errors[0]
    assert "is-open" in errors[0]
    assert "#1181" in errors[0]


def test_validate_rejects_milestone_with_empty_name():
    errors, _ = triage_scope.validate_scope_rules(
        [{"rule": "milestone", "name": "   "}]
    )
    assert errors
    assert "milestone.name" in errors[0]


def test_validate_rejects_milestone_name_and_is_open_combined():
    """D14b (#1181): name + is-open is a hard mutex error, not a warning."""
    errors, _ = triage_scope.validate_scope_rules(
        [{"rule": "milestone", "name": "v2.0", "is-open": True}]
    )
    assert any("mutually exclusive" in e for e in errors)
    assert any("#1181" in e for e in errors)


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


def test_validate_triage_scope_on_plan_accepts_milestone_d14():
    """D14 / #1133: milestone {name: ...} now passes validation."""
    plan = {"policy": {"triageScope": [{"rule": "milestone", "name": "v1"}]}}
    out = triage_scope.validate_triage_scope_on_plan(plan, "x.vbrief.json")
    assert out == []


def test_validate_triage_scope_on_plan_surfaces_milestone_missing_variant():
    plan = {"policy": {"triageScope": [{"rule": "milestone"}]}}
    out = triage_scope.validate_triage_scope_on_plan(plan, "x.vbrief.json")
    assert out
    assert all("(#1131)" in e for e in out)
    # D14b (#1181) now points at the three-variant matrix instead of name-only.
    assert any("requires one of" in e and "is-open" in e for e in out)


# ---------------------------------------------------------------------------
# D14 / #1133: milestone evaluator
# ---------------------------------------------------------------------------


def _issue_with_milestone(
    n: int,
    *,
    state: str = "open",
    milestone_title: str | None = None,
) -> dict:
    base = _issue(n, state=state, labels=[])
    if milestone_title is not None:
        base["milestone"] = {"title": milestone_title, "number": 1}
    return base


def test_evaluate_milestone_exact_match_open_only():
    issues = [
        _issue_with_milestone(1, milestone_title="v2.0-blocker"),
        _issue_with_milestone(2, milestone_title="v2.0-blocker"),
        _issue_with_milestone(3, milestone_title="v1.9"),
        _issue_with_milestone(4, state="closed", milestone_title="v2.0-blocker"),
        _issue_with_milestone(5, milestone_title=None),
    ]
    matched = triage_scope.evaluate_rules(
        [{"rule": "milestone", "name": "v2.0-blocker"}], issues, now=_now()
    )
    assert sorted(m["number"] for m in matched) == [1, 2]


def test_evaluate_milestone_handles_bare_string_field():
    issues = [
        {"number": 10, "state": "open", "labels": [], "milestone": "v3.0"},
        {"number": 11, "state": "open", "labels": []},
    ]
    matched = triage_scope.evaluate_rules(
        [{"rule": "milestone", "name": "v3.0"}], issues
    )
    assert [m["number"] for m in matched] == [10]


def test_evaluate_milestone_ignored_when_name_missing():
    issues = [_issue_with_milestone(1, milestone_title="v2.0")]
    matched = triage_scope.evaluate_rules([{"rule": "milestone"}], issues)
    assert matched == []


# ---------------------------------------------------------------------------
# D14b / #1181: milestone any-of + is-open variants
# ---------------------------------------------------------------------------


def test_validate_accepts_milestone_any_of_d14b():
    errors, warnings = triage_scope.validate_scope_rules(
        [{"rule": "milestone", "any-of": ["v0.27", "v0.28"]}]
    )
    assert errors == [], errors
    assert warnings == [], warnings


def test_validate_accepts_milestone_is_open_d14b():
    errors, warnings = triage_scope.validate_scope_rules(
        [{"rule": "milestone", "is-open": True}]
    )
    assert errors == [], errors
    assert warnings == [], warnings


def test_validate_rejects_milestone_any_of_empty_list():
    errors, _ = triage_scope.validate_scope_rules(
        [{"rule": "milestone", "any-of": []}]
    )
    assert errors
    assert any("any-of" in e and "non-empty" in e for e in errors)


def test_validate_rejects_milestone_any_of_non_string_member():
    errors, _ = triage_scope.validate_scope_rules(
        [{"rule": "milestone", "any-of": ["ok", 42, ""]}]
    )
    assert errors
    assert any("any-of[1]" in e or "any-of[2]" in e for e in errors)


def test_validate_rejects_milestone_is_open_false():
    errors, _ = triage_scope.validate_scope_rules(
        [{"rule": "milestone", "is-open": False}]
    )
    assert errors
    assert any("meaningless" in e for e in errors)
    assert any("name" in e and "any-of" in e for e in errors)


def test_validate_rejects_milestone_is_open_non_bool():
    errors, _ = triage_scope.validate_scope_rules(
        [{"rule": "milestone", "is-open": "true"}]
    )
    assert errors
    assert any("boolean" in e for e in errors)


def test_validate_rejects_milestone_name_and_any_of_combined():
    errors, _ = triage_scope.validate_scope_rules(
        [{"rule": "milestone", "name": "v0.27", "any-of": ["v0.27"]}]
    )
    assert any("mutually exclusive" in e for e in errors)


def test_validate_rejects_milestone_any_of_and_is_open_combined():
    errors, _ = triage_scope.validate_scope_rules(
        [{"rule": "milestone", "any-of": ["v0.27"], "is-open": True}]
    )
    assert any("mutually exclusive" in e for e in errors)


def test_validate_backward_compat_name_only_rule_still_passes():
    """Pre-D14b rules using ``{name: <str>}`` MUST continue to validate."""
    errors, warnings = triage_scope.validate_scope_rules(
        [{"rule": "milestone", "name": "v0.27"}]
    )
    assert errors == [], errors
    assert warnings == [], warnings


def test_evaluate_milestone_any_of_matches_members():
    issues = [
        _issue_with_milestone(1, milestone_title="v0.27"),
        _issue_with_milestone(2, milestone_title="v0.28"),
        _issue_with_milestone(3, milestone_title="v0.29"),
        _issue_with_milestone(4, milestone_title=None),
        _issue_with_milestone(5, state="closed", milestone_title="v0.27"),
    ]
    matched = triage_scope.evaluate_rules(
        [{"rule": "milestone", "any-of": ["v0.27", "v0.28"]}], issues
    )
    assert sorted(m["number"] for m in matched) == [1, 2]


def test_evaluate_milestone_any_of_no_match_returns_empty():
    issues = [_issue_with_milestone(1, milestone_title="v3.0")]
    matched = triage_scope.evaluate_rules(
        [{"rule": "milestone", "any-of": ["v0.27", "v0.28"]}], issues
    )
    assert matched == []


def test_evaluate_milestone_is_open_matches_open_milestones():
    issues = [
        _issue_with_milestone(1, milestone_title="v0.27"),
        _issue_with_milestone(2, milestone_title="v0.28"),
        _issue_with_milestone(3, milestone_title="v0.26"),  # closed upstream
        _issue_with_milestone(4, milestone_title=None),
        _issue_with_milestone(5, state="closed", milestone_title="v0.27"),
    ]
    matched = triage_scope.evaluate_rules(
        [{"rule": "milestone", "is-open": True}],
        issues,
        open_milestones_fetcher=lambda: {"v0.27", "v0.28"},
    )
    assert sorted(m["number"] for m in matched) == [1, 2]


def test_evaluate_milestone_is_open_does_not_match_closed():
    issues = [
        _issue_with_milestone(1, milestone_title="v0.26"),
        _issue_with_milestone(2, milestone_title="v0.25"),
    ]
    matched = triage_scope.evaluate_rules(
        [{"rule": "milestone", "is-open": True}],
        issues,
        open_milestones_fetcher=lambda: {"v0.27", "v0.28"},
    )
    assert matched == []


def test_evaluate_milestone_is_open_snapshot_memoized_once_per_call():
    """D14b (#1181): multiple is-open rules share a single fetcher call."""
    call_count = {"n": 0}

    def fetcher() -> set[str]:
        call_count["n"] += 1
        return {"v0.27", "v0.28"}

    issues = [
        _issue_with_milestone(1, milestone_title="v0.27"),
        _issue_with_milestone(2, milestone_title="v0.28"),
    ]
    # Three identical is-open rules; the fetcher MUST still be called once.
    rules = [
        {"rule": "milestone", "is-open": True},
        {"rule": "milestone", "is-open": True},
        {"rule": "milestone", "is-open": True},
    ]
    matched = triage_scope.evaluate_rules(
        rules, issues, open_milestones_fetcher=fetcher
    )
    assert call_count["n"] == 1
    assert sorted(m["number"] for m in matched) == [1, 2]


def test_evaluate_milestone_is_open_fetcher_failure_yields_no_matches():
    def boom() -> set[str]:
        raise RuntimeError("network down")

    issues = [_issue_with_milestone(1, milestone_title="v0.27")]
    matched = triage_scope.evaluate_rules(
        [{"rule": "milestone", "is-open": True}],
        issues,
        open_milestones_fetcher=boom,
    )
    assert matched == []


# ---------------------------------------------------------------------------
# D14b / #1181: infer_repo_from_issues strict-hostname validation
# (CodeQL py/incomplete-url-substring-sanitization regression)
# ---------------------------------------------------------------------------


def _load_milestone_module():
    import importlib

    return importlib.import_module("_triage_scope_milestone")


def test_infer_repo_accepts_api_github_repository_url():
    mod = _load_milestone_module()
    issues = [{"repository_url": "https://api.github.com/repos/deftai/directive"}]
    assert mod.infer_repo_from_issues(issues) == "deftai/directive"


def test_infer_repo_accepts_github_html_url_issues_form():
    mod = _load_milestone_module()
    issues = [{"html_url": "https://github.com/deftai/directive/issues/1181"}]
    assert mod.infer_repo_from_issues(issues) == "deftai/directive"


def test_infer_repo_accepts_github_html_url_repo_only_form():
    mod = _load_milestone_module()
    issues = [{"html_url": "https://github.com/deftai/directive"}]
    assert mod.infer_repo_from_issues(issues) == "deftai/directive"


def test_infer_repo_rejects_spoofed_subdomain_attack():
    """CodeQL py/incomplete-url-substring-sanitization regression.

    A naive ``"github.com" in url`` check would accept this URL because
    the literal substring ``github.com`` appears in the hostname. The
    strict ``urlparse().hostname`` allow-list MUST reject it.
    """
    mod = _load_milestone_module()
    issues = [
        {"html_url": "https://evil-github.com.attacker.com/deftai/directive/issues/1"}
    ]
    assert mod.infer_repo_from_issues(issues) is None


def test_infer_repo_rejects_github_com_in_path_only():
    mod = _load_milestone_module()
    issues = [
        {"html_url": "https://attacker.com/github.com/deftai/directive"}
    ]
    assert mod.infer_repo_from_issues(issues) is None


def test_infer_repo_rejects_github_com_with_credential_prefix():
    mod = _load_milestone_module()
    issues = [
        {"html_url": "https://github.com@attacker.com/deftai/directive"}
    ]
    assert mod.infer_repo_from_issues(issues) is None


def test_infer_repo_rejects_non_string_and_malformed_urls():
    mod = _load_milestone_module()
    issues = [
        {"html_url": 12345},
        {"html_url": ""},
        {"html_url": "not-a-url"},
        {"html_url": "https://github.com"},  # no path -> too few segments
        {"html_url": "https://github.com/deftai"},  # only owner, no name
    ]
    assert mod.infer_repo_from_issues(issues) is None


def test_infer_repo_skips_non_github_then_finds_canonical():
    """Issues with non-github URLs are skipped; the first canonical URL wins."""
    mod = _load_milestone_module()
    issues = [
        {"html_url": "https://evil-github.com.attacker.com/x/y"},
        {"repository_url": "https://api.github.com/repos/deftai/directive"},
    ]
    assert mod.infer_repo_from_issues(issues) == "deftai/directive"


def test_infer_repo_case_insensitive_hostname():
    mod = _load_milestone_module()
    issues = [{"html_url": "https://GitHub.com/deftai/directive/issues/1"}]
    assert mod.infer_repo_from_issues(issues) == "deftai/directive"


# ---------------------------------------------------------------------------
# D14 / #1133: triageScopeIgnores[] validation + resolve
# ---------------------------------------------------------------------------


def test_validate_scope_ignores_accepts_none():
    errors, warnings = triage_scope.validate_scope_ignores(None)
    assert errors == []
    assert warnings == []


def test_validate_scope_ignores_accepts_empty_list():
    errors, _ = triage_scope.validate_scope_ignores([])
    assert errors == []


def test_validate_scope_ignores_accepts_label_and_milestone():
    errors, _ = triage_scope.validate_scope_ignores(
        [{"label": "rfc-track"}, {"milestone": "future"}]
    )
    assert errors == [], errors


def test_validate_scope_ignores_rejects_non_list():
    errors, _ = triage_scope.validate_scope_ignores({"label": "x"})
    assert errors
    assert "must be a list" in errors[0]


def test_validate_scope_ignores_rejects_missing_keys():
    errors, _ = triage_scope.validate_scope_ignores([{}])
    assert errors
    assert "label" in errors[0].lower()


def test_validate_scope_ignores_rejects_both_keys():
    errors, _ = triage_scope.validate_scope_ignores(
        [{"label": "x", "milestone": "y"}]
    )
    assert any("mutually exclusive" in e for e in errors)


def test_validate_scope_ignores_rejects_empty_value():
    errors, _ = triage_scope.validate_scope_ignores([{"label": "  "}])
    assert errors
    assert "non-empty" in errors[0]


def test_resolve_scope_ignores_returns_empty_when_unset(tmp_path: Path):
    _write_project_definition(tmp_path, {"title": "x", "status": "running", "items": []})
    out = triage_scope.resolve_scope_ignores(project_root=tmp_path)
    assert out == {"labels": set(), "milestones": set()}


def test_resolve_scope_ignores_partitions_label_vs_milestone(tmp_path: Path):
    _write_project_definition(
        tmp_path,
        {
            "title": "x",
            "status": "running",
            "items": [],
            "policy": {
                "triageScopeIgnores": [
                    {"label": "rfc-track"},
                    {"label": "wontfix"},
                    {"milestone": "icebox"},
                ]
            },
        },
    )
    out = triage_scope.resolve_scope_ignores(project_root=tmp_path)
    assert out["labels"] == {"rfc-track", "wontfix"}
    assert out["milestones"] == {"icebox"}


def test_validate_triage_scope_ignores_on_plan_tags_issue_1133():
    plan = {"policy": {"triageScopeIgnores": [{}]}}
    out = triage_scope.validate_triage_scope_ignores_on_plan(plan, "x.vbrief.json")
    assert out
    assert all("(#1133)" in e for e in out)
