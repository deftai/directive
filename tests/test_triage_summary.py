"""Tests for scripts/triage_summary.py (#1122 / D2 of #1119).

Covers the acceptance criteria spelled out in the issue body:

- Empty / missing cache -> the documented empty-cache prompt (no zeros,
  no warning glyph).
- Populated cache, WIP under cap -> no warning glyph; ``0 untriaged``
  still prints.
- WIP at-or-above cap -> warning glyph appears.
- Stale-defer count >= 1 -> stale-defer field appears with the count.
- Long-content overflow -> graceful truncation at 120 chars.
- Summary-history append -> one JSONL line per emission.

The tests are hermetic: they build the cache + audit log + vBRIEF
lifecycle folders under ``tmp_path`` so they never touch real consumer
state. The script is imported directly (no subprocess) so failure modes
surface as Python exceptions in the test report.
"""

from __future__ import annotations

import importlib
import io
import json
import sys
from pathlib import Path
from typing import Any

import pytest

_SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

triage_summary = importlib.import_module("triage_summary")


# ---------------------------------------------------------------------------
# Fixture builders
# ---------------------------------------------------------------------------


def _make_cached_issue(cache_root: Path, repo: str, number: int) -> None:
    """Create the minimal cache-entry shape the walker recognises.

    The walker only cares about the directory path; meta.json / raw.json
    are stubbed for realism but are never read by triage_summary itself.
    """
    owner, name = repo.split("/", 1)
    entry = cache_root / "github-issue" / owner / name / str(number)
    entry.mkdir(parents=True, exist_ok=True)
    (entry / "meta.json").write_text("{}", encoding="utf-8")
    (entry / "raw.json").write_text("{}", encoding="utf-8")


def _make_audit_entry(
    repo: str,
    issue_number: int,
    decision: str,
    *,
    timestamp: str = "2026-05-17T20:00:00Z",
    actor: str = "agent:test",
    decision_id: str | None = None,
) -> dict:
    return {
        "decision_id": decision_id or "00000000-0000-0000-0000-000000000001",
        "timestamp": timestamp,
        "repo": repo,
        "issue_number": issue_number,
        "decision": decision,
        "actor": actor,
    }


def _write_audit_log(project_root: Path, entries: list[dict]) -> Path:
    log_path = project_root / triage_summary.CANDIDATES_LOG_REL_PATH
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "w", encoding="utf-8", newline="") as handle:
        for entry in entries:
            handle.write(
                json.dumps(entry, sort_keys=True, ensure_ascii=False) + "\n"
            )
    return log_path


def _write_wip(project_root: Path, count: int, *, folder: str = "active") -> None:
    target = project_root / "vbrief" / folder
    target.mkdir(parents=True, exist_ok=True)
    for i in range(count):
        (target / f"2026-05-17-test-{i:03d}.vbrief.json").write_text(
            "{}", encoding="utf-8"
        )


def _set_wip_cap(project_root: Path, cap: int) -> None:
    pd = project_root / triage_summary.PROJECT_DEFINITION_REL_PATH
    pd.parent.mkdir(parents=True, exist_ok=True)
    pd.write_text(
        json.dumps(
            {
                "vBRIEFInfo": {"version": "0.6"},
                "plan": {"policy": {"wipCap": cap}},
            }
        ),
        encoding="utf-8",
    )


def _set_triage_scope(
    project_root: Path, scope: list[dict[str, Any]] | None
) -> None:
    """Write ``plan.policy.triageScope`` on PROJECT-DEFINITION (#1270 helper).

    Passing ``None`` writes a PROJECT-DEFINITION with no ``policy.triageScope``
    key (i.e. the framework default applies). Passing a list writes that
    list verbatim. Used by the #1270 discrepancy-line tests to flip
    between the "configured" and "not configured" wording variants.
    """
    pd = project_root / triage_summary.PROJECT_DEFINITION_REL_PATH
    pd.parent.mkdir(parents=True, exist_ok=True)
    policy: dict[str, Any] = {}
    if scope is not None:
        policy["triageScope"] = scope
    pd.write_text(
        json.dumps(
            {
                "vBRIEFInfo": {"version": "0.6"},
                "plan": {"policy": policy},
            }
        ),
        encoding="utf-8",
    )


def _write_active_vbrief(
    project_root: Path, name: str, *, status: str = "running"
) -> Path:
    """Write a minimal ``vbrief/active/<name>.vbrief.json`` (#1270 helper).

    The #1270 filesystem-truth in-flight counter only inspects
    ``plan.status``; the rest of the vBRIEF shape is irrelevant for the
    count so we keep the fixture intentionally small.
    """
    folder = project_root / "vbrief" / "active"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{name}.vbrief.json"
    target.write_text(
        json.dumps(
            {
                "vBRIEFInfo": {"version": "0.6"},
                "plan": {"status": status, "title": name},
            }
        ),
        encoding="utf-8",
    )
    return target


# ---------------------------------------------------------------------------
# Empty / missing cache contract
# ---------------------------------------------------------------------------


def test_missing_cache_dir_emits_empty_cache_prompt(tmp_path: Path) -> None:
    result = triage_summary.compute_summary(tmp_path)
    assert result.cache_empty is True
    line = triage_summary.format_one_liner(result)
    assert line == triage_summary.EMPTY_CACHE_LINE
    # No zeros, no warning glyph.
    assert "untriaged" not in line
    assert "WIP" not in line
    assert triage_summary.WIP_WARN_GLYPH not in line


def test_present_but_empty_cache_dir_emits_empty_cache_prompt(tmp_path: Path) -> None:
    (tmp_path / triage_summary.CACHE_DIR_NAME / triage_summary.CACHE_SOURCE).mkdir(
        parents=True
    )
    result = triage_summary.compute_summary(tmp_path)
    assert result.cache_empty is True
    assert triage_summary.format_one_liner(result) == triage_summary.EMPTY_CACHE_LINE


# ---------------------------------------------------------------------------
# Populated cache: untriaged + in-flight classification
# ---------------------------------------------------------------------------


def test_populated_cache_zero_wip_no_warning(tmp_path: Path) -> None:
    """Populated cache, 0 WIP, audit-log accepts -- but no active/ vBRIEFs.

    Post-#1270 the headline ``in-flight`` is filesystem-truth, so the 2
    audit-log ``accept`` decisions surface only via
    :attr:`SummaryResult.in_flight_cache_scoped` (the divergence-detection
    field). Filesystem count is 0 because no active/ vBRIEFs exist on
    tmp_path. The two counts diverge -- the discrepancy line therefore
    appears in :func:`format_summary`. :func:`format_one_liner` still
    returns only the headline (single physical line).
    """
    cache_root = tmp_path / triage_summary.CACHE_DIR_NAME
    _make_cached_issue(cache_root, "deftai/directive", 100)
    _make_cached_issue(cache_root, "deftai/directive", 101)
    _make_cached_issue(cache_root, "deftai/directive", 102)
    _write_audit_log(
        tmp_path,
        [
            _make_audit_entry(
                "deftai/directive",
                100,
                "accept",
                decision_id="11111111-1111-1111-1111-111111111101",
            ),
            _make_audit_entry(
                "deftai/directive",
                101,
                "accept",
                decision_id="11111111-1111-1111-1111-111111111102",
            ),
        ],
    )
    # No vBRIEFs in pending/active -> 0/<cap> -> no warning glyph.
    # Default cap is now 10 (#1124 / D4 -- per umbrella #1119 Current
    # Shape v3, comment 4471269010; previously 12 in the D4 issue
    # body, now superseded).
    result = triage_summary.compute_summary(tmp_path)
    assert result.cache_empty is False
    assert result.untriaged == 1
    # #1270: headline `in_flight` == filesystem count (0 active/ vBRIEFs
    # on tmp_path); the legacy audit-log-derived count (2 accepts) is
    # preserved on `in_flight_cache_scoped` for divergence detection.
    assert result.in_flight == 0
    assert result.in_flight_filesystem == 0
    assert result.in_flight_cache_scoped == 2
    assert result.triage_scope_configured is False
    assert result.stale_defer == 0
    assert result.wip_count == 0
    assert result.wip_cap == triage_summary.DEFAULT_WIP_CAP

    line = triage_summary.format_one_liner(result)
    assert line.startswith("[triage] 1 untriaged")
    assert "0 in-flight" in line  # filesystem-truth headline
    assert f"WIP 0/{triage_summary.DEFAULT_WIP_CAP}" in line
    # Stale-defer suppressed when count is 0.
    assert "stale-defer" not in line
    # WIP warning glyph suppressed when wip < cap.
    assert triage_summary.WIP_WARN_GLYPH not in line


def test_zero_untriaged_still_prints(tmp_path: Path) -> None:
    """Zero is a healthy signal, not silence (#1122 issue body)."""
    cache_root = tmp_path / triage_summary.CACHE_DIR_NAME
    _make_cached_issue(cache_root, "deftai/directive", 200)
    _write_audit_log(
        tmp_path,
        [
            _make_audit_entry(
                "deftai/directive", 200, "accept",
                decision_id="22222222-2222-2222-2222-222222222200",
            ),
        ],
    )
    result = triage_summary.compute_summary(tmp_path)
    assert result.untriaged == 0
    line = triage_summary.format_one_liner(result)
    assert "0 untriaged" in line


def test_reset_decision_returns_to_untriaged(tmp_path: Path) -> None:
    cache_root = tmp_path / triage_summary.CACHE_DIR_NAME
    _make_cached_issue(cache_root, "deftai/directive", 300)
    _write_audit_log(
        tmp_path,
        [
            _make_audit_entry(
                "deftai/directive", 300, "accept",
                timestamp="2026-05-17T19:00:00Z",
                decision_id="33333333-3333-3333-3333-333333333300",
            ),
            {
                "decision_id": "33333333-3333-3333-3333-333333333301",
                "timestamp": "2026-05-17T19:30:00Z",
                "repo": "deftai/directive",
                "issue_number": 300,
                "decision": "reset",
                "actor": "agent:test",
                "prior_decision_id": "33333333-3333-3333-3333-333333333300",
            },
        ],
    )
    result = triage_summary.compute_summary(tmp_path)
    assert result.untriaged == 1
    assert result.in_flight == 0


def test_reject_excluded_from_untriaged_and_in_flight(tmp_path: Path) -> None:
    cache_root = tmp_path / triage_summary.CACHE_DIR_NAME
    _make_cached_issue(cache_root, "deftai/directive", 400)
    _write_audit_log(
        tmp_path,
        [
            _make_audit_entry(
                "deftai/directive", 400, "reject",
                decision_id="44444444-4444-4444-4444-444444444400",
            ),
        ],
    )
    result = triage_summary.compute_summary(tmp_path)
    assert result.untriaged == 0
    assert result.in_flight == 0


# ---------------------------------------------------------------------------
# WIP warning glyph contract
# ---------------------------------------------------------------------------


def test_wip_at_cap_emits_warning_glyph(tmp_path: Path) -> None:
    cache_root = tmp_path / triage_summary.CACHE_DIR_NAME
    _make_cached_issue(cache_root, "deftai/directive", 500)
    _set_wip_cap(tmp_path, 12)
    _write_wip(tmp_path, 12, folder="pending")
    result = triage_summary.compute_summary(tmp_path)
    assert result.wip_count == 12
    assert result.wip_cap == 12
    line = triage_summary.format_one_liner(result)
    assert triage_summary.WIP_WARN_GLYPH in line
    assert "WIP 12/12" in line


def test_wip_above_cap_emits_warning_glyph(tmp_path: Path) -> None:
    cache_root = tmp_path / triage_summary.CACHE_DIR_NAME
    _make_cached_issue(cache_root, "deftai/directive", 501)
    _set_wip_cap(tmp_path, 5)
    _write_wip(tmp_path, 7, folder="active")
    result = triage_summary.compute_summary(tmp_path)
    assert result.wip_count == 7
    assert result.wip_cap == 5
    line = triage_summary.format_one_liner(result)
    assert "WIP 7/5" in line
    assert triage_summary.WIP_WARN_GLYPH in line


def test_wip_just_under_cap_no_warning_glyph(tmp_path: Path) -> None:
    cache_root = tmp_path / triage_summary.CACHE_DIR_NAME
    _make_cached_issue(cache_root, "deftai/directive", 502)
    _set_wip_cap(tmp_path, 12)
    _write_wip(tmp_path, 11, folder="pending")
    result = triage_summary.compute_summary(tmp_path)
    line = triage_summary.format_one_liner(result)
    assert "WIP 11/12" in line
    assert triage_summary.WIP_WARN_GLYPH not in line


# ---------------------------------------------------------------------------
# Stale-defer field
# ---------------------------------------------------------------------------


def test_stale_defer_field_appears_when_count_nonzero(tmp_path: Path) -> None:
    """D3 (#1123) is not yet shipped so compute_summary cannot produce
    stale_defer >= 1 from real data. Drive the renderer directly to pin
    the formatting contract -- format_one_liner is the public surface
    D11's eventual wrap-up will share.
    """
    result = triage_summary.SummaryResult(
        cache_empty=False,
        untriaged=12,
        stale_defer=5,
        in_flight=8,
        wip_count=10,
        wip_cap=12,
    )
    line = triage_summary.format_one_liner(result)
    assert "5 stale-defer (resume condition met)" in line
    assert "12 untriaged" in line
    assert "8 in-flight" in line
    assert "WIP 10/12" in line
    assert triage_summary.WIP_WARN_GLYPH not in line


def test_stale_defer_field_suppressed_when_zero(tmp_path: Path) -> None:
    result = triage_summary.SummaryResult(
        cache_empty=False,
        untriaged=3,
        stale_defer=0,
        in_flight=2,
        wip_count=1,
        wip_cap=12,
    )
    line = triage_summary.format_one_liner(result)
    assert "stale-defer" not in line


# ---------------------------------------------------------------------------
# Truncation contract
# ---------------------------------------------------------------------------


def test_truncation_caps_at_120_chars() -> None:
    # Build a result that produces a > 120-char raw line.
    result = triage_summary.SummaryResult(
        cache_empty=False,
        untriaged=9999999,
        stale_defer=9999999,
        in_flight=9999999,
        wip_count=999999,
        wip_cap=12,
    )
    line = triage_summary.format_one_liner(result, max_chars=60)
    assert len(line) <= 60
    # The leading tag MUST always survive truncation.
    assert line.startswith("[triage]")


def test_truncation_drops_warning_glyph_first() -> None:
    # Engineer a case where the line WITH glyph overshoots by exactly
    # the glyph width but WITHOUT glyph fits.
    base = triage_summary.SummaryResult(
        cache_empty=False,
        untriaged=10,
        stale_defer=0,
        in_flight=8,
        wip_count=12,
        wip_cap=12,
    )
    with_glyph = triage_summary.format_one_liner(base)
    assert triage_summary.WIP_WARN_GLYPH in with_glyph
    cap = len(with_glyph) - 1
    trimmed = triage_summary.format_one_liner(base, max_chars=cap)
    # Glyph dropped, last field still legible.
    assert triage_summary.WIP_WARN_GLYPH not in trimmed
    assert "WIP 12/12" in trimmed


def test_empty_cache_line_within_120_chars() -> None:
    assert len(triage_summary.EMPTY_CACHE_LINE) <= triage_summary.MAX_LINE_CHARS


# ---------------------------------------------------------------------------
# Summary-history append
# ---------------------------------------------------------------------------


def test_append_history_writes_jsonl_record(tmp_path: Path) -> None:
    history_path = tmp_path / triage_summary.SUMMARY_HISTORY_REL_PATH
    result = triage_summary.SummaryResult(
        cache_empty=False,
        untriaged=4,
        stale_defer=0,
        in_flight=2,
        wip_count=3,
        wip_cap=12,
    )
    triage_summary.append_history(
        history_path,
        result,
        line="[triage] 4 untriaged \u00b7 2 in-flight \u00b7 WIP 3/12",
        emitted_at="2026-05-17T21:00:00Z",
    )
    assert history_path.is_file()
    lines = history_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert record["schema"] == triage_summary.SUMMARY_HISTORY_SCHEMA
    assert record["emitted_at"] == "2026-05-17T21:00:00Z"
    assert record["untriaged"] == 4
    assert record["in_flight"] == 2
    assert record["wip_count"] == 3
    assert record["wip_cap"] == 12
    assert record["cache_empty"] is False
    assert "line" in record


def test_append_history_appends_one_line_per_call(tmp_path: Path) -> None:
    history_path = tmp_path / triage_summary.SUMMARY_HISTORY_REL_PATH
    result = triage_summary.SummaryResult(
        cache_empty=True,
        untriaged=0,
        stale_defer=0,
        in_flight=0,
        wip_count=0,
        wip_cap=12,
    )
    line = triage_summary.format_one_liner(result)
    for i in range(3):
        triage_summary.append_history(
            history_path, result, line, emitted_at=f"2026-05-17T21:0{i}:00Z"
        )
    contents = history_path.read_text(encoding="utf-8").splitlines()
    assert len(contents) == 3
    for record_line in contents:
        record = json.loads(record_line)
        assert record["cache_empty"] is True


def test_main_appends_one_history_record_per_invocation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache_root = tmp_path / triage_summary.CACHE_DIR_NAME
    _make_cached_issue(cache_root, "deftai/directive", 700)
    monkeypatch.chdir(tmp_path)
    # Capture stdout via a real StringIO so the CLI prints land in-test.
    buf = io.StringIO()
    monkeypatch.setattr(sys, "stdout", buf)
    rc = triage_summary.main(["--project-root", str(tmp_path)])
    assert rc == 0
    history = tmp_path / triage_summary.SUMMARY_HISTORY_REL_PATH
    assert history.is_file()
    assert len(history.read_text(encoding="utf-8").splitlines()) == 1
    # Second invocation appends, never overwrites.
    triage_summary.main(["--project-root", str(tmp_path)])
    assert len(history.read_text(encoding="utf-8").splitlines()) == 2


# ---------------------------------------------------------------------------
# D14 / #1133: scope-drift segment
# ---------------------------------------------------------------------------


def test_scope_drift_segment_appears_when_count_nonzero() -> None:
    """D14: positive scope_drift surfaces as ``[scope-drift] N``."""
    result = triage_summary.SummaryResult(
        cache_empty=False,
        untriaged=4,
        stale_defer=0,
        in_flight=2,
        wip_count=3,
        wip_cap=10,
        scope_drift=12,
    )
    line = triage_summary.format_one_liner(result)
    assert "[scope-drift] 12" in line


def test_scope_drift_segment_suppressed_when_zero() -> None:
    result = triage_summary.SummaryResult(
        cache_empty=False,
        untriaged=4,
        stale_defer=0,
        in_flight=2,
        wip_count=3,
        wip_cap=10,
        scope_drift=0,
    )
    line = triage_summary.format_one_liner(result)
    assert "scope-drift" not in line


def test_to_record_includes_scope_drift_field() -> None:
    result = triage_summary.SummaryResult(
        cache_empty=False,
        untriaged=4,
        stale_defer=0,
        in_flight=2,
        wip_count=3,
        wip_cap=10,
        scope_drift=7,
    )
    rec = result.to_record(emitted_at="2026-05-18T14:30:00Z", line="[triage] ...")
    assert rec["scope_drift"] == 7


def test_to_record_default_scope_drift_zero() -> None:
    """Backward compat: pre-D14 callers that construct SummaryResult
    without scope_drift get the 0 default and the field in the JSONL.
    """
    result = triage_summary.SummaryResult(
        cache_empty=True,
        untriaged=0,
        stale_defer=0,
        in_flight=0,
        wip_count=0,
        wip_cap=10,
    )
    rec = result.to_record(emitted_at="2026-05-18T14:30:00Z", line="...")
    assert rec["scope_drift"] == 0


# ---------------------------------------------------------------------------
# CLI exit code contract
# ---------------------------------------------------------------------------


def test_cli_exits_zero_on_empty_cache(tmp_path: Path) -> None:
    rc = triage_summary.main(["--project-root", str(tmp_path), "--no-history"])
    assert rc == 0


def test_cli_exits_zero_with_at_cap_wip(tmp_path: Path) -> None:
    cache_root = tmp_path / triage_summary.CACHE_DIR_NAME
    _make_cached_issue(cache_root, "deftai/directive", 800)
    _set_wip_cap(tmp_path, 4)
    _write_wip(tmp_path, 5, folder="active")
    rc = triage_summary.main(["--project-root", str(tmp_path), "--no-history"])
    # Status surface, not a gate -- always 0.
    assert rc == 0


def test_cli_json_mode_emits_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    cache_root = tmp_path / triage_summary.CACHE_DIR_NAME
    _make_cached_issue(cache_root, "deftai/directive", 900)
    rc = triage_summary.main(
        ["--project-root", str(tmp_path), "--no-history", "--json"]
    )
    assert rc == 0
    captured = capsys.readouterr()
    record = json.loads(captured.out)
    assert record["schema"] == triage_summary.SUMMARY_HISTORY_SCHEMA
    assert record["cache_empty"] is False
    assert "line" in record


# ---------------------------------------------------------------------------
# Audit-log tolerance
# ---------------------------------------------------------------------------


def test_audit_log_tolerates_malformed_lines(tmp_path: Path) -> None:
    """Malformed audit-log lines must be skipped while the legitimate
    ``accept`` still classifies the cached issue.

    Post-#1270 the headline ``in_flight`` is filesystem-truth, so the
    audit-log-derived count surfaces via
    :attr:`SummaryResult.in_flight_cache_scoped` -- that's the field
    this test pins.
    """
    cache_root = tmp_path / triage_summary.CACHE_DIR_NAME
    _make_cached_issue(cache_root, "deftai/directive", 1000)
    log = tmp_path / triage_summary.CANDIDATES_LOG_REL_PATH
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text(
        "{this is not json\n"
        + json.dumps(
            _make_audit_entry(
                "deftai/directive", 1000, "accept",
                decision_id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            ),
            sort_keys=True,
        )
        + "\n\n"
        + "[]\n",  # non-object entry -- also tolerated
        encoding="utf-8",
    )
    result = triage_summary.compute_summary(tmp_path)
    assert result.in_flight_cache_scoped == 1
    assert result.untriaged == 0


def test_latest_decision_wins_chronologically() -> None:
    entries = [
        {
            "decision_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1",
            "timestamp": "2026-05-17T18:00:00Z",
            "repo": "deftai/directive",
            "issue_number": 50,
            "decision": "defer",
            "actor": "agent",
        },
        {
            "decision_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2",
            "timestamp": "2026-05-17T19:00:00Z",
            "repo": "deftai/directive",
            "issue_number": 50,
            "decision": "accept",
            "actor": "agent",
        },
    ]
    decisions = triage_summary.latest_decisions(entries)
    assert decisions[("deftai/directive", 50)] == "accept"


# ---------------------------------------------------------------------------
# WIP cap resolution
# ---------------------------------------------------------------------------


def test_wip_cap_defaults_to_framework_default_when_field_absent(tmp_path: Path) -> None:
    # D4 / #1124 fixes D2's default-drift bug -- the shared
    # ``scripts.policy.DEFAULT_WIP_CAP`` is the single source of truth
    # (resolved to 10 per umbrella #1119 Current Shape v3). The
    # historical 12-literal here mirrored the now-superseded D4 issue
    # body.
    assert triage_summary.resolve_wip_cap(tmp_path) == triage_summary.DEFAULT_WIP_CAP
    assert triage_summary.DEFAULT_WIP_CAP == 10


def test_wip_cap_honours_typed_field(tmp_path: Path) -> None:
    _set_wip_cap(tmp_path, 6)
    assert triage_summary.resolve_wip_cap(tmp_path) == 6


def test_wip_cap_rejects_non_int(tmp_path: Path) -> None:
    pd = tmp_path / triage_summary.PROJECT_DEFINITION_REL_PATH
    pd.parent.mkdir(parents=True, exist_ok=True)
    pd.write_text(
        json.dumps({"plan": {"policy": {"wipCap": "twelve"}}}),
        encoding="utf-8",
    )
    assert triage_summary.resolve_wip_cap(tmp_path) == triage_summary.DEFAULT_WIP_CAP


def test_wip_cap_zero_honoured(tmp_path: Path) -> None:
    """Cap=0 freezes promotion entirely -- still a legitimate operator state."""
    _set_wip_cap(tmp_path, 0)
    assert triage_summary.resolve_wip_cap(tmp_path) == 0


# ---------------------------------------------------------------------------
# Greptile P1 regression -- mkdir OSError must NOT escape append_history
# ---------------------------------------------------------------------------


def test_append_history_swallows_mkdir_oserror(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Greptile P1: a read-only filesystem / permission denial on the
    ``vbrief/.eval/`` parent ``mkdir`` MUST NOT propagate out of
    ``append_history`` -- the sidecar write is observability only and the
    issue body freezes the verb at exit 0 for every scenario.
    """
    history_path = tmp_path / triage_summary.SUMMARY_HISTORY_REL_PATH

    original_mkdir = Path.mkdir

    # ``*args``/``**kwargs`` typed as ``Any`` so the delegate call into
    # ``Path.mkdir`` (which expects ``mode: int``, ``parents: bool``,
    # ``exist_ok: bool``) does not fail mypy's ``object`` -> ``int|bool``
    # narrowing check. The test only cares about the side-effect of the
    # refusal; the forwarded signature is opaque.
    def _refuse_mkdir(self: Path, *args: Any, **kwargs: Any) -> None:
        # Only refuse the sidecar's parent; let other paths pass so the
        # tmp_path fixture itself stays usable for the helper.
        if self.name == ".eval":
            raise PermissionError(13, "refused for test")
        original_mkdir(self, *args, **kwargs)

    monkeypatch.setattr(Path, "mkdir", _refuse_mkdir)

    result = triage_summary.SummaryResult(
        cache_empty=True,
        untriaged=0,
        stale_defer=0,
        in_flight=0,
        wip_count=0,
        wip_cap=12,
    )
    # Pre-fix this would raise PermissionError -- the regression guard.
    returned = triage_summary.append_history(
        history_path,
        result,
        line=triage_summary.EMPTY_CACHE_LINE,
        emitted_at="2026-05-17T22:00:00Z",
    )
    assert returned == history_path
    # mkdir refused so the directory never came into being and the file
    # is therefore absent -- best-effort write is exactly the contract.
    assert not history_path.exists()


def test_main_swallows_mkdir_oserror_and_returns_zero(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """End-to-end Greptile P1 guard: ``main`` MUST exit 0 even when the
    sidecar mkdir refuses.
    """
    cache_root = tmp_path / triage_summary.CACHE_DIR_NAME
    _make_cached_issue(cache_root, "deftai/directive", 1100)

    original_mkdir = Path.mkdir

    def _refuse_mkdir(self: Path, *args: Any, **kwargs: Any) -> None:
        if self.name == ".eval":
            raise PermissionError(13, "refused for test")
        original_mkdir(self, *args, **kwargs)

    monkeypatch.setattr(Path, "mkdir", _refuse_mkdir)

    rc = triage_summary.main(["--project-root", str(tmp_path)])
    assert rc == 0
    history = tmp_path / triage_summary.SUMMARY_HISTORY_REL_PATH
    assert not history.exists()  # mkdir refused -> sidecar absent, no crash


# ---------------------------------------------------------------------------
# Greptile P2 regression -- Unicode digit directory names must be filtered
# ---------------------------------------------------------------------------


def test_iter_cached_issues_skips_unicode_digit_names(tmp_path: Path) -> None:
    """Greptile P2: ``str.isdigit()`` matches Unicode superscript digits
    (``\u00b2``, ``\u00b3``, circled digits, etc.) but ``int(name)``
    raises ``ValueError`` on those. The walker uses ``isdecimal`` (ASCII
    ``0-9`` plus the strict ``Nd`` Decimal_Number class) so a stray
    ``\u00b2``-named directory under ``<owner>/<repo>/`` is filtered out
    cleanly instead of crashing the walk.
    """
    cache_root = tmp_path / triage_summary.CACHE_DIR_NAME
    _make_cached_issue(cache_root, "deftai/directive", 200)
    # Drop a stray Unicode-digit directory alongside the legit one. The
    # name passes ``str.isdigit()`` but FAILS ``int()`` conversion.
    unicode_digit_dir = (
        cache_root / "github-issue" / "deftai" / "directive" / "\u00b2"
    )
    unicode_digit_dir.mkdir(parents=True, exist_ok=True)

    # Pre-fix this raised ``ValueError`` mid-walk. Post-fix the helper
    # returns only the valid ASCII-digit entry.
    entries = triage_summary.iter_cached_issues(cache_root)
    assert entries == [("deftai/directive", 200)]


def test_is_pos_int_dir_predicate_rejects_unicode_digit(tmp_path: Path) -> None:
    """Direct predicate-level coverage for the Greptile P2 fix."""
    valid = tmp_path / "7"
    valid.mkdir()
    unicode_digit = tmp_path / "\u00b2"
    unicode_digit.mkdir()
    circled_one = tmp_path / "\u2460"  # ① -- isdigit True, isdecimal False
    circled_one.mkdir()

    assert triage_summary._is_pos_int_dir(valid) is True
    assert triage_summary._is_pos_int_dir(unicode_digit) is False
    assert triage_summary._is_pos_int_dir(circled_one) is False
    # Sanity-check: confirm the canonical isdigit/isdecimal divergence so a
    # future Python release that tightens isdigit cannot silently retire
    # the regression scenario this test guards.
    assert "\u00b2".isdigit() is True
    assert "\u00b2".isdecimal() is False


# ---------------------------------------------------------------------------
# #1270: filesystem-truth in-flight + scope discrepancy line
# ---------------------------------------------------------------------------


def test_count_filesystem_in_flight_counts_only_running_status(
    tmp_path: Path,
) -> None:
    """Only ``plan.status == "running"`` active/ vBRIEFs count."""
    _write_active_vbrief(tmp_path, "a-running", status="running")
    _write_active_vbrief(tmp_path, "b-running", status="running")
    _write_active_vbrief(tmp_path, "c-done", status="done")
    _write_active_vbrief(tmp_path, "d-cancelled", status="cancelled")
    _write_active_vbrief(tmp_path, "e-blocked", status="blocked")
    assert triage_summary.count_filesystem_in_flight(tmp_path) == 2


def test_count_filesystem_in_flight_missing_folder_returns_zero(
    tmp_path: Path,
) -> None:
    """A fresh consumer with no ``vbrief/active/`` folder contributes 0."""
    assert triage_summary.count_filesystem_in_flight(tmp_path) == 0


def test_count_filesystem_in_flight_tolerates_malformed_vbriefs(
    tmp_path: Path,
) -> None:
    """Corrupt vBRIEFs MUST NOT crash the ritual; they're just skipped."""
    folder = tmp_path / "vbrief" / "active"
    folder.mkdir(parents=True)
    # Truncated JSON.
    (folder / "a-torn.vbrief.json").write_text(
        '{"plan": {"status":', encoding="utf-8"
    )
    # Non-dict top level.
    (folder / "b-list.vbrief.json").write_text("[]", encoding="utf-8")
    # Missing plan key.
    (folder / "c-no-plan.vbrief.json").write_text(
        json.dumps({"vBRIEFInfo": {}}), encoding="utf-8"
    )
    # plan.status is a non-string.
    (folder / "d-status-int.vbrief.json").write_text(
        json.dumps({"plan": {"status": 42}}), encoding="utf-8"
    )
    # Legit running vBRIEF -- this is the only one that counts.
    _write_active_vbrief(tmp_path, "e-good", status="running")
    # Non-.vbrief.json file in the folder -- ignored.
    (folder / "README.md").write_text("scratch", encoding="utf-8")
    assert triage_summary.count_filesystem_in_flight(tmp_path) == 1


def test_is_triage_scope_explicitly_configured_true_for_non_empty_list(
    tmp_path: Path,
) -> None:
    """A non-empty list of dict rules is the "configured" signal."""
    _set_triage_scope(tmp_path, [{"rule": "labels", "any-of": ["phase-1"]}])
    assert (
        triage_summary._is_triage_scope_explicitly_configured(tmp_path) is True
    )


def test_is_triage_scope_explicitly_configured_false_for_default(
    tmp_path: Path,
) -> None:
    """Absent / empty / non-list / list-of-non-dicts all collapse to False.

    The framework default (``[{"rule": "all-open"}]`` applied by
    :func:`scripts.triage_scope.resolve_scope_rules` when the field is
    unset) is treated as "not configured" -- the operator hasn't
    explicitly tightened scope. An explicitly-written ``all-open``
    rule, by contrast, is treated as configured because the operator
    wrote it on purpose.
    """
    # Case 1: no PROJECT-DEFINITION at all.
    assert (
        triage_summary._is_triage_scope_explicitly_configured(tmp_path) is False
    )

    # Case 2: PROJECT-DEFINITION exists but no triageScope field.
    _set_triage_scope(tmp_path, None)
    assert (
        triage_summary._is_triage_scope_explicitly_configured(tmp_path) is False
    )

    # Case 3: triageScope is an empty list.
    _set_triage_scope(tmp_path, [])
    assert (
        triage_summary._is_triage_scope_explicitly_configured(tmp_path) is False
    )

    # Case 4: triageScope is a list of non-dicts (malformed config).
    pd = tmp_path / triage_summary.PROJECT_DEFINITION_REL_PATH
    pd.write_text(
        json.dumps(
            {
                "vBRIEFInfo": {"version": "0.6"},
                "plan": {"policy": {"triageScope": ["all-open", 42]}},
            }
        ),
        encoding="utf-8",
    )
    assert (
        triage_summary._is_triage_scope_explicitly_configured(tmp_path) is False
    )


def test_is_triage_scope_explicitly_configured_tolerates_malformed_json(
    tmp_path: Path,
) -> None:
    """A corrupt PROJECT-DEFINITION must not crash the ritual."""
    pd = tmp_path / triage_summary.PROJECT_DEFINITION_REL_PATH
    pd.parent.mkdir(parents=True, exist_ok=True)
    pd.write_text("{not json", encoding="utf-8")
    assert (
        triage_summary._is_triage_scope_explicitly_configured(tmp_path) is False
    )


def test_compute_summary_in_flight_is_filesystem_truth(tmp_path: Path) -> None:
    """#1270: the headline ``in_flight`` is the filesystem-truth count.

    Setup: 3 cached issues with audit-log accepts on 2 of them (would
    yield ``in_flight=2`` under the legacy contract). Filesystem has 1
    active/ vBRIEF with ``status=="running"``. Headline must report 1,
    cache-scoped must report 2.
    """
    cache_root = tmp_path / triage_summary.CACHE_DIR_NAME
    _make_cached_issue(cache_root, "deftai/directive", 600)
    _make_cached_issue(cache_root, "deftai/directive", 601)
    _make_cached_issue(cache_root, "deftai/directive", 602)
    _write_audit_log(
        tmp_path,
        [
            _make_audit_entry(
                "deftai/directive", 600, "accept",
                decision_id="66666666-6666-6666-6666-666666666600",
            ),
            _make_audit_entry(
                "deftai/directive", 601, "accept",
                decision_id="66666666-6666-6666-6666-666666666601",
            ),
        ],
    )
    _write_active_vbrief(tmp_path, "only-running", status="running")

    result = triage_summary.compute_summary(tmp_path)
    assert result.in_flight == 1               # filesystem-truth headline
    assert result.in_flight_filesystem == 1
    assert result.in_flight_cache_scoped == 2  # legacy audit-log count


def test_format_scope_discrepancy_line_none_when_aligned() -> None:
    """Aligned counts -> no second line emitted."""
    result = triage_summary.SummaryResult(
        cache_empty=False,
        untriaged=4,
        stale_defer=0,
        in_flight=3,
        wip_count=3,
        wip_cap=10,
        in_flight_filesystem=3,
        in_flight_cache_scoped=3,
        triage_scope_configured=True,
    )
    assert triage_summary.format_scope_discrepancy_line(result) is None


def test_format_scope_discrepancy_line_none_on_cache_empty() -> None:
    """Cache-empty -> no second line (headline switches to EMPTY_CACHE_LINE)."""
    result = triage_summary.SummaryResult(
        cache_empty=True,
        untriaged=0,
        stale_defer=0,
        in_flight=2,
        wip_count=0,
        wip_cap=10,
        in_flight_filesystem=2,
        in_flight_cache_scoped=0,
        triage_scope_configured=False,
    )
    assert triage_summary.format_scope_discrepancy_line(result) is None


def test_format_scope_discrepancy_line_configured_wording() -> None:
    """Configured scope -> "outside plan.policy.triageScope[]" wording."""
    result = triage_summary.SummaryResult(
        cache_empty=False,
        untriaged=4,
        stale_defer=0,
        in_flight=3,
        wip_count=3,
        wip_cap=10,
        in_flight_filesystem=3,
        in_flight_cache_scoped=2,
        triage_scope_configured=True,
    )
    line = triage_summary.format_scope_discrepancy_line(result)
    assert line is not None
    assert line == (
        "[triage:scope] 1 in-flight outside "
        "plan.policy.triageScope[] (uncounted in queue ranking)"
    )


def test_format_scope_discrepancy_line_not_configured_wording() -> None:
    """Default / empty scope -> "not configured" wording."""
    result = triage_summary.SummaryResult(
        cache_empty=False,
        untriaged=359,
        stale_defer=0,
        in_flight=3,
        wip_count=3,
        wip_cap=10,
        in_flight_filesystem=3,
        in_flight_cache_scoped=38,
        triage_scope_configured=False,
    )
    line = triage_summary.format_scope_discrepancy_line(result)
    assert line is not None
    assert line == (
        "[triage:scope] 35 in-flight; "
        "plan.policy.triageScope[] not configured "
        "(uncounted in queue ranking)"
    )


def test_format_scope_discrepancy_line_uses_absolute_delta() -> None:
    """The delta is the absolute value -- direction agnostic.

    Either side (filesystem > cache or cache > filesystem) surfaces as
    a positive ``N``; the operator can investigate further from there.
    """
    # filesystem(5) > cache(2): delta = 3
    fs_high = triage_summary.SummaryResult(
        cache_empty=False, untriaged=0, stale_defer=0, in_flight=5,
        wip_count=0, wip_cap=10,
        in_flight_filesystem=5, in_flight_cache_scoped=2,
        triage_scope_configured=True,
    )
    # cache(38) > filesystem(3): delta = 35
    cache_high = triage_summary.SummaryResult(
        cache_empty=False, untriaged=0, stale_defer=0, in_flight=3,
        wip_count=0, wip_cap=10,
        in_flight_filesystem=3, in_flight_cache_scoped=38,
        triage_scope_configured=True,
    )
    fs_line = triage_summary.format_scope_discrepancy_line(fs_high)
    cache_line = triage_summary.format_scope_discrepancy_line(cache_high)
    assert fs_line is not None and "3 in-flight outside" in fs_line
    assert cache_line is not None and "35 in-flight outside" in cache_line


def test_format_summary_appends_discrepancy_line_when_diverged() -> None:
    """``format_summary`` returns ``headline\\n[triage:scope] ...`` on divergence."""
    result = triage_summary.SummaryResult(
        cache_empty=False,
        untriaged=359,
        stale_defer=0,
        in_flight=3,
        wip_count=3,
        wip_cap=10,
        in_flight_filesystem=3,
        in_flight_cache_scoped=38,
        triage_scope_configured=False,
    )
    full = triage_summary.format_summary(result)
    lines = full.split("\n")
    assert len(lines) == 2
    assert lines[0].startswith("[triage] 359 untriaged")
    assert "3 in-flight" in lines[0]
    assert lines[1].startswith("[triage:scope] 35 in-flight")
    assert "not configured" in lines[1]


def test_format_summary_single_line_when_aligned() -> None:
    """Aligned counts -> ``format_summary`` returns just the headline."""
    result = triage_summary.SummaryResult(
        cache_empty=False,
        untriaged=4,
        stale_defer=0,
        in_flight=2,
        wip_count=1,
        wip_cap=10,
        in_flight_filesystem=2,
        in_flight_cache_scoped=2,
        triage_scope_configured=True,
    )
    full = triage_summary.format_summary(result)
    assert "\n" not in full
    assert "[triage:scope]" not in full


def test_format_summary_single_line_when_cache_empty() -> None:
    """Cache-empty headline always single-line, no discrepancy line."""
    result = triage_summary.SummaryResult(
        cache_empty=True,
        untriaged=0,
        stale_defer=0,
        in_flight=2,
        wip_count=0,
        wip_cap=10,
        in_flight_filesystem=2,
        in_flight_cache_scoped=0,
        triage_scope_configured=False,
    )
    full = triage_summary.format_summary(result)
    assert full == triage_summary.EMPTY_CACHE_LINE
    assert "\n" not in full


def test_compute_summary_configured_scope_emits_configured_wording(
    tmp_path: Path,
) -> None:
    """End-to-end: a configured scope + divergence -> "outside" wording."""
    cache_root = tmp_path / triage_summary.CACHE_DIR_NAME
    _make_cached_issue(cache_root, "deftai/directive", 700)
    _write_audit_log(
        tmp_path,
        [
            _make_audit_entry(
                "deftai/directive", 700, "accept",
                decision_id="77777777-7777-7777-7777-777777777700",
            ),
        ],
    )
    _set_triage_scope(tmp_path, [{"rule": "labels", "any-of": ["phase-1"]}])
    _write_active_vbrief(tmp_path, "one-running", status="running")
    _write_active_vbrief(tmp_path, "two-running", status="running")

    result = triage_summary.compute_summary(tmp_path)
    assert result.triage_scope_configured is True
    assert result.in_flight_filesystem == 2
    assert result.in_flight_cache_scoped == 1
    full = triage_summary.format_summary(result)
    assert "outside plan.policy.triageScope[]" in full
    assert "not configured" not in full


def test_to_record_includes_new_in_flight_fields() -> None:
    """#1270 dataclass fields are persisted in the history JSONL record."""
    result = triage_summary.SummaryResult(
        cache_empty=False,
        untriaged=10,
        stale_defer=0,
        in_flight=3,
        wip_count=3,
        wip_cap=10,
        in_flight_filesystem=3,
        in_flight_cache_scoped=38,
        triage_scope_configured=True,
    )
    rec = result.to_record(emitted_at="2026-05-21T12:00:00Z", line="[triage] ...")
    assert rec["in_flight_filesystem"] == 3
    assert rec["in_flight_cache_scoped"] == 38
    assert rec["triage_scope_configured"] is True
    # The original alias survives.
    assert rec["in_flight"] == 3


def test_to_record_defaults_for_pre_1270_constructors() -> None:
    """Constructors that omit the #1270 fields still produce a record."""
    result = triage_summary.SummaryResult(
        cache_empty=True,
        untriaged=0,
        stale_defer=0,
        in_flight=0,
        wip_count=0,
        wip_cap=10,
    )
    rec = result.to_record(emitted_at="2026-05-21T12:00:00Z", line="...")
    assert rec["in_flight_filesystem"] == 0
    assert rec["in_flight_cache_scoped"] == 0
    assert rec["triage_scope_configured"] is False
