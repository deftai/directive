"""Regression tests for #1420 -- triage:reject + a missing triage-rejected label.

`task triage:reject` used to run ``gh issue edit --add-label triage-rejected``
unconditionally after closing the issue. On a repository that lacks the
``triage-rejected`` label the edit failed and the whole reject rolled back
-- even though the issue had already been closed with a reason. These tests
pin the fixed contract:

- A missing label is auto-created and the label re-applied.
- If auto-create / re-add still fails, the reject is NOT rolled back (the
  close already took effect); a warning is surfaced on stderr.
- A non-missing-label add failure (e.g. auth) is tolerated the same way.
- A ``gh issue close`` failure DOES still roll the audit entry back -- the
  close is the only load-bearing step.

The suite is hermetic: ``_run_gh`` and ``candidates_log`` are faked so no
real ``gh`` process or audit file is touched.
"""

from __future__ import annotations

import importlib
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

_SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

triage_actions = importlib.import_module("triage_actions")

REPO = "deftai/directive"


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


def _fake_candidates_log() -> SimpleNamespace:
    """Stub of ``candidates_log`` recording appends (mirrors test_triage_actions)."""

    appended: list[dict[str, Any]] = []
    state = {"latest": None}

    def append(entry: dict[str, Any], *, path: Path | None = None) -> str:
        appended.append(entry)
        return str(entry["decision_id"])

    def latest_decision(_n: int, _repo: str) -> dict | None:
        return state["latest"]

    def find_by_issue(n: int, _repo: str) -> list[dict]:
        return [e for e in appended if e.get("issue_number") == n]

    return SimpleNamespace(
        append=append,
        latest_decision=latest_decision,
        find_by_issue=find_by_issue,
        new_decision_id=lambda: "11111111-1111-1111-1111-111111111111",
        appended=appended,
        state=state,
    )


def _ok() -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args=["gh"], returncode=0, stdout="", stderr="")


def _add_label_in(args: list[str]) -> bool:
    return args[:2] == ["issue", "edit"] and "--add-label" in args


# ---------------------------------------------------------------------------
# Happy path: missing label is auto-created, then re-applied
# ---------------------------------------------------------------------------


def test_reject_autocreates_missing_label_and_persists(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    log = _fake_candidates_log()
    monkeypatch.setattr(triage_actions, "candidates_log", log)

    rolled_back: list[Any] = []
    monkeypatch.setattr(
        triage_actions,
        "_rollback_audit_entry",
        lambda *a, **k: rolled_back.append(a),
    )

    calls: list[list[str]] = []
    label_state = {"exists": False}

    def fake_gh(args: list[str]) -> subprocess.CompletedProcess[str]:
        calls.append(list(args))
        if args[:2] == ["issue", "close"]:
            return _ok()
        if args[:2] == ["label", "create"]:
            label_state["exists"] = True
            return _ok()
        if _add_label_in(args):
            if not label_state["exists"]:
                raise triage_actions.UpstreamCloseError(
                    "gh issue edit failed: 'triage-rejected' not found"
                )
            return _ok()
        return _ok()

    monkeypatch.setattr(triage_actions, "_run_gh", fake_gh)

    decision_id = triage_actions.reject(42, REPO, "obsolete", actor="agent:test")

    # The decision was recorded and NOT rolled back.
    assert decision_id == "11111111-1111-1111-1111-111111111111"
    assert len(log.appended) == 1
    assert log.appended[0]["decision"] == "reject"
    assert rolled_back == []

    # The flow: close -> add-label (fails, missing) -> label create -> add-label.
    verbs = [tuple(c[:2]) for c in calls]
    assert ("issue", "close") in verbs
    assert ("label", "create") in verbs
    add_label_attempts = [c for c in calls if _add_label_in(c)]
    assert len(add_label_attempts) == 2, calls
    # The created label carries the canonical name + color/description.
    create_call = next(c for c in calls if c[:2] == ["label", "create"])
    assert triage_actions.REJECTED_LABEL in create_call
    assert triage_actions.REJECTED_LABEL_COLOR in create_call


# ---------------------------------------------------------------------------
# Tolerated failures: create / re-add fails, but the close still stands
# ---------------------------------------------------------------------------


def test_reject_tolerates_label_create_failure_without_rollback(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    log = _fake_candidates_log()
    monkeypatch.setattr(triage_actions, "candidates_log", log)

    rolled_back: list[Any] = []
    monkeypatch.setattr(
        triage_actions,
        "_rollback_audit_entry",
        lambda *a, **k: rolled_back.append(a),
    )

    def fake_gh(args: list[str]) -> subprocess.CompletedProcess[str]:
        if args[:2] == ["issue", "close"]:
            return _ok()
        if args[:2] == ["label", "create"]:
            raise triage_actions.UpstreamCloseError(
                "gh label create failed: HTTP 403 forbidden"
            )
        if _add_label_in(args):
            raise triage_actions.UpstreamCloseError(
                "gh issue edit failed: 'triage-rejected' not found"
            )
        return _ok()

    monkeypatch.setattr(triage_actions, "_run_gh", fake_gh)

    decision_id = triage_actions.reject(7, REPO, "stale", actor="agent:test")

    # Reject persisted despite the label never landing -- no rollback.
    assert decision_id == "11111111-1111-1111-1111-111111111111"
    assert len(log.appended) == 1
    assert rolled_back == []
    err = capsys.readouterr().err
    assert "triage-rejected" in err
    assert "#7" in err


def test_reject_tolerates_non_missing_label_add_failure(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """An add-label failure unrelated to a missing label is tolerated too.

    A failure that does not look like a missing label (e.g. an auth error)
    must NOT trigger a label-create attempt and must NOT roll back the
    already-closed issue.
    """
    log = _fake_candidates_log()
    monkeypatch.setattr(triage_actions, "candidates_log", log)

    rolled_back: list[Any] = []
    monkeypatch.setattr(
        triage_actions,
        "_rollback_audit_entry",
        lambda *a, **k: rolled_back.append(a),
    )

    calls: list[list[str]] = []

    def fake_gh(args: list[str]) -> subprocess.CompletedProcess[str]:
        calls.append(list(args))
        if args[:2] == ["issue", "close"]:
            return _ok()
        if _add_label_in(args):
            raise triage_actions.UpstreamCloseError(
                "gh issue edit failed: HTTP 401 must authenticate"
            )
        return _ok()

    monkeypatch.setattr(triage_actions, "_run_gh", fake_gh)

    decision_id = triage_actions.reject(9, REPO, "dup", actor="agent:test")

    assert decision_id == "11111111-1111-1111-1111-111111111111"
    assert rolled_back == []
    # No label-create attempt for a non-missing-label failure.
    assert not any(c[:2] == ["label", "create"] for c in calls)
    assert "triage-rejected" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# The close is still load-bearing: a close failure rolls back
# ---------------------------------------------------------------------------


def test_reject_still_rolls_back_on_close_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    log = _fake_candidates_log()
    monkeypatch.setattr(triage_actions, "candidates_log", log)

    rolled_back: list[str] = []
    monkeypatch.setattr(
        triage_actions,
        "_rollback_audit_entry",
        lambda decision_id, **k: rolled_back.append(decision_id),
    )

    def fake_gh(args: list[str]) -> subprocess.CompletedProcess[str]:
        if args[:2] == ["issue", "close"]:
            raise triage_actions.UpstreamCloseError(
                "gh issue close failed: not authorized"
            )
        return _ok()

    monkeypatch.setattr(triage_actions, "_run_gh", fake_gh)

    with pytest.raises(triage_actions.UpstreamCloseError):
        triage_actions.reject(13, REPO, "obsolete", actor="agent:test")

    # The close failure rolled the audit entry back.
    assert rolled_back == ["11111111-1111-1111-1111-111111111111"]


# ---------------------------------------------------------------------------
# Helper-level units
# ---------------------------------------------------------------------------


def test_looks_like_missing_label_matches_not_found() -> None:
    exc = triage_actions.UpstreamCloseError("'triage-rejected' not found")
    assert triage_actions._looks_like_missing_label(exc) is True


def test_looks_like_missing_label_false_for_auth_error() -> None:
    exc = triage_actions.UpstreamCloseError("HTTP 401 must authenticate")
    assert triage_actions._looks_like_missing_label(exc) is False


def test_ensure_label_exists_swallows_already_exists(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_gh(args: list[str]) -> subprocess.CompletedProcess[str]:
        raise triage_actions.UpstreamCloseError(
            "gh label create failed: label already exists"
        )

    monkeypatch.setattr(triage_actions, "_run_gh", fake_gh)
    # Already-exists is the idempotent happy case -- it must NOT raise.
    triage_actions._ensure_label_exists(REPO)


def test_ensure_label_exists_propagates_other_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_gh(args: list[str]) -> subprocess.CompletedProcess[str]:
        raise triage_actions.UpstreamCloseError("gh label create failed: forbidden")

    monkeypatch.setattr(triage_actions, "_run_gh", fake_gh)
    with pytest.raises(triage_actions.UpstreamCloseError):
        triage_actions._ensure_label_exists(REPO)
