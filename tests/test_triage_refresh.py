"""Tests for scripts/triage_refresh.py (#845 Story 4 AC #4 -- freshness cases).

Covers Test narrative items (4)-(6) from the Story 4 vBRIEF:

- (4) freshness gate empty active is no-op
- (5) freshness gate single-drift surfaces three-way prompt (mock user input)
- (6) freshness gate proceed-with-stale records audit annotation

The Story 1 cache loader and Story 2 audit log are stubbed by passing
explicit ``cache_loader`` / ``audit_writer`` callables to ``refresh_active``,
keeping the suite hermetic against the upstream module landing order.
"""

from __future__ import annotations

import importlib
import io
import json
import sys
from collections import deque
from pathlib import Path

# Surface scripts/ on sys.path so we can import triage_refresh by short name;
# matches how the production Taskfile target dispatches the script.
_SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

triage_refresh = importlib.import_module("triage_refresh")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_active_vbrief(
    active_dir: Path,
    *,
    name: str,
    repo: str,
    issue_number: int,
) -> Path:
    """Write a minimal v0.6 active vBRIEF that references a single issue."""
    active_dir.mkdir(parents=True, exist_ok=True)
    path = active_dir / name
    payload = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "title": f"Test scope -- {repo}#{issue_number}",
            "status": "running",
            "items": [],
            "references": [
                {
                    "type": "x-vbrief/github-issue",
                    "uri": f"https://github.com/{repo}/issues/{issue_number}",
                    "title": f"Issue #{issue_number}",
                }
            ],
        },
    }
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_freshness_gate_empty_active_is_noop(tmp_path: Path) -> None:
    """(4) Empty vbrief/active/ exits cleanly without any drift detection."""
    project_root = tmp_path
    active_dir = project_root / "vbrief" / "active"
    active_dir.mkdir(parents=True)

    # Sentinels: any call MUST NOT happen -- raise on touch.
    def _explode_fetch(_repo: str, _n: int) -> str:
        raise AssertionError("fetch_live MUST NOT be called on empty active/")

    def _explode_cache(_repo: str, _n: int, _root: Path) -> str | None:
        raise AssertionError("cache_loader MUST NOT be called on empty active/")

    out = io.StringIO()
    summary = triage_refresh.refresh_active(
        project_root,
        fetch_live=_explode_fetch,
        cache_loader=_explode_cache,
        out=out,
    )

    assert summary.total_active == 0
    assert summary.drifts_detected == 0
    assert summary.proceeded == []
    assert summary.refreshed == []
    assert summary.deferred == []
    assert "no-op" in out.getvalue()


def test_freshness_gate_single_drift_three_way_prompt_defer(
    tmp_path: Path,
) -> None:
    """(5) Single drift surfaces the three-way prompt; defer routes correctly."""
    project_root = tmp_path
    active_dir = project_root / "vbrief" / "active"
    _write_active_vbrief(
        active_dir,
        name="2026-05-03-foo.vbrief.json",
        repo="deftai/directive",
        issue_number=845,
    )

    fetch_calls: list[tuple[str, int]] = []

    def _fake_fetch(repo: str, n: int) -> str:
        fetch_calls.append((repo, n))
        return "2026-05-03T20:00:00Z"  # live drift vs cached "T16"

    def _fake_cache(_repo: str, _n: int, _root: Path) -> str | None:
        return "2026-05-03T16:00:00Z"

    prompt_calls: list[str] = []

    def _input_fn(prompt: str) -> str:
        prompt_calls.append(prompt)
        return "3"  # defer-from-this-batch

    out = io.StringIO()
    summary = triage_refresh.refresh_active(
        project_root,
        fetch_live=_fake_fetch,
        cache_loader=_fake_cache,
        input_fn=_input_fn,
        out=out,
    )

    # Drift was detected exactly once (one issue ref).
    assert fetch_calls == [("deftai/directive", 845)]
    assert summary.drifts_detected == 1
    # Prompt was actually surfaced to the user.
    assert prompt_calls and "1/2/3" in prompt_calls[0]
    # User chose defer -> routed correctly.
    assert summary.deferred == [("deftai/directive", 845)]
    assert summary.proceeded == []
    assert summary.refreshed == []
    rendered = out.getvalue()
    # All three options were rendered to the user.
    for option in ("proceed-with-stale", "refresh-and-update-local", "defer-from-this-batch"):
        assert option in rendered


def test_freshness_gate_proceed_with_stale_records_audit_annotation(
    tmp_path: Path,
) -> None:
    """(6) ``proceed-with-stale`` invokes audit_writer with cached/live values."""
    project_root = tmp_path
    active_dir = project_root / "vbrief" / "active"
    _write_active_vbrief(
        active_dir,
        name="2026-05-03-bar.vbrief.json",
        repo="deftai/directive",
        issue_number=868,
    )

    audit_calls: list[tuple[str, int, str]] = []
    refresh_calls: list[tuple[str, int, Path]] = []

    def _fake_fetch(_repo: str, _n: int) -> str:
        return "2026-05-03T20:00:00Z"

    def _fake_cache(_repo: str, _n: int, _root: Path) -> str | None:
        return "2026-05-03T16:00:00Z"

    def _audit(repo: str, issue_number: int, annotation: str) -> None:
        audit_calls.append((repo, issue_number, annotation))

    def _refresh(repo: str, issue_number: int, root: Path) -> None:
        refresh_calls.append((repo, issue_number, root))

    # Queue: choose proceed-with-stale on first prompt.
    responses: deque[str] = deque(["1"])

    def _input_fn(_prompt: str) -> str:
        return responses.popleft()

    out = io.StringIO()
    summary = triage_refresh.refresh_active(
        project_root,
        fetch_live=_fake_fetch,
        cache_loader=_fake_cache,
        input_fn=_input_fn,
        audit_writer=_audit,
        refresh_local=_refresh,
        out=out,
    )

    # Audit annotation written exactly once with cached + live in the body.
    assert len(audit_calls) == 1
    repo, num, annotation = audit_calls[0]
    assert (repo, num) == ("deftai/directive", 868)
    assert "proceed-with-stale" in annotation
    assert "2026-05-03T16:00:00Z" in annotation  # cached
    assert "2026-05-03T20:00:00Z" in annotation  # live
    # No refresh side-effect on the proceed path.
    assert refresh_calls == []
    # Summary records the proceeded item.
    assert summary.proceeded == [("deftai/directive", 868)]
    assert "audit recorded" in out.getvalue()


def test_freshness_gate_silent_skip_does_not_falsely_report_all_fresh(
    tmp_path: Path,
) -> None:
    """Greptile P1 (PR #875): a wholesale fetch outage MUST NOT masquerade as
    ``all N fresh`` -- the WARN line and the FreshnessSummary.skipped list
    expose every dropped check.
    """
    project_root = tmp_path
    active_dir = project_root / "vbrief" / "active"
    _write_active_vbrief(
        active_dir,
        name="2026-05-03-outage.vbrief.json",
        repo="deftai/directive",
        issue_number=845,
    )

    def _explode_fetch(_repo: str, _n: int) -> str:
        raise OSError("network unreachable")

    out = io.StringIO()
    summary = triage_refresh.refresh_active(
        project_root,
        fetch_live=_explode_fetch,
        cache_loader=lambda _repo, _n, _root: "2026-05-03T16:00:00Z",
        out=out,
    )

    rendered = out.getvalue()
    assert "all 1 active vBRIEFs fresh" not in rendered
    assert "WARN" in rendered
    assert "skipped for deftai/directive#845" in rendered
    assert "unverified" in rendered
    assert summary.skipped == [("deftai/directive", 845)]
    assert summary.drifts_detected == 0


def test_freshness_gate_skip_warning_uses_pair_count_denominator(
    tmp_path: Path,
) -> None:
    """Greptile P1 second pass (PR #875): a vBRIEF with multiple issue refs
    that all fail live fetch MUST render ``M of N (repo, issue) fetch(es)``
    where N is the checked pair count, NOT ``M of 1`` (vBRIEF file count).
    """
    project_root = tmp_path
    active_dir = project_root / "vbrief" / "active"
    active_dir.mkdir(parents=True)
    # Single vBRIEF carrying THREE issue refs.
    payload = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "title": "Multi-ref scope",
            "status": "running",
            "items": [],
            "references": [
                {
                    "type": "x-vbrief/github-issue",
                    "uri": "https://github.com/deftai/directive/issues/100",
                },
                {
                    "type": "x-vbrief/github-issue",
                    "uri": "https://github.com/deftai/directive/issues/200",
                },
                {
                    "type": "x-vbrief/github-issue",
                    "uri": "https://github.com/deftai/directive/issues/300",
                },
            ],
        },
    }
    (active_dir / "2026-05-03-multi.vbrief.json").write_text(json.dumps(payload), encoding="utf-8")

    def _all_fail(_repo: str, _n: int) -> str:
        raise OSError("network unreachable")

    out = io.StringIO()
    summary = triage_refresh.refresh_active(
        project_root,
        fetch_live=_all_fail,
        cache_loader=lambda _r, _n, _root: "cached",
        out=out,
    )

    rendered = out.getvalue()
    # Correct denominator (3 of 3), NOT the nonsensical (3 of 1) shape.
    assert "3 of 3 (repo, issue) fetch(es)" in rendered
    assert "3 of 1" not in rendered
    assert summary.skipped == [
        ("deftai/directive", 100),
        ("deftai/directive", 200),
        ("deftai/directive", 300),
    ]


def test_record_audit_annotation_degrades_on_schema_rejection() -> None:
    """Greptile P1 second pass (PR #875): when Story 2's ``candidates_log`` is
    co-installed and rejects a ``freshness-annotation`` entry (the decision
    is not in the frozen enum), ``_record_audit_annotation`` MUST degrade to
    a stderr WARN line rather than propagate the ``ValueError`` and crash
    the CLI on every ``proceed-with-stale`` choice.

    Pre-rebase the upstream module was stubbed; post-rebase Story 2 is real
    on master and ``_validate_entry`` raises ``CandidatesLogError`` (a
    ``ValueError`` subclass) for both the unknown ``decision`` value and a
    missing ``decision_id``. This test pins the defensive contract.
    """
    captured: list[dict] = []

    class _FakeLog:
        @staticmethod
        def append(entry: dict) -> str:
            captured.append(entry)
            # Mimic the real candidates_log.CandidatesLogError
            # (a ValueError subclass) by raising its parent class.
            raise ValueError(
                "decision must be one of ['accept', 'defer', 'mark-duplicate', "
                "'needs-ac', 'reject', 'reset'], got 'freshness-annotation'"
            )

        @staticmethod
        def new_decision_id() -> str:
            return "00000000-0000-4000-8000-000000000000"

    sink = io.StringIO()
    # MUST NOT raise -- the schema rejection is logged, not propagated.
    triage_refresh._record_audit_annotation(
        "deftai/directive",
        868,
        "proceed-with-stale: cached=A live=B",
        log_module=_FakeLog,
        out=sink,
    )

    # The append call DID happen with a syntactically-complete entry --
    # decision_id was sourced from new_decision_id, the schema rejection
    # is purely an enum mismatch the operator can fix in a follow-up.
    assert len(captured) == 1
    assert captured[0]["decision_id"] == "00000000-0000-4000-8000-000000000000"
    assert captured[0]["decision"] == "freshness-annotation"
    assert captured[0]["repo"] == "deftai/directive"
    assert captured[0]["issue_number"] == 868

    rendered = sink.getvalue()
    assert "WARN" in rendered
    assert "audit annotation" in rendered
    assert "deftai/directive#868" in rendered
    assert "not persisted" in rendered


def test_record_audit_annotation_uses_uuid_fallback_when_helper_missing() -> None:
    """Greptile P1 (PR #875): when Story 2 does not expose ``new_decision_id``
    (e.g. an older candidates_log build), the helper falls back to
    ``uuid.uuid4()`` so the entry still satisfies the required-fields portion
    of the schema (the decision-enum mismatch is the only remaining barrier).
    """
    captured: list[dict] = []

    class _FakeLogNoHelper:
        @staticmethod
        def append(entry: dict) -> str:
            captured.append(entry)
            return entry["decision_id"]

    sink = io.StringIO()
    triage_refresh._record_audit_annotation(
        "deftai/directive",
        845,
        "annotation",
        log_module=_FakeLogNoHelper,
        out=sink,
    )

    assert len(captured) == 1
    decision_id = captured[0]["decision_id"]
    # UUID4 v4 shape: 8-4-4-4-12 hex with version nibble '4'.
    import re as _re

    assert _re.match(
        r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$",
        decision_id,
    )
    # No WARN -- append succeeded.
    assert sink.getvalue() == ""


def test_extract_issue_refs_only_returns_github_issue_type(tmp_path: Path) -> None:
    """Refs of unrelated types must NOT show up in the drift detector."""
    active_dir = tmp_path / "vbrief" / "active"
    active_dir.mkdir(parents=True)
    payload = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "title": "Mixed refs",
            "status": "running",
            "items": [],
            "references": [
                {
                    "type": "x-vbrief/related-plan",
                    "uri": "https://github.com/deftai/directive/issues/999",
                },
                {
                    "type": "x-vbrief/github-issue",
                    "uri": "https://github.com/deftai/directive/issues/845",
                },
            ],
        },
    }
    path = active_dir / "2026-05-03-mixed.vbrief.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    refs = triage_refresh.extract_issue_refs(path)
    assert refs == [("deftai/directive", 845)]
