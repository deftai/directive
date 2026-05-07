"""tests/cli/test_cmd_gate.py -- Tests for #768 universal upgrade gate.

Covers:
- cmd_gate emits OK v<version> when no upgrade work needed; exit 0
- cmd_gate emits NEEDS-UPGRADE for each agents-md axis
  (current / stale / missing / absent) and recorded version drift
- pre-cutover legacy artifacts force NEEDS-UPGRADE
- --json variant emits structured payload with all axes
- gate is read-only (no marker writes, no AGENTS.md mutation)
- exit code is 0 for OK, non-zero for NEEDS-UPGRADE

Story: #768 (universal-upgrade-gate)
"""

from __future__ import annotations

import json

import pytest

# ---------------------------------------------------------------------------
# Fixtures: synthesise a deft-template directory the run script can read.
# ---------------------------------------------------------------------------


def _patch_template(monkeypatch, deft_run_module, template_text: str) -> None:
    """Override `_read_agents_template` so tests don't depend on the live framework checkout state.

    The default helper reads ``templates/agents-entry.md`` from
    ``get_script_dir()``; tests override it so we can inject precisely the
    bytes we want as the rendered managed-section.
    """
    monkeypatch.setattr(
        deft_run_module, "_read_agents_template", lambda: template_text
    )


_TEMPLATE_BODY = (
    "<!-- deft:managed-section v1 -->\n"
    "# Deft\n"
    "Body\n"
    "<!-- /deft:managed-section -->\n"
)


# ---------------------------------------------------------------------------
# OK path
# ---------------------------------------------------------------------------


class TestCmdGateOK:
    """`cmd_gate` returns 0 + emits `OK v<version>` when the project is clean."""

    def test_no_marker_no_legacy_no_agents_md_returns_ok(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module, _TEMPLATE_BODY)

        result = run_command("cmd_gate", [])

        assert result.return_code == 0
        assert f"OK v{deft_run_module.VERSION}" in result.stdout
        assert "NEEDS-UPGRADE" not in result.stdout

    def test_marker_matches_current_version_returns_ok(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module, _TEMPLATE_BODY)
        (tmp_path / "vbrief").mkdir()
        (tmp_path / "vbrief" / ".deft-version").write_text(
            deft_run_module.VERSION + "\n", encoding="utf-8"
        )
        # AGENTS.md current with managed section
        (tmp_path / "AGENTS.md").write_text(_TEMPLATE_BODY, encoding="utf-8")

        result = run_command("cmd_gate", [])

        assert result.return_code == 0
        assert f"OK v{deft_run_module.VERSION}" in result.stdout


# ---------------------------------------------------------------------------
# NEEDS-UPGRADE: agents-md= axis
# ---------------------------------------------------------------------------


class TestAgentsMdAxis:
    """All four `agents-md=` states are reflected in the output line."""

    def test_agents_md_stale_marker_recorded(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module, _TEMPLATE_BODY)
        (tmp_path / "vbrief").mkdir()
        (tmp_path / "vbrief" / ".deft-version").write_text(
            deft_run_module.VERSION + "\n", encoding="utf-8"
        )
        # Markers present but body differs from template -> stale
        stale = (
            "<!-- deft:managed-section v1 -->\n"
            "# Old body\n"
            "<!-- /deft:managed-section -->\n"
        )
        (tmp_path / "AGENTS.md").write_text(stale, encoding="utf-8")

        result = run_command("cmd_gate", [])

        assert result.return_code == 1
        assert "NEEDS-UPGRADE" in result.stdout
        assert "agents-md=stale" in result.stdout

    def test_agents_md_missing_no_markers(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module, _TEMPLATE_BODY)
        (tmp_path / "AGENTS.md").write_text(
            "# Hand-rolled v0.19 entry\nNo markers here\n", encoding="utf-8"
        )

        result = run_command("cmd_gate", [])

        assert result.return_code == 1
        assert "NEEDS-UPGRADE" in result.stdout
        assert "agents-md=missing" in result.stdout

    def test_agents_md_absent_with_marker(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        """When ./AGENTS.md is absent but a marker exists at the current version, the gate stays OK
        because absent-without-other-signals is indistinguishable from "not a deft project"."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module, _TEMPLATE_BODY)
        (tmp_path / "vbrief").mkdir()
        (tmp_path / "vbrief" / ".deft-version").write_text(
            deft_run_module.VERSION + "\n", encoding="utf-8"
        )

        result = run_command("cmd_gate", [])

        assert result.return_code == 0
        assert "OK v" in result.stdout

    def test_agents_md_current_returns_ok(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module, _TEMPLATE_BODY)
        (tmp_path / "AGENTS.md").write_text(_TEMPLATE_BODY, encoding="utf-8")

        result = run_command("cmd_gate", [])

        assert result.return_code == 0
        assert "OK v" in result.stdout


# ---------------------------------------------------------------------------
# Version drift
# ---------------------------------------------------------------------------


class TestVersionDrift:
    """`recorded != current` triggers NEEDS-UPGRADE with `recorded=<value>`."""

    def test_version_drift_triggers_needs_upgrade(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module, _TEMPLATE_BODY)
        (tmp_path / "vbrief").mkdir()
        (tmp_path / "vbrief" / ".deft-version").write_text("0.5.0\n", encoding="utf-8")
        (tmp_path / "AGENTS.md").write_text(_TEMPLATE_BODY, encoding="utf-8")

        result = run_command("cmd_gate", [])

        assert result.return_code == 1
        assert "NEEDS-UPGRADE" in result.stdout
        assert "recorded=0.5.0" in result.stdout
        assert f"current={deft_run_module.VERSION}" in result.stdout

    def test_unknown_recorded_when_marker_missing(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        """No marker + legacy artifacts surface as `recorded=unknown`."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module, _TEMPLATE_BODY)
        (tmp_path / "SPECIFICATION.md").write_text(
            "# Real spec content\n", encoding="utf-8"
        )

        result = run_command("cmd_gate", [])

        assert result.return_code == 1
        assert "recorded=unknown" in result.stdout


# ---------------------------------------------------------------------------
# Pre-cutover combinations
# ---------------------------------------------------------------------------


class TestPreCutover:
    """Legacy SPECIFICATION.md / PROJECT.md without sentinel surface in CSV form."""

    def test_precutover_lists_specification(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module, _TEMPLATE_BODY)
        (tmp_path / "SPECIFICATION.md").write_text("# real content\n", encoding="utf-8")

        result = run_command("cmd_gate", [])

        assert result.return_code == 1
        assert "precutover=SPECIFICATION.md" in result.stdout

    def test_precutover_lists_both(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module, _TEMPLATE_BODY)
        (tmp_path / "SPECIFICATION.md").write_text("# real spec\n", encoding="utf-8")
        (tmp_path / "PROJECT.md").write_text("# real project\n", encoding="utf-8")

        result = run_command("cmd_gate", [])

        assert result.return_code == 1
        # Order is fixed by _detect_pre_cutover_legacy iteration order.
        assert "precutover=SPECIFICATION.md,PROJECT.md" in result.stdout

    def test_precutover_with_redirect_sentinel_does_not_fire(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module, _TEMPLATE_BODY)
        sentinel = deft_run_module.DEPRECATED_REDIRECT_SENTINEL
        (tmp_path / "SPECIFICATION.md").write_text(sentinel + "\n", encoding="utf-8")

        result = run_command("cmd_gate", [])

        assert result.return_code == 0


# ---------------------------------------------------------------------------
# --json variant
# ---------------------------------------------------------------------------


class TestJsonVariant:
    """`--json` emits the same axes as a single JSON object on stdout."""

    def test_json_ok_payload(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module, _TEMPLATE_BODY)

        result = run_command("cmd_gate", ["--json"])

        assert result.return_code == 0
        payload = json.loads(result.stdout.strip())
        assert payload["status"] == "ok"
        assert payload["current"] == deft_run_module.VERSION
        assert payload["recorded"] is None
        assert payload["precutover"] == []
        assert payload["agents-md"] == "absent"
        assert "inside_deft_repo" in payload

    def test_json_needs_upgrade_payload(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module, _TEMPLATE_BODY)
        (tmp_path / "vbrief").mkdir()
        (tmp_path / "vbrief" / ".deft-version").write_text("0.5.0\n", encoding="utf-8")
        (tmp_path / "SPECIFICATION.md").write_text("# real\n", encoding="utf-8")
        (tmp_path / "AGENTS.md").write_text(
            "# legacy without markers\n", encoding="utf-8"
        )

        result = run_command("cmd_gate", ["--json"])

        assert result.return_code == 1
        payload = json.loads(result.stdout.strip())
        assert payload["status"] == "needs-upgrade"
        assert payload["recorded"] == "0.5.0"
        assert payload["current"] == deft_run_module.VERSION
        assert payload["precutover"] == ["SPECIFICATION.md"]
        assert payload["agents-md"] == "missing"


# ---------------------------------------------------------------------------
# Read-only invariant
# ---------------------------------------------------------------------------


class TestReadOnlyInvariant:
    """`cmd_gate` MUST NOT write any markers or mutate AGENTS.md."""

    def test_no_marker_written_after_gate(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module, _TEMPLATE_BODY)
        (tmp_path / "SPECIFICATION.md").write_text("# real\n", encoding="utf-8")

        run_command("cmd_gate", [])

        assert not (tmp_path / "vbrief" / ".deft-version").exists()
        assert not (tmp_path / ".deft-version").exists()

    def test_agents_md_not_mutated_by_gate(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module, _TEMPLATE_BODY)
        original = "# Pre-existing AGENTS.md without markers\n"
        (tmp_path / "AGENTS.md").write_text(original, encoding="utf-8")

        run_command("cmd_gate", [])

        assert (tmp_path / "AGENTS.md").read_text(encoding="utf-8") == original


# ---------------------------------------------------------------------------
# Exit code contract
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "setup,expected_code",
    [
        ("clean", 0),
        ("legacy-only", 1),
        ("stale-agents-md", 1),
    ],
)
def test_exit_code_matrix(
    tmp_path, run_command, deft_run_module, monkeypatch, setup, expected_code
):
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    monkeypatch.chdir(tmp_path)
    _patch_template(monkeypatch, deft_run_module, _TEMPLATE_BODY)
    if setup == "legacy-only":
        (tmp_path / "PROJECT.md").write_text("# real\n", encoding="utf-8")
    elif setup == "stale-agents-md":
        (tmp_path / "vbrief").mkdir()
        (tmp_path / "vbrief" / ".deft-version").write_text(
            deft_run_module.VERSION + "\n", encoding="utf-8"
        )
        (tmp_path / "AGENTS.md").write_text(
            "<!-- deft:managed-section v1 -->\nold\n<!-- /deft:managed-section -->\n",
            encoding="utf-8",
        )

    result = run_command("cmd_gate", [])

    assert result.return_code == expected_code
