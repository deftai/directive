"""tests/cli/test_doctor_upgrade_command_contract.py -- doctor vs AGENTS.md (#2003)."""

from __future__ import annotations

from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_AGENTS_ENTRY = _REPO_ROOT / "content/templates/agents-entry.md"
_CANONICAL_NPM_UPGRADE = "npm i -g @deftai/directive@latest"


def test_doctor_module_emits_agents_entry_upgrade_command(doctor_module) -> None:
    assert doctor_module.CANONICAL_UPGRADE_COMMAND == _CANONICAL_NPM_UPGRADE
    agents_entry = _AGENTS_ENTRY.read_text(encoding="utf-8")
    assert _CANONICAL_NPM_UPGRADE in agents_entry, (
        "agents-entry.md MUST document the same canonical upgrade command "
        "the doctor emits (#2003)."
    )


def test_payload_staleness_stale_finding_uses_npm_command(
    doctor_module, tmp_path, monkeypatch
):
    """Stale payload surfaces npm upgrade in message + suggestion (#2003)."""
    deft_core = tmp_path / ".deft" / "core"
    deft_core.mkdir(parents=True)
    (deft_core / "VERSION").write_text(
        f"sha: {'1' * 40}\nref: master\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        doctor_module, "get_script_dir", lambda: tmp_path / "no-scripts"
    )

    class _FakeProc:
        stdout = f"{'2' * 40}\trefs/heads/master\n"
        returncode = 0

    monkeypatch.setattr(
        doctor_module.subprocess, "run", lambda *a, **k: _FakeProc()
    )

    warnings: list[str] = []
    findings: list[dict] = []

    doctor_module._run_payload_staleness_check(
        tmp_path,
        emit_warn=warnings.append,
        emit_info=lambda _m: None,
        add_finding=lambda severity, message, **extras: findings.append(
            {"severity": severity, "message": message, **extras}
        ),
    )

    stale = [f for f in findings if f.get("status") == "stale"]
    assert stale, findings
    assert _CANONICAL_NPM_UPGRADE in stale[0]["message"]
    assert stale[0].get("suggestion") == _CANONICAL_NPM_UPGRADE


def test_payload_staleness_unverified_surfaces_warning_not_silent_green(
    doctor_module, tmp_path, monkeypatch
):
    """When currency cannot be verified, emit a warning advisory (#2004)."""
    deft_core = tmp_path / ".deft" / "core"
    deft_core.mkdir(parents=True)
    (deft_core / "VERSION").write_text(
        f"sha: {'3' * 40}\nref: v0.56.0\ntag: v0.56.0\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        doctor_module, "get_script_dir", lambda: tmp_path / "no-scripts"
    )
    monkeypatch.setattr(
        doctor_module, "_npm_view_version", lambda: (False, "")
    )

    class _FailProc:
        stdout = ""
        returncode = 1

    monkeypatch.setattr(
        doctor_module.subprocess, "run", lambda *a, **k: _FailProc()
    )

    warnings: list[str] = []
    findings: list[dict] = []

    doctor_module._run_payload_staleness_check(
        tmp_path,
        emit_warn=warnings.append,
        emit_info=lambda _m: None,
        add_finding=lambda severity, message, **extras: findings.append(
            {"severity": severity, "message": message, **extras}
        ),
    )

    unverified = [f for f in findings if f.get("status") == "unverified"]
    assert unverified, findings
    assert unverified[0]["severity"] == "warning"
    assert "UNVERIFIED" in unverified[0]["message"]
    assert any("UNVERIFIED" in w for w in warnings)
