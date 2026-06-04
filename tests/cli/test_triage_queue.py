"""CLI-tier tests for scripts/triage_queue.py rank ordering + spec-readiness.

Covers RFC #1419 Delivery Slice 1 (closes #987): wiring
``plan.metadata.rank`` into the triage-queue selection ordering and the
spec-readiness eligibility gate.

Acceptance criteria exercised here (from the slice-1 story vBRIEF):

* a1 -- two pending scopes with distinct ``plan.metadata.rank`` values:
  ``task triage:queue`` orders the lower rank value first. Proven both
  through the programmatic ``QueueBuildOptions.rank_by_number`` surface
  and through the CLI data path (``load_cached_issues`` annotating rank
  from the scope vBRIEFs, then ``build_queue``).
* a2 -- two ready scopes sharing a bucket and rank: ordered by ascending
  creation date.
* spec-readiness refusal -- an under-specified scope is refused with a
  pointer to refinement; a well-formed scope is eligible.

The existing ``tests/test_triage_queue.py`` covers the #1128 group
ordering and the ``updated_at``-desc within-group fallback; this file is
additive and intentionally does not duplicate those.
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

triage_queue = importlib.import_module("triage_queue")

REPO = "owner/repo"


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------


def _issue(
    n,
    *,
    title=None,
    state="open",
    labels=None,
    updated_at="2026-05-17T10:00:00Z",
    created_at=None,
):
    issue = {
        "number": n,
        "title": title or f"Issue {n}",
        "state": state,
        "labels": labels or [],
        "updated_at": updated_at,
    }
    if created_at is not None:
        issue["created_at"] = created_at
    return issue


def _write_cached_issue(cache_root, repo, issue, *, source="github-issue"):
    owner, name = repo.split("/", 1)
    edir = cache_root / source / owner / name / str(issue["number"])
    edir.mkdir(parents=True, exist_ok=True)
    raw = dict(issue)
    raw["labels"] = [{"name": label} for label in issue.get("labels", [])]
    (edir / "raw.json").write_text(json.dumps(raw, sort_keys=True), encoding="utf-8")


def _write_scope_vbrief(folder, filename, *, rank, issue_number, title="Scope"):
    folder.mkdir(parents=True, exist_ok=True)
    payload = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "title": title,
            "status": "pending",
            "metadata": {"rank": rank},
            "references": [
                {
                    "uri": f"https://github.com/{REPO}/issues/{issue_number}",
                    "type": "x-vbrief/github-issue",
                    "title": f"Issue #{issue_number}",
                }
            ],
        },
    }
    (folder / filename).write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _well_formed_plan():
    """A spec-ready plan modelled on the slice-1 story vBRIEF."""
    return {
        "title": "Wire rank into selection ordering",
        "status": "running",
        "narratives": {
            "Description": (
                "Adds an intrinsic rank field and teaches the queue to use it. "
                "This closes the gap between sibling scopes."
            ),
            "ImplementationPlan": (
                "1. Extend the comparator in scripts/triage_queue.py and add tests. "
                "2. Mirror the order in scripts/roadmap_render.py with verification."
            ),
            "UserStory": (
                "As an operator, I want sibling scopes ordered by an explicit rank, "
                "so that the queue reflects priority between vBRIEFs."
            ),
        },
        "items": [
            {
                "id": "a1",
                "narrative": {"Acceptance": "When the queue runs, lower rank sorts first."},
            }
        ],
        "metadata": {
            "swarm": {
                "readiness": "ready",
                "parallel_safe": True,
                "file_scope": ["scripts/triage_queue.py"],
                "verify_commands": ["uv run pytest tests/cli/test_triage_queue.py"],
                "expected_outputs": ["queue sorts by rank"],
                "depends_on": [],
                "conflict_group": "selection-ordering",
                "size": "small",
                "file_scope_confidence": "high",
                "model_tier": "medium",
            }
        },
    }


# ---------------------------------------------------------------------------
# scope_metadata_rank parsing
# ---------------------------------------------------------------------------


def test_scope_metadata_rank_reads_int():
    assert triage_queue.scope_metadata_rank({"metadata": {"rank": 3}}) == 3


def test_scope_metadata_rank_reads_integer_string():
    assert triage_queue.scope_metadata_rank({"metadata": {"rank": "7"}}) == 7


def test_scope_metadata_rank_reads_negative():
    assert triage_queue.scope_metadata_rank({"metadata": {"rank": -2}}) == -2


def test_scope_metadata_rank_rejects_bool():
    # bool subclasses int, but a True rank is meaningless.
    assert triage_queue.scope_metadata_rank({"metadata": {"rank": True}}) is None


def test_scope_metadata_rank_missing_returns_none():
    assert triage_queue.scope_metadata_rank({"metadata": {}}) is None
    assert triage_queue.scope_metadata_rank({}) is None
    assert triage_queue.scope_metadata_rank(None) is None


def test_scope_metadata_rank_reads_negative_string():
    assert triage_queue.scope_metadata_rank({"metadata": {"rank": "-5"}}) == -5


def test_scope_metadata_rank_rejects_malformed_string():
    # Double-hyphen / non-numeric / empty strings must return None, not raise.
    assert triage_queue.scope_metadata_rank({"metadata": {"rank": "--3"}}) is None
    assert triage_queue.scope_metadata_rank({"metadata": {"rank": "abc"}}) is None
    assert triage_queue.scope_metadata_rank({"metadata": {"rank": ""}}) is None
    assert triage_queue.scope_metadata_rank({"metadata": {"rank": "3.5"}}) is None


# ---------------------------------------------------------------------------
# a1 -- rank precedence over creation date (programmatic surface)
# ---------------------------------------------------------------------------


def test_build_queue_orders_lower_rank_first_over_date():
    """a1: lower plan.metadata.rank sorts first, beating creation date."""
    issues = [
        # rank 3, but created earliest -> would win on date alone.
        _issue(1, created_at="2026-01-01T00:00:00Z"),
        # rank 1, created latest -> still wins because rank dominates.
        _issue(2, created_at="2026-06-01T00:00:00Z"),
    ]
    options = triage_queue.QueueBuildOptions(rank_by_number={1: 3, 2: 1})
    items = triage_queue.build_queue(issues, [], repo=REPO, options=options)
    assert [i.number for i in items] == [2, 1]


# ---------------------------------------------------------------------------
# a2 -- same rank tiebreaks by ascending creation date
# ---------------------------------------------------------------------------


def test_build_queue_same_rank_tiebreaks_by_creation_date_ascending():
    """a2: equal rank within a bucket -> ascending creation date."""
    issues = [
        _issue(10, created_at="2026-03-01T00:00:00Z"),
        _issue(11, created_at="2026-01-01T00:00:00Z"),
    ]
    options = triage_queue.QueueBuildOptions(rank_by_number={10: 5, 11: 5})
    items = triage_queue.build_queue(issues, [], repo=REPO, options=options)
    # Earlier creation date sorts first.
    assert [i.number for i in items] == [11, 10]


def test_build_queue_unranked_sorts_after_ranked():
    """The least-surprising rule: scopes without a rank tail-sort after ranked ones."""
    issues = [
        # ranked, but created later than the unranked sibling.
        _issue(20, created_at="2026-06-01T00:00:00Z"),
        # unranked, created earlier.
        _issue(21, created_at="2026-01-01T00:00:00Z"),
    ]
    options = triage_queue.QueueBuildOptions(rank_by_number={20: 5})
    items = triage_queue.build_queue(issues, [], repo=REPO, options=options)
    assert [i.number for i in items] == [20, 21]


def test_build_queue_rank_from_metadata_annotation():
    """CLI surface: rank read from the per-issue _metadata_rank annotation."""
    issues = [
        dict(_issue(30), _metadata_rank=2),
        dict(_issue(31), _metadata_rank=1),
    ]
    items = triage_queue.build_queue(issues, [], repo=REPO)
    assert [i.number for i in items] == [31, 30]


def test_build_queue_non_ascii_updated_at_does_not_raise():
    """A non-ASCII char in updated_at must not crash the date-inversion tiebreak."""
    # Em dash (U+2014, ord > 0x7F) in updated_at, no created_at, no rank.
    issues = [_issue(1, updated_at="2026\u2014bad")]
    items = triage_queue.build_queue(issues, [], repo=REPO)
    assert [i.number for i in items] == [1]


def test_date_sort_key_non_ascii_falls_back_without_error():
    key = triage_queue._date_sort_key({"number": 1, "updated_at": "x\u2014y"})
    assert key[0] == 1  # bucket 1 (updated_at fallback), no exception raised


# ---------------------------------------------------------------------------
# a1 -- rank wired from scope vBRIEFs through the CLI data path
# ---------------------------------------------------------------------------


def test_rank_by_issue_number_reads_pending_and_active(tmp_path):
    pending = tmp_path / "vbrief" / "pending"
    active = tmp_path / "vbrief" / "active"
    _write_scope_vbrief(pending, "2026-06-04-a.vbrief.json", rank=5, issue_number=100)
    _write_scope_vbrief(active, "2026-06-04-b.vbrief.json", rank=2, issue_number=200)
    rank_map = triage_queue._rank_by_issue_number(tmp_path)
    assert rank_map == {100: 5, 200: 2}


def test_load_cached_issues_annotates_rank_from_scope_vbriefs(tmp_path):
    """End-to-end a1: load_cached_issues stamps rank, build_queue orders by it."""
    cache_root = tmp_path / ".deft-cache"
    _write_cached_issue(cache_root, REPO, _issue(100, created_at="2026-01-01T00:00:00Z"))
    _write_cached_issue(cache_root, REPO, _issue(200, created_at="2026-06-01T00:00:00Z"))
    pending = tmp_path / "vbrief" / "pending"
    # Issue 100 ranked 9 (created earliest); issue 200 ranked 1 (created latest).
    _write_scope_vbrief(pending, "2026-06-04-a.vbrief.json", rank=9, issue_number=100)
    _write_scope_vbrief(pending, "2026-06-04-b.vbrief.json", rank=1, issue_number=200)
    issues = triage_queue.load_cached_issues(REPO, project_root=tmp_path)
    by_number = {i["number"]: i for i in issues}
    assert by_number[100]["_metadata_rank"] == 9
    assert by_number[200]["_metadata_rank"] == 1
    items = triage_queue.build_queue(issues, [], repo=REPO)
    # Rank 1 (issue 200) sorts ahead of rank 9 (issue 100) despite 200's
    # later creation date -- rank dominates.
    assert [i.number for i in items] == [200, 100]


def test_load_cached_issues_extracts_created_at(tmp_path):
    cache_root = tmp_path / ".deft-cache"
    _write_cached_issue(cache_root, REPO, _issue(1, created_at="2026-02-03T04:05:06Z"))
    issues = triage_queue.load_cached_issues(REPO, project_root=tmp_path)
    assert issues[0]["created_at"] == "2026-02-03T04:05:06Z"


def test_load_cached_issues_rank_none_without_scope_vbrief(tmp_path):
    cache_root = tmp_path / ".deft-cache"
    _write_cached_issue(cache_root, REPO, _issue(1))
    issues = triage_queue.load_cached_issues(REPO, project_root=tmp_path)
    assert issues[0]["_metadata_rank"] is None


# ---------------------------------------------------------------------------
# spec-readiness eligibility (refuse under-specified scopes -> refinement)
# ---------------------------------------------------------------------------


def test_scope_spec_readiness_refuses_underspecified():
    eligible, reasons = triage_queue.scope_spec_readiness({"title": "bare", "status": "pending"})
    assert eligible is False
    # The swarm readiness gate and the missing swarm fields are all reported.
    assert "plan.metadata.swarm.readiness=ready" in reasons
    assert any("plan.metadata.swarm.file_scope" in r for r in reasons)
    assert any("plan.narratives.Description" in r for r in reasons)


def test_spec_readiness_refusal_points_at_refinement():
    msg = triage_queue.spec_readiness_refusal(
        {"title": "bare", "status": "pending"}, scope_label="scope-x"
    )
    assert msg is not None
    assert "scope-x" in msg
    assert "under-specified" in msg
    assert "refinement" in msg


def test_scope_spec_readiness_accepts_well_formed():
    eligible, reasons = triage_queue.scope_spec_readiness(_well_formed_plan())
    assert eligible is True, f"expected eligible, got reasons: {reasons}"
    assert reasons == []


def test_spec_readiness_refusal_none_when_eligible():
    assert triage_queue.spec_readiness_refusal(_well_formed_plan()) is None
