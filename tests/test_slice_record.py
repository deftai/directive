"""Tests for scripts/slice_record.py + scripts/slice_audit.py + integrations (#1132 / D13).

Coverage:

* :func:`scripts.slice_record.write_slice` -- happy path, validation,
  retry idempotency (same slice_id is a no-op).
* :func:`scripts.slice_record.read_all` / ``find_by_*`` -- read API +
  tolerance of missing files and malformed lines.
* :func:`scripts.slice_audit.compute_orphans` -- closed umbrella +
  open child detection.
* :func:`scripts.slice_audit.compute_stalled` -- Wave-1 closed +
  Wave-2 idle detection with the ``--days`` cutoff.
* :func:`scripts.slice_audit.compute_coverage` -- per-umbrella
  closed/total rollup.
* :func:`scripts.triage_queue.build_queue` -- ORPHAN group routing
  via :class:`QueueBuildOptions.orphan_issue_numbers` and the queue
  ranking matrix from the issue body (orphan > resume-eligible >
  urgent).
* :func:`scripts.resume_conditions.parse` /
  :func:`scripts.resume_conditions.evaluate` -- the
  ``slice-wave-ready:<slice_id>:<wave>`` atomic.
* Backward compat -- `slices.jsonl` missing returns ``[]`` /
  no orphans / no coverage rows without raising.
* Slicing-skill integration -- the three SKILLs reference
  ``slice_record`` so a fresh contributor can find the helper.
"""

from __future__ import annotations

import importlib
import json
import sys
import uuid
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import pytest

_SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

slice_record = importlib.import_module("slice_record")
slice_audit = importlib.import_module("slice_audit")
triage_queue = importlib.import_module("triage_queue")
resume_conditions = importlib.import_module("resume_conditions")


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def _children(*pairs: tuple[int, int, str]) -> list[dict[str, Any]]:
    """Build child dicts from ``(n, wave, role)`` tuples."""
    return [
        {
            "n": n,
            "url": f"https://github.com/owner/repo/issues/{n}",
            "wave": wave,
            "role": role,
        }
        for (n, wave, role) in pairs
    ]


def _slice_id() -> str:
    return str(uuid.uuid4())


def _new_slices_path(tmp_path: Path) -> Path:
    return tmp_path / "vbrief" / ".eval" / "slices.jsonl"


def _cached_issue(
    number: int,
    *,
    state: str = "open",
    updated_at: str = "2026-05-18T00:00:00Z",
    title: str | None = None,
    labels: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "number": number,
        "title": title or f"Issue {number}",
        "state": state,
        "labels": labels or [],
        "updated_at": updated_at,
    }


# ---------------------------------------------------------------------------
# write_slice / read_all
# ---------------------------------------------------------------------------


def test_write_slice_minimal_payload_roundtrips(tmp_path: Path) -> None:
    path = _new_slices_path(tmp_path)
    sid = slice_record.write_slice(
        umbrella=1119,
        umbrella_url="https://github.com/owner/repo/issues/1119",
        actor="skill:gh-slice",
        children=_children((1145, 2, "feature"), (1148, 2, "docs")),
        path=path,
    )
    records = slice_record.read_all(path=path)
    assert len(records) == 1
    assert records[0]["slice_id"] == sid
    assert records[0]["umbrella"] == 1119
    assert records[0]["expected_close_signal"] == "all-children-merged"
    assert len(records[0]["children"]) == 2


def test_write_slice_is_idempotent_on_retry(tmp_path: Path) -> None:
    """Re-writing with the same slice_id is a no-op (acceptance criterion)."""
    path = _new_slices_path(tmp_path)
    sid = _slice_id()
    a = slice_record.write_slice(
        umbrella=42,
        umbrella_url="https://github.com/owner/repo/issues/42",
        actor="skill:gh-slice",
        children=_children((100, 1, "structural")),
        slice_id=sid,
        path=path,
    )
    b = slice_record.write_slice(
        umbrella=42,
        umbrella_url="https://github.com/owner/repo/issues/42",
        actor="skill:gh-slice",
        children=_children((100, 1, "structural")),
        slice_id=sid,
        path=path,
    )
    assert a == b == sid
    records = slice_record.read_all(path=path)
    assert len(records) == 1


def test_write_slice_rejects_invalid_record(tmp_path: Path) -> None:
    path = _new_slices_path(tmp_path)
    with pytest.raises(slice_record.SliceRecordError):
        slice_record.write_slice(
            umbrella=0,  # invalid
            umbrella_url="https://example.com/issues/0",
            actor="skill:gh-slice",
            children=_children((1, 1, "feature")),
            path=path,
        )
    assert not path.exists()


def test_write_slice_rejects_empty_children(tmp_path: Path) -> None:
    path = _new_slices_path(tmp_path)
    with pytest.raises(slice_record.SliceRecordError):
        slice_record.write_slice(
            umbrella=1,
            umbrella_url="https://example.com/issues/1",
            actor="skill:gh-slice",
            children=[],
            path=path,
        )


def test_write_slice_rejects_bad_expected_close_signal(tmp_path: Path) -> None:
    path = _new_slices_path(tmp_path)
    with pytest.raises(slice_record.SliceRecordError):
        slice_record.write_slice(
            umbrella=1,
            umbrella_url="https://example.com/issues/1",
            actor="skill:gh-slice",
            children=_children((2, 1, "feature")),
            expected_close_signal="someday",  # not in enum
            path=path,
        )


def test_read_all_tolerates_missing_file(tmp_path: Path) -> None:
    assert slice_record.read_all(path=tmp_path / "absent.jsonl") == []


def test_read_all_skips_malformed_lines(tmp_path: Path) -> None:
    path = _new_slices_path(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Write one bad line then one good line.
    with path.open("w", encoding="utf-8") as fh:
        fh.write("{not valid json\n")
        fh.write(json.dumps({"slice_id": "x", "umbrella": 1}) + "\n")
    records = slice_record.read_all(path=path)
    assert len(records) == 1


def test_find_by_umbrella(tmp_path: Path) -> None:
    path = _new_slices_path(tmp_path)
    slice_record.write_slice(
        umbrella=10,
        umbrella_url="u",
        actor="skill:gh-slice",
        children=_children((11, 1, "a")),
        path=path,
    )
    slice_record.write_slice(
        umbrella=20,
        umbrella_url="u",
        actor="skill:gh-slice",
        children=_children((21, 1, "a")),
        path=path,
    )
    by_10 = slice_record.find_by_umbrella(10, path=path)
    assert len(by_10) == 1
    assert by_10[0]["umbrella"] == 10


# ---------------------------------------------------------------------------
# slice_audit.compute_orphans
# ---------------------------------------------------------------------------


def test_compute_orphans_surfaces_open_child_with_closed_umbrella() -> None:
    records = [
        {
            "slice_id": "11111111-1111-1111-1111-111111111111",
            "umbrella": 1119,
            "umbrella_url": "u",
            "sliced_at": "2026-04-26T00:00:00Z",
            "actor": "skill:gh-slice",
            "expected_close_signal": "all-children-merged",
            "children": _children((1145, 2, "feature"), (1148, 2, "docs"), (1140, 1, "structural")),
        }
    ]
    issues = {
        1119: _cached_issue(1119, state="closed"),
        1145: _cached_issue(1145, state="open"),
        1148: _cached_issue(1148, state="open"),
        1140: _cached_issue(1140, state="closed"),
    }
    rows = slice_audit.compute_orphans(records, issues)
    assert [r.n for r in rows] == [1145, 1148]


def test_compute_orphans_skips_when_umbrella_still_open() -> None:
    records = [
        {
            "slice_id": "22222222-2222-2222-2222-222222222222",
            "umbrella": 1200,
            "umbrella_url": "u",
            "sliced_at": "2026-05-01T00:00:00Z",
            "actor": "skill:gh-slice",
            "expected_close_signal": "all-children-merged",
            "children": _children((1201, 1, "feature")),
        }
    ]
    issues = {1200: _cached_issue(1200, state="open"), 1201: _cached_issue(1201, state="open")}
    assert slice_audit.compute_orphans(records, issues) == []


# ---------------------------------------------------------------------------
# slice_audit.compute_stalled
# ---------------------------------------------------------------------------


def test_compute_stalled_when_wave1_closed_and_wave2_idle() -> None:
    records = [
        {
            "slice_id": "33333333-3333-3333-3333-333333333333",
            "umbrella": 500,
            "umbrella_url": "u",
            "sliced_at": "2026-03-01T00:00:00Z",
            "actor": "skill:gh-slice",
            "expected_close_signal": "all-children-merged",
            "children": _children(
                (501, 1, "feature"),
                (502, 1, "feature"),
                (503, 2, "feature"),  # idle Wave-2
                (504, 2, "docs"),  # idle Wave-2
            ),
        }
    ]
    issues = {
        501: _cached_issue(501, state="closed"),
        502: _cached_issue(502, state="closed"),
        # 503 / 504 last touched far in the past.
        503: _cached_issue(503, state="open", updated_at="2026-01-01T00:00:00Z"),
        504: _cached_issue(504, state="open", updated_at="2026-01-15T00:00:00Z"),
    }
    now = datetime(2026, 5, 18, tzinfo=UTC)
    rows = slice_audit.compute_stalled(records, issues, days=30, now=now)
    assert len(rows) == 1
    assert rows[0].progressed_siblings == (501, 502)
    assert rows[0].stalled_siblings == (503, 504)


def test_compute_stalled_skips_when_all_children_recent() -> None:
    records = [
        {
            "slice_id": "44444444-4444-4444-4444-444444444444",
            "umbrella": 600,
            "umbrella_url": "u",
            "sliced_at": "2026-05-01T00:00:00Z",
            "actor": "skill:gh-slice",
            "expected_close_signal": "all-children-merged",
            "children": _children((601, 1, "feature"), (602, 2, "feature")),
        }
    ]
    issues = {
        601: _cached_issue(601, state="closed"),
        602: _cached_issue(602, state="open", updated_at="2026-05-15T00:00:00Z"),
    }
    now = datetime(2026, 5, 18, tzinfo=UTC)
    assert slice_audit.compute_stalled(records, issues, days=30, now=now) == []


# ---------------------------------------------------------------------------
# slice_audit.compute_coverage
# ---------------------------------------------------------------------------


def test_compute_coverage_per_open_umbrella() -> None:
    records = [
        {
            "slice_id": "55555555-5555-5555-5555-555555555555",
            "umbrella": 700,
            "umbrella_url": "u",
            "sliced_at": "2026-04-25T00:00:00Z",
            "actor": "skill:gh-slice",
            "expected_close_signal": "all-children-merged",
            "children": _children(
                (701, 1, "feature"), (702, 1, "feature"), (703, 2, "feature")
            ),
        },
        {
            "slice_id": "66666666-6666-6666-6666-666666666666",
            "umbrella": 800,
            "umbrella_url": "u",
            "sliced_at": "2026-04-25T00:00:00Z",
            "actor": "skill:gh-slice",
            "expected_close_signal": "all-children-merged",
            "children": _children((801, 1, "feature"), (802, 1, "feature")),
        },
    ]
    issues = {
        700: _cached_issue(700, state="open"),
        800: _cached_issue(800, state="open"),
        701: _cached_issue(701, state="closed"),
        702: _cached_issue(702, state="closed"),
        703: _cached_issue(703, state="open"),
        801: _cached_issue(801, state="closed"),
        802: _cached_issue(802, state="closed"),
    }
    rows = slice_audit.compute_coverage(records, issues)
    by_umbrella = {r.umbrella: r for r in rows}
    assert by_umbrella[700].closed == 2
    assert by_umbrella[700].total == 3
    assert by_umbrella[800].closed == 2
    assert by_umbrella[800].total == 2


def test_compute_coverage_skips_closed_umbrellas_by_default() -> None:
    records = [
        {
            "slice_id": "77777777-7777-7777-7777-777777777777",
            "umbrella": 900,
            "umbrella_url": "u",
            "sliced_at": "2026-04-25T00:00:00Z",
            "actor": "skill:gh-slice",
            "expected_close_signal": "all-children-merged",
            "children": _children((901, 1, "feature")),
        }
    ]
    issues = {
        900: _cached_issue(900, state="closed"),
        901: _cached_issue(901, state="closed"),
    }
    assert slice_audit.compute_coverage(records, issues) == []
    rows_all = slice_audit.compute_coverage(records, issues, only_open_umbrella=False)
    assert len(rows_all) == 1


# ---------------------------------------------------------------------------
# Backward compatibility: slices.jsonl missing -> empty result, no crash
# ---------------------------------------------------------------------------


def test_load_slice_records_returns_empty_when_module_missing() -> None:
    assert slice_audit.load_slice_records(None) == []


def test_load_slice_records_passthrough_for_list_fixture() -> None:
    fixture = [{"slice_id": "abc", "umbrella": 1}]
    assert slice_audit.load_slice_records(fixture) == fixture


def test_compute_orphans_empty_when_no_records() -> None:
    assert slice_audit.compute_orphans([], {}) == []


def test_compute_coverage_empty_when_no_records() -> None:
    assert slice_audit.compute_coverage([], {}) == []


# ---------------------------------------------------------------------------
# Queue ranking matrix -- orphan > resume-eligible > urgent (#1132 + #1128)
# ---------------------------------------------------------------------------


def _audit(n: int, decision: str, *, ts: str = "2026-05-17T00:00:00Z") -> dict[str, Any]:
    return {
        "decision_id": str(uuid.uuid4()),
        "timestamp": ts,
        "repo": "owner/repo",
        "issue_number": n,
        "decision": decision,
        "actor": "tester",
    }


def test_build_queue_routes_orphan_to_top_group() -> None:
    """Acceptance: orphan > resume-eligible > urgent within the queue."""
    issues = [
        _cached_issue(2000),  # orphan candidate
        _cached_issue(2001),  # resume-eligible
        _cached_issue(2002),  # urgent (needs-ac)
    ]
    audit = [
        _audit(2001, "resume-eligible"),
        _audit(2002, "needs-ac"),
    ]
    options = triage_queue.QueueBuildOptions(
        orphan_issue_numbers=frozenset({2000}),
    )
    items = triage_queue.build_queue(issues, audit, repo="owner/repo", options=options)
    groups = [i.group for i in items]
    nums = [i.number for i in items]
    assert groups[0] == "ORPHAN"
    assert nums[0] == 2000
    # Resume-eligible comes before URGENT.
    assert groups.index("RESUME") < groups.index("URGENT")
    assert nums == [2000, 2001, 2002]


def test_build_queue_orphan_outranks_active_vbrief_resume() -> None:
    """An issue that is BOTH orphan AND in an active vBRIEF still surfaces as ORPHAN."""
    issues = [_cached_issue(3000)]
    options = triage_queue.QueueBuildOptions(
        active_referenced=frozenset({3000}),
        orphan_issue_numbers=frozenset({3000}),
    )
    items = triage_queue.build_queue(issues, [], repo="owner/repo", options=options)
    assert items[0].group == "ORPHAN"


def test_render_queue_emits_orphan_prefix() -> None:
    item = triage_queue.QueueItem(
        number=1145,
        title="Wave-2 child",
        state="open",
        labels=(),
        updated_at="2026-05-17T00:00:00Z",
        group="ORPHAN",
        latest_decision=None,
        matched_label=None,
        repo="owner/repo",
    )
    out = triage_queue.render_queue([item], repo="owner/repo")
    assert "[ORPHAN]" in out
    assert "#1145" in out


# ---------------------------------------------------------------------------
# D3 grammar: slice-wave-ready atomic
# ---------------------------------------------------------------------------


SLICE_UUID = "abcdef01-2345-6789-abcd-ef0123456789"


def test_parse_slice_wave_ready_atomic() -> None:
    expr = f"slice-wave-ready:{SLICE_UUID}:2"
    ast = resume_conditions.parse(expr)
    assert ast.op == "ATOM"
    assert ast.left.kind == "slice-wave-ready"
    assert ast.left.value == 2
    assert ast.left.slice_id == SLICE_UUID


@pytest.mark.parametrize(
    "expr",
    [
        "slice-wave-ready:not-a-uuid:1",
        "slice-wave-ready::1",
        f"slice-wave-ready:{SLICE_UUID}:0",  # wave must be >= 1
        f"slice-wave-ready:{SLICE_UUID}",  # missing wave
        f"slice-wave-ready:{SLICE_UUID}:abc",  # non-numeric wave
    ],
)
def test_parse_slice_wave_ready_rejects_malformed(expr: str) -> None:
    with pytest.raises(resume_conditions.ResumeGrammarError):
        resume_conditions.parse(expr)


def test_slice_wave_ready_fires_when_all_earlier_waves_closed() -> None:
    slice_payload = {
        "slice_id": SLICE_UUID,
        "umbrella": 1119,
        "umbrella_url": "u",
        "sliced_at": "2026-04-26T00:00:00Z",
        "actor": "skill:gh-slice",
        "expected_close_signal": "all-children-merged",
        "children": _children(
            (1140, 1, "structural"),
            (1141, 1, "feature"),
            (1145, 2, "feature"),
            (1148, 2, "docs"),
        ),
    }
    ctx_fires = resume_conditions.ResumeContext(
        today=date(2026, 5, 18),
        closed_refs=frozenset({1140, 1141}),
        slices=(slice_payload,),
    )
    ctx_partial = resume_conditions.ResumeContext(
        today=date(2026, 5, 18),
        closed_refs=frozenset({1140}),  # Wave-1 only partially closed
        slices=(slice_payload,),
    )
    expr = resume_conditions.parse(f"slice-wave-ready:{SLICE_UUID}:2")
    assert resume_conditions.evaluate(expr, ctx_fires) is True
    assert resume_conditions.evaluate(expr, ctx_partial) is False


def test_slice_wave_ready_does_not_fire_when_slice_id_missing() -> None:
    ctx = resume_conditions.ResumeContext(
        today=date(2026, 5, 18),
        closed_refs=frozenset({1, 2, 3}),
        slices=(),
    )
    expr = resume_conditions.parse(f"slice-wave-ready:{SLICE_UUID}:2")
    assert resume_conditions.evaluate(expr, ctx) is False


def test_slice_wave_ready_does_not_fire_for_wave_one() -> None:
    """Wave 1 has no earlier wave so the atomic conceptually never fires."""
    slice_payload = {
        "slice_id": SLICE_UUID,
        "umbrella": 1,
        "umbrella_url": "u",
        "sliced_at": "2026-04-26T00:00:00Z",
        "actor": "skill:gh-slice",
        "expected_close_signal": "all-children-merged",
        "children": _children((10, 1, "feature")),
    }
    ctx = resume_conditions.ResumeContext(
        today=date(2026, 5, 18),
        closed_refs=frozenset({10}),
        slices=(slice_payload,),
    )
    expr = resume_conditions.parse(f"slice-wave-ready:{SLICE_UUID}:1")
    assert resume_conditions.evaluate(expr, ctx) is False


def test_slice_wave_ready_composes_with_and() -> None:
    slice_payload = {
        "slice_id": SLICE_UUID,
        "umbrella": 1,
        "umbrella_url": "u",
        "sliced_at": "2026-04-26T00:00:00Z",
        "actor": "skill:gh-slice",
        "expected_close_signal": "all-children-merged",
        "children": _children((10, 1, "feature")),
    }
    ctx = resume_conditions.ResumeContext(
        today=date(2026, 5, 18),
        closed_refs=frozenset({10, 99}),
        slices=(slice_payload,),
    )
    expr = resume_conditions.parse(
        f"slice-wave-ready:{SLICE_UUID}:2 AND ref:closed:#99"
    )
    assert resume_conditions.evaluate(expr, ctx) is True


# ---------------------------------------------------------------------------
# Slicing-skill integration content tests
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "skill_path",
    [
        "skills/deft-directive-gh-slice/SKILL.md",
        "skills/deft-directive-gh-arch/SKILL.md",
        "skills/deft-directive-refinement/SKILL.md",
    ],
)
def test_slicing_skills_reference_slice_record(skill_path: str) -> None:
    """Each slicing skill MUST document the write_slice call (#1132 acceptance)."""
    body = Path(__file__).parent.parent.joinpath(skill_path).read_text(encoding="utf-8")
    assert "slice_record" in body
    assert "#1132" in body
    assert "slices.jsonl" in body


def test_gh_slice_skill_step_6_present() -> None:
    body = (
        Path(__file__).parent.parent
        / "skills/deft-directive-gh-slice/SKILL.md"
    ).read_text(encoding="utf-8")
    assert "Step 6" in body
    assert "actor=\"skill:gh-slice\"" in body


def test_gh_arch_skill_actor_present() -> None:
    body = (
        Path(__file__).parent.parent
        / "skills/deft-directive-gh-arch/SKILL.md"
    ).read_text(encoding="utf-8")
    assert "skill:gh-arch" in body


def test_refinement_skill_actor_present() -> None:
    body = (
        Path(__file__).parent.parent
        / "skills/deft-directive-refinement/SKILL.md"
    ).read_text(encoding="utf-8")
    assert "skill:refinement" in body


# ---------------------------------------------------------------------------
# Schema lockstep -- writer enum mirrors slices.schema.json
# ---------------------------------------------------------------------------


def test_writer_enum_matches_schema_enum() -> None:
    schema = json.loads(slice_record.SCHEMA_PATH.read_text(encoding="utf-8"))
    schema_enum = set(
        schema["properties"]["expected_close_signal"]["enum"]
    )
    # _VALID_EXPECTED_CLOSE_SIGNALS is a module private but we cross-check
    # via the public failure mode (write rejected) when the writer would
    # drift. Defensive: also assert against the private constant.
    assert schema_enum == set(slice_record._VALID_EXPECTED_CLOSE_SIGNALS)


# ---------------------------------------------------------------------------
# Renderer smoke tests
# ---------------------------------------------------------------------------


def test_render_orphans_plain_includes_marker_and_back_pointer() -> None:
    row = slice_audit.OrphanRow(
        n=1145,
        url="https://github.com/owner/repo/issues/1145",
        wave=2,
        role="feature",
        umbrella=1119,
        umbrella_url="https://github.com/owner/repo/issues/1119",
        umbrella_state="closed",
        slice_id=SLICE_UUID,
        sliced_at="2026-04-26T00:00:00Z",
        actor="skill:gh-slice",
    )
    out = slice_audit.render_orphans_plain(
        [row], repo="owner/repo", now=datetime(2026, 5, 18, tzinfo=UTC)
    )
    assert "[ORPHAN] #1145" in out
    assert "#1119" in out
    assert "Wave-2" in out


def test_render_orphans_json_stable_schema() -> None:
    row = slice_audit.OrphanRow(
        n=1145,
        url="u",
        wave=2,
        role="feature",
        umbrella=1119,
        umbrella_url="u",
        umbrella_state="closed",
        slice_id=SLICE_UUID,
        sliced_at="2026-04-26T00:00:00Z",
        actor="skill:gh-slice",
    )
    out = slice_audit.render_orphans_json(
        [row], repo="owner/repo", generated_at=datetime(2026, 5, 18, tzinfo=UTC)
    )
    payload = json.loads(out)
    assert payload["surface"] == "orphans"
    assert payload["entry_count"] == 1
    assert payload["entries"][0]["n"] == 1145
    assert payload["repo"] == "owner/repo"


def test_render_coverage_plain_uses_issue_body_format() -> None:
    row = slice_audit.CoverageRow(
        slice_id=SLICE_UUID,
        umbrella=1119,
        umbrella_url="u",
        umbrella_state="open",
        closed=3,
        total=5,
        last_child_activity="2026-04-26T00:00:00Z",
    )
    out = slice_audit.render_coverage_plain(
        [row], repo="owner/repo", now=datetime(2026, 5, 18, tzinfo=UTC)
    )
    assert "#1119: 3/5 children merged" in out


def test_render_stalled_json_carries_days() -> None:
    row = slice_audit.StalledCohortRow(
        slice_id=SLICE_UUID,
        umbrella=500,
        umbrella_url="u",
        sliced_at="2026-03-01T00:00:00Z",
        progressed_siblings=(501,),
        stalled_siblings=(502,),
    )
    out = slice_audit.render_stalled_json(
        [row],
        repo="owner/repo",
        days=14,
        generated_at=datetime(2026, 5, 18, tzinfo=UTC),
    )
    payload = json.loads(out)
    assert payload["surface"] == "slice-stalled"
    assert payload["days"] == 14
    assert payload["entries"][0]["umbrella"] == 500
