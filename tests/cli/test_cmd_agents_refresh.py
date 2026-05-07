"""tests/cli/test_cmd_agents_refresh.py -- Tests for #768 AGENTS.md contract.

Covers:
- Fresh write when AGENTS.md absent (state=absent)
- Marker round-trip (rewrite when stale; no-op when current)
- Legacy-to-marker migration (state=missing) preserves existing content above
- --check exit codes (0 only when current; non-zero for absent/stale/missing)
- --dry-run prints planned change without writing
- Idempotency: running twice produces byte-identical output

Story: #768 (universal-upgrade-gate)
"""

from __future__ import annotations

import pytest

_TEMPLATE_BODY = (
    "<!-- deft:managed-section v1 -->\n"
    "# Deft\n"
    "Body\n"
    "<!-- /deft:managed-section -->\n"
)


def _patch_template(monkeypatch, deft_run_module, template_text: str = _TEMPLATE_BODY):
    monkeypatch.setattr(
        deft_run_module, "_read_agents_template", lambda: template_text
    )


# ---------------------------------------------------------------------------
# Fresh write (absent -> create)
# ---------------------------------------------------------------------------


class TestFreshWrite:
    """`cmd_agents_refresh` creates AGENTS.md from the template when absent."""

    def test_creates_agents_md_when_absent(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module)

        result = run_command("cmd_agents_refresh", [])

        assert result.return_code == 0
        assert (tmp_path / "AGENTS.md").is_file()
        # Managed section content lives in the file
        content = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")
        assert "<!-- deft:managed-section v1 -->" in content
        assert "<!-- /deft:managed-section -->" in content


# ---------------------------------------------------------------------------
# Marker round-trip: stale -> rewritten; current -> no-op
# ---------------------------------------------------------------------------


class TestMarkerRoundTrip:
    """Stale managed section is byte-replaced; current state is a no-op."""

    def test_stale_section_rewritten_in_place(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module)
        # Existing content with stale managed section + user notes ABOVE.
        existing = (
            "# My consumer notes (preserved)\n"
            "Custom rules.\n"
            "\n"
            "<!-- deft:managed-section v1 -->\n"
            "# Old body\n"
            "Old content\n"
            "<!-- /deft:managed-section -->\n"
            "\n"
            "## Below the markers (preserved)\n"
        )
        (tmp_path / "AGENTS.md").write_text(existing, encoding="utf-8")

        result = run_command("cmd_agents_refresh", [])

        assert result.return_code == 0
        new = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")
        # User content above and below preserved
        assert "My consumer notes (preserved)" in new
        assert "Below the markers (preserved)" in new
        # Managed section is now the rendered template
        assert "# Deft\nBody" in new
        # Old body is gone
        assert "Old content" not in new

    def test_current_state_is_idempotent_noop(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module)
        (tmp_path / "AGENTS.md").write_text(_TEMPLATE_BODY, encoding="utf-8")
        before = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")

        result = run_command("cmd_agents_refresh", [])

        assert result.return_code == 0
        after = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")
        assert before == after

    def test_double_run_byte_stable(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        """Running refresh twice produces byte-identical output."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module)
        (tmp_path / "AGENTS.md").write_text(
            "preamble\n"
            "<!-- deft:managed-section v1 -->\n"
            "old\n"
            "<!-- /deft:managed-section -->\n",
            encoding="utf-8",
        )

        run_command("cmd_agents_refresh", [])
        first = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")
        run_command("cmd_agents_refresh", [])
        second = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")

        assert first == second


# ---------------------------------------------------------------------------
# Legacy-to-marker migration (missing -> wrap)
# ---------------------------------------------------------------------------


class TestLegacyMigration:
    """First-run migration wraps legacy AGENTS.md content above the new markers."""

    def test_legacy_content_preserved_above_managed_section(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module)
        legacy = (
            "# Old hand-rolled v0.19 entry\n"
            "Custom rules from before the marker contract.\n"
        )
        (tmp_path / "AGENTS.md").write_text(legacy, encoding="utf-8")

        result = run_command("cmd_agents_refresh", [])

        assert result.return_code == 0
        new = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")
        assert "Old hand-rolled v0.19 entry" in new
        assert "Custom rules from before the marker contract" in new
        assert "<!-- deft:managed-section v1 -->" in new
        assert "<!-- /deft:managed-section -->" in new
        # Markers come AFTER the legacy content -> migration shape
        legacy_idx = new.index("Custom rules from before")
        marker_idx = new.index("<!-- deft:managed-section v1 -->")
        assert legacy_idx < marker_idx

    def test_legacy_migration_then_refresh_is_idempotent(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module)
        (tmp_path / "AGENTS.md").write_text(
            "# Legacy content\n", encoding="utf-8"
        )

        run_command("cmd_agents_refresh", [])
        first = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")
        run_command("cmd_agents_refresh", [])
        second = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")

        assert first == second


# ---------------------------------------------------------------------------
# --check exit codes
# ---------------------------------------------------------------------------


class TestCheckMode:
    """`--check` exits 0 only when state is `current`; never writes."""

    def test_check_returns_zero_when_current(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module)
        (tmp_path / "AGENTS.md").write_text(_TEMPLATE_BODY, encoding="utf-8")

        result = run_command("cmd_agents_refresh", ["--check"])

        assert result.return_code == 0

    @pytest.mark.parametrize(
        "scenario",
        ["absent", "missing", "stale"],
    )
    def test_check_returns_nonzero_for_non_current_states(
        self, tmp_path, run_command, deft_run_module, monkeypatch, scenario
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module)
        if scenario == "missing":
            (tmp_path / "AGENTS.md").write_text("# legacy\n", encoding="utf-8")
        elif scenario == "stale":
            (tmp_path / "AGENTS.md").write_text(
                "<!-- deft:managed-section v1 -->\nold\n<!-- /deft:managed-section -->\n",
                encoding="utf-8",
            )
        # absent: no AGENTS.md written

        result = run_command("cmd_agents_refresh", ["--check"])

        assert result.return_code != 0
        # --check MUST NOT write
        if scenario == "absent":
            assert not (tmp_path / "AGENTS.md").exists()


# ---------------------------------------------------------------------------
# --dry-run output
# ---------------------------------------------------------------------------


class TestDryRun:
    """`--dry-run` prints the planned change without writing."""

    def test_dry_run_does_not_write(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module)

        result = run_command("cmd_agents_refresh", ["--dry-run"])

        assert result.return_code == 0
        assert not (tmp_path / "AGENTS.md").exists()
        assert "AGENTS.md state: absent" in result.stdout
        assert "Plan:" in result.stdout

    def test_dry_run_describes_stale_plan(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module)
        (tmp_path / "AGENTS.md").write_text(
            "<!-- deft:managed-section v1 -->\nold\n<!-- /deft:managed-section -->\n",
            encoding="utf-8",
        )
        before = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")

        result = run_command("cmd_agents_refresh", ["--dry-run"])

        assert result.return_code == 0
        assert "AGENTS.md state: stale" in result.stdout
        # File untouched
        assert (tmp_path / "AGENTS.md").read_text(encoding="utf-8") == before


# ---------------------------------------------------------------------------
# cmd_upgrade propagates cmd_agents_refresh failures (Greptile P1 #776)
# ---------------------------------------------------------------------------


class TestCmdUpgradePropagatesRefreshFailure:
    """`cmd_upgrade` MUST propagate `cmd_agents_refresh`'s return code.

    Greptile P1 review on PR #776 surfaced: when ``cmd_agents_refresh``
    fails (e.g. AGENTS.md not writable), ``cmd_upgrade`` was discarding
    the return value and exiting 0 -- the exact silent-partial-upgrade
    failure mode this PR aims to close. These regression tests pin both
    cmd_upgrade callsites so the bug cannot recur.
    """

    def test_already_at_current_version_propagates_refresh_failure(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        """`recorded == VERSION` branch propagates non-zero refresh."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        # Stub _read_agents_template to return None -> template-missing
        # state -> cmd_agents_refresh returns 1.
        monkeypatch.setattr(deft_run_module, "_read_agents_template", lambda: None)
        # Pre-write a current-version marker so cmd_upgrade takes the
        # "Project already at VERSION" early-return branch.
        (tmp_path / "vbrief").mkdir()
        (tmp_path / "vbrief" / ".deft-version").write_text(
            deft_run_module.VERSION + "\n", encoding="utf-8"
        )

        result = run_command("cmd_upgrade", [])

        # cmd_agents_refresh returned 1; cmd_upgrade MUST propagate it.
        assert result.return_code == 1

    def test_first_upgrade_propagates_refresh_failure(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        """First-upgrade branch (recorded != VERSION) propagates refresh failure."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        # Template missing -> cmd_agents_refresh returns 1.
        monkeypatch.setattr(deft_run_module, "_read_agents_template", lambda: None)
        # No marker -> takes the "first upgrade" branch that writes the
        # marker and then refreshes AGENTS.md.

        result = run_command("cmd_upgrade", [])

        assert result.return_code == 1

    def test_already_at_current_version_returns_zero_when_refresh_succeeds(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        """Happy path: refresh returns 0 -> cmd_upgrade returns 0."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module)
        (tmp_path / "vbrief").mkdir()
        (tmp_path / "vbrief" / ".deft-version").write_text(
            deft_run_module.VERSION + "\n", encoding="utf-8"
        )
        # AGENTS.md current with managed section -> refresh is a no-op (rc=0).
        (tmp_path / "AGENTS.md").write_text(_TEMPLATE_BODY, encoding="utf-8")

        result = run_command("cmd_upgrade", [])

        assert result.return_code == 0
