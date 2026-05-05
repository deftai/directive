"""Tests for scripts/triage_bulk.py (#845 Story 4 + #915 cache-walk fix).

Covers Test narrative items (1)-(3) from the Story 4 vBRIEF AND the
#915 hardening:

- (1) bulk-accept with --label fixture
- (2) combined --label --age-days filters
- (3) zero-match returns clean exit
- (#915) cache-walk source: ``_list_cached_candidates`` parses sidecars,
  tolerates malformed JSON, returns ``[]`` on missing dir
- (#915) audit-log skip: terminal records ALWAYS short-circuit; in-progress
  records short-circuit unless ``re_action=True``
- (#915) empty-cache hard-fail: ``bulk_action`` raises ``CacheEmptyError``;
  ``main`` translates to exit 2 with the canonical stderr message

Story 3's ``triage_actions`` module may not yet be on the import path. Tests
inject a stub via the ``actions_module`` parameter to keep the suite hermetic.
``candidates_log_module`` is also injected so tests do not depend on the
ambient ``vbrief/.eval/candidates.jsonl`` file.
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
    """Build a minimal cached-issue payload (matches ``triage_cache._GH_FIELDS``)."""
    created = datetime.now(UTC) - timedelta(days=days_old)
    return {
        "number": number,
        "title": f"Issue {number}",
        "body": "",
        "state": "open",
        "labels": [{"name": name} for name in (labels or [])],
        "author": {"login": author},
        "createdAt": created.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "updatedAt": created.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "url": f"https://github.com/deftai/directive/issues/{number}",
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


@pytest.fixture
def empty_audit_log() -> SimpleNamespace:
    """A namespace stub of ``candidates_log`` with an empty ``read_all``."""
    return SimpleNamespace(read_all=lambda **_kw: [])


def _audit_log_with(*entries: dict[str, Any]) -> SimpleNamespace:
    """Build a ``candidates_log`` stub whose ``read_all`` yields the entries."""
    return SimpleNamespace(read_all=lambda **_kw: list(entries))


def _audit_entry(
    issue_number: int,
    decision: str,
    *,
    timestamp: str = "2026-05-05T10:00:00Z",
    repo: str = "deftai/directive",
) -> dict[str, Any]:
    """Build a minimal audit-log entry of the shape ``read_all`` yields."""
    return {
        "decision_id": "00000000-0000-0000-0000-000000000000",
        "timestamp": timestamp,
        "repo": repo,
        "issue_number": issue_number,
        "decision": decision,
        "actor": "agent:test",
    }


# ---------------------------------------------------------------------------
# Tests -- filter semantics (Story 4 AC #4 narrative items 1-3)
# ---------------------------------------------------------------------------


def test_bulk_accept_filters_by_label(
    stub_actions_module: SimpleNamespace, empty_audit_log: SimpleNamespace
) -> None:
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
        candidates_log_module=empty_audit_log,
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
    stub_actions_module: SimpleNamespace, empty_audit_log: SimpleNamespace
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
        candidates_log_module=empty_audit_log,
        issues_provider=lambda _repo: issues,
        out=out,
    )

    assert actioned == 2
    actioned_numbers = sorted(call[1] for call in stub_actions_module.calls)
    assert actioned_numbers == [201, 204]


def test_bulk_action_zero_match_clean_exit(
    stub_actions_module: SimpleNamespace, empty_audit_log: SimpleNamespace
) -> None:
    """(3) Zero-match exits cleanly with status 0 + single summary line."""
    issues = [_issue(301, labels=["docs"])]
    out = io.StringIO()

    actioned = triage_bulk.bulk_action(
        "accept",
        "deftai/directive",
        label="nonexistent-label",
        actions_module=stub_actions_module,
        candidates_log_module=empty_audit_log,
        issues_provider=lambda _repo: issues,
        out=out,
    )

    assert actioned == 0
    assert stub_actions_module.calls == []
    rendered = out.getvalue()
    assert "[triage:bulk-accept] zero matches for given filters" in rendered
    # No per-issue "actioned" lines emitted on the zero-match path.
    assert "actioned" not in rendered.replace("zero matches", "")


# ---------------------------------------------------------------------------
# Tests -- _list_cached_candidates contract (#915)
# ---------------------------------------------------------------------------


def test_list_cached_candidates_returns_empty_on_missing_dir(tmp_path: Path) -> None:
    """Missing cache dir -> empty list (caller translates to hard-fail)."""
    sink = io.StringIO()
    out = triage_bulk._list_cached_candidates(
        "deftai/directive",
        cache_root=tmp_path / "nonexistent",
        out=sink,
    )
    assert out == []


def test_list_cached_candidates_parses_sidecars(tmp_path: Path) -> None:
    """Populated cache -> returns the parsed JSON payloads."""
    cache_root = tmp_path / "issues"
    repo_dir = cache_root / "deftai-directive"
    repo_dir.mkdir(parents=True)
    payload_a = _issue(11, labels=["bug"])
    payload_b = _issue(22, labels=["docs"])
    (repo_dir / "11.json").write_text(json.dumps(payload_a), encoding="utf-8")
    (repo_dir / "22.json").write_text(json.dumps(payload_b), encoding="utf-8")
    sink = io.StringIO()

    out = triage_bulk._list_cached_candidates(
        "deftai/directive", cache_root=cache_root, out=sink
    )

    assert sorted(item["number"] for item in out) == [11, 22]
    # No warnings emitted for clean files.
    assert "WARN" not in sink.getvalue()


def test_list_cached_candidates_tolerates_invalid_json(tmp_path: Path) -> None:
    """A malformed sidecar is logged and skipped; valid entries still surface."""
    cache_root = tmp_path / "issues"
    repo_dir = cache_root / "deftai-directive"
    repo_dir.mkdir(parents=True)
    (repo_dir / "1.json").write_text(json.dumps(_issue(1)), encoding="utf-8")
    (repo_dir / "2.json").write_text("{not valid json", encoding="utf-8")
    (repo_dir / "3.json").write_text("[1, 2, 3]", encoding="utf-8")  # not a dict
    (repo_dir / "4.json").write_text(json.dumps(_issue(4)), encoding="utf-8")
    sink = io.StringIO()

    out = triage_bulk._list_cached_candidates(
        "deftai/directive", cache_root=cache_root, out=sink
    )

    assert sorted(item["number"] for item in out) == [1, 4]
    rendered = sink.getvalue()
    assert "2.json" in rendered  # malformed file flagged
    assert "3.json" in rendered  # non-dict file flagged
    assert "WARN" in rendered


# ---------------------------------------------------------------------------
# Tests -- empty cache hard-fail (#915)
# ---------------------------------------------------------------------------


def test_bulk_action_raises_cache_empty_on_no_candidates(
    stub_actions_module: SimpleNamespace, empty_audit_log: SimpleNamespace
) -> None:
    """``bulk_action`` raises ``CacheEmptyError`` when the candidate set is empty."""
    with pytest.raises(triage_bulk.CacheEmptyError, match="cache is empty for deftai/directive"):
        triage_bulk.bulk_action(
            "defer",
            "deftai/directive",
            actions_module=stub_actions_module,
            candidates_log_module=empty_audit_log,
            issues_provider=lambda _repo: [],
        )


def test_main_empty_cache_returns_exit_2(
    stub_actions_module: SimpleNamespace,
    empty_audit_log: SimpleNamespace,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``main`` translates ``CacheEmptyError`` into exit 2 + canonical stderr."""
    monkeypatch.setitem(sys.modules, "triage_actions", stub_actions_module)
    monkeypatch.setitem(sys.modules, "candidates_log", empty_audit_log)
    # Force the cache walk to return empty regardless of fs state.
    monkeypatch.setattr(
        triage_bulk, "_list_cached_candidates", lambda *_a, **_kw: []
    )

    rc = triage_bulk.main(["defer", "--repo", "deftai/directive"])
    assert rc == 2
    captured = capsys.readouterr()
    assert "cache is empty for deftai/directive" in captured.err
    assert "task triage:bootstrap" in captured.err


# ---------------------------------------------------------------------------
# Tests -- audit-log skip semantics (#915)
# ---------------------------------------------------------------------------


def test_bulk_skips_issues_with_terminal_audit_records(
    stub_actions_module: SimpleNamespace,
) -> None:
    """Terminal decisions (accept/reject/mark-duplicate) ALWAYS short-circuit."""
    issues = [_issue(401), _issue(402), _issue(403)]
    audit = _audit_log_with(
        _audit_entry(401, "accept"),
        _audit_entry(402, "reject"),
    )
    out = io.StringIO()

    actioned = triage_bulk.bulk_action(
        "defer",
        "deftai/directive",
        actions_module=stub_actions_module,
        candidates_log_module=audit,
        issues_provider=lambda _repo: issues,
        out=out,
    )

    assert actioned == 1
    actioned_numbers = sorted(call[1] for call in stub_actions_module.calls)
    assert actioned_numbers == [403]
    rendered = out.getvalue()
    assert "skipped 2 candidate(s) with prior audit-log records" in rendered


def test_bulk_skips_in_progress_records_without_re_action(
    stub_actions_module: SimpleNamespace,
) -> None:
    """defer/needs-ac records short-circuit when ``re_action`` is False."""
    issues = [_issue(501), _issue(502), _issue(503)]
    audit = _audit_log_with(
        _audit_entry(501, "defer"),
        _audit_entry(502, "needs-ac"),
    )
    out = io.StringIO()

    actioned = triage_bulk.bulk_action(
        "defer",
        "deftai/directive",
        actions_module=stub_actions_module,
        candidates_log_module=audit,
        issues_provider=lambda _repo: issues,
        out=out,
    )

    assert actioned == 1
    assert sorted(call[1] for call in stub_actions_module.calls) == [503]
    assert "pass --re-action to override defer/needs-ac records" in out.getvalue()


def test_bulk_re_action_overrides_in_progress_but_not_terminal(
    stub_actions_module: SimpleNamespace,
) -> None:
    """``re_action=True`` re-actions defer/needs-ac but still skips terminal."""
    issues = [_issue(601), _issue(602), _issue(603), _issue(604)]
    audit = _audit_log_with(
        _audit_entry(601, "defer"),
        _audit_entry(602, "needs-ac"),
        _audit_entry(603, "accept"),  # terminal -- still skipped
    )

    actioned = triage_bulk.bulk_action(
        "defer",
        "deftai/directive",
        re_action=True,
        actions_module=stub_actions_module,
        candidates_log_module=audit,
        issues_provider=lambda _repo: issues,
        out=io.StringIO(),
    )

    assert actioned == 3
    actioned_numbers = sorted(call[1] for call in stub_actions_module.calls)
    assert actioned_numbers == [601, 602, 604]


def test_bulk_uses_latest_audit_entry_per_issue(
    stub_actions_module: SimpleNamespace,
) -> None:
    """When multiple records exist for an issue, the latest timestamp wins."""
    issues = [_issue(701)]
    audit = _audit_log_with(
        # First defer, then reset -> latest is reset (non-skipping).
        _audit_entry(701, "defer", timestamp="2026-05-01T10:00:00Z"),
        {
            "decision_id": "11111111-1111-1111-1111-111111111111",
            "timestamp": "2026-05-02T10:00:00Z",
            "repo": "deftai/directive",
            "issue_number": 701,
            "decision": "reset",
            "actor": "agent:test",
            "prior_decision_id": "00000000-0000-0000-0000-000000000000",
        },
    )

    actioned = triage_bulk.bulk_action(
        "defer",
        "deftai/directive",
        actions_module=stub_actions_module,
        candidates_log_module=audit,
        issues_provider=lambda _repo: issues,
        out=io.StringIO(),
    )

    assert actioned == 1
    assert sorted(call[1] for call in stub_actions_module.calls) == [701]


# ---------------------------------------------------------------------------
# Tests -- argparse + signature-mismatch fallback
# ---------------------------------------------------------------------------


def test_argparse_accepts_re_action_flag(
    stub_actions_module: SimpleNamespace,
    empty_audit_log: SimpleNamespace,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``--re-action`` parses cleanly through argparse and forwards to bulk_action."""
    monkeypatch.setitem(sys.modules, "triage_actions", stub_actions_module)
    monkeypatch.setitem(sys.modules, "candidates_log", empty_audit_log)
    monkeypatch.setattr(
        triage_bulk, "_list_cached_candidates", lambda *_a, **_kw: [_issue(1, labels=["bug"])]
    )

    rc = triage_bulk.main(
        ["defer", "--repo", "deftai/directive", "--label", "bug", "--re-action"]
    )
    assert rc == 0


def test_invoke_action_propagates_typeerror_from_action_body(
    stub_actions_module: SimpleNamespace, empty_audit_log: SimpleNamespace
) -> None:
    """A ``TypeError`` raised *inside* a Story 3 action MUST surface."""

    def _broken_accept(_n: int, _repo: str, **_kwargs: object) -> None:
        raise TypeError("unsupported operand type(s) for +: 'int' and 'str'")

    stub_actions_module.accept = _broken_accept
    issues = [_issue(1, labels=["bug"])]

    with pytest.raises(TypeError, match="unsupported operand"):
        triage_bulk.bulk_action(
            "accept",
            "deftai/directive",
            label="bug",
            actions_module=stub_actions_module,
            candidates_log_module=empty_audit_log,
            issues_provider=lambda _repo: issues,
            out=io.StringIO(),
        )


def test_invoke_action_tolerates_signature_mismatch_in_call_site(
    stub_actions_module: SimpleNamespace, empty_audit_log: SimpleNamespace
) -> None:
    """Companion: a real signature mismatch falls back to the positional shape."""
    captured: list[tuple[int, str, str | None]] = []
    call_log: list[str] = []

    def _smart_reject(*args: Any, **kwargs: Any) -> None:
        if kwargs:
            call_log.append("kwarg")
            raise TypeError("got an unexpected keyword argument 'reason'")
        call_log.append("positional")
        captured.append((int(args[0]), str(args[1]), str(args[2]) if len(args) > 2 else None))

    stub_actions_module.reject = _smart_reject
    issues = [_issue(7, labels=["bug"])]

    actioned = triage_bulk.bulk_action(
        "reject",
        "deftai/directive",
        label="bug",
        reason="obsolete",
        actions_module=stub_actions_module,
        candidates_log_module=empty_audit_log,
        issues_provider=lambda _repo: issues,
        out=io.StringIO(),
    )

    assert actioned == 1
    assert call_log == ["kwarg", "positional"]
    assert captured == [(7, "deftai/directive", "obsolete")]


# ---------------------------------------------------------------------------
# Tests -- skip-set helper (pure function)
# ---------------------------------------------------------------------------


def test_build_skip_set_default_includes_terminal_and_in_progress() -> None:
    skip = triage_bulk._build_skip_set(False)
    assert skip == {"accept", "reject", "mark-duplicate", "defer", "needs-ac"}


def test_build_skip_set_re_action_excludes_in_progress() -> None:
    skip = triage_bulk._build_skip_set(True)
    assert skip == {"accept", "reject", "mark-duplicate"}
    assert "defer" not in skip
    assert "needs-ac" not in skip
