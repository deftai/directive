"""Tests for scripts/triage_queue.py (#1128 / D11).

Covers the read-only triage queue + show + audit surface:

* ``plan.policy.triageRankingLabels[]`` schema validation + framework default
* Group ordering (RESUME -> URGENT -> untriaged -> other) and within-group
  ``updated_at`` desc fallback
* Consumer ranking-labels override (matched-label declared order, then
  updated_at desc)
* ``--limit`` cap on queue output
* ``triage:audit --format=json`` schema stability
* ``triage:audit --vbrief-staleness`` filter (accepted issues without
  active-vBRIEF reference)
* ``triage:show <N>`` snapshot
"""

from __future__ import annotations

import importlib
import json
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest

_SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

triage_queue = importlib.import_module("triage_queue")
triage_queue_cli = importlib.import_module("_triage_queue_cli")
candidates_log = importlib.import_module("candidates_log")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


REPO = "owner/repo"


def _ts(seconds_offset: int = 0) -> str:
    base = datetime(2026, 5, 17, 20, 0, 0, tzinfo=UTC)
    delta_h = abs(seconds_offset) // 3600
    sign = -1 if seconds_offset < 0 else 1
    hour = base.hour + sign * delta_h
    return base.replace(hour=max(0, min(23, hour))).strftime("%Y-%m-%dT%H:%M:%SZ")


def _issue(
    n: int,
    *,
    title: str | None = None,
    state: str = "open",
    labels: list[str] | None = None,
    updated_at: str | None = None,
) -> dict:
    return {
        "number": n,
        "title": title or f"Issue {n}",
        "state": state,
        "labels": labels or [],
        "updated_at": updated_at or _ts(),
    }


def _audit_entry(
    n: int,
    decision: str,
    *,
    timestamp: str | None = None,
    repo: str = REPO,
    reason: str | None = None,
    actor: str = "tester",
    extra: dict | None = None,
) -> dict:
    entry = {
        "decision_id": str(uuid.uuid4()),
        "timestamp": timestamp or _ts(),
        "repo": repo,
        "issue_number": n,
        "decision": decision,
        "actor": actor,
    }
    if reason is not None:
        entry["reason"] = reason
    if extra:
        entry.update(extra)
    return entry


def _write_audit_log(path: Path, entries: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for entry in entries:
            fh.write(json.dumps(entry, sort_keys=True) + "\n")


def _write_cached_issue(
    cache_root: Path, repo: str, issue: dict, *, source: str = "github-issue"
) -> Path:
    owner, name = repo.split("/", 1)
    n = issue["number"]
    edir = cache_root / source / owner / name / str(n)
    edir.mkdir(parents=True, exist_ok=True)
    # Emulate the unified-cache labels shape: list of {name: ...} dicts.
    raw = dict(issue)
    raw["labels"] = [{"name": label} for label in issue.get("labels", [])]
    (edir / "raw.json").write_text(
        json.dumps(raw, sort_keys=True), encoding="utf-8"
    )
    return edir


# ---------------------------------------------------------------------------
# Ranking-labels validator (plan.policy.triageRankingLabels[])
# ---------------------------------------------------------------------------


def test_validate_ranking_labels_accepts_none():
    errors, warnings = triage_queue.validate_ranking_labels(None)
    assert errors == []
    assert warnings == []


def test_validate_ranking_labels_accepts_empty_list():
    errors, _ = triage_queue.validate_ranking_labels([])
    assert errors == []


def test_validate_ranking_labels_accepts_list_of_strings():
    errors, _ = triage_queue.validate_ranking_labels(["urgent", "breaking-change"])
    assert errors == []


def test_validate_ranking_labels_rejects_non_list():
    errors, _ = triage_queue.validate_ranking_labels("urgent")
    assert any("must be a list" in e for e in errors)


def test_validate_ranking_labels_rejects_non_string_entry():
    errors, _ = triage_queue.validate_ranking_labels(["urgent", 42])
    assert any("must be a string" in e for e in errors)


def test_validate_ranking_labels_rejects_empty_entry():
    errors, _ = triage_queue.validate_ranking_labels([""])
    assert any("must be a non-empty string" in e for e in errors)


def test_validate_ranking_labels_warns_duplicate():
    _errors, warnings = triage_queue.validate_ranking_labels(
        ["urgent", "urgent"]
    )
    assert any("duplicate label" in w for w in warnings)


def test_validate_triage_ranking_labels_on_plan_returns_empty_when_unset():
    # No policy block at all -> no errors.
    assert triage_queue.validate_triage_ranking_labels_on_plan({}, "PD.json") == []


def test_validate_triage_ranking_labels_on_plan_prefixes_filepath():
    plan = {"policy": {"triageRankingLabels": "urgent"}}
    errors = triage_queue.validate_triage_ranking_labels_on_plan(plan, "PD.json")
    assert errors
    assert errors[0].startswith("PD.json: ")
    assert "#1128" in errors[0]


def test_resolve_ranking_labels_default_is_empty(tmp_path: Path):
    # No PROJECT-DEFINITION -> framework default applies.
    assert triage_queue.resolve_ranking_labels(tmp_path) == []


def test_resolve_ranking_labels_reads_consumer_value(tmp_path: Path):
    vbrief_dir = tmp_path / "vbrief"
    vbrief_dir.mkdir(parents=True)
    payload = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "policy": {
                "triageRankingLabels": ["urgent", "breaking-change"],
            }
        },
    }
    (vbrief_dir / "PROJECT-DEFINITION.vbrief.json").write_text(
        json.dumps(payload), encoding="utf-8"
    )
    assert triage_queue.resolve_ranking_labels(tmp_path) == [
        "urgent",
        "breaking-change",
    ]


# ---------------------------------------------------------------------------
# derive_group
# ---------------------------------------------------------------------------


def test_derive_group_resume_wins_over_urgent():
    # Active vBRIEF reference outranks needs-ac.
    assert triage_queue.derive_group("needs-ac", True) == "RESUME"


def test_derive_group_urgent_from_needs_ac():
    assert triage_queue.derive_group("needs-ac", False) == "URGENT"


def test_derive_group_untriaged_when_no_decision():
    assert triage_queue.derive_group(None, False) == "untriaged"


@pytest.mark.parametrize(
    "decision",
    ["accept", "reject", "defer", "mark-duplicate", "reset"],
)
def test_derive_group_other_for_terminal_decisions(decision: str):
    assert triage_queue.derive_group(decision, False) == "other"


# ---------------------------------------------------------------------------
# Build queue -- ordering correctness
# ---------------------------------------------------------------------------


def test_build_queue_group_order_resume_urgent_untriaged_other():
    issues = [
        _issue(1),  # untriaged
        _issue(2),  # RESUME (active vBRIEF)
        _issue(3),  # URGENT (needs-ac)
        _issue(4),  # other (deferred)
    ]
    audit = [
        _audit_entry(3, "needs-ac", timestamp=_ts(-3600)),
        _audit_entry(4, "defer", timestamp=_ts(-7200)),
    ]
    options = triage_queue.QueueBuildOptions(
        active_referenced=frozenset({2}),
    )
    items = triage_queue.build_queue(issues, audit, repo=REPO, options=options)
    assert [i.number for i in items] == [2, 3, 1, 4]
    assert [i.group for i in items] == ["RESUME", "URGENT", "untriaged", "other"]


def test_build_queue_within_group_updated_at_desc():
    # All untriaged; only updated_at differs.
    issues = [
        _issue(10, updated_at="2026-05-15T10:00:00Z"),
        _issue(11, updated_at="2026-05-17T10:00:00Z"),
        _issue(12, updated_at="2026-05-16T10:00:00Z"),
    ]
    items = triage_queue.build_queue(issues, [], repo=REPO)
    # Most-recent updated_at first.
    assert [i.number for i in items] == [11, 12, 10]


def test_build_queue_consumer_ranking_labels_override_updated_at():
    issues = [
        _issue(20, labels=[], updated_at="2026-05-17T10:00:00Z"),
        _issue(
            21,
            labels=["breaking-change"],
            updated_at="2026-05-15T10:00:00Z",
        ),
        _issue(22, labels=["urgent"], updated_at="2026-05-16T10:00:00Z"),
    ]
    options = triage_queue.QueueBuildOptions(
        ranking_labels=("urgent", "breaking-change"),
    )
    items = triage_queue.build_queue(issues, [], repo=REPO, options=options)
    # urgent first (rank 0), then breaking-change (rank 1), then unranked.
    assert [i.number for i in items] == [22, 21, 20]
    assert items[0].matched_label == "urgent"
    assert items[1].matched_label == "breaking-change"
    assert items[2].matched_label is None


def test_build_queue_consumer_ranking_labels_tiebreak_by_updated_at():
    issues = [
        _issue(
            30,
            labels=["urgent"],
            updated_at="2026-05-15T10:00:00Z",
        ),
        _issue(
            31,
            labels=["urgent"],
            updated_at="2026-05-17T10:00:00Z",
        ),
    ]
    options = triage_queue.QueueBuildOptions(ranking_labels=("urgent",))
    items = triage_queue.build_queue(issues, [], repo=REPO, options=options)
    # Both have matched_label=urgent; tiebreak by updated_at desc.
    assert [i.number for i in items] == [31, 30]


def test_build_queue_limit_caps_output():
    issues = [_issue(n) for n in range(1, 11)]
    options = triage_queue.QueueBuildOptions(limit=3)
    items = triage_queue.build_queue(issues, [], repo=REPO, options=options)
    assert len(items) == 3


# ---------------------------------------------------------------------------
# Audit-log integration -- vBRIEF staleness
# ---------------------------------------------------------------------------


def test_is_stale_acceptance_true_when_accept_without_active_vbrief():
    entry = _audit_entry(101, "accept")
    assert triage_queue.is_stale_acceptance(entry, frozenset()) is True


def test_is_stale_acceptance_false_when_issue_in_active_set():
    entry = _audit_entry(101, "accept")
    assert triage_queue.is_stale_acceptance(entry, frozenset({101})) is False


def test_is_stale_acceptance_false_for_non_accept_decision():
    entry = _audit_entry(101, "defer")
    assert triage_queue.is_stale_acceptance(entry, frozenset()) is False


# ---------------------------------------------------------------------------
# Audit renderers -- JSON schema stability
# ---------------------------------------------------------------------------


def test_render_audit_json_schema():
    entries = [_audit_entry(1, "accept"), _audit_entry(2, "defer")]
    generated_at = datetime(2026, 5, 17, 21, 0, 0, tzinfo=UTC)
    out = triage_queue.render_audit_json(
        entries,
        repo=REPO,
        vbrief_staleness=False,
        generated_at=generated_at,
    )
    payload = json.loads(out)
    assert payload["generated_at"] == "2026-05-17T21:00:00Z"
    assert payload["repo"] == REPO
    assert payload["vbrief_staleness"] is False
    assert payload["entry_count"] == 2
    assert len(payload["entries"]) == 2
    assert payload["entries"][0]["decision"] == "accept"


def test_render_audit_json_carries_vbrief_staleness_flag():
    out = triage_queue.render_audit_json(
        [], repo=None, vbrief_staleness=True, generated_at=datetime(2026, 5, 17, tzinfo=UTC)
    )
    payload = json.loads(out)
    assert payload["vbrief_staleness"] is True
    assert payload["repo"] is None


# ---------------------------------------------------------------------------
# Cache walk -- load_cached_issues
# ---------------------------------------------------------------------------


def test_load_cached_issues_walks_repo_dir(tmp_path: Path):
    cache_root = tmp_path / ".deft-cache"
    _write_cached_issue(cache_root, REPO, _issue(1, title="First"))
    _write_cached_issue(cache_root, REPO, _issue(2, title="Second"))
    _write_cached_issue(
        cache_root, REPO, _issue(3, title="Closed", state="closed")
    )
    issues = triage_queue.load_cached_issues(REPO, project_root=tmp_path)
    # Closed excluded by default; sort by number for assertion stability.
    nums = sorted(i["number"] for i in issues)
    assert nums == [1, 2]


def test_load_cached_issues_returns_empty_when_repo_dir_absent(tmp_path: Path):
    assert triage_queue.load_cached_issues(REPO, project_root=tmp_path) == []


def test_load_cached_issues_include_closed(tmp_path: Path):
    cache_root = tmp_path / ".deft-cache"
    _write_cached_issue(cache_root, REPO, _issue(1, state="open"))
    _write_cached_issue(cache_root, REPO, _issue(2, state="closed"))
    issues = triage_queue.load_cached_issues(
        REPO, project_root=tmp_path, include_closed=True
    )
    assert sorted(i["number"] for i in issues) == [1, 2]


# ---------------------------------------------------------------------------
# Show renderer
# ---------------------------------------------------------------------------


def test_render_show_missing_issue():
    out = triage_queue.render_show(
        None,
        repo=REPO,
        number=999,
        latest_decision=None,
        history=[],
        in_active_vbrief=False,
    )
    assert "999" in out
    assert "not present in local cache" in out


def test_render_show_with_decision_and_history():
    issue = _issue(7, labels=["bug"], updated_at="2026-05-17T10:00:00Z")
    history = [
        _audit_entry(7, "needs-ac", timestamp="2026-05-15T10:00:00Z"),
        _audit_entry(7, "accept", timestamp="2026-05-17T11:00:00Z"),
    ]
    latest = history[-1]
    out = triage_queue.render_show(
        issue,
        repo=REPO,
        number=7,
        latest_decision=latest,
        history=history,
        in_active_vbrief=True,
    )
    assert "Issue 7" in out
    assert "active vBRIEF reference: yes" in out
    assert "latest decision: accept" in out
    assert "needs-ac" in out  # history mentions older decision


# ---------------------------------------------------------------------------
# Queue renderer surface
# ---------------------------------------------------------------------------


def test_render_queue_header_names_default_ranking_when_empty():
    items = [
        triage_queue.QueueItem(
            number=1,
            title="hello",
            state="open",
            labels=(),
            updated_at="2026-05-17T10:00:00Z",
            group="untriaged",
            latest_decision=None,
            matched_label=None,
            repo=REPO,
        )
    ]
    out = triage_queue.render_queue(items, repo=REPO, limit=5)
    assert "consumer ranking labels: <empty>" in out
    assert "updated_at desc" in out
    assert "limit: 5" in out
    assert "#1" in out


def test_render_queue_header_lists_consumer_labels():
    out = triage_queue.render_queue(
        [],
        repo=REPO,
        limit=None,
        ranking_labels=("urgent", "breaking-change"),
    )
    assert "urgent, breaking-change" in out
    # Empty list message when no rows.
    assert "no cached issues" in out


# ---------------------------------------------------------------------------
# CLI dispatch (queue / audit / show)
# ---------------------------------------------------------------------------


def _seed_cache_and_log(tmp_path: Path) -> dict:
    cache_root = tmp_path / ".deft-cache"
    issues = [
        _issue(
            100,
            title="Untriaged most recent",
            updated_at="2026-05-17T12:00:00Z",
        ),
        _issue(
            101,
            title="URGENT older",
            updated_at="2026-05-15T10:00:00Z",
        ),
        _issue(
            102,
            title="Deferred elder",
            updated_at="2026-05-14T10:00:00Z",
        ),
    ]
    for i in issues:
        _write_cached_issue(cache_root, REPO, i)
    audit_path = tmp_path / "vbrief" / ".eval" / "candidates.jsonl"
    entries = [
        _audit_entry(101, "needs-ac", timestamp="2026-05-15T11:00:00Z"),
        _audit_entry(102, "defer", timestamp="2026-05-14T11:00:00Z"),
    ]
    _write_audit_log(audit_path, entries)
    return {"audit_path": audit_path}


def test_cli_queue_orders_groups_correctly(capsys, tmp_path: Path):
    seeded = _seed_cache_and_log(tmp_path)
    rc = triage_queue.main(
        [
            "queue",
            "--project-root",
            str(tmp_path),
            "--repo",
            REPO,
            "--audit-log",
            str(seeded["audit_path"]),
            "--limit",
            "0",
        ]
    )
    assert rc == 0
    captured = capsys.readouterr().out
    # Expect URGENT (#101) before untriaged (#100) before other (#102).
    idx_101 = captured.find("#101")
    idx_100 = captured.find("#100")
    idx_102 = captured.find("#102")
    assert -1 < idx_101 < idx_100 < idx_102, captured


def test_cli_queue_respects_limit(capsys, tmp_path: Path):
    seeded = _seed_cache_and_log(tmp_path)
    rc = triage_queue.main(
        [
            "queue",
            "--project-root",
            str(tmp_path),
            "--repo",
            REPO,
            "--audit-log",
            str(seeded["audit_path"]),
            "--limit",
            "1",
        ]
    )
    assert rc == 0
    captured = capsys.readouterr().out
    assert "#101" in captured
    assert "#100" not in captured
    assert "#102" not in captured


def test_cli_audit_json_emits_stable_schema(capsys, tmp_path: Path):
    seeded = _seed_cache_and_log(tmp_path)
    rc = triage_queue.main(
        [
            "audit",
            "--project-root",
            str(tmp_path),
            "--repo",
            REPO,
            "--audit-log",
            str(seeded["audit_path"]),
            "--format",
            "json",
        ]
    )
    assert rc == 0
    payload = json.loads(capsys.readouterr().out)
    assert set(payload.keys()) == {
        "entries",
        "entry_count",
        "generated_at",
        "repo",
        "vbrief_staleness",
    }
    assert payload["entry_count"] == 2
    assert payload["repo"] == REPO


def test_cli_audit_vbrief_staleness_filters_to_stale_accepts(
    capsys, tmp_path: Path
):
    audit_path = tmp_path / "vbrief" / ".eval" / "candidates.jsonl"
    entries = [
        _audit_entry(200, "accept", timestamp="2026-05-15T10:00:00Z"),  # stale
        _audit_entry(201, "accept", timestamp="2026-05-16T10:00:00Z"),  # active -> not stale
        _audit_entry(202, "defer", timestamp="2026-05-15T10:00:00Z"),
    ]
    _write_audit_log(audit_path, entries)
    # vbrief/active/ contains a vBRIEF referencing #201 but NOT #200.
    active_dir = tmp_path / "vbrief" / "active"
    active_dir.mkdir(parents=True)
    (active_dir / "active-201.vbrief.json").write_text(
        json.dumps(
            {
                "plan": {
                    "references": [
                        {
                            "uri": "https://github.com/owner/repo/issues/201",
                            "type": "x-vbrief/github-issue",
                        }
                    ]
                }
            }
        ),
        encoding="utf-8",
    )
    rc = triage_queue.main(
        [
            "audit",
            "--project-root",
            str(tmp_path),
            "--repo",
            REPO,
            "--audit-log",
            str(audit_path),
            "--vbrief-staleness",
            "--format",
            "json",
        ]
    )
    assert rc == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["vbrief_staleness"] is True
    nums = [e["issue_number"] for e in payload["entries"]]
    assert nums == [200]


def test_cli_show_returns_1_when_issue_absent(capsys, tmp_path: Path):
    # No cache populated -> show <N> reports not present + exit 1.
    seeded = _seed_cache_and_log(tmp_path)
    rc = triage_queue.main(
        [
            "show",
            "--project-root",
            str(tmp_path),
            "--repo",
            REPO,
            "--audit-log",
            str(seeded["audit_path"]),
            "999",
        ]
    )
    assert rc == 1
    assert "not present in local cache" in capsys.readouterr().out


def test_cli_show_returns_0_with_decision_history(capsys, tmp_path: Path):
    seeded = _seed_cache_and_log(tmp_path)
    rc = triage_queue.main(
        [
            "show",
            "--project-root",
            str(tmp_path),
            "--repo",
            REPO,
            "--audit-log",
            str(seeded["audit_path"]),
            "101",
        ]
    )
    assert rc == 0
    out = capsys.readouterr().out
    assert "#101" in out
    assert "latest decision: needs-ac" in out


def test_cli_queue_requires_repo(capsys, tmp_path: Path, monkeypatch):
    monkeypatch.delenv("DEFT_TRIAGE_REPO", raising=False)
    rc = triage_queue.main(
        ["queue", "--project-root", str(tmp_path)]
    )
    assert rc == 2
    assert "--repo" in capsys.readouterr().err
