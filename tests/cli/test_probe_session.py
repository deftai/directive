"""Tests for scripts/probe_session.py -- mechanical probe handoff guard (#1518c).

Covers:
- Explicit interrogate vs complete state with target, branch, decisions
- Incomplete sessions block artifact and plan registration
- Complete sessions allow handoff guards to pass
- CLI surface (start, record, complete, guard-* exit codes)

New source + test per AGENTS.md requirement for scripts/*.py.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "probe_session.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("probe_session", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["probe_session"] = mod
    spec.loader.exec_module(mod)
    return mod


def _run_cli(*args: str, project_root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT_PATH), "--project-root", str(project_root), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )


def test_module_loads_and_exports_guard_surface():
    mod = _load_module()
    for name in (
        "read",
        "write",
        "start_session",
        "record_decision",
        "mark_complete",
        "guard_probe_artifact",
        "guard_plan_probe_registration",
        "ProbeHandoffBlockedError",
    ):
        assert hasattr(mod, name), f"missing export: {name}"


def test_start_session_records_interrogate_state(tmp_path: Path):
    mod = _load_module()
    fixed = datetime(2026, 6, 9, 12, 0, 0, tzinfo=UTC)
    session = mod.start_session(
        tmp_path,
        target="auth-probe",
        current_branch="session-store",
        now=fixed,
    )
    assert session.state == mod.STATE_INTERROGATE
    assert session.target == "auth-probe"
    assert session.current_branch == "session-store"
    assert session.resolved_decisions == ()
    assert session.completed_at is None

    reloaded = mod.read(tmp_path)
    assert reloaded == session


def test_record_decision_appends_resolved_decisions(tmp_path: Path):
    mod = _load_module()
    mod.start_session(tmp_path, target="auth-probe", current_branch="tokens")
    updated = mod.record_decision(
        tmp_path,
        question="Where is session state stored?",
        answer="Server-side Redis with TTL",
        status="locked",
    )
    assert len(updated.resolved_decisions) == 1
    assert updated.resolved_decisions[0].question.startswith("Where is session")
    assert updated.state == mod.STATE_INTERROGATE


def test_incomplete_session_blocks_artifact_and_plan_registration(tmp_path: Path):
    mod = _load_module()
    mod.start_session(tmp_path, target="auth-probe", current_branch="tokens")

    with pytest.raises(mod.ProbeHandoffBlockedError) as artifact_exc:
        mod.guard_probe_artifact(tmp_path, "vbrief/proposed/auth-probe.vbrief.json")
    assert "interrogate" in str(artifact_exc.value).lower()
    assert "complete" in str(artifact_exc.value).lower()

    with pytest.raises(mod.ProbeHandoffBlockedError) as plan_exc:
        mod.guard_plan_probe_registration(tmp_path)
    assert "completedStrategies.probe" in str(plan_exc.value)


def test_complete_session_allows_handoff_guards(tmp_path: Path):
    mod = _load_module()
    mod.start_session(tmp_path, target="auth-probe", current_branch="tokens")
    mod.record_decision(
        tmp_path,
        question="Failure mode?",
        answer="Return 503 with retry-after",
        status="risk-accepted",
    )
    mod.mark_complete(tmp_path)

    session = mod.guard_probe_artifact(tmp_path, "vbrief/proposed/auth-probe.vbrief.json")
    assert session.state == mod.STATE_COMPLETE
    assert session.target == "auth-probe"

    plan_session = mod.guard_plan_probe_registration(tmp_path)
    assert plan_session.state == mod.STATE_COMPLETE
    assert len(plan_session.resolved_decisions) == 1


def test_cli_guard_artifact_exits_nonzero_while_interrogating(tmp_path: Path):
    start = _run_cli("start", "--target", "auth-probe", "--branch", "tokens", project_root=tmp_path)
    assert start.returncode == 0

    blocked = _run_cli(
        "guard-artifact",
        "--path",
        "vbrief/proposed/auth-probe.vbrief.json",
        project_root=tmp_path,
    )
    assert blocked.returncode == 1
    assert "blocked" in blocked.stderr.lower()
    assert "interrogate" in blocked.stderr.lower()


def test_cli_complete_then_guard_artifact_passes(tmp_path: Path):
    assert _run_cli("start", "--target", "auth-probe", project_root=tmp_path).returncode == 0
    assert (
        _run_cli(
            "record",
            "--question",
            "Edge case?",
            "--answer",
            "Empty input rejected",
            "--status",
            "locked",
            project_root=tmp_path,
        ).returncode
        == 0
    )
    assert _run_cli("complete", project_root=tmp_path).returncode == 0

    allowed = _run_cli(
        "guard-artifact",
        "--path",
        "vbrief/proposed/auth-probe.vbrief.json",
        project_root=tmp_path,
    )
    assert allowed.returncode == 0
    assert "allowed" in allowed.stdout.lower()

    plan_allowed = _run_cli("guard-plan-registration", project_root=tmp_path)
    assert plan_allowed.returncode == 0


def test_cli_status_json_exposes_state_fields(tmp_path: Path):
    mod = _load_module()
    mod.start_session(tmp_path, target="billing-probe", current_branch="pricing")
    mod.record_decision(
        tmp_path,
        question="Currency?",
        answer="USD only for v1",
        status="deferred",
    )

    result = _run_cli("status", "--json", project_root=tmp_path)
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    assert payload["state"] == "interrogate"
    assert payload["target"] == "billing-probe"
    assert payload["currentBranch"] == "pricing"
    assert len(payload["resolvedDecisions"]) == 1
    assert payload["resolvedDecisions"][0]["status"] == "deferred"
