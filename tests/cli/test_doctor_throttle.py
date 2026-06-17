"""
test_doctor_throttle.py -- coverage for the consolidated doctor throttle (#1308).

The doctor throttle short-circuits ``run doctor`` (and the ``task doctor``
shim that wraps it) when a prior run is still within the 24h-clean /
4h-dirty cooldown. ``--full`` bypasses the gate, a corrupt state file
falls back to a full run, and the persisted JSON payload is the single
source of truth that lets the next invocation make the same decision
across processes.

Covers:

  * ``scripts/_doctor_state.py`` unit surface -- read/write round-trip,
    clean vs dirty window selection, corrupt-state handling, decision
    fields on first run, ``DEFT_DOCTOR_STATE_PATH`` override.
  * cmd_doctor throttle integration -- skip exit codes (0 clean / 1
    dirty), one-line status surface, ``--full`` bypass, ``--json`` skip
    schema vs completed schema.
  * State persistence -- a completed full run writes a well-formed
    state file the next invocation can consume.

Sibling to ``test_cmd_doctor.py`` (uv / dir layout / Taskfile diagnostics)
and ``test_doctor.py`` (broad happy-path smoke test). Refs: #1308.
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

# ---------------------------------------------------------------------------
# Module loader -- scripts/_doctor_state.py is loaded directly so we can
# unit-test the pure helpers without dragging the rest of ``run`` along
# (and without depending on PYTHONPATH adjustments the CLI does at
# import time).
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def doctor_state_module():
    """Load ``scripts/_doctor_state.py`` for the unit-test surface."""
    if "_doctor_state" in sys.modules:
        return sys.modules["_doctor_state"]
    repo_root = Path(__file__).resolve().parents[2]
    module_path = repo_root / "scripts" / "_doctor_state.py"
    spec = importlib.util.spec_from_file_location("_doctor_state", module_path)
    module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    assert spec is not None and spec.loader is not None
    # Register before exec so frozen-dataclass annotation resolution can
    # look up the module via ``sys.modules[cls.__module__]`` (Python 3.12).
    sys.modules["_doctor_state"] = module
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


def _make_fake_which(presence: dict[str, bool]):
    """Return a ``shutil.which`` replacement that overrides selected names."""
    real_which = shutil.which

    def _fake(cmd, *args, **kwargs):
        if cmd in presence:
            return f"/fake/path/to/{cmd}" if presence[cmd] else None
        return real_which(cmd, *args, **kwargs)

    return _fake


# ---------------------------------------------------------------------------
# Unit tests -- scripts/_doctor_state.py
# ---------------------------------------------------------------------------


def test_state_path_uses_project_root_by_default(
    doctor_state_module, tmp_path, monkeypatch
):
    # The autouse fixture in tests/cli/conftest.py pins
    # DEFT_DOCTOR_STATE_PATH to a tmp file so cmd_doctor never writes
    # to the live worktree. Drop the override here so the default
    # resolution path is exercised.
    monkeypatch.delenv("DEFT_DOCTOR_STATE_PATH", raising=False)
    path = doctor_state_module.state_path(tmp_path)
    assert path == tmp_path / "vbrief" / ".eval" / "doctor-state.json"


def test_state_path_honors_env_override(doctor_state_module, tmp_path, monkeypatch):
    override = tmp_path / "elsewhere" / "doctor-state.json"
    monkeypatch.setenv("DEFT_DOCTOR_STATE_PATH", str(override))
    resolved = doctor_state_module.state_path(tmp_path)
    assert resolved == override


def test_read_state_returns_none_when_missing(doctor_state_module, tmp_path):
    assert doctor_state_module.read_state(tmp_path) is None


def test_write_state_round_trips(doctor_state_module, tmp_path):
    when = datetime(2026, 5, 22, 12, 0, 0, tzinfo=UTC)
    persisted = doctor_state_module.write_state(
        tmp_path,
        exit_code=0,
        finding_count=2,
        error_count=0,
        now=when,
    )
    assert persisted is not None
    state = doctor_state_module.read_state(tmp_path)
    assert state is not None
    assert state.last_run_at == when
    assert state.last_exit_code == 0
    assert state.last_finding_count == 2
    assert state.last_error_count == 0


def test_read_state_returns_none_on_corrupt_json(doctor_state_module, tmp_path):
    path = doctor_state_module.state_path(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json", encoding="utf-8")
    assert doctor_state_module.read_state(tmp_path) is None


def test_read_state_returns_none_on_malformed_timestamp(doctor_state_module, tmp_path):
    path = doctor_state_module.state_path(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "last_run_at": "not-a-timestamp",
                "last_exit_code": 0,
                "last_finding_count": 0,
                "last_error_count": 0,
            }
        ),
        encoding="utf-8",
    )
    assert doctor_state_module.read_state(tmp_path) is None


def test_decide_throttle_no_state_runs_full(doctor_state_module):
    decision = doctor_state_module.decide_throttle(None)
    assert decision.skip is False
    assert decision.dirty is False
    assert decision.last_run_at is None
    assert decision.next_eligible_at is None
    assert decision.age_hours == 0.0


def test_decide_throttle_clean_within_window_skips(doctor_state_module):
    now = datetime(2026, 5, 22, 12, 0, 0, tzinfo=UTC)
    state = doctor_state_module.DoctorState(
        last_run_at=now - timedelta(hours=2),
        last_exit_code=0,
        last_finding_count=0,
        last_error_count=0,
    )
    decision = doctor_state_module.decide_throttle(state, now=now)
    assert decision.skip is True
    assert decision.dirty is False
    assert decision.next_eligible_at == state.last_run_at + timedelta(
        hours=doctor_state_module.CLEAN_WINDOW_HOURS
    )


def test_decide_throttle_clean_after_window_runs_full(doctor_state_module):
    now = datetime(2026, 5, 22, 12, 0, 0, tzinfo=UTC)
    state = doctor_state_module.DoctorState(
        last_run_at=now - timedelta(hours=25),
        last_exit_code=0,
        last_finding_count=0,
        last_error_count=0,
    )
    decision = doctor_state_module.decide_throttle(state, now=now)
    assert decision.skip is False


def test_decide_throttle_dirty_within_window_skips_with_dirty_flag(doctor_state_module):
    now = datetime(2026, 5, 22, 12, 0, 0, tzinfo=UTC)
    state = doctor_state_module.DoctorState(
        last_run_at=now - timedelta(hours=2),
        last_exit_code=1,
        last_finding_count=3,
        last_error_count=2,
    )
    decision = doctor_state_module.decide_throttle(state, now=now)
    assert decision.skip is True
    assert decision.dirty is True
    assert decision.last_error_count == 2


def test_decide_throttle_dirty_uses_4h_window(doctor_state_module):
    now = datetime(2026, 5, 22, 12, 0, 0, tzinfo=UTC)
    state = doctor_state_module.DoctorState(
        last_run_at=now - timedelta(hours=5),
        last_exit_code=1,
        last_finding_count=1,
        last_error_count=1,
    )
    decision = doctor_state_module.decide_throttle(state, now=now)
    # 5h after a dirty run is past the 4h dirty window -- caller MUST
    # re-probe so a persistent-dirty install can be reconfirmed once
    # the cooldown lapses.
    assert decision.skip is False
    assert decision.dirty is True


# ---------------------------------------------------------------------------
# Integration tests -- cmd_doctor surface
# ---------------------------------------------------------------------------


def _seed_state(
    doctor_state_module,
    project_root: Path,
    *,
    last_error_count: int,
    age_hours: float,
    exit_code: int = 0,
    finding_count: int = 0,
) -> None:
    """Materialise a doctor-state.json file under ``project_root``."""
    when = datetime.now(UTC) - timedelta(hours=age_hours)
    persisted = doctor_state_module.write_state(
        project_root,
        exit_code=exit_code,
        finding_count=finding_count,
        error_count=last_error_count,
        now=when,
    )
    assert persisted is not None, "state-file write must succeed in tests"


@pytest.fixture
def doctor_project(tmp_path: Path) -> Path:
    """Minimal project root used to drive cmd_doctor in an isolated cwd."""
    (tmp_path / "vbrief").mkdir(parents=True, exist_ok=True)
    return tmp_path


@pytest.fixture
def doctor_env(
    monkeypatch: pytest.MonkeyPatch,
    deft_run_module,
    doctor_project: Path,
    doctor_state_module,
):
    """Pin cwd / state path / which() for a deterministic cmd_doctor run."""
    monkeypatch.chdir(doctor_project)
    monkeypatch.setenv(
        "DEFT_DOCTOR_STATE_PATH",
        str(doctor_project / "vbrief" / ".eval" / "doctor-state.json"),
    )
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    monkeypatch.setattr(
        deft_run_module.shutil,
        "which",
        _make_fake_which({"uv": True, "git": True, "task": True}),
    )
    # Skip the install-integrity + AGENTS.md freshness probes so the
    # throttle integration tests assert on the throttle path itself
    # rather than on a tmp-dir project's lack of an install manifest.
    monkeypatch.setattr(
        deft_run_module,
        "_run_install_integrity_checks",
        lambda *a, **kw: None,
        raising=False,
    )
    monkeypatch.setattr(
        deft_run_module,
        "_run_agents_md_freshness_check",
        lambda *a, **kw: None,
        raising=False,
    )
    return SimpleNamespace(project=doctor_project, state=doctor_state_module)


def test_cmd_doctor_skips_clean_within_window(
    run_command, doctor_env, doctor_state_module
):
    _seed_state(
        doctor_state_module,
        doctor_env.project,
        last_error_count=0,
        age_hours=1.0,
    )
    result = run_command("cmd_doctor", [])
    assert result.return_code == 0, (
        "clean-within-window must skip with exit 0; got "
        f"rc={result.return_code}\n{result.stdout}\n{result.stderr}"
    )
    assert "[doctor]" in result.stdout
    assert "clean" in result.stdout
    assert "--full" in result.stdout
    assert "Checking system dependencies" not in result.stdout


def test_cmd_doctor_dirty_skip_blocks_with_exit_one(
    run_command, doctor_env, doctor_state_module
):
    _seed_state(
        doctor_state_module,
        doctor_env.project,
        last_error_count=2,
        age_hours=1.0,
        exit_code=1,
        finding_count=3,
    )
    result = run_command("cmd_doctor", [])
    assert result.return_code == 1, (
        "dirty-within-window must exit non-zero so the session-start ritual "
        f"stays gated; got rc={result.return_code}\n{result.stdout}"
    )
    assert "[doctor]" in result.stdout
    assert "UNRESOLVED" in result.stdout
    assert "task doctor --full" in result.stdout


def test_cmd_doctor_full_bypass_runs_checks(
    run_command, doctor_env, doctor_state_module
):
    _seed_state(
        doctor_state_module,
        doctor_env.project,
        last_error_count=0,
        age_hours=1.0,
    )
    result = run_command("cmd_doctor", ["--full"])
    # --full bypasses the throttle; the doctor body always emits at
    # least one ✓ / ⚠ / ✗ check symbol once it runs.
    assert any(sym in result.stdout for sym in ("\u2713", "\u26a0", "\u2717"))
    assert "Checking system dependencies" in result.stdout


def test_cmd_doctor_json_skip_schema(
    run_command, doctor_env, doctor_state_module
):
    _seed_state(
        doctor_state_module,
        doctor_env.project,
        last_error_count=0,
        age_hours=1.0,
    )
    result = run_command("cmd_doctor", ["--json"])
    assert result.return_code == 0
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["status"] == "throttle-skipped"
    assert "last_run_at" in payload
    assert "next_eligible_at" in payload
    assert payload["last_error_count"] == 0
    assert payload["last_finding_count"] == 0


def test_cmd_doctor_json_dirty_skip_schema(
    run_command, doctor_env, doctor_state_module
):
    _seed_state(
        doctor_state_module,
        doctor_env.project,
        last_error_count=4,
        age_hours=1.0,
        exit_code=1,
        finding_count=5,
    )
    result = run_command("cmd_doctor", ["--json"])
    assert result.return_code == 1
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["status"] == "throttle-skipped"
    assert payload["last_error_count"] == 4
    assert payload["last_finding_count"] == 5
    assert "task doctor --full" in payload["hint"]


def test_cmd_doctor_full_run_persists_state(
    run_command, doctor_env, doctor_state_module
):
    # No seed state -- the gate falls through to a full run, which MUST
    # write a well-formed doctor-state.json so the next invocation can
    # short-circuit.
    state_path = doctor_state_module.state_path(doctor_env.project)
    assert not state_path.exists()
    result = run_command("cmd_doctor", ["--json"])
    assert result.return_code in (0, 1)
    assert state_path.is_file(), (
        "cmd_doctor must persist doctor-state.json after a full run"
    )
    saved = json.loads(state_path.read_text(encoding="utf-8"))
    assert "last_run_at" in saved
    assert "last_exit_code" in saved
    assert "last_finding_count" in saved
    assert "last_error_count" in saved


def test_cmd_doctor_json_completed_schema_carries_status(
    run_command, doctor_env, doctor_state_module
):
    result = run_command("cmd_doctor", ["--json", "--full"])
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    # Completed runs MUST report ``status: completed`` so consumers can
    # distinguish the throttle-skip envelope from a full report.
    assert payload["status"] == "completed"
    assert "findings" in payload
    assert "summary" in payload
    assert "errors" in payload["summary"]
    assert "warnings" in payload["summary"]


def test_cmd_doctor_corrupt_state_runs_full(
    run_command, doctor_env, doctor_state_module
):
    state_path = doctor_state_module.state_path(doctor_env.project)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text("not json", encoding="utf-8")
    result = run_command("cmd_doctor", [])
    # Corrupt-state fallback path is "treat as no-state"; full check runs
    # and emits the canonical header text.
    assert "Checking system dependencies" in result.stdout


# ---------------------------------------------------------------------------
# #1316 -- skip-severity findings must not inflate the persisted warning tally
# ---------------------------------------------------------------------------


def test_dirty_skip_status_line_excludes_skip_severity_from_warning_count(
    doctor_module, doctor_state_module, tmp_path
):
    """#1316: a ``severity == "skip"`` finding must NOT count as a warning.

    Reproduces the dirty throttle-skip off-by-one end-to-end: a full
    doctor run on a maintainer/consumer repo emits the AGENTS.md-freshness
    check's ``severity == "skip"`` finding alongside one real error and one
    real warning. ``_persist_doctor_state`` writes the state, the next
    invocation reads it back and renders the throttle-skip status line.

    Before the fix ``last_finding_count`` was ``len(findings) == 3``, so
    ``_render_doctor_status_line`` derived ``warns = 3 - 1 = 2`` and
    over-reported "2 warnings". After the fix the skip is excluded
    (``last_finding_count == 2``) and the line correctly reports
    "1 warning".
    """
    # The autouse `_isolate_doctor_state_path` fixture pins
    # DEFT_DOCTOR_STATE_PATH, so persist + read resolve to the same file
    # regardless of the project_root argument.
    findings = [
        {
            "severity": "error",
            "message": "Root Taskfile.yml missing",
            "check": "taskfile-include",
        },
        {
            "severity": "warning",
            "message": "Missing directory: tasks/",
            "check": "framework-layout",
        },
        {
            # Shaped exactly like _run_agents_md_freshness_check's skip
            # finding (the #1316 trigger).
            "severity": "skip",
            "message": "no managed-section markers (likely maintainer repo)",
            "check": "agents-md-managed-section-fresh",
            "status": "skip",
        },
    ]

    doctor_module._persist_doctor_state(tmp_path, exit_code=1, findings=findings)

    state = doctor_state_module.read_state(tmp_path)
    assert state is not None, "persisted doctor-state.json must be readable"
    # The skip is excluded -- only the error + warning "matter".
    assert state.last_finding_count == 2
    assert state.last_error_count == 1

    # A freshly persisted dirty state is within the 4h dirty window, so the
    # throttle decision is a dirty skip -> the status line renders the
    # warning tally as last_finding_count - last_error_count.
    decision = doctor_state_module.decide_throttle(state)
    assert decision.dirty is True
    assert decision.skip is True

    line = doctor_module._render_doctor_status_line(decision)
    assert "1 error / 1 warning --" in line, line
    assert "2 warning" not in line, line
