"""Tests for scripts/resume_conditions.py + D3 integration surfaces (#1123).

Coverage:

* Grammar parser -- each atomic kind, both compositions, malformed
  expressions, whitespace handling, multi-operator rejection.
* Evaluator -- each atomic firing / not firing, AND/OR truth matrix.
* :func:`build_context` -- on-disk state -> ``ResumeContext`` translation.
* :func:`evaluate_resume_eligibility` -- appends ``resume-eligible``
  entries idempotently, skips pre-D3 defers without ``resume_on``,
  skips defers superseded by reset / new defer, tolerates malformed
  expressions in storage.
* Integration with sibling deliverables:
  - :func:`scripts.triage_queue.derive_group` routes
    ``resume-eligible`` to ``RESUME``.
  - :func:`scripts.triage_summary.compute_summary` increments
    ``stale_defer`` for every cached issue whose latest decision is
    ``resume-eligible`` (and zero otherwise, preserving back-compat).
  - :func:`scripts.triage_actions.defer` carries the new ``reason``
    + ``resume_on`` fields and rejects malformed ``resume_on``
    expressions at the public API boundary.
"""

from __future__ import annotations

import importlib
import json
import sys
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

_SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

resume_conditions = importlib.import_module("resume_conditions")
triage_actions = importlib.import_module("triage_actions")
triage_queue = importlib.import_module("triage_queue")
triage_summary = importlib.import_module("triage_summary")


# ---------------------------------------------------------------------------
# Fakes / helpers
# ---------------------------------------------------------------------------


def _fake_log() -> SimpleNamespace:
    """Return an in-memory stub of ``candidates_log`` for the evaluator."""

    appended: list[dict[str, Any]] = []
    _id_counter = {"n": 0}

    def append(entry: dict[str, Any], *, path: Any = None) -> str:
        # Match the public Story 2 contract: caller pre-fills decision_id.
        appended.append(entry)
        return str(entry["decision_id"])

    def read_all(repo: str | None = None, *, path: Any = None) -> list[dict[str, Any]]:
        if repo is None:
            return list(appended)
        return [e for e in appended if e.get("repo") == repo]

    def new_decision_id() -> str:
        _id_counter["n"] += 1
        # UUID-shape but deterministic.
        return f"00000000-0000-0000-0000-{_id_counter['n']:012d}"

    return SimpleNamespace(
        append=append,
        read_all=read_all,
        new_decision_id=new_decision_id,
        appended=appended,
    )


def _defer_entry(
    *,
    decision_id: str = "11111111-1111-1111-1111-111111111111",
    repo: str = "deftai/directive",
    issue_number: int = 1097,
    timestamp: str = "2026-05-10T00:00:00Z",
    reason: str = "awaiting close",
    resume_on: str | None = "ref:closed:#1121",
    actor: str = "agent:test",
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "decision_id": decision_id,
        "timestamp": timestamp,
        "repo": repo,
        "issue_number": issue_number,
        "decision": "defer",
        "actor": actor,
        "reason": reason,
    }
    if resume_on is not None:
        entry["resume_on"] = resume_on
    return entry


# ---------------------------------------------------------------------------
# Grammar parser -- atomic forms
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "expr,kind,value",
    [
        ("ref:closed:#1121", "ref-closed", 1121),
        ("ref:merged:#1196", "ref-merged", 1196),
        ("date:>=2026-05-31", "date-ge", date(2026, 5, 31)),
        ("pending-count:>=18", "pending-count-ge", 18),
        ("pending-count:<=5", "pending-count-le", 5),
    ],
)
def test_parse_each_atomic_kind(expr: str, kind: str, value: Any) -> None:
    ast = resume_conditions.parse(expr)
    assert ast.op == "ATOM"
    assert ast.left.kind == kind
    assert ast.left.value == value
    assert ast.right is None


def test_parse_strips_outer_whitespace() -> None:
    ast = resume_conditions.parse("  ref:closed:#42  ")
    assert ast.op == "ATOM"
    assert ast.left.value == 42


def test_parse_and_composition() -> None:
    ast = resume_conditions.parse("ref:closed:#1121 AND pending-count:>=18")
    assert ast.op == "AND"
    assert ast.left.kind == "ref-closed"
    assert ast.right is not None
    assert ast.right.kind == "pending-count-ge"


def test_parse_or_composition() -> None:
    ast = resume_conditions.parse("ref:merged:#7 OR date:>=2026-12-31")
    assert ast.op == "OR"
    assert ast.left.kind == "ref-merged"
    assert ast.right is not None
    assert ast.right.kind == "date-ge"


@pytest.mark.parametrize(
    "expr",
    [
        "",                                     # empty
        "   ",                                  # whitespace-only
        "unknown:thing",                        # unknown atomic
        "ref:closed:1121",                      # missing #
        "ref:closed:#",                         # missing number
        "ref:merged:#abc",                      # non-numeric
        "date:>=2026-13-40",                    # invalid date
        "pending-count:==5",                    # wrong operator
        "ref:closed:#1 AND ref:closed:#2 AND ref:closed:#3",  # nested forbidden
        "ref:closed:#1 XOR ref:closed:#2",      # unknown operator
        "ref:closed:#1 ANDref:closed:#2",       # missing whitespace
    ],
)
def test_parse_rejects_malformed(expr: str) -> None:
    with pytest.raises(resume_conditions.ResumeGrammarError):
        resume_conditions.parse(expr)


def test_parse_non_string_rejected() -> None:
    with pytest.raises(resume_conditions.ResumeGrammarError):
        resume_conditions.parse(123)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Evaluator -- atomics
# ---------------------------------------------------------------------------


# NOTE: ``ResumeContext`` is dynamically imported via ``importlib.import_module``
# so mypy cannot resolve ``resume_conditions.ResumeContext`` as a type. The
# fixture is annotated as ``Any`` and consumers carry the same annotation --
# pytest fills the runtime value with the real dataclass instance.


@pytest.fixture
def ctx() -> Any:
    return resume_conditions.ResumeContext(
        today=date(2026, 5, 18),
        closed_refs=frozenset({1121, 1100}),
        merged_refs=frozenset({1196}),
        pending_count=18,
    )


def test_eval_ref_closed_fires(ctx: Any) -> None:
    assert resume_conditions.evaluate(
        resume_conditions.parse("ref:closed:#1121"), ctx
    )


def test_eval_ref_closed_no_fire(ctx: Any) -> None:
    assert not resume_conditions.evaluate(
        resume_conditions.parse("ref:closed:#9999"), ctx
    )


def test_eval_ref_merged_distinct_from_closed(
    ctx: Any,
) -> None:
    # 1121 is closed but not merged -> ref:merged:#1121 must NOT fire.
    assert resume_conditions.evaluate(
        resume_conditions.parse("ref:closed:#1121"), ctx
    )
    assert not resume_conditions.evaluate(
        resume_conditions.parse("ref:merged:#1121"), ctx
    )
    # 1196 is merged.
    assert resume_conditions.evaluate(
        resume_conditions.parse("ref:merged:#1196"), ctx
    )


def test_eval_date_ge_boundary(ctx: Any) -> None:
    assert resume_conditions.evaluate(
        resume_conditions.parse("date:>=2026-05-18"), ctx
    )
    assert resume_conditions.evaluate(
        resume_conditions.parse("date:>=2026-05-01"), ctx
    )
    assert not resume_conditions.evaluate(
        resume_conditions.parse("date:>=2027-01-01"), ctx
    )


def test_eval_pending_count_ge_and_le(
    ctx: Any,
) -> None:
    assert resume_conditions.evaluate(
        resume_conditions.parse("pending-count:>=18"), ctx
    )
    assert not resume_conditions.evaluate(
        resume_conditions.parse("pending-count:>=19"), ctx
    )
    assert resume_conditions.evaluate(
        resume_conditions.parse("pending-count:<=18"), ctx
    )
    assert not resume_conditions.evaluate(
        resume_conditions.parse("pending-count:<=17"), ctx
    )


# ---------------------------------------------------------------------------
# AND / OR truth matrix
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "left,right,op,expected",
    [
        # AND: both fire -> True
        ("ref:closed:#1121", "pending-count:>=18", "AND", True),
        # AND: left only
        ("ref:closed:#1121", "pending-count:>=19", "AND", False),
        # AND: right only
        ("ref:closed:#9999", "pending-count:>=18", "AND", False),
        # AND: neither
        ("ref:closed:#9999", "pending-count:>=19", "AND", False),
        # OR: both
        ("ref:closed:#1121", "pending-count:>=18", "OR", True),
        # OR: left only
        ("ref:closed:#1121", "pending-count:>=99", "OR", True),
        # OR: right only
        ("ref:closed:#9999", "pending-count:>=18", "OR", True),
        # OR: neither
        ("ref:closed:#9999", "pending-count:>=99", "OR", False),
    ],
)
def test_and_or_matrix(
    ctx: Any,
    left: str,
    right: str,
    op: str,
    expected: bool,
) -> None:
    expr = f"{left} {op} {right}"
    assert resume_conditions.evaluate(resume_conditions.parse(expr), ctx) is expected


# ---------------------------------------------------------------------------
# build_context -- on-disk reader
# ---------------------------------------------------------------------------


def _write_cached_issue(
    cache_root: Path,
    repo: str,
    number: int,
    *,
    state: str = "open",
    merged: bool = False,
) -> None:
    owner, name = repo.split("/", 1)
    issue_dir = cache_root / "github-issue" / owner / name / str(number)
    issue_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "number": number,
        "state": state,
        "title": f"#{number}",
    }
    if merged:
        payload["merged"] = True
    (issue_dir / "raw.json").write_text(
        json.dumps(payload), encoding="utf-8"
    )


def test_build_context_reads_cache_and_pending(tmp_path: Path) -> None:
    cache_root = tmp_path / ".deft-cache"
    _write_cached_issue(cache_root, "deftai/directive", 1, state="open")
    _write_cached_issue(cache_root, "deftai/directive", 2, state="closed")
    _write_cached_issue(
        cache_root, "deftai/directive", 3, state="closed", merged=True
    )
    pending = tmp_path / "vbrief" / "pending"
    pending.mkdir(parents=True, exist_ok=True)
    (pending / "a.vbrief.json").write_text("{}", encoding="utf-8")
    (pending / "b.vbrief.json").write_text("{}", encoding="utf-8")
    (pending / "c.vbrief.json").write_text("{}", encoding="utf-8")

    ctx = resume_conditions.build_context(
        tmp_path, today=date(2026, 5, 18)
    )
    assert ctx.today == date(2026, 5, 18)
    assert ctx.closed_refs == frozenset({2, 3})
    assert ctx.merged_refs == frozenset({3})
    assert ctx.pending_count == 3


def test_build_context_empty_cache(tmp_path: Path) -> None:
    ctx = resume_conditions.build_context(tmp_path, today=date(2026, 1, 1))
    assert ctx.closed_refs == frozenset()
    assert ctx.merged_refs == frozenset()
    assert ctx.pending_count == 0


# ---------------------------------------------------------------------------
# evaluate_resume_eligibility -- orchestration
# ---------------------------------------------------------------------------


def test_evaluator_appends_resume_eligible_on_fire(tmp_path: Path) -> None:
    cache_root = tmp_path / ".deft-cache"
    _write_cached_issue(cache_root, "deftai/directive", 1121, state="closed")
    log = _fake_log()
    log.appended.append(_defer_entry(resume_on="ref:closed:#1121"))

    appended = resume_conditions.evaluate_resume_eligibility(
        tmp_path,
        today=date(2026, 5, 18),
        log_module=log,
    )
    assert len(appended) == 1
    new_entry = appended[0]
    assert new_entry["decision"] == "resume-eligible"
    assert new_entry["prior_decision_id"] == (
        "11111111-1111-1111-1111-111111111111"
    )
    assert new_entry["issue_number"] == 1097
    assert "ref:closed:#1121" in new_entry["reason"]


def test_evaluator_skips_when_condition_not_fired(tmp_path: Path) -> None:
    log = _fake_log()
    log.appended.append(_defer_entry(resume_on="ref:closed:#9999"))

    appended = resume_conditions.evaluate_resume_eligibility(
        tmp_path,
        today=date(2026, 5, 18),
        log_module=log,
    )
    assert appended == []


def test_evaluator_idempotent_on_repeat(tmp_path: Path) -> None:
    cache_root = tmp_path / ".deft-cache"
    _write_cached_issue(cache_root, "deftai/directive", 1121, state="closed")
    log = _fake_log()
    log.appended.append(_defer_entry(resume_on="ref:closed:#1121"))

    first = resume_conditions.evaluate_resume_eligibility(
        tmp_path, today=date(2026, 5, 18), log_module=log
    )
    second = resume_conditions.evaluate_resume_eligibility(
        tmp_path, today=date(2026, 5, 18), log_module=log
    )
    assert len(first) == 1
    # The first run appended a resume-eligible entry which now supersedes
    # the defer; the second run MUST NOT duplicate it.
    assert second == []
    eligible_rows = [
        e for e in log.appended if e.get("decision") == "resume-eligible"
    ]
    assert len(eligible_rows) == 1


def test_evaluator_skips_pre_d3_defers_without_resume_on(tmp_path: Path) -> None:
    cache_root = tmp_path / ".deft-cache"
    _write_cached_issue(cache_root, "deftai/directive", 1121, state="closed")
    log = _fake_log()
    # Pre-D3 defer entry: no resume_on field at all.
    log.appended.append(_defer_entry(resume_on=None))

    appended = resume_conditions.evaluate_resume_eligibility(
        tmp_path, today=date(2026, 5, 18), log_module=log
    )
    assert appended == []


def test_evaluator_skips_defers_superseded_by_reset(tmp_path: Path) -> None:
    cache_root = tmp_path / ".deft-cache"
    _write_cached_issue(cache_root, "deftai/directive", 1121, state="closed")
    log = _fake_log()
    log.appended.extend(
        [
            _defer_entry(
                decision_id="11111111-1111-1111-1111-111111111111",
                timestamp="2026-05-01T00:00:00Z",
                resume_on="ref:closed:#1121",
            ),
            {
                "decision_id": "22222222-2222-2222-2222-222222222222",
                "timestamp": "2026-05-15T00:00:00Z",
                "repo": "deftai/directive",
                "issue_number": 1097,
                "decision": "reset",
                "actor": "agent:test",
                "prior_decision_id": "11111111-1111-1111-1111-111111111111",
            },
        ]
    )

    appended = resume_conditions.evaluate_resume_eligibility(
        tmp_path, today=date(2026, 5, 18), log_module=log
    )
    assert appended == []


def test_evaluator_tolerates_malformed_resume_on(tmp_path: Path) -> None:
    log = _fake_log()
    log.appended.append(_defer_entry(resume_on="???garbage???"))
    # Should not raise; just skip the malformed entry.
    appended = resume_conditions.evaluate_resume_eligibility(
        tmp_path, today=date(2026, 5, 18), log_module=log
    )
    assert appended == []


# ---------------------------------------------------------------------------
# triage_actions.defer integration
# ---------------------------------------------------------------------------


def test_defer_records_reason_and_resume_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = SimpleNamespace(
        append=lambda entry, **_: str(entry["decision_id"]),
        appended=[],
    )

    captured: list[dict[str, Any]] = []

    def _append(entry: dict[str, Any], **_: Any) -> str:
        captured.append(entry)
        return str(entry["decision_id"])

    fake.append = _append
    fake.new_decision_id = lambda: "33333333-3333-3333-3333-333333333333"
    monkeypatch.setattr(triage_actions, "candidates_log", fake)

    triage_actions.defer(
        1097,
        "deftai/directive",
        "awaiting D1 close",
        actor="agent:test",
        resume_on="ref:closed:#1121 AND pending-count:>=18",
    )
    assert len(captured) == 1
    entry = captured[0]
    assert entry["decision"] == "defer"
    assert entry["reason"] == "awaiting D1 close"
    assert entry["resume_on"] == "ref:closed:#1121 AND pending-count:>=18"


def test_defer_backward_compat_without_resume_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: list[dict[str, Any]] = []

    def _append(entry: dict[str, Any], **_: Any) -> str:
        captured.append(entry)
        return str(entry["decision_id"])

    fake = SimpleNamespace(
        append=_append,
        new_decision_id=lambda: "44444444-4444-4444-4444-444444444444",
    )
    monkeypatch.setattr(triage_actions, "candidates_log", fake)

    # Reason only (no resume_on) -- works exactly like pre-D3 free-text.
    triage_actions.defer(
        42, "deftai/directive", "awaiting input", actor="agent:test"
    )
    entry = captured[-1]
    assert entry["decision"] == "defer"
    assert entry["reason"] == "awaiting input"
    assert "resume_on" not in entry


def test_defer_rejects_malformed_resume_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = SimpleNamespace(
        append=lambda entry, **_: str(entry["decision_id"]),
        new_decision_id=lambda: "55555555-5555-5555-5555-555555555555",
    )
    monkeypatch.setattr(triage_actions, "candidates_log", fake)

    with pytest.raises(triage_actions.TriageError, match="invalid --resume-on"):
        triage_actions.defer(
            1,
            "deftai/directive",
            "x",
            actor="agent:test",
            resume_on="not a valid expression",
        )


# ---------------------------------------------------------------------------
# derive_group / triage_queue integration
# ---------------------------------------------------------------------------


def test_derive_group_routes_resume_eligible_to_resume() -> None:
    assert (
        triage_queue.derive_group("resume-eligible", in_active_vbrief=False)
        == "RESUME"
    )


def test_derive_group_active_vbrief_still_wins() -> None:
    # in_active_vbrief takes priority over any decision.
    assert (
        triage_queue.derive_group("resume-eligible", in_active_vbrief=True)
        == "RESUME"
    )
    assert (
        triage_queue.derive_group("needs-ac", in_active_vbrief=True) == "RESUME"
    )


def test_derive_group_existing_decisions_still_route_correctly() -> None:
    # Back-compat sanity: prior buckets are not broken by the new branch.
    assert triage_queue.derive_group(None, in_active_vbrief=False) == "untriaged"
    assert (
        triage_queue.derive_group("needs-ac", in_active_vbrief=False) == "URGENT"
    )
    assert triage_queue.derive_group("defer", in_active_vbrief=False) == "other"


# ---------------------------------------------------------------------------
# triage_summary.compute_summary integration
# ---------------------------------------------------------------------------


def _seed_summary_fixture(
    tmp_path: Path,
    *,
    decisions: list[dict[str, Any]],
    cached_issues: list[tuple[str, int]],
) -> None:
    cache_root = tmp_path / ".deft-cache"
    for repo, number in cached_issues:
        _write_cached_issue(cache_root, repo, number, state="open")
    log_path = tmp_path / "vbrief" / ".eval" / "candidates.jsonl"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("w", encoding="utf-8") as fh:
        for entry in decisions:
            fh.write(json.dumps(entry) + "\n")


def test_summary_stale_defer_counts_resume_eligible(tmp_path: Path) -> None:
    _seed_summary_fixture(
        tmp_path,
        cached_issues=[
            ("deftai/directive", 1),
            ("deftai/directive", 2),
            ("deftai/directive", 3),
        ],
        decisions=[
            # #1 -- defer with resume_on (older)
            {
                "decision_id": "11111111-1111-1111-1111-111111111111",
                "timestamp": "2026-05-10T00:00:00Z",
                "repo": "deftai/directive",
                "issue_number": 1,
                "decision": "defer",
                "actor": "agent:test",
                "reason": "x",
                "resume_on": "date:>=2020-01-01",
            },
            # #1 -- resume-eligible appended later (newer)
            {
                "decision_id": "22222222-2222-2222-2222-222222222222",
                "timestamp": "2026-05-15T00:00:00Z",
                "repo": "deftai/directive",
                "issue_number": 1,
                "decision": "resume-eligible",
                "actor": "agent:resume-evaluator",
                "prior_decision_id": "11111111-1111-1111-1111-111111111111",
            },
            # #2 -- still deferred (no resume-eligible row)
            {
                "decision_id": "33333333-3333-3333-3333-333333333333",
                "timestamp": "2026-05-10T00:00:00Z",
                "repo": "deftai/directive",
                "issue_number": 2,
                "decision": "defer",
                "actor": "agent:test",
                "reason": "y",
            },
            # #3 -- accepted (in-flight)
            {
                "decision_id": "44444444-4444-4444-4444-444444444444",
                "timestamp": "2026-05-10T00:00:00Z",
                "repo": "deftai/directive",
                "issue_number": 3,
                "decision": "accept",
                "actor": "agent:test",
            },
        ],
    )

    result = triage_summary.compute_summary(tmp_path)
    assert result.cache_empty is False
    assert result.stale_defer == 1
    assert result.in_flight == 1
    # #2 has a defer decision (not in TRIAGED_DECISIONS' untriaged set);
    # the original summary semantics keep it OUT of "untriaged" because
    # ``defer`` IS in TRIAGED_DECISIONS. So untriaged == 0.
    assert result.untriaged == 0


def test_summary_stale_defer_zero_when_no_resume_eligible(
    tmp_path: Path,
) -> None:
    _seed_summary_fixture(
        tmp_path,
        cached_issues=[("deftai/directive", 1)],
        decisions=[
            {
                "decision_id": "55555555-5555-5555-5555-555555555555",
                "timestamp": "2026-05-10T00:00:00Z",
                "repo": "deftai/directive",
                "issue_number": 1,
                "decision": "defer",
                "actor": "agent:test",
                "reason": "x",
            }
        ],
    )
    result = triage_summary.compute_summary(tmp_path)
    assert result.stale_defer == 0


# ---------------------------------------------------------------------------
# candidates_log schema mirror
# ---------------------------------------------------------------------------


def test_candidates_log_accepts_resume_on_field(tmp_path: Path) -> None:
    candidates_log = importlib.import_module("candidates_log")
    path = tmp_path / "candidates.jsonl"
    entry = {
        "decision_id": "12345678-1234-1234-1234-123456789012",
        "timestamp": "2026-05-18T00:00:00Z",
        "repo": "deftai/directive",
        "issue_number": 1097,
        "decision": "defer",
        "actor": "agent:test",
        "reason": "awaiting close",
        "resume_on": "ref:closed:#1121",
    }
    decision_id = candidates_log.append(entry, path=path)
    assert decision_id == "12345678-1234-1234-1234-123456789012"
    rows = candidates_log.read_all(path=path)
    assert rows[0]["resume_on"] == "ref:closed:#1121"


def test_candidates_log_accepts_resume_eligible_decision(tmp_path: Path) -> None:
    candidates_log = importlib.import_module("candidates_log")
    path = tmp_path / "candidates.jsonl"
    entry = {
        "decision_id": "abcdef01-abcd-abcd-abcd-abcdef012345",
        "timestamp": "2026-05-18T00:00:00Z",
        "repo": "deftai/directive",
        "issue_number": 1097,
        "decision": "resume-eligible",
        "actor": "agent:resume-evaluator",
        "prior_decision_id": "11111111-1111-1111-1111-111111111111",
    }
    candidates_log.append(entry, path=path)
    rows = candidates_log.read_all(path=path)
    assert rows[0]["decision"] == "resume-eligible"


def test_candidates_log_resume_eligible_requires_prior_decision_id(
    tmp_path: Path,
) -> None:
    candidates_log = importlib.import_module("candidates_log")
    path = tmp_path / "candidates.jsonl"
    entry = {
        "decision_id": "abcdef02-abcd-abcd-abcd-abcdef012345",
        "timestamp": "2026-05-18T00:00:00Z",
        "repo": "deftai/directive",
        "issue_number": 1097,
        "decision": "resume-eligible",
        "actor": "agent:resume-evaluator",
        # missing prior_decision_id
    }
    with pytest.raises(candidates_log.CandidatesLogError, match="prior_decision_id"):
        candidates_log.append(entry, path=path)


def test_candidates_log_rejects_empty_resume_on(tmp_path: Path) -> None:
    candidates_log = importlib.import_module("candidates_log")
    path = tmp_path / "candidates.jsonl"
    entry = {
        "decision_id": "abcdef03-abcd-abcd-abcd-abcdef012345",
        "timestamp": "2026-05-18T00:00:00Z",
        "repo": "deftai/directive",
        "issue_number": 1097,
        "decision": "defer",
        "actor": "agent:test",
        "resume_on": "",
    }
    with pytest.raises(candidates_log.CandidatesLogError, match="resume_on"):
        candidates_log.append(entry, path=path)
