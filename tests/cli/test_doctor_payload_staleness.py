"""tests/cli/test_doctor_payload_staleness.py -- payload-staleness remediation (#1409 / #2003).

`_run_payload_staleness_check` (scripts/doctor.py) is the deterministic surface
the installer -> doctor handoff (#1339) uses to tell a consumer their framework
payload is behind the remote. Post-freeze (#2003) the remediation is the npm
canonical upgrade command, not the Go bridge installer.
"""

from __future__ import annotations

from pathlib import Path

CANONICAL_NPM_UPGRADE = "npm i -g @deftai/directive@latest"


def _seed_manifest(project_root: Path, *, sha: str, ref: str = "master") -> None:
    deft_core = project_root / ".deft" / "core"
    deft_core.mkdir(parents=True, exist_ok=True)
    (deft_core / "VERSION").write_text(
        f"sha: {sha}\nref: {ref}\ntag: v0.38.0\n",
        encoding="utf-8",
    )


def _force_manifest_fallback(doctor_module, tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        doctor_module, "get_script_dir", lambda: tmp_path / "no-such-scripts"
    )


class _FakeProc:
    def __init__(self, stdout: str, returncode: int = 0) -> None:
        self.stdout = stdout
        self.returncode = returncode


def _collect(doctor_module, project_root: Path):
    warnings: list[str] = []
    infos: list[str] = []
    findings: list[dict] = []

    def _add_finding(severity: str, message: str, **extras: object) -> None:
        entry: dict[str, object] = {"severity": severity, "message": message}
        entry.update(extras)
        findings.append(entry)

    doctor_module._run_payload_staleness_check(
        project_root,
        emit_warn=warnings.append,
        emit_info=infos.append,
        add_finding=_add_finding,
    )
    return warnings, infos, findings


def test_stale_payload_emits_canonical_npm_command(
    doctor_module, tmp_path, monkeypatch
):
    project_root = tmp_path
    _seed_manifest(project_root, sha="1" * 40)
    _force_manifest_fallback(doctor_module, tmp_path, monkeypatch)
    monkeypatch.setattr(
        doctor_module.subprocess,
        "run",
        lambda *a, **k: _FakeProc("2" * 40 + "\trefs/heads/master\n"),
    )

    warnings, _infos, findings = _collect(doctor_module, project_root)

    stale = [f for f in findings if f.get("status") == "stale"]
    assert stale, f"expected a stale finding; got findings={findings}"
    finding = stale[0]
    assert CANONICAL_NPM_UPGRADE in finding["message"]
    assert finding.get("suggestion") == CANONICAL_NPM_UPGRADE
    assert any(CANONICAL_NPM_UPGRADE in w for w in warnings)


def test_current_payload_emits_no_command(doctor_module, tmp_path, monkeypatch):
    project_root = tmp_path
    _seed_manifest(project_root, sha="a" * 40)
    _force_manifest_fallback(doctor_module, tmp_path, monkeypatch)
    monkeypatch.setattr(
        doctor_module.subprocess,
        "run",
        lambda *a, **k: _FakeProc("a" * 40 + "\trefs/heads/master\n"),
    )

    warnings, _infos, findings = _collect(doctor_module, project_root)

    assert not [f for f in findings if f.get("status") == "stale"]
    assert not any(CANONICAL_NPM_UPGRADE in w for w in warnings)


def test_npm_fallback_when_ls_remote_empty(doctor_module, tmp_path, monkeypatch):
    project_root = tmp_path
    _seed_manifest(project_root, sha="1" * 40, ref="v0.56.0")
    _force_manifest_fallback(doctor_module, tmp_path, monkeypatch)
    monkeypatch.setattr(
        doctor_module.subprocess,
        "run",
        lambda *a, **k: _FakeProc(""),
    )
    monkeypatch.setattr(
        doctor_module, "_npm_view_version", lambda: (True, "0.56.2")
    )

    _warnings, _infos, findings = _collect(doctor_module, project_root)

    stale = [f for f in findings if f.get("status") == "stale"]
    assert stale
    assert stale[0].get("resolver") == "npm-view"
    assert stale[0].get("suggestion") == CANONICAL_NPM_UPGRADE
