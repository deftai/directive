"""test_subagent_monitor.py -- Tests for scripts/subagent_monitor.py (#1365).

Covers the four canonical paths from the vBRIEF acceptance items:

- empty scratch dir that EXISTS -> exit 0 (no agents to monitor; the
  contract intentionally distinguishes \"no records\" from \"stale\")
- fresh heartbeat under threshold -> exit 0
- stale heartbeat over threshold -> exit 1 with per-record diagnostics
- malformed JSON record -> exit 1 with a `MALFORMED` status line

Plus the three load-bearing edge cases the implementation guards:

- a record whose ``last_heartbeat_at`` is older than the threshold BUT
  whose ``terminal_state`` is populated counts as TERMINAL, not STALE
  (the agent finished cleanly; staleness is only meaningful mid-flight)
- a record whose ``agent_id`` does not match the filename surfaces as
  MALFORMED (catches stale files left behind by a renamed agent)
- a missing scratch directory exits 2 (config error, NOT exit 1) so the
  operator can distinguish setup mistakes from agent staleness

The script is loaded via importlib (mirroring
``tests/cli/test_swarm_verify_review_clean.py``) so the test does not
need to be installed as a console_scripts entry point.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module():
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "subagent_monitor",
        scripts_dir / "subagent_monitor.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["subagent_monitor"] = module
    spec.loader.exec_module(module)
    return module


sam = _load_module()


# ---------------------------------------------------------------------------
# Heartbeat-record fixtures
# ---------------------------------------------------------------------------


def _now_utc() -> datetime:
    """Real wall-clock now in UTC. The fixtures compute heartbeat
    timestamps relative to this so the script's own ``datetime.now(
    timezone.utc)`` inside ``main()`` aligns with what the tests wrote --
    a fixed reference time would silently drift relative to real now and
    flip every record stale."""
    return datetime.now(UTC)


def _write_record(
    scratch_dir: Path,
    agent_id: str,
    *,
    minutes_ago: float = 0.0,
    phase: str = "polling",
    terminal_state: str | None = None,
    parent_id: str = "parent-test",
    last_message: str = "polling Greptile",
    pr_number: int | None = None,
    iso_override: str | None = None,
    payload_override: object | None = None,
) -> Path:
    """Write a heartbeat record file under ``scratch_dir``.

    ``minutes_ago`` is relative to real wall-clock now. ``iso_override`` /
    ``payload_override`` are escape hatches for tests that need to write
    malformed content (bad timestamp, non-object payload, etc.).
    """
    scratch_dir.mkdir(parents=True, exist_ok=True)
    target = scratch_dir / f"{agent_id}.json"
    if payload_override is not None:
        target.write_text(json.dumps(payload_override), encoding="utf-8")
        return target
    ts = _now_utc() - timedelta(minutes=minutes_ago)
    iso = iso_override if iso_override is not None else (
        ts.strftime("%Y-%m-%dT%H:%M:%SZ")
    )
    payload: dict[str, object] = {
        "agent_id": agent_id,
        "parent_id": parent_id,
        "last_heartbeat_at": iso,
        "last_message": last_message,
        "phase": phase,
        "terminal_state": terminal_state,
    }
    if pr_number is not None:
        payload["pr_number"] = pr_number
    target.write_text(json.dumps(payload), encoding="utf-8")
    return target


# ---------------------------------------------------------------------------
# Empty-scratch-dir contract (exit 0)
# ---------------------------------------------------------------------------


class TestEmptyScratchDir:
    def test_empty_existing_scratch_dir_exits_0(self, tmp_path, capsys):
        scratch = tmp_path / ".deft-scratch" / "subagent-status"
        scratch.mkdir(parents=True)
        rc = sam.main(["--scratch-dir", str(scratch)])
        assert rc == sam.EXIT_OK
        out = capsys.readouterr().out
        assert "NO AGENTS TO MONITOR" in out
        assert "empty scratch dir" in out

    def test_empty_scratch_dir_json_emits_record_count_zero(self, tmp_path, capsys):
        scratch = tmp_path / ".deft-scratch" / "subagent-status"
        scratch.mkdir(parents=True)
        rc = sam.main(["--scratch-dir", str(scratch), "--json"])
        assert rc == sam.EXIT_OK
        payload = json.loads(capsys.readouterr().out)
        assert payload["record_count"] == 0
        assert payload["stale_count"] == 0
        assert payload["malformed_count"] == 0
        assert payload["all_ok"] is True


# ---------------------------------------------------------------------------
# Fresh-heartbeat contract (exit 0)
# ---------------------------------------------------------------------------


class TestFreshHeartbeat:
    def test_single_fresh_record_exits_0(self, tmp_path, capsys):
        scratch = tmp_path / "subagent-status"
        _write_record(
            scratch,
            "agent3-1365",
            minutes_ago=1.0,
            phase="polling",
            last_message="poll 1/20 fresh",
        )
        result = sam.sweep_scratch_dirs(
            [scratch], threshold_minutes=30, now=_now_utc()
        )
        assert result.all_ok is True
        assert len(result.records) == 1
        rec = result.records[0]
        assert rec.agent_id == "agent3-1365"
        assert rec.phase == "polling"
        assert rec.is_stale is False
        assert rec.is_terminal is False

        # Main should also exit 0 with a clear OK status banner.
        rc = sam.main([
            "--scratch-dir",
            str(scratch),
            "--threshold-minutes",
            "30",
        ])
        assert rc == sam.EXIT_OK
        out = capsys.readouterr().out
        assert "ALL AGENTS ALIVE" in out
        assert "agent3-1365 -- OK" in out
        assert "poll 1/20 fresh" in out

    def test_multiple_fresh_records_all_listed_with_phase(self, tmp_path, capsys):
        scratch = tmp_path / "subagent-status"
        _write_record(scratch, "agent-a", minutes_ago=2.0, phase="polling")
        _write_record(scratch, "agent-b", minutes_ago=1.0, phase="implementing")
        _write_record(scratch, "agent-c", minutes_ago=0.5, phase="fixing")
        rc = sam.main(["--scratch-dir", str(scratch)])
        assert rc == sam.EXIT_OK
        out = capsys.readouterr().out
        for agent in ("agent-a", "agent-b", "agent-c"):
            assert f"{agent} -- OK" in out
        # The status report MUST surface phase for each agent
        # (acceptance item: "emits a status report listing each agent's
        # last_heartbeat_at and phase").
        assert "polling" in out
        assert "implementing" in out
        assert "fixing" in out

    def test_terminal_record_is_not_stale_even_when_old(self, tmp_path):
        scratch = tmp_path / "subagent-status"
        _write_record(
            scratch,
            "agent-done",
            minutes_ago=120.0,  # 2 hours -- way over threshold
            phase="terminal",
            terminal_state="CLEAN",
        )
        result = sam.sweep_scratch_dirs(
            [scratch], threshold_minutes=30, now=_now_utc()
        )
        rec = result.records[0]
        assert rec.is_terminal is True
        assert rec.is_stale is False
        assert rec.ok is True


# ---------------------------------------------------------------------------
# Stale-heartbeat contract (exit 1)
# ---------------------------------------------------------------------------


class TestStaleHeartbeat:
    def test_single_stale_record_exits_1(self, tmp_path, capsys):
        scratch = tmp_path / "subagent-status"
        _write_record(
            scratch,
            "agent-stalled",
            minutes_ago=45.0,
            phase="polling",
            last_message="stuck on poll 9/20",
        )
        result = sam.sweep_scratch_dirs(
            [scratch], threshold_minutes=30, now=_now_utc()
        )
        assert result.all_ok is False
        rec = result.records[0]
        assert rec.is_stale is True
        assert rec.is_terminal is False

        rc = sam.main([
            "--scratch-dir",
            str(scratch),
            "--threshold-minutes",
            "30",
        ])
        assert rc == sam.EXIT_STALE
        out = capsys.readouterr().out
        assert "agent-stalled -- STALE" in out
        assert "ATTENTION" in out

    def test_mixed_fresh_and_stale_blocks_with_per_record_diagnostics(
        self, tmp_path, capsys
    ):
        scratch = tmp_path / "subagent-status"
        _write_record(scratch, "agent-fresh", minutes_ago=2.0)
        _write_record(scratch, "agent-stalled", minutes_ago=45.0)
        rc = sam.main([
            "--scratch-dir",
            str(scratch),
            "--threshold-minutes",
            "30",
        ])
        assert rc == sam.EXIT_STALE
        out = capsys.readouterr().out
        assert "agent-fresh -- OK" in out
        assert "agent-stalled -- STALE" in out

    def test_tight_threshold_flags_otherwise_fresh_record(self, tmp_path, capsys):
        scratch = tmp_path / "subagent-status"
        _write_record(scratch, "agent-impatient", minutes_ago=2.0)
        # Threshold below the record's age -> STALE.
        rc = sam.main([
            "--scratch-dir",
            str(scratch),
            "--threshold-minutes",
            "1",
        ])
        assert rc == sam.EXIT_STALE
        out = capsys.readouterr().out
        assert "agent-impatient -- STALE" in out


# ---------------------------------------------------------------------------
# Malformed-record contract (exit 1)
# ---------------------------------------------------------------------------


class TestMalformedRecord:
    def test_malformed_json_exits_1_with_warning(self, tmp_path, capsys):
        scratch = tmp_path / "subagent-status"
        scratch.mkdir(parents=True)
        (scratch / "broken-agent.json").write_text(
            "{not valid json", encoding="utf-8"
        )
        rc = sam.main([
            "--scratch-dir",
            str(scratch),
            "--threshold-minutes",
            "30",
        ])
        assert rc == sam.EXIT_STALE
        out = capsys.readouterr().out
        assert "broken-agent -- MALFORMED" in out
        assert "malformed JSON" in out

    def test_missing_required_fields_flags_malformed(self, tmp_path, capsys):
        scratch = tmp_path / "subagent-status"
        # Drop `last_message` and `phase`. Use a fresh timestamp so the
        # record is MALFORMED but not also stale -- the test pins the
        # MALFORMED status line, not STALE+MALFORMED.
        _write_record(
            scratch,
            "agent-partial",
            payload_override={
                "agent_id": "agent-partial",
                "parent_id": "parent",
                "last_heartbeat_at": _now_utc().strftime(
                    "%Y-%m-%dT%H:%M:%SZ"
                ),
            },
        )
        rc = sam.main(["--scratch-dir", str(scratch)])
        assert rc == sam.EXIT_STALE
        out = capsys.readouterr().out
        assert "agent-partial -- MALFORMED" in out
        assert "missing required field" in out
        assert "last_message" in out
        assert "phase" in out

    def test_unknown_phase_flags_malformed(self, tmp_path, capsys):
        scratch = tmp_path / "subagent-status"
        _write_record(
            scratch,
            "agent-typo",
            phase="poling",  # typo for "polling"
        )
        rc = sam.main(["--scratch-dir", str(scratch)])
        assert rc == sam.EXIT_STALE
        out = capsys.readouterr().out
        assert "agent-typo -- MALFORMED" in out
        assert "unknown phase" in out

    def test_agent_id_filename_mismatch_flags_malformed(self, tmp_path, capsys):
        scratch = tmp_path / "subagent-status"
        scratch.mkdir(parents=True)
        (scratch / "filename-on-disk.json").write_text(
            json.dumps({
                "agent_id": "different-from-filename",
                "parent_id": "parent",
                "last_heartbeat_at": _now_utc().strftime("%Y-%m-%dT%H:%M:%SZ"),
                "last_message": "hi",
                "phase": "polling",
            }),
            encoding="utf-8",
        )
        rc = sam.main(["--scratch-dir", str(scratch)])
        assert rc == sam.EXIT_STALE
        out = capsys.readouterr().out
        assert "agent_id mismatch" in out

    def test_bad_timestamp_flags_malformed(self, tmp_path, capsys):
        scratch = tmp_path / "subagent-status"
        _write_record(
            scratch,
            "agent-localtz",
            iso_override="2026-05-28 14:00:00",  # no timezone
        )
        rc = sam.main(["--scratch-dir", str(scratch)])
        assert rc == sam.EXIT_STALE
        out = capsys.readouterr().out
        assert "agent-localtz -- MALFORMED" in out
        assert "ISO-8601 UTC" in out

    def test_required_field_wrong_type_flags_malformed(self, tmp_path, capsys):
        """Required string fields that hold null / non-string values MUST be
        surfaced as MALFORMED.

        Greptile review on #1375 (#1365): the original implementation
        only checked key PRESENCE in ``payload`` and then silently skipped
        the downstream ``isinstance(..., str)`` assignment for non-string
        values. That left the record's ``.ok`` property evaluating to
        ``True`` for an agent whose ``last_heartbeat_at`` was an integer
        epoch or JSON ``null`` -- a structurally broken record
        masquerading as ALL ALIVE. The fix appends an explicit
        "required field(s) must be string" failure so writers cannot
        emit a broken record without the monitor surfacing it.
        """
        scratch = tmp_path / "subagent-status"
        _write_record(
            scratch,
            "agent-typed-bad",
            payload_override={
                "agent_id": "agent-typed-bad",
                "parent_id": "parent",
                # Integer epoch instead of ISO-8601 string -- the exact
                # silent-pass mode Greptile flagged.
                "last_heartbeat_at": 1716906470,
                # null instead of string -- second flavour of the same gap.
                "last_message": None,
                "phase": "polling",
            },
        )
        rc = sam.main(["--scratch-dir", str(scratch)])
        assert rc == sam.EXIT_STALE
        out = capsys.readouterr().out
        assert "agent-typed-bad -- MALFORMED" in out
        assert "required field(s) must be string" in out
        # Both bad fields surface together in one diagnostic (the failure
        # collects all gaps so the operator sees the full picture).
        assert "last_heartbeat_at=int" in out
        assert "last_message=NoneType" in out

    def test_terminal_phase_without_terminal_state_flags_malformed(self, tmp_path):
        scratch = tmp_path / "subagent-status"
        _write_record(
            scratch,
            "agent-half-exit",
            phase="terminal",
            terminal_state=None,
        )
        result = sam.sweep_scratch_dirs(
            [scratch], threshold_minutes=30, now=_now_utc()
        )
        rec = result.records[0]
        assert any("phase='terminal' requires" in f for f in rec.failures)
        assert rec.ok is False


# ---------------------------------------------------------------------------
# Config-error contract (exit 2)
# ---------------------------------------------------------------------------


class TestConfigError:
    def test_missing_scratch_dir_exits_2(self, tmp_path, capsys):
        scratch = tmp_path / "does-not-exist"
        rc = sam.main(["--scratch-dir", str(scratch)])
        assert rc == sam.EXIT_EXTERNAL_ERROR
        out = capsys.readouterr().out
        assert "does not exist" in out

    def test_non_positive_threshold_exits_2(self, tmp_path, capsys):
        scratch = tmp_path / "subagent-status"
        scratch.mkdir(parents=True)
        rc = sam.main([
            "--scratch-dir",
            str(scratch),
            "--threshold-minutes",
            "0",
        ])
        assert rc == sam.EXIT_EXTERNAL_ERROR
        err = capsys.readouterr().err
        assert "must be positive" in err

    def test_negative_threshold_exits_2(self, tmp_path, capsys):
        scratch = tmp_path / "subagent-status"
        scratch.mkdir(parents=True)
        rc = sam.main([
            "--scratch-dir",
            str(scratch),
            "--threshold-minutes",
            "-5",
        ])
        assert rc == sam.EXIT_EXTERNAL_ERROR

    def test_scratch_path_is_file_not_dir_exits_2(self, tmp_path, capsys):
        bogus = tmp_path / "not-a-dir.txt"
        bogus.write_text("hello", encoding="utf-8")
        rc = sam.main(["--scratch-dir", str(bogus)])
        assert rc == sam.EXIT_EXTERNAL_ERROR
        out = capsys.readouterr().out
        assert "not a directory" in out


# ---------------------------------------------------------------------------
# Multi-scratch-dir aggregation
# ---------------------------------------------------------------------------


class TestMultiScratchDir:
    def test_two_worktrees_aggregate_into_one_report(self, tmp_path, capsys):
        worktree_a = tmp_path / "worktree-a" / "subagent-status"
        worktree_b = tmp_path / "worktree-b" / "subagent-status"
        _write_record(worktree_a, "agent-a", minutes_ago=1.0)
        _write_record(worktree_b, "agent-b", minutes_ago=1.0)
        rc = sam.main([
            "--scratch-dir",
            str(worktree_a),
            "--scratch-dir",
            str(worktree_b),
        ])
        assert rc == sam.EXIT_OK
        out = capsys.readouterr().out
        assert "agent-a -- OK" in out
        assert "agent-b -- OK" in out

    def test_dir_errors_with_healthy_records_yield_actionable_summary(
        self, tmp_path, capsys
    ):
        """When sweep_errors coexist with healthy records, the summary line
        MUST point the operator at scratch-dir paths, not at stalled agents.

        Greptile P1 on PR #1375 (#1365): the previous code printed
        ``ATTENTION -- 0 stale, 0 malformed record(s). Inspect diagnostics
        above and either re-dispatch the stalled agent(s) or take over
        manually.`` for the case where one --scratch-dir was missing but
        another carried healthy records. The recovery advice was wrong
        (no agents are actually stalled; the misconfigured path is the
        issue). The fix surfaces a CONFIG-flavoured summary that names
        the directory-error count and points the operator at the
        --scratch-dir flags.
        """
        worktree_a = tmp_path / "worktree-a" / "subagent-status"
        missing = tmp_path / "worktree-b" / "does-not-exist"
        _write_record(worktree_a, "agent-healthy", minutes_ago=1.0)
        rc = sam.main([
            "--scratch-dir",
            str(worktree_a),
            "--scratch-dir",
            str(missing),
        ])
        # Mixed-state: healthy record found AND a missing scratch dir.
        # The latter is the only blocker, so we exit STALE (not config
        # error -- config error is reserved for "no records anywhere").
        assert rc == sam.EXIT_STALE
        out = capsys.readouterr().out
        assert "agent-healthy -- OK" in out
        # The new actionable summary names the directory-error count
        # and the --scratch-dir surface.
        assert "scratch dir error(s)" in out
        assert "1 record(s) healthy" in out
        assert "--scratch-dir path" in out
        # And the OLD misleading wording is GONE for this state.
        assert "0 stale, 0 malformed" not in out
        assert "re-dispatch the stalled agent(s)" not in out

    def test_one_stale_in_two_worktrees_blocks(self, tmp_path, capsys):
        worktree_a = tmp_path / "worktree-a" / "subagent-status"
        worktree_b = tmp_path / "worktree-b" / "subagent-status"
        _write_record(worktree_a, "agent-fresh", minutes_ago=1.0)
        _write_record(worktree_b, "agent-stalled", minutes_ago=45.0)
        rc = sam.main([
            "--scratch-dir",
            str(worktree_a),
            "--scratch-dir",
            str(worktree_b),
        ])
        assert rc == sam.EXIT_STALE


# ---------------------------------------------------------------------------
# JSON output surface (for parent monitor consumers)
# ---------------------------------------------------------------------------


class TestJsonOutput:
    def test_json_payload_carries_per_record_diagnostics(self, tmp_path, capsys):
        scratch = tmp_path / "subagent-status"
        _write_record(scratch, "agent-fresh", minutes_ago=2.0)
        _write_record(scratch, "agent-stalled", minutes_ago=45.0)
        rc = sam.main([
            "--scratch-dir",
            str(scratch),
            "--threshold-minutes",
            "30",
            "--json",
        ])
        assert rc == sam.EXIT_STALE
        payload = json.loads(capsys.readouterr().out)
        assert payload["record_count"] == 2
        assert payload["stale_count"] == 1
        assert payload["malformed_count"] == 0
        assert payload["all_ok"] is False
        agents = {r["agent_id"]: r for r in payload["records"]}
        assert agents["agent-fresh"]["is_stale"] is False
        assert agents["agent-stalled"]["is_stale"] is True
