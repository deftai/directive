"""Tests for scripts/triage_bulk.py (#845 Story 4 AC #4 -- bulk cases).

Covers Test narrative items (1)-(3) from the Story 4 vBRIEF:

- (1) bulk-accept with --label fixture
- (2) combined --label --age-days filters
- (3) zero-match returns clean exit

Story 3's ``triage_actions`` module may not yet be on the import path. Tests
inject a stub via the ``actions_module`` parameter to keep the suite hermetic.
"""

from __future__ import annotations

import importlib
import io
import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

# Surface scripts/ on sys.path so we can import triage_bulk by short name; this
# matches how the production Taskfile target dispatches the script (`uv run
# python "{{.DEFT_ROOT}}/scripts/triage_bulk.py" ...`).
_SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

triage_bulk = importlib.import_module("triage_bulk")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _issue(
    number: int,
    *,
    labels: list[str] | None = None,
    author: str = "octocat",
    days_old: int = 0,
) -> dict[str, object]:
    """Build a minimal ``gh issue list --json`` shaped record."""
    created = datetime.now(UTC) - timedelta(days=days_old)
    return {
        "number": number,
        "title": f"Issue {number}",
        "labels": [{"name": name} for name in (labels or [])],
        "author": {"login": author},
        "createdAt": created.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "updatedAt": created.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


@pytest.fixture
def stub_actions_module() -> SimpleNamespace:
    """A namespace-shaped stub of Story 3's ``triage_actions``.

    Each callable records every (action, n, repo, kwargs) invocation onto the
    ``calls`` list so tests can assert per-action loop semantics.
    """
    calls: list[tuple[str, int, str, dict[str, object]]] = []

    def _record(name: str):
        def _fn(n: int, repo: str, **kwargs: object) -> None:
            calls.append((name, n, repo, kwargs))

        return _fn

    return SimpleNamespace(
        accept=_record("accept"),
        reject=_record("reject"),
        defer=_record("defer"),
        needs_ac=_record("needs-ac"),
        calls=calls,
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_bulk_accept_filters_by_label(stub_actions_module: SimpleNamespace) -> None:
    """(1) bulk-accept --label fixture loops Story 3.accept only over matched."""
    issues = [
        _issue(101, labels=["triage", "bug"]),
        _issue(102, labels=["enhancement"]),
        _issue(103, labels=["bug"]),
    ]
    out = io.StringIO()

    actioned = triage_bulk.bulk_action(
        "accept",
        "deftai/directive",
        label="bug",
        actions_module=stub_actions_module,
        issues_provider=lambda _repo: issues,
        out=out,
    )

    assert actioned == 2
    actioned_numbers = sorted(call[1] for call in stub_actions_module.calls)
    assert actioned_numbers == [101, 103]
    # Every recorded call goes through accept (no other Story 3 fn invoked).
    assert {call[0] for call in stub_actions_module.calls} == {"accept"}
    # User-visible total line emitted.
    assert "[triage:bulk-accept] total: 2" in out.getvalue()


def test_bulk_accept_combined_label_and_age_days(
    stub_actions_module: SimpleNamespace,
) -> None:
    """(2) Combined --label --age-days filters apply with AND semantics."""
    issues = [
        _issue(201, labels=["bug"], days_old=10),  # matches both -> ACTION
        _issue(202, labels=["bug"], days_old=2),  # too fresh -> SKIP
        _issue(203, labels=["docs"], days_old=30),  # wrong label -> SKIP
        _issue(204, labels=["bug", "p0"], days_old=15),  # matches both -> ACTION
    ]
    out = io.StringIO()

    actioned = triage_bulk.bulk_action(
        "accept",
        "deftai/directive",
        label="bug",
        age_days=7,
        actions_module=stub_actions_module,
        issues_provider=lambda _repo: issues,
        out=out,
    )

    assert actioned == 2
    actioned_numbers = sorted(call[1] for call in stub_actions_module.calls)
    assert actioned_numbers == [201, 204]


def test_bulk_action_zero_match_clean_exit(
    stub_actions_module: SimpleNamespace,
) -> None:
    """(3) Zero-match exits cleanly with status 0 + single summary line."""
    issues = [_issue(301, labels=["docs"])]
    out = io.StringIO()

    actioned = triage_bulk.bulk_action(
        "accept",
        "deftai/directive",
        label="nonexistent-label",
        actions_module=stub_actions_module,
        issues_provider=lambda _repo: issues,
        out=out,
    )

    assert actioned == 0
    assert stub_actions_module.calls == []
    rendered = out.getvalue()
    assert "[triage:bulk-accept] zero matches for given filters" in rendered
    # No per-issue "actioned" lines emitted on the zero-match path.
    assert "actioned" not in rendered.replace("zero matches", "")


def test_list_open_issues_warns_when_at_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Greptile P2 (PR #875): emit an explicit truncation warning when the
    returned issue count meets ``--limit`` -- silent truncation is forbidden.
    """
    payload_issues = [{"number": i, "labels": [], "author": {}} for i in range(5)]

    class _Fake:
        stdout = json.dumps(payload_issues)

    def _fake_run(_cmd, **_kwargs):
        return _Fake()

    monkeypatch.setattr(triage_bulk.subprocess, "run", _fake_run)
    sink = io.StringIO()

    issues = triage_bulk._list_open_issues("deftai/directive", limit=5, out=sink)

    assert len(issues) == 5
    rendered = sink.getvalue()
    assert "WARN" in rendered
    assert "--limit 5" in rendered


def test_invoke_action_propagates_typeerror_from_action_body(
    stub_actions_module: SimpleNamespace,
) -> None:
    """Greptile P2 (PR #875): a ``TypeError`` raised *inside* a Story 3 action
    MUST surface to the operator instead of being swallowed by the
    signature-mismatch fallback.
    """

    def _broken_accept(_n: int, _repo: str, **_kwargs: object) -> None:
        # Genuine bug inside Story 3 -- not a call-site signature issue.
        raise TypeError("unsupported operand type(s) for +: 'int' and 'str'")

    stub_actions_module.accept = _broken_accept
    issues = [{"number": 1, "labels": [{"name": "bug"}], "author": {}}]

    with pytest.raises(TypeError, match="unsupported operand"):
        triage_bulk.bulk_action(
            "accept",
            "deftai/directive",
            label="bug",
            actions_module=stub_actions_module,
            issues_provider=lambda _repo: issues,
            out=io.StringIO(),
        )


def test_invoke_action_tolerates_signature_mismatch_in_call_site(
    stub_actions_module: SimpleNamespace,
) -> None:
    """Companion to the above: a real signature mismatch (kwarg unsupported)
    still falls back to the positional shape.
    """
    captured: list[tuple[int, str, str | None]] = []
    call_log: list[str] = []

    def _smart_reject(*args: Any, **kwargs: Any) -> None:
        # First call raises the canonical kwarg-unsupported signature
        # ``TypeError``; the fallback positional call then succeeds.
        # ``*args: Any`` (rather than ``object``) is required so mypy
        # admits ``int(args[0])`` / ``str(args[1])`` -- the ``object``
        # annotation has no overload for ``int(...)`` (Python CI mypy
        # call-overload regression on PR #875 post-rebase).
        if kwargs:
            call_log.append("kwarg")
            raise TypeError("got an unexpected keyword argument 'reason'")
        call_log.append("positional")
        captured.append((int(args[0]), str(args[1]), str(args[2]) if len(args) > 2 else None))

    stub_actions_module.reject = _smart_reject
    issues = [{"number": 7, "labels": [{"name": "bug"}], "author": {}}]

    actioned = triage_bulk.bulk_action(
        "reject",
        "deftai/directive",
        label="bug",
        reason="obsolete",
        actions_module=stub_actions_module,
        issues_provider=lambda _repo: issues,
        out=io.StringIO(),
    )

    assert actioned == 1
    assert call_log == ["kwarg", "positional"]
    assert captured == [(7, "deftai/directive", "obsolete")]


def test_resolve_limit_prefers_cli_then_env_then_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Greptile P1 (PR #875): the documented ``--limit`` / env-var overrides
    MUST resolve in CLI > env-var > default order, with malformed env-var
    values falling back to the default.
    """
    monkeypatch.delenv(triage_bulk.LIMIT_ENV_VAR, raising=False)
    assert triage_bulk._resolve_limit(None) == triage_bulk.DEFAULT_ISSUE_LIST_LIMIT
    assert triage_bulk._resolve_limit(2500) == 2500

    monkeypatch.setenv(triage_bulk.LIMIT_ENV_VAR, "3000")
    assert triage_bulk._resolve_limit(None) == 3000
    # CLI still wins over env when both are present.
    assert triage_bulk._resolve_limit(500) == 500

    # Malformed env-var value -> default fallback (defensive parse).
    monkeypatch.setenv(triage_bulk.LIMIT_ENV_VAR, "not-an-int")
    assert triage_bulk._resolve_limit(None) == triage_bulk.DEFAULT_ISSUE_LIST_LIMIT


def test_argparse_accepts_limit_flag(
    stub_actions_module: SimpleNamespace,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Greptile P1 (PR #875): ``--limit N`` parses cleanly through argparse
    -- it MUST NOT raise ``unrecognized arguments``.
    """
    monkeypatch.setitem(sys.modules, "triage_actions", stub_actions_module)
    monkeypatch.setattr(triage_bulk, "_list_open_issues", lambda *_args, **_kw: [])

    rc = triage_bulk.main(
        ["accept", "--repo", "deftai/directive", "--label", "bug", "--limit", "50"]
    )
    assert rc == 0


def test_main_zero_match_exits_zero(
    stub_actions_module: SimpleNamespace,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The CLI ``main`` returns 0 on zero-match per Story 4 Constraint."""
    monkeypatch.setitem(sys.modules, "triage_actions", stub_actions_module)
    # Stub matches the post-PR-#875 signature (`limit` + `out` kwargs).
    monkeypatch.setattr(triage_bulk, "_list_open_issues", lambda *_a, **_k: [])

    rc = triage_bulk.main(["accept", "--repo", "deftai/directive", "--label", "anything"])
    assert rc == 0
