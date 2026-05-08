"""Tests for scripts/triage_actions.py (#883 Story 3 rebind onto cache:*).

Covers the eight per-issue triage actions documented in the module
docstring. Special focus on:

- ``mark_duplicate`` validates the duplicate target via the unified
  ``cache.cache_get`` (post-#883 rebind) instead of the legacy
  ``triage_cache.show`` seam.
- ``reject`` rolls the audit entry back on upstream-close failure.
- The accept / defer / needs-ac / status / reset / history surfaces
  remain semantically unchanged.

Tests substitute fakes via ``monkeypatch.setattr(triage_actions, "cache",
fake_cache)`` and ``monkeypatch.setattr(triage_actions, "candidates_log",
fake_log)`` so the suite is hermetic.
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

_SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

triage_actions = importlib.import_module("triage_actions")


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class _FakeNotFoundError(KeyError):
    pass


class _FakeValidationError(ValueError):
    pass


class _FakeCacheError(RuntimeError):
    pass


def _fake_cache(known_keys: set[str]) -> SimpleNamespace:
    """Return a stub of the unified ``cache`` module."""

    calls: list[tuple[str, str, dict[str, Any]]] = []

    def cache_get(source: str, key: str, **kwargs: Any) -> SimpleNamespace:
        calls.append((source, key, kwargs))
        if key not in known_keys:
            raise _FakeNotFoundError(f"cache miss for {key}")
        return SimpleNamespace(
            source=source,
            key=key,
            entry_dir=Path(".") / "fake" / source / key,
            meta={"fetched_at": "2026-05-05T00:00:00Z"},
            content_path=None,
            stale=False,
        )

    return SimpleNamespace(
        cache_get=cache_get,
        CacheNotFoundError=_FakeNotFoundError,
        CacheValidationError=_FakeValidationError,
        CacheError=_FakeCacheError,
        calls=calls,
    )


def _fake_candidates_log() -> SimpleNamespace:
    """Return a stub of ``candidates_log`` that records appends."""

    appended: list[dict[str, Any]] = []

    def append(entry: dict[str, Any], *, path: Path | None = None) -> str:
        appended.append(entry)
        return str(entry["decision_id"])

    state = {"latest": None}

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


# ---------------------------------------------------------------------------
# accept / defer / status / reset / history
# ---------------------------------------------------------------------------


def _fake_issue_ingest(
    *,
    fail: bool = False,
    error: Exception | None = None,
) -> SimpleNamespace:
    """Return a stub of ``issue_ingest`` recording delegation calls.

    When ``fail`` is True (or an explicit ``error`` is supplied) the stub
    raises -- exercising the audit-rollback path on the accept side.
    """

    calls: list[dict[str, Any]] = []

    def ingest_single_for_accept(
        n: int,
        repo: str,
        *,
        project_root: Path | None = None,
        status: str = "proposed",
        cache_root: Path | None = None,
    ) -> tuple[str, Path | None]:
        calls.append(
            {
                "n": n,
                "repo": repo,
                "project_root": project_root,
                "status": status,
                "cache_root": cache_root,
            }
        )
        if error is not None:
            raise error
        if fail:
            raise RuntimeError("simulated ingest failure")
        return "created", Path("vbrief/proposed/fake.vbrief.json")

    return SimpleNamespace(
        ingest_single_for_accept=ingest_single_for_accept,
        calls=calls,
    )


def test_accept_appends_audit_entry(monkeypatch: pytest.MonkeyPatch) -> None:
    log = _fake_candidates_log()
    ingest = _fake_issue_ingest()
    monkeypatch.setattr(triage_actions, "candidates_log", log)
    monkeypatch.setattr(triage_actions, "issue_ingest", ingest)

    decision_id = triage_actions.accept(123, "deftai/directive", actor="agent:test")

    assert decision_id == "11111111-1111-1111-1111-111111111111"
    assert len(log.appended) == 1
    entry = log.appended[0]
    assert entry["decision"] == "accept"
    assert entry["issue_number"] == 123
    assert entry["repo"] == "deftai/directive"
    assert entry["actor"] == "agent:test"
    # #985: accept MUST delegate to issue_ingest after the audit append.
    assert len(ingest.calls) == 1
    assert ingest.calls[0]["n"] == 123
    assert ingest.calls[0]["repo"] == "deftai/directive"


def test_accept_delegates_to_issue_ingest_after_audit_append(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """#985: ``accept`` invokes ``issue_ingest.ingest_single_for_accept`` once,
    AFTER the audit entry has been recorded, with the project_root threaded
    through so the delegate writes into the correct ``vbrief/`` tree.
    """
    log = _fake_candidates_log()
    ingest = _fake_issue_ingest()

    # Capture the audit-append order: every append happens BEFORE the
    # delegate is called. Stash a marker on the entry so the test can
    # assert ordering rather than relying on call counts alone.
    order: list[str] = []

    def _ordered_append(entry: dict[str, Any], *, path: Path | None = None) -> str:
        order.append("append")
        log.appended.append(entry)
        return str(entry["decision_id"])

    log.append = _ordered_append

    def _ordered_ingest(
        n: int,
        repo: str,
        *,
        project_root: Path | None = None,
        status: str = "proposed",
        cache_root: Path | None = None,
    ) -> tuple[str, Path | None]:
        order.append("ingest")
        ingest.calls.append({"n": n, "repo": repo, "project_root": project_root})
        return "created", tmp_path / "vbrief" / "proposed" / "fake.vbrief.json"

    ingest.ingest_single_for_accept = _ordered_ingest

    monkeypatch.setattr(triage_actions, "candidates_log", log)
    monkeypatch.setattr(triage_actions, "issue_ingest", ingest)

    triage_actions.accept(
        555, "deftai/directive", actor="agent:test", project_root=tmp_path
    )

    assert order == ["append", "ingest"]
    assert ingest.calls[0]["project_root"] == tmp_path


def test_accept_rolls_audit_back_on_ingest_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """#985: when the delegated ingest raises, the audit entry MUST be rolled
    back (mirrors :func:`reject`'s upstream-close-failure pattern). The log
    must never reference an accept decision that did not produce a vBRIEF.
    """
    log = _fake_candidates_log()

    audit_path = tmp_path / "vbrief" / ".eval" / "candidates.jsonl"
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    audit_path.write_text("", encoding="utf-8")
    monkeypatch.setattr(
        triage_actions, "AUDIT_LOG_REL_PATH", str(audit_path.relative_to(tmp_path))
    )

    def _capture_append(entry: dict[str, Any], *, path: Path | None = None) -> str:
        log.appended.append(entry)
        with audit_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
        return str(entry["decision_id"])

    log.append = _capture_append

    ingest = _fake_issue_ingest(fail=True)
    monkeypatch.setattr(triage_actions, "candidates_log", log)
    monkeypatch.setattr(triage_actions, "issue_ingest", ingest)

    with pytest.raises(triage_actions.TriageError, match="ingest delegation failed"):
        triage_actions.accept(
            42, "deftai/directive", actor="agent:test", project_root=tmp_path
        )

    # The audit entry was written, then rolled back -- the file is empty.
    remaining = audit_path.read_text(encoding="utf-8").strip()
    assert remaining == "", (
        f"audit entry must be rolled back on ingest failure; remaining: {remaining!r}"
    )


def test_accept_idempotent_does_not_re_ingest(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """#985: a re-accept on an already-accepted issue MUST NOT call the
    ingest delegate again. The original ``vbrief/proposed/`` artefact is
    preserved as-is; re-ingesting would overwrite human edits.
    """
    log = _fake_candidates_log()
    log.state["latest"] = {
        "decision_id": "prior-id",
        "decision": "accept",
        "issue_number": 9,
        "repo": "deftai/directive",
    }
    ingest = _fake_issue_ingest()
    monkeypatch.setattr(triage_actions, "candidates_log", log)
    monkeypatch.setattr(triage_actions, "issue_ingest", ingest)

    decision_id = triage_actions.accept(9, "deftai/directive", actor="agent:test")

    assert decision_id == "prior-id"
    assert log.appended == []
    assert ingest.calls == [], (
        "idempotent re-accept must not re-invoke the ingest delegate"
    )


def test_defer_appends_audit_entry(monkeypatch: pytest.MonkeyPatch) -> None:
    log = _fake_candidates_log()
    monkeypatch.setattr(triage_actions, "candidates_log", log)

    triage_actions.defer(7, "deftai/directive", actor="agent:test")

    assert log.appended[-1]["decision"] == "defer"


def test_history_returns_entries_sorted(monkeypatch: pytest.MonkeyPatch) -> None:
    log = _fake_candidates_log()
    log.appended.extend(
        [
            {
                "decision_id": "a",
                "timestamp": "2026-05-02T00:00:00Z",
                "issue_number": 5,
                "repo": "deftai/directive",
                "decision": "defer",
                "actor": "agent:test",
            },
            {
                "decision_id": "b",
                "timestamp": "2026-05-01T00:00:00Z",
                "issue_number": 5,
                "repo": "deftai/directive",
                "decision": "accept",
                "actor": "agent:test",
            },
        ]
    )
    monkeypatch.setattr(triage_actions, "candidates_log", log)

    rows = triage_actions.history(5, "deftai/directive")
    timestamps = [r["timestamp"] for r in rows]
    assert timestamps == sorted(timestamps)


# ---------------------------------------------------------------------------
# mark_duplicate -- validates target via cache.cache_get (#883 Story 3 rebind)
# ---------------------------------------------------------------------------


def test_mark_duplicate_uses_cache_get_to_validate_target(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The duplicate target must be validated through ``cache.cache_get``."""

    log = _fake_candidates_log()
    cache = _fake_cache(known_keys={"deftai/directive/77"})
    monkeypatch.setattr(triage_actions, "candidates_log", log)
    monkeypatch.setattr(triage_actions, "cache", cache)

    decision_id = triage_actions.mark_duplicate(
        12, "deftai/directive", 77, actor="agent:test"
    )

    # cache.cache_get was the validation seam (not triage_cache.show).
    assert cache.calls
    source, key, kwargs = cache.calls[0]
    assert source == "github-issue"
    assert key == "deftai/directive/77"
    assert kwargs.get("allow_stale") is True

    # Audit entry written with linked_to.
    assert decision_id == log.appended[-1]["decision_id"]
    assert log.appended[-1]["decision"] == "mark-duplicate"
    assert log.appended[-1]["linked_to"] == 77


def test_mark_duplicate_raises_when_target_missing_in_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Target absent from cache -> :class:`TriageError`; no audit append."""

    log = _fake_candidates_log()
    cache = _fake_cache(known_keys=set())
    monkeypatch.setattr(triage_actions, "candidates_log", log)
    monkeypatch.setattr(triage_actions, "cache", cache)

    with pytest.raises(triage_actions.TriageError, match="not found in cache"):
        triage_actions.mark_duplicate(12, "deftai/directive", 99)
    assert log.appended == []


def test_mark_duplicate_rejects_self_reference(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    log = _fake_candidates_log()
    cache = _fake_cache(known_keys={"deftai/directive/12"})
    monkeypatch.setattr(triage_actions, "candidates_log", log)
    monkeypatch.setattr(triage_actions, "cache", cache)

    with pytest.raises(triage_actions.TriageError, match="cannot equal source"):
        triage_actions.mark_duplicate(12, "deftai/directive", 12)
    # Validation rejects before reaching the cache seam.
    assert cache.calls == []
    assert log.appended == []


# ---------------------------------------------------------------------------
# reject -- rolls audit back on upstream-close failure
# ---------------------------------------------------------------------------


def test_reject_rolls_audit_back_on_gh_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    log = _fake_candidates_log()
    monkeypatch.setattr(triage_actions, "candidates_log", log)

    # Wire a fake gh wrapper that always fails.
    def _failing_gh(args: list[str]):
        raise triage_actions.UpstreamCloseError("gh issue close failed: not authorized")

    monkeypatch.setattr(triage_actions, "_run_gh", _failing_gh)

    audit_path = tmp_path / "vbrief" / ".eval" / "candidates.jsonl"
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    audit_path.write_text("", encoding="utf-8")
    # Pre-seed the audit file with a record matching the to-be-rolled-back
    # entry so _rollback_audit_entry has something to drop.
    monkeypatch.setattr(triage_actions, "AUDIT_LOG_REL_PATH", str(audit_path.relative_to(tmp_path)))

    # Drive the reject through the normal path and capture the appended entry
    # so the test can confirm rollback was attempted.
    def _capture_append(entry: dict[str, Any], *, path: Path | None = None) -> str:
        log.appended.append(entry)
        # Simulate Story 2's on-disk write so rollback has a line to remove.
        with audit_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
        return str(entry["decision_id"])

    log.append = _capture_append

    with pytest.raises(triage_actions.UpstreamCloseError):
        triage_actions.reject(
            42, "deftai/directive", "obsolete", project_root=tmp_path
        )

    # The append happened, but the rollback removed the line again.
    remaining = audit_path.read_text(encoding="utf-8").strip()
    assert remaining == "", (
        f"audit entry must be rolled back on gh failure; remaining: {remaining!r}"
    )


# ---------------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------------


def test_accept_idempotent_on_already_accepted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    log = _fake_candidates_log()
    log.state["latest"] = {
        "decision_id": "prior-id",
        "decision": "accept",
        "issue_number": 9,
        "repo": "deftai/directive",
    }
    monkeypatch.setattr(triage_actions, "candidates_log", log)

    decision_id = triage_actions.accept(9, "deftai/directive", actor="agent:test")
    assert decision_id == "prior-id"
    # No new entry appended.
    assert log.appended == []
