"""Tests for scripts/triage_classify.py (#1129 / D10).

Covers the auto-classification surface:

* Four hardcoded framework universal rules fire on the right synthetic
  fixtures (hold marker, closed never-triaged, dormant + thin body,
  vBRIEF-referenced).
* Consumer rules layer after framework rules; first match wins.
* Schema validation rejects malformed payloads.
* Default behaviour when ``triageAutoClassify[]`` / ``triageHoldMarkers[]``
  are unset.
* Hold-marker default + per-consumer override.
* No deft-specific label / state / milestone leaks into the framework
  defaults (§12 framework-vs-consumer-config boundary).
* vbrief_validate hooks (``validate_triage_auto_classify_on_plan`` /
  ``validate_triage_hold_markers_on_plan``).
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

triage_classify = importlib.import_module("triage_classify")


# ---------------------------------------------------------------------------
# Synthetic issue helpers
# ---------------------------------------------------------------------------


def _issue(
    n: int,
    *,
    state: str = "open",
    body: str = "",
    labels: list[str] | None = None,
    updated_at: str | None = None,
    created_at: str | None = None,
) -> dict:
    return {
        "number": n,
        "state": state,
        "body": body,
        "labels": [{"name": label} for label in (labels or [])],
        "updated_at": updated_at or "2026-05-17T00:00:00Z",
        "created_at": created_at or "2026-05-17T00:00:00Z",
    }


def _now() -> datetime:
    return datetime(2026, 5, 17, 21, 0, 0, tzinfo=UTC)


# ---------------------------------------------------------------------------
# Universal rule 1: hold marker in body
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "marker_text",
    [
        "do not implement",
        "DO NOT IMPLEMENT",
        "BLOCKED",
        "blocked: waiting on legal",
        "HOLDING",
        "Holding / capture only",
        "holding / capture only -- ignore for now",
    ],
)
def test_universal_hold_marker_fires(marker_text):
    issue = _issue(1, body=f"Some preamble. {marker_text}\nMore details.")
    result = triage_classify.classify_issue(issue, now=_now())
    assert result is not None
    assert result.action == "defer"
    assert result.reason == "hold marker in body"
    assert result.rule_source == "framework"
    assert result.rule_kind == "universal:hold-marker"


def test_universal_hold_marker_does_not_fire_when_body_is_clean():
    issue = _issue(1, body="A normal feature request with acceptance criteria.")
    result = triage_classify.classify_issue(issue, now=_now())
    # No rule should fire on this issue (under default rules).
    assert result is None


def test_universal_hold_marker_uses_configured_phrases():
    issue = _issue(1, body="WONTFIX upstream")
    # With defaults, no match.
    assert triage_classify.classify_issue(issue, now=_now()) is None
    # With override list, WONTFIX trips the rule.
    result = triage_classify.classify_issue(
        issue, hold_markers=["WONTFIX"], now=_now()
    )
    assert result is not None
    assert result.action == "defer"
    assert result.rule_kind == "universal:hold-marker"


def test_universal_hold_marker_silenced_by_empty_list():
    issue = _issue(1, body="BLOCKED upstream")
    # Default list catches it.
    assert triage_classify.classify_issue(issue, now=_now()) is not None
    # Empty override silences the rule.
    assert triage_classify.classify_issue(
        issue, hold_markers=[], now=_now()
    ) is None


# ---------------------------------------------------------------------------
# Universal rule 2: closed + never triaged -> archive
# ---------------------------------------------------------------------------


def test_universal_closed_never_triaged_fires():
    issue = _issue(2, state="closed", body="Was a duplicate")
    result = triage_classify.classify_issue(
        issue, has_triage_decision=False, now=_now()
    )
    assert result is not None
    assert result.action == "archive"
    assert result.rule_kind == "universal:closed-never-triaged"


def test_universal_closed_with_prior_decision_does_not_fire():
    issue = _issue(2, state="closed", body="Has prior decision")
    result = triage_classify.classify_issue(
        issue, has_triage_decision=True, now=_now()
    )
    # No archive when there's already a triage decision in the log.
    # Other universal rules also won't fire here (body has no hold marker,
    # state is closed so dormant doesn't apply, no vBRIEF reference).
    assert result is None


# ---------------------------------------------------------------------------
# Universal rule 3: dormant + thin body
# ---------------------------------------------------------------------------


def test_universal_dormant_thin_body_fires():
    stale = (_now() - timedelta(days=120)).strftime("%Y-%m-%dT%H:%M:%SZ")
    issue = _issue(3, body="too short", updated_at=stale, created_at=stale)
    result = triage_classify.classify_issue(issue, now=_now())
    assert result is not None
    assert result.action == "defer"
    assert result.reason == "dormant; needs AC refresh"
    assert result.rule_kind == "universal:dormant-thin-body"


def test_universal_dormant_does_not_fire_when_recent():
    recent = (_now() - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
    issue = _issue(3, body="too short", updated_at=recent, created_at=recent)
    assert triage_classify.classify_issue(issue, now=_now()) is None


def test_universal_dormant_does_not_fire_when_body_is_full():
    stale = (_now() - timedelta(days=120)).strftime("%Y-%m-%dT%H:%M:%SZ")
    full = "x" * 60
    issue = _issue(3, body=full, updated_at=stale, created_at=stale)
    assert triage_classify.classify_issue(issue, now=_now()) is None


def test_universal_dormant_skips_closed_issues():
    stale = (_now() - timedelta(days=200)).strftime("%Y-%m-%dT%H:%M:%SZ")
    issue = _issue(
        3,
        state="closed",
        body="short",
        updated_at=stale,
        created_at=stale,
    )
    # Closed-never-triaged fires first instead.
    result = triage_classify.classify_issue(
        issue, has_triage_decision=False, now=_now()
    )
    assert result is not None
    assert result.rule_kind == "universal:closed-never-triaged"


# ---------------------------------------------------------------------------
# Universal rule 4: vBRIEF-referenced -> accept
# ---------------------------------------------------------------------------


def test_universal_vbrief_referenced_fires():
    issue = _issue(42, body="Issue 42 details")
    result = triage_classify.classify_issue(
        issue, vbrief_referenced={42, 99}, now=_now()
    )
    assert result is not None
    assert result.action == "accept"
    assert result.rule_kind == "universal:vbrief-referenced"


def test_universal_vbrief_referenced_does_not_fire_when_not_referenced():
    issue = _issue(42, body="Standalone")
    result = triage_classify.classify_issue(
        issue, vbrief_referenced={99}, now=_now()
    )
    assert result is None


# ---------------------------------------------------------------------------
# Consumer rule layering + first-match-wins
# ---------------------------------------------------------------------------


def test_consumer_rule_appended_after_universal_rules():
    rules = triage_classify.resolve_classify_rules(
        project_definition={
            "plan": {
                "policy": {
                    "triageAutoClassify": [
                        {
                            "match": {"labels": {"any-of": ["wontfix"]}},
                            "action": "defer",
                            "reason": "wontfix",
                        }
                    ]
                }
            }
        }
    )
    # Universal rules first (4), then the consumer rule (5 total).
    assert len(rules) == 5
    assert rules[0]["rule"].startswith("universal:")
    assert rules[3]["rule"].startswith("universal:")
    assert rules[4]["action"] == "defer"
    assert rules[4]["reason"] == "wontfix"


def test_first_match_wins_universal_rule_short_circuits_consumer():
    issue = _issue(
        1, body="BLOCKED upstream", labels=["wontfix"]
    )
    rules = (
        list(triage_classify.UNIVERSAL_RULES)
        + [
            {
                "match": {"labels": {"any-of": ["wontfix"]}},
                "action": "defer",
                "reason": "wontfix per consumer rule",
            }
        ]
    )
    result = triage_classify.classify_issue(issue, rules=rules, now=_now())
    # Universal hold-marker rule (index 0) fires first; the consumer
    # "wontfix" rule never gets a chance.
    assert result is not None
    assert result.rule_index == 0
    assert result.rule_kind == "universal:hold-marker"
    assert result.reason == "hold marker in body"


def test_consumer_rule_fires_when_universal_rules_do_not_match():
    issue = _issue(
        2,
        body="A perfectly reasonable feature request with detail.",
        labels=["wontfix"],
    )
    rules = (
        list(triage_classify.UNIVERSAL_RULES)
        + [
            {
                "match": {"labels": {"any-of": ["wontfix"]}},
                "action": "defer",
                "reason": "wontfix per consumer rule",
            }
        ]
    )
    result = triage_classify.classify_issue(issue, rules=rules, now=_now())
    assert result is not None
    assert result.rule_index == 4
    assert result.rule_source == "consumer"
    assert result.reason == "wontfix per consumer rule"


def test_consumer_rules_evaluated_in_declared_order():
    issue = _issue(3, body="OK feature.", labels=["bug", "rfc"])
    consumer_rules = [
        {
            "match": {"labels": {"any-of": ["bug"]}},
            "action": "escalate",
            "reason": "fires first",
        },
        {
            "match": {"labels": {"any-of": ["rfc"]}},
            "action": "defer",
            "reason": "would fire second but never",
        },
    ]
    rules = list(triage_classify.UNIVERSAL_RULES) + consumer_rules
    result = triage_classify.classify_issue(issue, rules=rules, now=_now())
    assert result is not None
    assert result.reason == "fires first"
    assert result.rule_index == 4


# ---------------------------------------------------------------------------
# Consumer match block predicates
# ---------------------------------------------------------------------------


def test_consumer_labels_all_of_requires_all():
    issue = _issue(1, body="x" * 80, labels=["bug"])
    rules = [
        {
            "match": {"labels": {"all-of": ["bug", "regression"]}},
            "action": "escalate",
            "reason": "p0 bug",
        }
    ]
    assert (
        triage_classify.classify_issue(issue, rules=rules, now=_now()) is None
    )
    issue["labels"] = [{"name": "bug"}, {"name": "regression"}]
    result = triage_classify.classify_issue(issue, rules=rules, now=_now())
    assert result is not None
    assert result.action == "escalate"


def test_consumer_body_text_match():
    issue = _issue(1, body="This is exploratory; just a thought.")
    rules = [
        {
            "match": {"body-text": {"any-of": ["exploratory"]}},
            "action": "defer",
            "reason": "exploratory",
        }
    ]
    result = triage_classify.classify_issue(issue, rules=rules, now=_now())
    assert result is not None
    assert result.action == "defer"


def test_consumer_state_match():
    issue = _issue(1, state="closed", body="x" * 80)
    rules = [
        {
            "match": {"state": "closed"},
            "action": "archive",
            "reason": "closed",
        }
    ]
    # state must combine with at least one predicate; here state alone is
    # used and the universal "closed-never-triaged" should fire first.
    result = triage_classify.classify_issue(
        issue, rules=list(triage_classify.UNIVERSAL_RULES) + rules, now=_now()
    )
    assert result is not None
    assert result.rule_kind == "universal:closed-never-triaged"


def test_consumer_age_days_match():
    stale = (_now() - timedelta(days=60)).strftime("%Y-%m-%dT%H:%M:%SZ")
    issue = _issue(
        1, body="x" * 80, updated_at=stale, created_at=stale
    )
    rules = [
        {
            "match": {"age-days": {"gt": 30}, "state": "open"},
            "action": "defer",
            "reason": "stale",
        }
    ]
    result = triage_classify.classify_issue(issue, rules=rules, now=_now())
    assert result is not None
    assert result.action == "defer"


def test_consumer_resume_on_field_surfaces_in_result():
    issue = _issue(1, body="x" * 80, labels=["fixed-pending-merge"])
    rules = [
        {
            "match": {"labels": {"any-of": ["fixed-pending-merge"]}},
            "action": "defer",
            "reason": "fixed pending merge",
            "resume-on": "label-removed",
        }
    ]
    result = triage_classify.classify_issue(issue, rules=rules, now=_now())
    assert result is not None
    assert result.resume_on == "label-removed"


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


def test_resolve_returns_only_universal_when_unset(tmp_path):
    _write_project_definition(
        tmp_path, {"title": "x", "status": "running", "items": []}
    )
    rules = triage_classify.resolve_classify_rules(project_root=tmp_path)
    assert len(rules) == 4
    for r in rules:
        assert r["rule"].startswith("universal:")


def test_resolve_returns_only_universal_when_empty_list(tmp_path):
    _write_project_definition(
        tmp_path,
        {
            "title": "x",
            "status": "running",
            "items": [],
            "policy": {"triageAutoClassify": []},
        },
    )
    rules = triage_classify.resolve_classify_rules(project_root=tmp_path)
    assert len(rules) == 4


def test_resolve_handles_missing_project_definition(tmp_path):
    rules = triage_classify.resolve_classify_rules(project_root=tmp_path)
    assert len(rules) == 4


def test_resolve_hold_markers_default():
    markers = triage_classify.resolve_hold_markers(project_definition=None)
    assert markers == list(triage_classify.DEFAULT_HOLD_MARKERS)


def test_resolve_hold_markers_override(tmp_path):
    _write_project_definition(
        tmp_path,
        {
            "title": "x",
            "status": "running",
            "items": [],
            "policy": {"triageHoldMarkers": ["WONTFIX", "PARKED"]},
        },
    )
    markers = triage_classify.resolve_hold_markers(project_root=tmp_path)
    assert markers == ["WONTFIX", "PARKED"]


def test_resolve_hold_markers_empty_list_silences(tmp_path):
    _write_project_definition(
        tmp_path,
        {
            "title": "x",
            "status": "running",
            "items": [],
            "policy": {"triageHoldMarkers": []},
        },
    )
    markers = triage_classify.resolve_hold_markers(project_root=tmp_path)
    assert markers == []


# ---------------------------------------------------------------------------
# Schema validation
# ---------------------------------------------------------------------------


def test_validate_accepts_none():
    errors, warnings = triage_classify.validate_classify_rules(None)
    assert errors == []
    assert warnings == []


def test_validate_accepts_empty_list():
    errors, _ = triage_classify.validate_classify_rules([])
    assert errors == []


def test_validate_rejects_non_list():
    errors, _ = triage_classify.validate_classify_rules({"oops": True})
    assert errors
    assert "must be a list" in errors[0]


def test_validate_rejects_unknown_action():
    errors, _ = triage_classify.validate_classify_rules(
        [
            {
                "match": {"labels": {"any-of": ["x"]}},
                "action": "delete-the-issue",
                "reason": "evil",
            }
        ]
    )
    assert any("action" in e for e in errors)


def test_validate_rejects_missing_reason():
    errors, _ = triage_classify.validate_classify_rules(
        [
            {
                "match": {"labels": {"any-of": ["x"]}},
                "action": "defer",
            }
        ]
    )
    assert any("reason" in e for e in errors)


def test_validate_rejects_empty_match_block():
    errors, _ = triage_classify.validate_classify_rules(
        [{"match": {}, "action": "defer", "reason": "??"}]
    )
    assert any("at least one of" in e for e in errors)


def test_validate_rejects_labels_with_both_any_and_all():
    errors, _ = triage_classify.validate_classify_rules(
        [
            {
                "match": {
                    "labels": {"any-of": ["a"], "all-of": ["b"]}
                },
                "action": "defer",
                "reason": "??",
            }
        ]
    )
    assert any("mutually exclusive" in e for e in errors)


def test_validate_rejects_bad_state():
    errors, _ = triage_classify.validate_classify_rules(
        [
            {
                "match": {"state": "mystery", "labels": {"any-of": ["x"]}},
                "action": "defer",
                "reason": "??",
            }
        ]
    )
    assert any("state" in e for e in errors)


def test_validate_rejects_bad_age_days():
    errors, _ = triage_classify.validate_classify_rules(
        [
            {
                "match": {"age-days": {"gt": -5}},
                "action": "defer",
                "reason": "??",
            }
        ]
    )
    assert any("age-days" in e for e in errors)


def test_validate_rejects_universal_rule_in_consumer_config():
    errors, _ = triage_classify.validate_classify_rules(
        [
            {
                "rule": "universal:hold-marker",
                "match": {"labels": {"any-of": ["x"]}},
                "action": "defer",
                "reason": "trying to override",
            }
        ]
    )
    assert any("reserved" in e for e in errors)


def test_validate_warns_on_extra_match_predicates():
    _, warnings = triage_classify.validate_classify_rules(
        [
            {
                "match": {
                    "labels": {"any-of": ["x"]},
                    "made-up-key": True,
                },
                "action": "defer",
                "reason": "??",
            }
        ]
    )
    assert any("unrecognised predicate" in w for w in warnings)


def test_validate_rejects_bad_resume_on():
    errors, _ = triage_classify.validate_classify_rules(
        [
            {
                "match": {"labels": {"any-of": ["x"]}},
                "action": "defer",
                "reason": "??",
                "resume-on": "",
            }
        ]
    )
    assert any("resume-on" in e for e in errors)


# ---------------------------------------------------------------------------
# Hold-marker schema validation
# ---------------------------------------------------------------------------


def test_validate_hold_markers_accepts_none():
    errors, _ = triage_classify.validate_hold_markers(None)
    assert errors == []


def test_validate_hold_markers_accepts_empty_list():
    errors, _ = triage_classify.validate_hold_markers([])
    assert errors == []


def test_validate_hold_markers_rejects_non_list():
    errors, _ = triage_classify.validate_hold_markers("BLOCKED")
    assert errors
    assert "must be a list" in errors[0]


def test_validate_hold_markers_rejects_empty_string():
    errors, _ = triage_classify.validate_hold_markers(["", "BLOCKED"])
    assert errors


# ---------------------------------------------------------------------------
# vbrief_validate hooks
# ---------------------------------------------------------------------------


def test_hook_returns_empty_when_unset():
    plan = {"title": "x", "status": "running"}
    assert (
        triage_classify.validate_triage_auto_classify_on_plan(plan, "x.json")
        == []
    )
    assert (
        triage_classify.validate_triage_hold_markers_on_plan(plan, "x.json")
        == []
    )


def test_hook_surfaces_classify_errors_with_1129_pointer():
    plan = {
        "policy": {
            "triageAutoClassify": [
                {
                    "match": {},
                    "action": "defer",
                    "reason": "??",
                }
            ]
        }
    }
    out = triage_classify.validate_triage_auto_classify_on_plan(
        plan, "x.json"
    )
    assert out
    assert all("(#1129)" in e for e in out)


def test_hook_surfaces_hold_marker_errors():
    plan = {"policy": {"triageHoldMarkers": ""}}
    out = triage_classify.validate_triage_hold_markers_on_plan(
        plan, "x.json"
    )
    assert out
    assert all("(#1129)" in e for e in out)


# ---------------------------------------------------------------------------
# §12 framework-vs-consumer boundary -- no deft-specific values leak in
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "forbidden",
    [
        "status:superseded-pending",
        "rfc",
        "type:research",
        "wontfix",
        "duplicate",
        "fixed-pending-merge",
    ],
)
def test_framework_defaults_do_not_reference_deft_labels(forbidden):
    """Framework defaults MUST NOT bake in deft-specific labels (§12)."""
    blob = json.dumps(
        [
            list(triage_classify.UNIVERSAL_RULES),
            list(triage_classify.DEFAULT_HOLD_MARKERS),
        ]
    )
    assert forbidden not in blob


# ---------------------------------------------------------------------------
# extract_referenced_issues helper
# ---------------------------------------------------------------------------


def test_extract_referenced_issues_pulls_from_pending_and_active(tmp_path):
    vbrief_dir = tmp_path / "vbrief"
    (vbrief_dir / "pending").mkdir(parents=True, exist_ok=True)
    (vbrief_dir / "active").mkdir(parents=True, exist_ok=True)
    (vbrief_dir / "completed").mkdir(parents=True, exist_ok=True)

    def _write(folder: str, name: str, issue_n: int) -> None:
        payload = {
            "vBRIEFInfo": {"version": "0.6"},
            "plan": {
                "title": name,
                "status": "running",
                "items": [],
                "references": [
                    {
                        "uri": f"https://github.com/o/r/issues/{issue_n}",
                        "type": "x-vbrief/github-issue",
                    }
                ],
            },
        }
        (vbrief_dir / folder / f"2026-05-17-{name}.vbrief.json").write_text(
            json.dumps(payload), encoding="utf-8"
        )

    _write("pending", "a", 11)
    _write("active", "b", 22)
    _write("completed", "c", 33)
    refs = triage_classify.extract_referenced_issues(project_root=tmp_path)
    assert refs == {11, 22}


# ---------------------------------------------------------------------------
# render_list snapshot
# ---------------------------------------------------------------------------


def test_render_list_includes_universal_and_consumer_rules():
    rules = list(triage_classify.UNIVERSAL_RULES) + [
        {
            "match": {"labels": {"any-of": ["bug"]}},
            "action": "escalate",
            "reason": "p0",
        }
    ]
    out = triage_classify.render_list(rules, hold_markers=["BLOCKED"])
    assert "universal:hold-marker" in out
    assert "universal:closed-never-triaged" in out
    assert "universal:dormant-thin-body" in out
    assert "universal:vbrief-referenced" in out
    assert "consumer rule" in out
    assert "escalate" in out
    assert "BLOCKED" in out


def test_render_list_default_markers():
    out = triage_classify.render_list(triage_classify.UNIVERSAL_RULES)
    assert "do not implement" in out
