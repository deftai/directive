"""tests/cli/test_doctor_payload_staleness.py -- payload-staleness remediation (#1409).

`_run_payload_staleness_check` (scripts/doctor.py) is the deterministic surface
the installer -> doctor handoff (#1339) uses to tell a consumer their framework
payload is behind the remote. #1409 makes that remediation actionable by
emitting the EXACT canonical headless upgrade command -- so a normal consumer
following doctor guidance can copy-paste one line and end up with a fresh
payload + updated metadata, instead of the vague "re-run the installer" prose.

These tests pin the contract:
  * Stale state -> the warn message AND the structured `suggestion` finding
    BOTH carry the exact `deft-install --yes --upgrade --repo-root . --json`.
  * Current state (installed sha == remote sha) -> no stale finding, no command.

The check is exercised directly (rather than via `cmd_doctor`) so the test is
hermetic: it stubs `git ls-remote` via the module-level `subprocess` and points
the manifest probe at a tmp `.deft/core/VERSION` we control. Refs #1409, #1339.
"""

from __future__ import annotations

from pathlib import Path

# The exact canonical headless upgrade command #1409 standardises on. This
# literal MUST stay byte-identical to the string emitted by
# `scripts/doctor.py::_run_payload_staleness_check` and documented in
# README.md / UPGRADING.md / the deft-directive-sync skill / AGENTS.md.
CANONICAL_HEADLESS_UPGRADE = "deft-install --yes --upgrade --repo-root . --json"


def _seed_manifest(project_root: Path, *, sha: str, ref: str = "master") -> None:
    """Write a canonical `.deft/core/VERSION` manifest with sha + ref provenance."""
    deft_core = project_root / ".deft" / "core"
    deft_core.mkdir(parents=True, exist_ok=True)
    (deft_core / "VERSION").write_text(
        f"sha: {sha}\nref: {ref}\ntag: v0.38.0\n",
        encoding="utf-8",
    )


def _force_manifest_fallback(doctor_module, tmp_path: Path, monkeypatch) -> None:
    """Make the "manifest next to doctor.py" probe miss.

    `_run_payload_staleness_check` first looks for `<get_script_dir()>/../VERSION`
    (the installed layout). Point `get_script_dir` at a non-existent dir so the
    function falls back to the `project_root / .deft/core/VERSION` manifest the
    test controls.
    """
    monkeypatch.setattr(
        doctor_module, "get_script_dir", lambda: tmp_path / "no-such-scripts"
    )


class _FakeProc:
    """Minimal stand-in for `subprocess.run` output (returncode + stdout)."""

    def __init__(self, stdout: str, returncode: int = 0) -> None:
        self.stdout = stdout
        self.returncode = returncode


def _collect(doctor_module, project_root: Path):
    """Invoke the check, returning (warnings, infos, findings)."""
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


def test_stale_payload_emits_canonical_headless_command(
    doctor_module, tmp_path, monkeypatch
):
    """A stale payload surfaces the exact headless upgrade command (#1409)."""
    project_root = tmp_path
    _seed_manifest(project_root, sha="1" * 40)
    _force_manifest_fallback(doctor_module, tmp_path, monkeypatch)
    # git ls-remote returns a DIFFERENT remote sha -> stale.
    monkeypatch.setattr(
        doctor_module.subprocess,
        "run",
        lambda *a, **k: _FakeProc("2" * 40 + "\trefs/heads/master\n"),
    )

    warnings, _infos, findings = _collect(doctor_module, project_root)

    stale = [f for f in findings if f.get("status") == "stale"]
    assert stale, f"expected a stale finding; got findings={findings}"
    finding = stale[0]
    assert CANONICAL_HEADLESS_UPGRADE in finding["message"], (
        "stale remediation message MUST name the exact canonical headless "
        f"upgrade command. Got: {finding['message']!r}"
    )
    assert finding.get("suggestion") == CANONICAL_HEADLESS_UPGRADE, (
        "the structured `suggestion` finding MUST be the exact canonical "
        f"command so agents/CI can act on it. Got: {finding.get('suggestion')!r}"
    )
    assert any(CANONICAL_HEADLESS_UPGRADE in w for w in warnings), (
        "the human-facing warn line MUST also carry the exact command. "
        f"Warnings: {warnings!r}"
    )


def test_current_payload_emits_no_command(doctor_module, tmp_path, monkeypatch):
    """When installed sha == remote sha, no stale finding / command surfaces."""
    project_root = tmp_path
    _seed_manifest(project_root, sha="a" * 40)
    _force_manifest_fallback(doctor_module, tmp_path, monkeypatch)
    # Remote sha matches the installed sha -> current, not stale.
    monkeypatch.setattr(
        doctor_module.subprocess,
        "run",
        lambda *a, **k: _FakeProc("a" * 40 + "\trefs/heads/master\n"),
    )

    warnings, _infos, findings = _collect(doctor_module, project_root)

    assert not [f for f in findings if f.get("status") == "stale"], (
        "a current payload MUST NOT produce a stale finding."
    )
    assert not any(CANONICAL_HEADLESS_UPGRADE in w for w in warnings), (
        "a current payload MUST NOT recommend the headless upgrade command."
    )


def test_stale_message_notes_json_and_version_skew(
    doctor_module, tmp_path, monkeypatch
):
    """The remediation explains `--json` is optional and covers version skew (#1409)."""
    project_root = tmp_path
    _seed_manifest(project_root, sha="1" * 40)
    _force_manifest_fallback(doctor_module, tmp_path, monkeypatch)
    monkeypatch.setattr(
        doctor_module.subprocess,
        "run",
        lambda *a, **k: _FakeProc("3" * 40 + "\trefs/heads/master\n"),
    )

    _warnings, _infos, findings = _collect(doctor_module, project_root)

    stale = [f for f in findings if f.get("status") == "stale"]
    assert stale, f"expected a stale finding; got findings={findings}"
    message = stale[0]["message"]
    assert "--json" in message and "human-readable" in message, (
        "the remediation SHOULD note that `--json` can be dropped for "
        f"human-readable output. Got: {message!r}"
    )
    assert "GitHub Releases" in message, (
        "the remediation SHOULD cover the version-skew case (download the "
        f"latest deft-install binary first). Got: {message!r}"
    )
