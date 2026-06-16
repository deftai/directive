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
import subprocess
import sys
from datetime import UTC, datetime, timedelta
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


# ---------------------------------------------------------------------------
# Slice 2 (#1419 / #987) -- continuation precedence + deficit-biased selection
# ---------------------------------------------------------------------------
#
# Acceptance criteria from the slice-2 story vBRIEF:
#   a1 -- a started epic's remaining stories rank ahead of net-new scopes.
#   a2 -- among net-new scopes the most-under-target bucket sorts first.
#   a3 -- finishBeforeStart + wipCap reached blocks net-new, allows only
#         continuation work.


def _write_epic(folder, filename, *, children, title="Epic"):
    """Write a parent epic vBRIEF with ``x-vbrief/plan`` child references.

    ``children`` is a list of ``(folder, child_filename)`` tuples mirroring
    the on-disk lifecycle-folder layout (e.g. ``("completed", "slice1...")``).
    """
    folder.mkdir(parents=True, exist_ok=True)
    refs = [
        {"uri": f"{child_folder}/{child_name}", "type": "x-vbrief/plan", "title": child_name}
        for child_folder, child_name in children
    ]
    payload = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "title": title,
            "status": "proposed",
            "metadata": {"kind": "epic"},
            "references": refs,
        },
    }
    (folder / filename).write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _write_child_scope(
    folder, filename, *, issue_number, plan_ref=None, rank=None, capacity_bucket=None
):
    """Write an in-flight child scope vBRIEF referencing a GitHub issue."""
    folder.mkdir(parents=True, exist_ok=True)
    metadata = {}
    if rank is not None:
        metadata["rank"] = rank
    if capacity_bucket is not None:
        metadata["capacityBucket"] = capacity_bucket
    plan = {
        "title": "Child scope",
        "status": "running",
        "references": [
            {
                "uri": f"https://github.com/{REPO}/issues/{issue_number}",
                "type": "x-vbrief/github-issue",
                "title": f"Issue #{issue_number}",
            }
        ],
    }
    if plan_ref is not None:
        plan["planRef"] = plan_ref
    if metadata:
        plan["metadata"] = metadata
    payload = {"vBRIEFInfo": {"version": "0.6"}, "plan": plan}
    (folder / filename).write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _write_completed_scope(folder, filename, *, bucket, completed_at):
    """Write a completed scope carrying a capacity bucket + completedAt."""
    folder.mkdir(parents=True, exist_ok=True)
    payload = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "title": "Done",
            "status": "completed",
            "metadata": {"kind": "story", "capacityBucket": bucket, "completedAt": completed_at},
        },
    }
    (folder / filename).write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _write_capacity_project_definition(
    vbrief, *, buckets, window=30, default_bucket=None, finish_before_start=None, wip_cap=None
):
    """Write a PROJECT-DEFINITION with a capacityAllocation (+ optional wipCap)."""
    cap = {"window": window, "buckets": [{"id": bid, "target": t} for bid, t in buckets]}
    if default_bucket is not None:
        cap["defaultBucket"] = default_bucket
    if finish_before_start is not None:
        cap["finishBeforeStart"] = finish_before_start
    policy = {"capacityAllocation": cap}
    if wip_cap is not None:
        policy["wipCap"] = wip_cap
    payload = {"vBRIEFInfo": {"version": "0.6"}, "plan": {"title": "P", "policy": policy}}
    vbrief.mkdir(parents=True, exist_ok=True)
    (vbrief / "PROJECT-DEFINITION.vbrief.json").write_text(
        json.dumps(payload, indent=2), encoding="utf-8"
    )


# --- selection_ordering_key (the canonical lexicographic key) ---------------


def test_selection_ordering_key_continuation_before_net_new():
    cont = triage_queue.selection_ordering_key(label_index=0, is_continuation=True)
    net_new = triage_queue.selection_ordering_key(label_index=0, is_continuation=False)
    assert cont < net_new


def test_selection_ordering_key_higher_deficit_first_among_net_new():
    high = triage_queue.selection_ordering_key(
        label_index=0, is_continuation=False, bucket_deficit=0.5
    )
    low = triage_queue.selection_ordering_key(
        label_index=0, is_continuation=False, bucket_deficit=0.1
    )
    assert high < low


def test_selection_ordering_key_label_preempts_continuation():
    urgent_net_new = triage_queue.selection_ordering_key(label_index=0, is_continuation=False)
    nonurgent_continuation = triage_queue.selection_ordering_key(
        label_index=1, is_continuation=True
    )
    assert urgent_net_new < nonurgent_continuation


def test_selection_ordering_key_oldest_started_epic_first():
    older = triage_queue.selection_ordering_key(
        label_index=0, is_continuation=True, continuation_order="2026-01-01-epic"
    )
    newer = triage_queue.selection_ordering_key(
        label_index=0, is_continuation=True, continuation_order="2026-06-01-epic"
    )
    assert older < newer


# --- a1: continuation outranks net-new (programmatic surface) ---------------


def test_build_queue_continuation_outranks_net_new():
    """a1: a started epic's story sorts ahead of net-new despite a later date."""
    issues = [
        _issue(1, created_at="2026-01-01T00:00:00Z"),  # net-new, earliest
        _issue(2, created_at="2026-06-01T00:00:00Z"),  # continuation, latest
    ]
    options = triage_queue.QueueBuildOptions(continuation_numbers=frozenset({2}))
    items = triage_queue.build_queue(issues, [], repo=REPO, options=options)
    assert [i.number for i in items] == [2, 1]


def test_build_queue_continuation_outranks_better_ranked_net_new():
    """a1: continuation precedence beats a lower (better) net-new rank."""
    issues = [_issue(1), _issue(2)]
    options = triage_queue.QueueBuildOptions(
        continuation_numbers=frozenset({2}),
        rank_by_number={1: 1, 2: 9},  # net-new #1 has the better rank
    )
    items = triage_queue.build_queue(issues, [], repo=REPO, options=options)
    assert [i.number for i in items] == [2, 1]


def test_build_queue_continuation_oldest_started_epic_first():
    issues = [_issue(1), _issue(2)]
    options = triage_queue.QueueBuildOptions(
        continuation_numbers=frozenset({1, 2}),
        continuation_order_by_number={1: "2026-06-04-newer", 2: "2026-01-01-older"},
    )
    items = triage_queue.build_queue(issues, [], repo=REPO, options=options)
    assert [i.number for i in items] == [2, 1]


# --- a2: deficit-biased ordering among net-new ------------------------------


def test_build_queue_deficit_orders_most_under_target_first():
    """a2: among net-new scopes the higher-deficit (more under target) first."""
    issues = [_issue(1), _issue(2)]
    options = triage_queue.QueueBuildOptions(deficit_by_number={1: 0.1, 2: 0.5})
    items = triage_queue.build_queue(issues, [], repo=REPO, options=options)
    assert [i.number for i in items] == [2, 1]


def test_build_queue_continuation_beats_deficit():
    """Continuation precedence dominates the bucket deficit (RFC order)."""
    issues = [_issue(1), _issue(2)]
    options = triage_queue.QueueBuildOptions(
        continuation_numbers=frozenset({2}),
        deficit_by_number={1: 0.9},  # net-new #1 is badly under target
    )
    items = triage_queue.build_queue(issues, [], repo=REPO, options=options)
    assert [i.number for i in items] == [2, 1]


# --- a3: finishBeforeStart blocks net-new at wipCap -------------------------


def test_build_queue_finish_before_start_blocks_net_new_at_cap():
    """a3: finishBeforeStart + wipCap reached -> only continuation promotable."""
    issues = [_issue(1), _issue(2), _issue(3)]
    options = triage_queue.QueueBuildOptions(
        continuation_numbers=frozenset({2}),
        finish_before_start=True,
        wip_at_cap=True,
    )
    items = triage_queue.build_queue(issues, [], repo=REPO, options=options)
    assert [i.number for i in items] == [2]


def test_build_queue_finish_before_start_inert_below_cap():
    """finishBeforeStart does nothing until wipCap is reached."""
    issues = [_issue(1), _issue(2)]
    options = triage_queue.QueueBuildOptions(
        continuation_numbers=frozenset({2}),
        finish_before_start=True,
        wip_at_cap=False,
    )
    items = triage_queue.build_queue(issues, [], repo=REPO, options=options)
    assert sorted(i.number for i in items) == [1, 2]
    assert items[0].number == 2  # continuation still leads


def test_build_queue_finish_before_start_requires_flag():
    """wipCap reached without finishBeforeStart leaves net-new selectable."""
    issues = [_issue(1), _issue(2)]
    options = triage_queue.QueueBuildOptions(
        continuation_numbers=frozenset({2}),
        finish_before_start=False,
        wip_at_cap=True,
    )
    items = triage_queue.build_queue(issues, [], repo=REPO, options=options)
    assert sorted(i.number for i in items) == [1, 2]


def test_build_queue_finish_before_start_keeps_orphans():
    """ORPHAN items (D13 / #1132) survive finishBeforeStart -- only net-new drops."""
    issues = [_issue(1), _issue(2), _issue(3)]
    options = triage_queue.QueueBuildOptions(
        continuation_numbers=frozenset({2}),
        orphan_issue_numbers=frozenset({3}),
        finish_before_start=True,
        wip_at_cap=True,
    )
    items = triage_queue.build_queue(issues, [], repo=REPO, options=options)
    numbers = [i.number for i in items]
    # Net-new #1 dropped; continuation #2 and orphan #3 both survive.
    assert set(numbers) == {2, 3}
    # ORPHAN tops GROUP_ORDER, so the orphan leads the surviving rows.
    assert numbers[0] == 3


# --- continuation_by_issue_number (filesystem-truth) ------------------------


def test_continuation_by_issue_number_detects_started_epic(tmp_path):
    vbrief = tmp_path / "vbrief"
    _write_epic(
        vbrief / "proposed",
        "2026-06-01-epic.vbrief.json",
        children=[
            ("completed", "2026-06-01-slice1.vbrief.json"),
            ("active", "2026-06-04-slice2.vbrief.json"),
        ],
    )
    _write_child_scope(
        vbrief / "active",
        "2026-06-04-slice2.vbrief.json",
        issue_number=200,
        plan_ref="proposed/2026-06-01-epic.vbrief.json",
    )
    result = triage_queue.continuation_by_issue_number(tmp_path)
    assert result == {200: "2026-06-01-epic.vbrief.json"}


def test_continuation_by_issue_number_sibling_active_counts(tmp_path):
    vbrief = tmp_path / "vbrief"
    _write_epic(
        vbrief / "proposed",
        "2026-06-01-epic.vbrief.json",
        children=[
            ("active", "2026-06-04-slice2.vbrief.json"),
            ("active", "2026-06-04-slice5.vbrief.json"),
        ],
    )
    _write_child_scope(
        vbrief / "active",
        "2026-06-04-slice2.vbrief.json",
        issue_number=200,
        plan_ref="proposed/2026-06-01-epic.vbrief.json",
    )
    result = triage_queue.continuation_by_issue_number(tmp_path)
    assert 200 in result  # the sibling active child started the epic


def test_continuation_by_issue_number_lone_active_self_not_flagged(tmp_path):
    """An epic whose only active child IS this candidate is not yet started."""
    vbrief = tmp_path / "vbrief"
    _write_epic(
        vbrief / "proposed",
        "2026-06-04-epic.vbrief.json",
        children=[("active", "2026-06-04-slice1.vbrief.json")],
    )
    _write_child_scope(
        vbrief / "active",
        "2026-06-04-slice1.vbrief.json",
        issue_number=300,
        plan_ref="proposed/2026-06-04-epic.vbrief.json",
    )
    assert triage_queue.continuation_by_issue_number(tmp_path) == {}


def test_continuation_by_issue_number_no_plan_ref(tmp_path):
    vbrief = tmp_path / "vbrief"
    _write_child_scope(vbrief / "active", "2026-06-04-x.vbrief.json", issue_number=400)
    assert triage_queue.continuation_by_issue_number(tmp_path) == {}


# --- bucket_deficit_by_issue_number (reads the Slice-4 capacity engine) -----


def test_bucket_deficit_by_issue_number_reads_capacity_engine(tmp_path):
    vbrief = tmp_path / "vbrief"
    for sub in ("proposed", "pending", "active", "completed", "cancelled"):
        (vbrief / sub).mkdir(parents=True)
    _write_capacity_project_definition(vbrief, buckets=[("feature", 0.5), ("debt", 0.5)], window=30)
    recent = (datetime.now(UTC) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    completed = vbrief / "completed"
    # Two completions in 'feature' -> 'debt' is starved (positive deficit).
    _write_completed_scope(completed, "c1.vbrief.json", bucket="feature", completed_at=recent)
    _write_completed_scope(completed, "c2.vbrief.json", bucket="feature", completed_at=recent)
    _write_child_scope(
        vbrief / "active",
        "2026-06-04-debt.vbrief.json",
        issue_number=500,
        capacity_bucket="debt",
    )
    _write_child_scope(
        vbrief / "active",
        "2026-06-04-feature.vbrief.json",
        issue_number=600,
        capacity_bucket="feature",
    )
    result = triage_queue.bucket_deficit_by_issue_number(tmp_path)
    assert result[500] > 0  # debt under target
    assert result[600] < 0  # feature over target
    assert result[500] > result[600]


# --- resolve_finish_before_start / wip_at_cap ------------------------------


def test_resolve_finish_before_start_true(tmp_path):
    vbrief = tmp_path / "vbrief"
    _write_capacity_project_definition(vbrief, buckets=[("feature", 1.0)], finish_before_start=True)
    assert triage_queue.resolve_finish_before_start(tmp_path) is True


def test_resolve_finish_before_start_default_false(tmp_path):
    vbrief = tmp_path / "vbrief"
    _write_capacity_project_definition(vbrief, buckets=[("feature", 1.0)])
    assert triage_queue.resolve_finish_before_start(tmp_path) is False


def test_resolve_finish_before_start_no_project_definition(tmp_path):
    assert triage_queue.resolve_finish_before_start(tmp_path) is False


def test_wip_at_cap_true_when_count_reaches_cap(tmp_path):
    vbrief = tmp_path / "vbrief"
    _write_capacity_project_definition(vbrief, buckets=[("feature", 1.0)], wip_cap=1)
    _write_child_scope(vbrief / "pending", "2026-06-04-a.vbrief.json", issue_number=1)
    assert triage_queue.wip_at_cap(tmp_path) is True


def test_wip_at_cap_false_below_cap(tmp_path):
    vbrief = tmp_path / "vbrief"
    _write_capacity_project_definition(vbrief, buckets=[("feature", 1.0)], wip_cap=10)
    _write_child_scope(vbrief / "pending", "2026-06-04-a.vbrief.json", issue_number=1)
    assert triage_queue.wip_at_cap(tmp_path) is False


# --- CLI data path: load_cached_issues stamps continuation/deficit ----------


def test_load_cached_issues_annotates_continuation(tmp_path):
    """End-to-end a1: load_cached_issues stamps continuation, build_queue leads it."""
    cache_root = tmp_path / ".deft-cache"
    _write_cached_issue(cache_root, REPO, _issue(100, created_at="2026-01-01T00:00:00Z"))
    _write_cached_issue(cache_root, REPO, _issue(200, created_at="2026-06-01T00:00:00Z"))
    vbrief = tmp_path / "vbrief"
    _write_epic(
        vbrief / "proposed",
        "2026-06-01-epic.vbrief.json",
        children=[
            ("completed", "2026-06-01-slice1.vbrief.json"),
            ("active", "2026-06-04-slice2.vbrief.json"),
        ],
    )
    # Issue 200 is continuation (started epic); issue 100 is net-new.
    _write_child_scope(
        vbrief / "active",
        "2026-06-04-slice2.vbrief.json",
        issue_number=200,
        plan_ref="proposed/2026-06-01-epic.vbrief.json",
    )
    _write_child_scope(vbrief / "active", "2026-06-04-netnew.vbrief.json", issue_number=100)
    issues = triage_queue.load_cached_issues(REPO, project_root=tmp_path)
    by_number = {i["number"]: i for i in issues}
    assert by_number[200]["_continuation"] is True
    assert by_number[200]["_continuation_order"] == "2026-06-01-epic.vbrief.json"
    assert by_number[100]["_continuation"] is False
    items = triage_queue.build_queue(issues, [], repo=REPO)
    assert [i.number for i in items] == [200, 100]


# ---------------------------------------------------------------------------
# #1286 -- demote vBRIEF-status:blocked / unresolved-dependency items
# ---------------------------------------------------------------------------
#
# Acceptance criteria from the story vBRIEF:
#   * Blocked items (linked vBRIEF plan.status == "blocked" OR an unresolved
#     plan.metadata.swarm.depends_on) are demoted into the [BLOCKED] group by
#     default.
#   * Unblocked items surface in their natural group.
#   * The --include-blocked opt-in re-surfaces blocked items into their
#     natural group.


def _write_status_scope(
    folder, filename, *, issue_number, status="running", depends_on=None, plan_id=None
):
    """Write an in-flight scope with a given status / depends_on / plan id."""
    folder.mkdir(parents=True, exist_ok=True)
    plan = {
        "title": "Scope",
        "status": status,
        "references": [
            {
                "uri": f"https://github.com/{REPO}/issues/{issue_number}",
                "type": "x-vbrief/github-issue",
                "title": f"Issue #{issue_number}",
            }
        ],
    }
    if plan_id is not None:
        plan["id"] = plan_id
    if depends_on is not None:
        plan["metadata"] = {"swarm": {"depends_on": depends_on}}
    payload = {"vBRIEFInfo": {"version": "0.6"}, "plan": plan}
    (folder / filename).write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _write_completed_with_id(folder, filename, *, plan_id):
    folder.mkdir(parents=True, exist_ok=True)
    payload = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {"title": "done", "status": "completed", "id": plan_id},
    }
    (folder / filename).write_text(json.dumps(payload, indent=2), encoding="utf-8")


# --- GROUP_ORDER + scope_is_blocked unit coverage ---------------------------


def test_blocked_group_is_last_in_group_order():
    assert "BLOCKED" in triage_queue.GROUP_ORDER
    assert triage_queue.GROUP_ORDER[-1] == "BLOCKED"
    # The display marker is registered so render_queue does not fall back.
    assert "BLOCKED" in triage_queue.GROUP_DISPLAY


def test_scope_is_blocked_status_blocked():
    assert triage_queue.scope_is_blocked({"status": "blocked"}, completed_ids=set()) is True


def test_scope_is_blocked_unresolved_depends_on():
    plan = {"status": "running", "metadata": {"swarm": {"depends_on": ["dep-a"]}}}
    assert triage_queue.scope_is_blocked(plan, completed_ids=set()) is True


def test_scope_is_blocked_resolved_depends_on_is_not_blocked():
    plan = {"status": "running", "metadata": {"swarm": {"depends_on": ["dep-a"]}}}
    assert triage_queue.scope_is_blocked(plan, completed_ids={"dep-a"}) is False


def test_scope_is_blocked_partial_unresolved_depends_on():
    plan = {"status": "running", "metadata": {"swarm": {"depends_on": ["dep-a", "dep-b"]}}}
    # dep-b still unresolved -> blocked.
    assert triage_queue.scope_is_blocked(plan, completed_ids={"dep-a"}) is True


def test_scope_is_blocked_no_deps_running_is_not_blocked():
    plan = {"status": "running", "metadata": {"swarm": {"depends_on": []}}}
    assert triage_queue.scope_is_blocked(plan, completed_ids=set()) is False
    assert triage_queue.scope_is_blocked({"status": "running"}, completed_ids=set()) is False


# --- build_queue: demote by default / surface unblocked / opt-in ------------


def test_build_queue_demotes_blocked_into_blocked_group():
    """Blocked items are demoted into the [BLOCKED] group by default."""
    issues = [_issue(1), _issue(2)]
    options = triage_queue.QueueBuildOptions(blocked_issue_numbers=frozenset({1}))
    items = triage_queue.build_queue(issues, [], repo=REPO, options=options)
    by_number = {i.number: i for i in items}
    assert by_number[1].group == "BLOCKED"
    assert by_number[2].group == "untriaged"
    # BLOCKED sorts last, so the unblocked item leads.
    assert [i.number for i in items] == [2, 1]


def test_build_queue_unblocked_issue_surfaces_in_natural_group():
    issues = [_issue(1)]
    options = triage_queue.QueueBuildOptions(blocked_issue_numbers=frozenset())
    items = triage_queue.build_queue(issues, [], repo=REPO, options=options)
    assert items[0].group == "untriaged"


def test_build_queue_include_blocked_resurfaces_into_natural_group():
    """--include-blocked re-surfaces blocked items into their natural group."""
    issues = [_issue(1), _issue(2)]
    options = triage_queue.QueueBuildOptions(
        blocked_issue_numbers=frozenset({1}),
        include_blocked=True,
    )
    items = triage_queue.build_queue(issues, [], repo=REPO, options=options)
    by_number = {i.number: i for i in items}
    assert by_number[1].group == "untriaged"
    assert by_number[2].group == "untriaged"


def test_build_queue_blocked_resume_demoted_unless_included():
    """A blocked item that would otherwise RESUME is still demoted by default."""
    issues = [_issue(1)]
    options = triage_queue.QueueBuildOptions(
        active_referenced=frozenset({1}),
        blocked_issue_numbers=frozenset({1}),
    )
    items = triage_queue.build_queue(issues, [], repo=REPO, options=options)
    assert items[0].group == "BLOCKED"
    # With include_blocked the RESUME group is restored.
    items2 = triage_queue.build_queue(
        issues,
        [],
        repo=REPO,
        options=triage_queue.QueueBuildOptions(
            active_referenced=frozenset({1}),
            blocked_issue_numbers=frozenset({1}),
            include_blocked=True,
        ),
    )
    assert items2[0].group == "RESUME"


# --- blocked_by_issue_number (filesystem-truth) -----------------------------


def test_blocked_by_issue_number_detects_status_blocked(tmp_path):
    vbrief = tmp_path / "vbrief"
    _write_status_scope(
        vbrief / "active", "2026-06-04-a.vbrief.json", issue_number=700, status="blocked"
    )
    _write_status_scope(
        vbrief / "active", "2026-06-04-b.vbrief.json", issue_number=701, status="running"
    )
    result = triage_queue.blocked_by_issue_number(tmp_path)
    assert 700 in result
    assert 701 not in result


def test_blocked_by_issue_number_detects_unresolved_depends_on(tmp_path):
    vbrief = tmp_path / "vbrief"
    _write_status_scope(
        vbrief / "pending",
        "2026-06-04-dep.vbrief.json",
        issue_number=800,
        status="pending",
        depends_on=["story-x"],
    )
    result = triage_queue.blocked_by_issue_number(tmp_path)
    assert 800 in result


def test_blocked_by_issue_number_resolved_depends_on_not_blocked(tmp_path):
    vbrief = tmp_path / "vbrief"
    _write_completed_with_id(vbrief / "completed", "2026-06-01-x.vbrief.json", plan_id="story-x")
    _write_status_scope(
        vbrief / "pending",
        "2026-06-04-dep.vbrief.json",
        issue_number=810,
        status="pending",
        depends_on=["story-x"],
    )
    result = triage_queue.blocked_by_issue_number(tmp_path)
    assert 810 not in result


# --- CLI data path: load_cached_issues stamps _blocked ----------------------


def test_load_cached_issues_annotates_blocked(tmp_path):
    cache_root = tmp_path / ".deft-cache"
    _write_cached_issue(cache_root, REPO, _issue(700))
    _write_cached_issue(cache_root, REPO, _issue(701))
    vbrief = tmp_path / "vbrief"
    _write_status_scope(
        vbrief / "active", "2026-06-04-blocked.vbrief.json", issue_number=700, status="blocked"
    )
    _write_status_scope(
        vbrief / "active", "2026-06-04-ok.vbrief.json", issue_number=701, status="running"
    )
    issues = triage_queue.load_cached_issues(REPO, project_root=tmp_path)
    by_number = {i["number"]: i for i in issues}
    assert by_number[700]["_blocked"] is True
    assert by_number[701]["_blocked"] is False
    # End-to-end: build_queue demotes the blocked issue.
    items = triage_queue.build_queue(issues, [], repo=REPO)
    by_num = {i.number: i for i in items}
    assert by_num[700].group == "BLOCKED"
    assert by_num[701].group == "untriaged"


def test_load_cached_issues_blocked_resurfaces_with_include_blocked(tmp_path):
    cache_root = tmp_path / ".deft-cache"
    _write_cached_issue(cache_root, REPO, _issue(700))
    vbrief = tmp_path / "vbrief"
    _write_status_scope(
        vbrief / "active", "2026-06-04-blocked.vbrief.json", issue_number=700, status="blocked"
    )
    issues = triage_queue.load_cached_issues(REPO, project_root=tmp_path)
    items = triage_queue.build_queue(
        issues,
        [],
        repo=REPO,
        options=triage_queue.QueueBuildOptions(include_blocked=True),
    )
    assert items[0].group != "BLOCKED"


# ---------------------------------------------------------------------------
# #1238 -- canonical repo resolution helper in scripts/triage_queue.py
# ---------------------------------------------------------------------------
#
# Acceptance criteria from the story vBRIEF (issue #1238):
#   1. ``_resolve_repo`` helper mirroring preflight_cache: explicit --repo >
#      DEFT_TRIAGE_REPO env > git remote get-url origin.
#   2. Explicit --repo wins over env + git; DEFT_TRIAGE_REPO wins over git.
#   3. None (-> exit 2) only when none of the three sources resolve.
#   4. Regression test: fake project root + monkeypatched git origin covering
#      inference, --repo precedence, env precedence, and the no-source path.
#
# The helper-level tests below fail before the fix (the module exposed no
# ``_resolve_repo`` / ``_infer_repo_from_git`` symbol -- it lived only in the
# CLI shim), satisfying the "should fail before your fix" requirement.


def _init_fake_git_origin(repo_root: Path, url: str) -> None:
    """Initialise a bare-bones git tree in ``repo_root`` with ``origin=url``.

    Exercises the ``git remote get-url origin`` path without depending on
    the host working copy's remote configuration.
    """
    subprocess.run(
        ["git", "init", "--quiet", str(repo_root)],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    subprocess.run(
        ["git", "-C", str(repo_root), "remote", "add", "origin", url],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


# --- _infer_repo_from_git parsing -------------------------------------------


def test_infer_repo_from_git_https(tmp_path):
    _init_fake_git_origin(tmp_path, "https://github.com/deftai/directive.git")
    assert triage_queue._infer_repo_from_git(tmp_path) == "deftai/directive"


def test_infer_repo_from_git_ssh_preserves_dots(tmp_path):
    _init_fake_git_origin(tmp_path, "git@github.com:owner/with.dots.git")
    assert triage_queue._infer_repo_from_git(tmp_path) == "owner/with.dots"


def test_infer_repo_from_git_none_outside_git_tree(tmp_path):
    # No .git / no origin remote -> detection fails so the caller can
    # surface the canonical --repo error.
    assert triage_queue._infer_repo_from_git(tmp_path) is None


def test_infer_repo_from_git_none_for_non_github_remote(tmp_path):
    _init_fake_git_origin(tmp_path, "https://gitlab.com/owner/name.git")
    assert triage_queue._infer_repo_from_git(tmp_path) is None


# --- _resolve_repo precedence (flag > env > git origin > None) ----------------


def test_resolve_repo_explicit_flag_wins(monkeypatch, tmp_path):
    """AC2: explicit --repo wins over env var and git origin."""
    monkeypatch.setenv("DEFT_TRIAGE_REPO", "env/repo")
    monkeypatch.setattr(triage_queue, "_infer_repo_from_git", lambda _root: "git/origin")
    assert triage_queue._resolve_repo("explicit/win", project_root=tmp_path) == "explicit/win"


def test_resolve_repo_env_var_beats_git_origin(monkeypatch, tmp_path):
    """AC2: DEFT_TRIAGE_REPO wins over git origin when no --repo flag."""
    monkeypatch.setenv("DEFT_TRIAGE_REPO", "env/wins")
    monkeypatch.setattr(triage_queue, "_infer_repo_from_git", lambda _root: "git/origin")
    assert triage_queue._resolve_repo(None, project_root=tmp_path) == "env/wins"


def test_resolve_repo_infers_from_git_origin(monkeypatch, tmp_path):
    """AC1: no flag + no env -> inferred from git remote get-url origin."""
    monkeypatch.delenv("DEFT_TRIAGE_REPO", raising=False)
    _init_fake_git_origin(tmp_path, "https://github.com/deftai/directive.git")
    assert triage_queue._resolve_repo(None, project_root=tmp_path) == "deftai/directive"


def test_resolve_repo_returns_none_when_no_source(monkeypatch, tmp_path):
    """AC3: None (-> caller exit 2) only when none of the three sources resolve."""
    monkeypatch.delenv("DEFT_TRIAGE_REPO", raising=False)
    # tmp_path has no .git and no origin remote.
    assert triage_queue._resolve_repo(None, project_root=tmp_path) is None


def test_resolve_repo_blank_env_var_is_ignored(monkeypatch, tmp_path):
    """A whitespace-only DEFT_TRIAGE_REPO falls through to git inference."""
    monkeypatch.setenv("DEFT_TRIAGE_REPO", "   ")
    monkeypatch.setattr(triage_queue, "_infer_repo_from_git", lambda _root: "git/origin")
    assert triage_queue._resolve_repo(None, project_root=tmp_path) == "git/origin"


# --- CLI end-to-end: inference clears the papercut / no source still errors ---


def test_cli_queue_infers_repo_from_origin(monkeypatch, capsys, tmp_path):
    """AC1/AC3: `task triage:queue` with no --repo/env succeeds when origin resolves."""
    monkeypatch.delenv("DEFT_TRIAGE_REPO", raising=False)
    _init_fake_git_origin(tmp_path, "https://github.com/deftai/directive.git")
    rc = triage_queue.main(["queue", "--project-root", str(tmp_path)])
    out = capsys.readouterr()
    assert rc == 0, f"stdout={out.out!r} stderr={out.err!r}"
    assert "deftai/directive" in out.out


def test_cli_queue_exit_2_when_no_source_resolves(monkeypatch, capsys, tmp_path):
    """AC3: no --repo + no env + outside git tree -> exit 2 with the --repo error."""
    monkeypatch.delenv("DEFT_TRIAGE_REPO", raising=False)
    rc = triage_queue.main(["queue", "--project-root", str(tmp_path)])
    assert rc == 2
    assert "--repo" in capsys.readouterr().err
