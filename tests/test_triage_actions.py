"""Tests for scripts/triage_actions.py (#845 Story 3).

Covers the 10 cases enumerated in the Story 3 vBRIEF Test narrative:

1. accept records audit entry
2. reject closes upstream + records + labels (mock ``gh``)
3. defer records
4. needs-ac records + posts AC-request comment to upstream
5. mark-duplicate validates target
6. status returns latest
7. history returns timeline ordered by timestamp
8. reset writes new entry referencing prior
9. reject failure rolls back audit entry
10. idempotent re-action is no-op

Story 1 + Story 2 modules (``triage_cache``, ``candidates_log``) may not exist
on master when this PR is opened. Tests therefore install lightweight fakes
via ``monkeypatch.setattr(triage_actions, "candidates_log", ...)``.

Author: Agent A3 (#845 swarm wave 2)
"""

from __future__ import annotations

import importlib.util
import itertools
import json
import sys
from contextlib import contextmanager as contextlib_contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

# Load triage_actions through importlib so the test file works whether or not
# scripts/ is on sys.path. Mirrors the conftest pattern for run.py.
_SCRIPT_PATH = Path(__file__).parent.parent / "scripts" / "triage_actions.py"
_spec = importlib.util.spec_from_file_location("triage_actions", _SCRIPT_PATH)
assert _spec is not None and _spec.loader is not None
triage_actions = importlib.util.module_from_spec(_spec)
sys.modules["triage_actions"] = triage_actions
_spec.loader.exec_module(triage_actions)


# Fixtures -----------------------------------------------------------------


@pytest.fixture
def audit_log_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Provide an isolated JSONL audit-log path; patch the script's resolver."""
    path = tmp_path / "vbrief" / ".eval" / "candidates.jsonl"
    path.parent.mkdir(parents=True)
    path.touch()
    monkeypatch.setattr(triage_actions, "_audit_log_path", lambda *_, **__: path)
    return path


@pytest.fixture
def monotonic_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    """Replace ``triage_actions._now_iso`` with a strictly monotonic source.

    Real ``datetime.now`` resolution on Windows is ~16 ms; rapid back-to-back
    actions in tests can collide and break ``history`` ordering. A counter-
    based timestamp removes the flake.
    """
    counter = itertools.count(1)

    def _fake_now() -> str:
        seconds = next(counter)
        # Format: 2026-01-01T00:00:01Z, 2026-01-01T00:00:02Z, ...
        return f"2026-01-01T00:{seconds // 60:02d}:{seconds % 60:02d}Z"

    monkeypatch.setattr(triage_actions, "_now_iso", _fake_now)


@pytest.fixture
def fake_log(
    monkeypatch: pytest.MonkeyPatch,
    audit_log_path: Path,
    monotonic_clock: None,
) -> SimpleNamespace:
    """Install a fake ``candidates_log`` module that writes to audit_log_path.

    Implements the frozen Story 2 surface:
      append(entry) -> str
      latest_decision(issue_number, repo) -> dict | None
      find_by_issue(issue_number, repo) -> list[dict]

    Per the strict Story 2 writer contract, ``entry`` MUST already contain
    ``decision_id`` and ``timestamp`` -- the fake mirrors that and does not
    fill them in. ``triage_actions._build_entry`` is responsible for both.
    """
    entries: list[dict] = []

    def append(entry: dict) -> str:
        if "decision_id" not in entry or "timestamp" not in entry:
            raise AssertionError(
                "caller must supply decision_id and timestamp "
                "(Story 2 writer contract); got: " + repr(sorted(entry))
            )
        record = dict(entry)
        with audit_log_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")
        entries.append(record)
        return record["decision_id"]

    def _matches(entry: dict, issue_number: int, repo: str) -> bool:
        return entry.get("issue_number") == issue_number and entry.get("repo") == repo

    def _live() -> list[dict]:
        # Re-read from disk so rollback is reflected (the on-disk file is the
        # authoritative source per Story 2's append-only contract).
        out: list[dict] = []
        with audit_log_path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        return out

    def latest_decision(issue_number: int, repo: str) -> dict | None:
        matching = [e for e in _live() if _matches(e, issue_number, repo)]
        return matching[-1] if matching else None

    def find_by_issue(issue_number: int, repo: str) -> list[dict]:
        return [e for e in _live() if _matches(e, issue_number, repo)]

    fake = SimpleNamespace(
        append=append,
        latest_decision=latest_decision,
        find_by_issue=find_by_issue,
        _entries=entries,
    )
    monkeypatch.setattr(triage_actions, "candidates_log", fake)
    return fake


@pytest.fixture
def fake_cache(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    """Install a fake ``triage_cache`` whose ``show()`` succeeds for known IDs."""
    known: set[tuple[int, str]] = set()

    def show(issue_number: int, repo: str) -> str:
        if (int(issue_number), repo) not in known:
            raise FileNotFoundError(f"#{issue_number} not in cache for {repo}")
        return f"# Issue #{issue_number} body (cached)\n"

    fake = SimpleNamespace(show=show, _known=known)
    monkeypatch.setattr(triage_actions, "triage_cache", fake)
    return fake


@pytest.fixture
def gh_calls(monkeypatch: pytest.MonkeyPatch) -> list[list[str]]:
    """Capture all ``_run_gh`` invocations; succeed by default."""
    calls: list[list[str]] = []

    def _fake(args: list[str]):
        calls.append(list(args))
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(triage_actions, "_run_gh", _fake)
    return calls


REPO = "deftai/directive"


# Test cases ---------------------------------------------------------------


def test_accept_records_audit_entry(fake_log, gh_calls):
    """Case 1: accept records an audit entry."""
    decision_id = triage_actions.accept(845, REPO, actor="msadams")
    assert decision_id
    latest = fake_log.latest_decision(845, REPO)
    assert latest is not None
    assert latest["decision"] == "accept"
    assert latest["issue_number"] == 845
    assert latest["repo"] == REPO
    assert latest["actor"] == "msadams"
    # accept does NOT call gh.
    assert gh_calls == []


def test_reject_closes_upstream_and_labels(fake_log, gh_calls):
    """Case 2: reject closes upstream + records + applies label."""
    decision_id = triage_actions.reject(
        845, REPO, "out of scope for v1", actor="msadams"
    )
    assert decision_id
    # Audit entry recorded.
    latest = fake_log.latest_decision(845, REPO)
    assert latest["decision"] == "reject"
    assert latest["reason"] == "out of scope for v1"
    # Two gh calls in expected order: close, then add label.
    assert len(gh_calls) == 2
    assert gh_calls[0][:3] == ["issue", "close", "845"]
    assert "--reason" in gh_calls[0]
    assert gh_calls[0][gh_calls[0].index("--reason") + 1] == "not planned"
    assert "--comment" in gh_calls[0]
    assert gh_calls[0][gh_calls[0].index("--comment") + 1] == "out of scope for v1"
    assert gh_calls[1][:3] == ["issue", "edit", "845"]
    assert "--add-label" in gh_calls[1]
    assert gh_calls[1][gh_calls[1].index("--add-label") + 1] == "triage-rejected"


def test_defer_records_audit_entry(fake_log, gh_calls):
    """Case 3: defer records an audit entry; no upstream call."""
    decision_id = triage_actions.defer(845, REPO, actor="msadams")
    assert decision_id
    latest = fake_log.latest_decision(845, REPO)
    assert latest["decision"] == "defer"
    assert gh_calls == []


def test_needs_ac_records_and_posts_comment(fake_log, gh_calls):
    """Case 4: needs-ac records + posts AC-request comment upstream."""
    decision_id = triage_actions.needs_ac(845, REPO, actor="msadams")
    assert decision_id
    latest = fake_log.latest_decision(845, REPO)
    assert latest["decision"] == "needs-ac"
    # gh issue comment posted with a non-empty body.
    assert len(gh_calls) == 1
    assert gh_calls[0][:3] == ["issue", "comment", "845"]
    assert "--body" in gh_calls[0]
    body = gh_calls[0][gh_calls[0].index("--body") + 1]
    assert body  # non-empty
    assert "acceptance criteria" in body.lower() or "deft #845" in body


def test_mark_duplicate_validates_target(fake_log, fake_cache, gh_calls):
    """Case 5: mark-duplicate raises when target is missing in cache; succeeds otherwise."""
    # Target #100 NOT in cache -> TriageError.
    with pytest.raises(triage_actions.TriageError, match="not found in cache"):
        triage_actions.mark_duplicate(845, REPO, 100, actor="msadams")
    # No audit recorded for the failed attempt.
    assert fake_log.latest_decision(845, REPO) is None
    # Now register #100 in cache and retry.
    fake_cache._known.add((100, REPO))
    decision_id = triage_actions.mark_duplicate(845, REPO, 100, actor="msadams")
    assert decision_id
    latest = fake_log.latest_decision(845, REPO)
    assert latest["decision"] == "mark-duplicate"
    assert latest["linked_to"] == 100


def test_status_returns_latest(fake_log, gh_calls):
    """Case 6: status() returns the most recent decision."""
    assert triage_actions.status(845, REPO) is None
    triage_actions.accept(845, REPO, actor="msadams")
    triage_actions.defer(845, REPO, actor="msadams")
    latest = triage_actions.status(845, REPO)
    assert latest is not None
    assert latest["decision"] == "defer"


def test_history_returns_timeline_ordered(fake_log, gh_calls):
    """Case 7: history() returns entries ordered by timestamp ascending."""
    triage_actions.accept(845, REPO, actor="a")
    triage_actions.defer(845, REPO, actor="b")
    triage_actions.accept(999, REPO, actor="c")  # different issue, must not appear
    triage_actions.reset(845, REPO, actor="d")
    timeline = triage_actions.history(845, REPO)
    assert [e["decision"] for e in timeline] == ["accept", "defer", "reset"]
    timestamps = [e["timestamp"] for e in timeline]
    assert timestamps == sorted(timestamps)
    # No cross-contamination from #999.
    assert all(e["issue_number"] == 845 for e in timeline)


def test_reset_writes_new_entry_referencing_prior(fake_log, gh_calls):
    """Case 8: reset chain depth >= 2 -- writes new entry, references prior id."""
    accept_id = triage_actions.accept(845, REPO, actor="msadams")
    reset_id = triage_actions.reset(845, REPO, actor="msadams")
    assert reset_id != accept_id
    timeline = triage_actions.history(845, REPO)
    # Chain depth >= 2 (accept + reset).
    assert len(timeline) >= 2
    reset_entry = timeline[-1]
    assert reset_entry["decision"] == "reset"
    assert reset_entry["prior_decision_id"] == accept_id
    # History was NOT deleted -- the original accept entry is still present.
    assert any(e["decision"] == "accept" and e["decision_id"] == accept_id for e in timeline)


def test_reject_failure_rolls_back_audit_entry(
    fake_log, monkeypatch, audit_log_path: Path
):
    """Case 9: when ``gh issue close`` fails, the audit entry is rolled back."""
    def _fail(args: list[str]):
        raise triage_actions.UpstreamCloseError(
            f"gh {' '.join(args)} failed: HTTP 403"
        )

    monkeypatch.setattr(triage_actions, "_run_gh", _fail)
    with pytest.raises(triage_actions.UpstreamCloseError):
        triage_actions.reject(845, REPO, "duplicate of #100", actor="msadams")
    # No reject entry should remain in the audit log.
    contents = audit_log_path.read_text(encoding="utf-8")
    for line in contents.splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        assert not (
            record.get("decision") == "reject"
            and record.get("issue_number") == 845
        ), f"reject entry was not rolled back: {record}"
    # Latest decision should be None (no surviving entries for this issue).
    assert fake_log.latest_decision(845, REPO) is None


def test_idempotent_reject_is_no_op(fake_log, gh_calls):
    """Case 10: re-rejecting an already-rejected issue is a no-op (no new gh, no new audit)."""
    first = triage_actions.reject(845, REPO, "stale", actor="msadams")
    assert len(gh_calls) == 2  # close + label on first reject
    assert len(fake_log._entries) == 1
    # Re-reject -- expected to short-circuit returning the same decision_id.
    second = triage_actions.reject(845, REPO, "still stale", actor="msadams")
    assert second == first
    # No additional gh calls and no additional audit entries.
    assert len(gh_calls) == 2
    assert len(fake_log._entries) == 1


def test_rollback_acquires_candidates_log_lock(
    fake_log, monkeypatch, audit_log_path: Path
):
    """Greptile #879 P1 regression: rollback path MUST hold the candidates_log
    advisory lock while it reads + filters + rewrites the JSONL, otherwise a
    concurrent ``candidates_log.append`` from Story 4 bulk ops can land bytes
    that we silently clobber. The fake log carries an ``_append_lock`` shim
    we count entries against; the test asserts (a) the lock context is
    actually entered and (b) it is exited before ``_rollback_audit_entry``
    returns so a follow-up appender can proceed.
    """
    lock_events: list[str] = []

    @contextlib_contextmanager
    def _fake_lock(_path):
        lock_events.append("acquire")
        try:
            yield
        finally:
            lock_events.append("release")

    fake_log._append_lock = _fake_lock  # type: ignore[attr-defined]

    def _fail(args):
        raise triage_actions.UpstreamCloseError(
            f"gh {' '.join(args)} failed: HTTP 500"
        )

    monkeypatch.setattr(triage_actions, "_run_gh", _fail)
    with pytest.raises(triage_actions.UpstreamCloseError):
        triage_actions.reject(845, REPO, "test", actor="msadams")

    # Lock must have been acquired AND released exactly once during rollback.
    assert lock_events == ["acquire", "release"], lock_events
    # And the audit entry must be gone after rollback.
    assert fake_log.latest_decision(845, REPO) is None


def test_needs_ac_surfaces_gh_failure_to_stderr(
    fake_log, monkeypatch, capsys
):
    """Greptile #879 P2 regression: when ``gh issue comment`` fails the
    audit entry MUST persist (best-effort upstream post) AND the operator
    MUST see a stderr message naming the issue. The prior
    ``contextlib.suppress`` swallowed the failure entirely, contradicting
    the docstring's "logged" claim.
    """
    def _fail(args):
        raise triage_actions.UpstreamCloseError(
            f"gh {' '.join(args)} failed: HTTP 403"
        )

    monkeypatch.setattr(triage_actions, "_run_gh", _fail)
    decision_id = triage_actions.needs_ac(845, REPO, actor="msadams")
    assert decision_id
    captured = capsys.readouterr()
    assert "#845" in captured.err
    assert "needs-ac comment not posted" in captured.err
    # Audit entry persists (best-effort -- gh failure does not roll back).
    latest = fake_log.latest_decision(845, REPO)
    assert latest is not None
    assert latest["decision"] == "needs-ac"


# Sanity-check coverage of the reset edge case explicitly named in the
# vBRIEF Test narrative ("reset chain depth >= 2") via a separate angle: a
# stack of accept -> reset -> defer -> reset still preserves all four entries
# in order and the second reset references the most recent non-reset entry.
def test_reset_chain_depth_two(fake_log, gh_calls):
    accept_id = triage_actions.accept(845, REPO, actor="a")
    triage_actions.reset(845, REPO, actor="a")
    defer_id = triage_actions.defer(845, REPO, actor="a")
    second_reset = triage_actions.reset(845, REPO, actor="a")
    timeline = triage_actions.history(845, REPO)
    decisions = [e["decision"] for e in timeline]
    assert decisions == ["accept", "reset", "defer", "reset"]
    # The first reset references accept; the second reset references defer.
    assert timeline[1]["prior_decision_id"] == accept_id
    assert timeline[3]["prior_decision_id"] == defer_id
    assert second_reset == timeline[3]["decision_id"]
