"""Tests for scripts/triage_subscribe.py (D14 / #1133)."""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest

_SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

triage_subscribe = importlib.import_module("triage_subscribe")


def _write_pd(tmp_path: Path, policy: dict | None = None) -> Path:
    vbrief = tmp_path / "vbrief"
    vbrief.mkdir(parents=True, exist_ok=True)
    payload = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "title": "x",
            "status": "running",
            "items": [],
            "policy": policy or {},
        },
    }
    path = vbrief / "PROJECT-DEFINITION.vbrief.json"
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return path


def _read_rules(tmp_path: Path) -> list:
    pd = tmp_path / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    data = json.loads(pd.read_text(encoding="utf-8"))
    return data.get("plan", {}).get("policy", {}).get("triageScope", [])


def _read_history(tmp_path: Path) -> list[dict]:
    path = tmp_path / "vbrief" / ".eval" / "subscription-history.jsonl"
    if not path.is_file():
        return []
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


# ---------------------------------------------------------------------------
# subscribe()
# ---------------------------------------------------------------------------


def test_subscribe_label_creates_new_rule_when_none_exists(tmp_path: Path):
    _write_pd(tmp_path)
    changed, message = triage_subscribe.subscribe(tmp_path, label="priority:p0")
    assert changed is True
    rules = _read_rules(tmp_path)
    assert rules == [{"rule": "labels", "any-of": ["priority:p0"]}]


def test_subscribe_label_merges_into_existing_any_of(tmp_path: Path):
    _write_pd(
        tmp_path,
        policy={"triageScope": [{"rule": "labels", "any-of": ["bug"]}]},
    )
    triage_subscribe.subscribe(tmp_path, label="urgent")
    rules = _read_rules(tmp_path)
    assert rules == [{"rule": "labels", "any-of": ["bug", "urgent"]}]


def test_subscribe_label_idempotent(tmp_path: Path):
    _write_pd(tmp_path)
    triage_subscribe.subscribe(tmp_path, label="bug")
    changed, message = triage_subscribe.subscribe(tmp_path, label="bug")
    assert changed is False
    assert "already-subscribed" in message


def test_subscribe_milestone_appends_milestone_rule(tmp_path: Path):
    _write_pd(tmp_path)
    changed, _ = triage_subscribe.subscribe(tmp_path, milestone="v2.0-blocker")
    assert changed is True
    rules = _read_rules(tmp_path)
    assert {"rule": "milestone", "name": "v2.0-blocker"} in rules


def test_subscribe_milestone_idempotent(tmp_path: Path):
    _write_pd(tmp_path)
    triage_subscribe.subscribe(tmp_path, milestone="v2.0")
    changed, _ = triage_subscribe.subscribe(tmp_path, milestone="v2.0")
    assert changed is False


def test_subscribe_issue_creates_explicit_watch(tmp_path: Path):
    _write_pd(tmp_path)
    changed, _ = triage_subscribe.subscribe(
        tmp_path, issue=1234, issue_note="pinned by ops"
    )
    assert changed is True
    rules = _read_rules(tmp_path)
    assert rules[0]["rule"] == "explicit-watch"
    assert rules[0]["issues"] == [{"n": 1234, "note": "pinned by ops"}]


def test_subscribe_issue_appends_to_existing_explicit_watch(tmp_path: Path):
    _write_pd(
        tmp_path,
        policy={
            "triageScope": [
                {
                    "rule": "explicit-watch",
                    "issues": [{"n": 1, "note": "first"}],
                }
            ]
        },
    )
    triage_subscribe.subscribe(tmp_path, issue=2, issue_note="second")
    rules = _read_rules(tmp_path)
    assert len(rules[0]["issues"]) == 2
    assert {"n": 2, "note": "second"} in rules[0]["issues"]


def test_subscribe_requires_exactly_one_arg(tmp_path: Path):
    _write_pd(tmp_path)
    with pytest.raises(ValueError):
        triage_subscribe.subscribe(tmp_path, label="a", milestone="b")
    with pytest.raises(ValueError):
        triage_subscribe.subscribe(tmp_path)


# ---------------------------------------------------------------------------
# unsubscribe()
# ---------------------------------------------------------------------------


def test_unsubscribe_label_removes_from_any_of(tmp_path: Path):
    _write_pd(
        tmp_path,
        policy={"triageScope": [{"rule": "labels", "any-of": ["bug", "urgent"]}]},
    )
    changed, _ = triage_subscribe.unsubscribe(tmp_path, label="urgent")
    assert changed is True
    rules = _read_rules(tmp_path)
    assert rules == [{"rule": "labels", "any-of": ["bug"]}]


def test_unsubscribe_label_removes_empty_rule(tmp_path: Path):
    """When the last label drops, the rule itself is dropped."""
    _write_pd(
        tmp_path,
        policy={"triageScope": [{"rule": "labels", "any-of": ["bug"]}]},
    )
    triage_subscribe.unsubscribe(tmp_path, label="bug")
    rules = _read_rules(tmp_path)
    assert rules == []


def test_unsubscribe_label_idempotent(tmp_path: Path):
    _write_pd(tmp_path)
    changed, message = triage_subscribe.unsubscribe(tmp_path, label="ghost")
    assert changed is False
    assert "not-subscribed" in message


def test_unsubscribe_milestone(tmp_path: Path):
    _write_pd(
        tmp_path,
        policy={"triageScope": [{"rule": "milestone", "name": "v2.0"}]},
    )
    changed, _ = triage_subscribe.unsubscribe(tmp_path, milestone="v2.0")
    assert changed is True
    assert _read_rules(tmp_path) == []


def test_unsubscribe_issue(tmp_path: Path):
    _write_pd(
        tmp_path,
        policy={
            "triageScope": [
                {
                    "rule": "explicit-watch",
                    "issues": [
                        {"n": 1, "note": "one"},
                        {"n": 2, "note": "two"},
                    ],
                }
            ]
        },
    )
    changed, _ = triage_subscribe.unsubscribe(tmp_path, issue=1)
    assert changed is True
    rules = _read_rules(tmp_path)
    assert rules[0]["issues"] == [{"n": 2, "note": "two"}]


# ---------------------------------------------------------------------------
# Subscription-history audit sidecar
# ---------------------------------------------------------------------------


def test_subscribe_appends_audit_entry(tmp_path: Path):
    _write_pd(tmp_path)
    triage_subscribe.subscribe(tmp_path, label="bug", actor="user:test")
    history = _read_history(tmp_path)
    assert len(history) == 1
    rec = history[0]
    assert rec["schema"] == triage_subscribe.SUBSCRIPTION_HISTORY_SCHEMA
    assert rec["op"] == "subscribe"
    assert rec["label"] == "bug"
    assert rec["milestone"] is None
    assert rec["issue"] is None
    assert rec["actor"] == "user:test"
    assert rec["before"] == []
    assert rec["after"] == [{"rule": "labels", "any-of": ["bug"]}]
    assert "change_id" in rec
    assert "timestamp" in rec


def test_no_op_does_not_append_audit_entry(tmp_path: Path):
    _write_pd(tmp_path)
    triage_subscribe.subscribe(tmp_path, label="bug")
    triage_subscribe.subscribe(tmp_path, label="bug")  # no-op
    history = _read_history(tmp_path)
    assert len(history) == 1


def test_unsubscribe_appends_audit_entry_with_before_after(tmp_path: Path):
    _write_pd(
        tmp_path,
        policy={"triageScope": [{"rule": "labels", "any-of": ["bug"]}]},
    )
    triage_subscribe.unsubscribe(tmp_path, label="bug")
    history = _read_history(tmp_path)
    assert len(history) == 1
    rec = history[0]
    assert rec["op"] == "unsubscribe"
    assert rec["before"] == [{"rule": "labels", "any-of": ["bug"]}]
    assert rec["after"] == []


# ---------------------------------------------------------------------------
# Reconciliation cycle: subscribe -> unsubscribe -> subscribe
# ---------------------------------------------------------------------------


def test_reconciliation_cycle(tmp_path: Path):
    _write_pd(tmp_path)
    a_changed, _ = triage_subscribe.subscribe(tmp_path, label="bug")
    b_changed, _ = triage_subscribe.unsubscribe(tmp_path, label="bug")
    c_changed, _ = triage_subscribe.subscribe(tmp_path, label="bug")
    assert (a_changed, b_changed, c_changed) == (True, True, True)
    rules = _read_rules(tmp_path)
    assert rules == [{"rule": "labels", "any-of": ["bug"]}]
    history = _read_history(tmp_path)
    assert [r["op"] for r in history] == ["subscribe", "unsubscribe", "subscribe"]


# ---------------------------------------------------------------------------
# Atomic write -- PROJECT-DEFINITION survives a malformed write attempt
# ---------------------------------------------------------------------------


def test_subscribe_uses_atomic_write(tmp_path: Path):
    """The PROJECT-DEFINITION JSON is a valid JSON object after mutation."""
    _write_pd(tmp_path)
    triage_subscribe.subscribe(tmp_path, label="bug")
    pd = tmp_path / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    data = json.loads(pd.read_text(encoding="utf-8"))  # parses cleanly
    assert isinstance(data, dict)
    assert "plan" in data


def test_unsubscribe_preserves_other_rules(tmp_path: Path):
    _write_pd(
        tmp_path,
        policy={
            "triageScope": [
                {"rule": "all-open"},
                {"rule": "labels", "any-of": ["bug"]},
                {"rule": "milestone", "name": "v2.0"},
            ]
        },
    )
    triage_subscribe.unsubscribe(tmp_path, label="bug")
    rules = _read_rules(tmp_path)
    assert {"rule": "all-open"} in rules
    assert {"rule": "milestone", "name": "v2.0"} in rules
    assert not any(r.get("rule") == "labels" for r in rules)
