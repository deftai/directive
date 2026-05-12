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
    "<!-- deft:managed-section v3 -->\n"
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
        # Managed section content lives in the file. The v3 marker carries
        # per-refresh provenance attributes (#1046 PR-B AC-5) so match the
        # opening tag with a regex rather than a literal substring.
        import re as _re
        content = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")
        assert _re.search(
            r"<!--\s*deft:managed-section v3(?:\s+[^>]*)?\s*-->", content
        )
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
            "<!-- deft:managed-section v3 -->\n"
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
            "<!-- deft:managed-section v3 -->\n"
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
        import re as _re
        assert "Old hand-rolled v0.19 entry" in new
        assert "Custom rules from before the marker contract" in new
        # v3 marker carries per-refresh attributes (#1046 PR-B AC-5); accept
        # either the bare or attributed form via regex.
        marker_match = _re.search(
            r"<!--\s*deft:managed-section v3(?:\s+[^>]*)?\s*-->", new
        )
        assert marker_match is not None
        assert "<!-- /deft:managed-section -->" in new
        # Markers come AFTER the legacy content -> migration shape
        legacy_idx = new.index("Custom rules from before")
        assert legacy_idx < marker_match.start()

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
                "<!-- deft:managed-section v3 -->\nold\n<!-- /deft:managed-section -->\n",
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
            "<!-- deft:managed-section v3 -->\nold\n<!-- /deft:managed-section -->\n",
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


# ---------------------------------------------------------------------------
# Legacy v1/v2 marker upgrade + duplicate-block recovery (#1044)
# ---------------------------------------------------------------------------


_BARE_V1_OPEN = "<!-- deft:managed-section v1 -->"
_BARE_V2_OPEN = "<!-- deft:managed-section v2 -->"
_BARE_V3_OPEN = "<!-- deft:managed-section v3 -->"
_MARKER_CLOSE = "<!-- /deft:managed-section -->"


def _count_managed_blocks(text: str) -> int:
    """Return the count of managed-section blocks in ``text`` (#1044 helper)."""
    import re as _re
    return len(_re.findall(
        r"<!--\s*deft:managed-section\s+v[123](?:\s+[^>]*)?\s*-->", text
    ))


class TestLegacyMarkerUpgrade:
    """Legacy v1/v2 managed blocks are byte-replaced in place, never appended (#1044).

    Before #1044 a consumer's AGENTS.md whose managed section was
    bracketed by ``<!-- deft:managed-section v1 -->`` (the v0.26
    marker) fell through to the ``missing`` classification because
    the regex only matched v2/v3. The ``missing`` path triggered
    ``_wrap_legacy_in_markers`` which APPENDED a fresh v3 block --
    leaving the file with two managed blocks. The fix is to extend
    the open-marker regex to accept v1 as well so the classifier
    routes the file through ``stale`` (in-place byte-replace).
    """

    def test_v1_marker_only_replaces_in_place_at_original_position(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module)
        existing = (
            "# My consumer notes (preserved above)\n"
            "Custom rules.\n"
            "\n"
            f"{_BARE_V1_OPEN}\n"
            "# Old v0.26 body\n"
            "Old v1 content\n"
            f"{_MARKER_CLOSE}\n"
            "\n"
            "## Below the markers (preserved)\n"
        )
        (tmp_path / "AGENTS.md").write_text(existing, encoding="utf-8")

        result = run_command("cmd_agents_refresh", [])

        assert result.return_code == 0
        new = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")
        # Exactly one managed block remains -- no append.
        assert _count_managed_blocks(new) == 1
        # The remaining block is v3 (the v1 marker was upgraded).
        import re as _re
        marker_match = _re.search(
            r"<!--\s*deft:managed-section v3(?:\s+[^>]*)?\s*-->", new
        )
        assert marker_match is not None
        # No trace of the legacy v1 marker.
        assert _BARE_V1_OPEN not in new
        # Old v1 body bytes are replaced by the rendered template.
        assert "Old v1 content" not in new
        assert "# Deft\nBody" in new
        # Surrounding user content order is preserved -- consumer notes
        # above the original v1 block AND content below remain in
        # document order.
        notes_idx = new.index("My consumer notes (preserved above)")
        below_idx = new.index("Below the markers (preserved)")
        marker_idx = marker_match.start()
        assert notes_idx < marker_idx < below_idx

    def test_v1_marker_classified_as_stale(
        self, tmp_path, deft_run_module, monkeypatch
    ):
        """`_classify_agents_md` returns ``stale`` for v1-only AGENTS.md (#1044)."""
        _patch_template(monkeypatch, deft_run_module)
        legacy = f"{_BARE_V1_OPEN}\n# Deft\nBody\n{_MARKER_CLOSE}\n"
        (tmp_path / "AGENTS.md").write_text(legacy, encoding="utf-8")
        assert deft_run_module._classify_agents_md(tmp_path) == "stale"

    def test_v2_marker_only_replaces_in_place_at_original_position(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        """v2 markers also classify as stale and byte-replace in place (#1046 PR-B AC-5).

        Pinned alongside the v1 case so #1044's expanded regex does not
        accidentally break the existing v2 -> v3 transition.
        """
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module)
        existing = (
            "# preamble (preserved)\n"
            "\n"
            f"{_BARE_V2_OPEN}\n"
            "# Old v0.27 body\n"
            "Old v2 content\n"
            f"{_MARKER_CLOSE}\n"
            "\n"
            "## footer (preserved)\n"
        )
        (tmp_path / "AGENTS.md").write_text(existing, encoding="utf-8")

        result = run_command("cmd_agents_refresh", [])

        assert result.return_code == 0
        new = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")
        assert _count_managed_blocks(new) == 1
        assert _BARE_V2_OPEN not in new
        assert "Old v2 content" not in new
        assert "# Deft\nBody" in new
        # Surrounding user content order preserved.
        import re as _re
        marker_match = _re.search(
            r"<!--\s*deft:managed-section v3(?:\s+[^>]*)?\s*-->", new
        )
        assert marker_match is not None
        assert new.index("preamble (preserved)") < marker_match.start()
        assert marker_match.start() < new.index("footer (preserved)")

    def test_v1_plus_v3_duplicate_blocks_collapsed_to_single_v3(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        """A v1 leftover coexisting with a v3 block is removed; only v3 remains (#1044).

        Reproduces the broken state a pre-#1044 partial upgrade leaves
        behind: the legacy v1 block stays put AND a fresh v3 block was
        appended below it. After this fix, the refresh path detects
        multiple managed blocks, removes ALL of them, and inserts a
        single v3-attributed block at the position of the FIRST block
        so the file's surrounding user content order is preserved.
        """
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module)
        existing = (
            "# Top notes (preserved)\n"
            "\n"
            f"{_BARE_V1_OPEN}\n"
            "# Old v1 body\n"
            "Old v1 content\n"
            f"{_MARKER_CLOSE}\n"
            "\n"
            "# Middle notes (preserved)\n"
            "\n"
            f"{_BARE_V3_OPEN}\n"
            "# Deft\n"
            "Body\n"
            f"{_MARKER_CLOSE}\n"
            "\n"
            "# Bottom notes (preserved)\n"
        )
        (tmp_path / "AGENTS.md").write_text(existing, encoding="utf-8")

        result = run_command("cmd_agents_refresh", [])

        assert result.return_code == 0
        new = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")
        # Exactly one managed block remains -- the duplicate leftover
        # is gone.
        assert _count_managed_blocks(new) == 1
        # No legacy v1 marker survives.
        assert _BARE_V1_OPEN not in new
        assert "Old v1 content" not in new
        # The remaining block is v3 (bare or attributed).
        import re as _re
        marker_match = _re.search(
            r"<!--\s*deft:managed-section v3(?:\s+[^>]*)?\s*-->", new
        )
        assert marker_match is not None
        # Surrounding user content order preserved -- top, middle, and
        # bottom notes survive in document order, and the single v3
        # block sits where the FIRST (v1) block used to be (above the
        # middle notes).
        top_idx = new.index("Top notes (preserved)")
        middle_idx = new.index("Middle notes (preserved)")
        bottom_idx = new.index("Bottom notes (preserved)")
        marker_idx = marker_match.start()
        assert top_idx < marker_idx < middle_idx < bottom_idx

    def test_duplicate_block_classified_as_stale(
        self, tmp_path, deft_run_module, monkeypatch
    ):
        """`_classify_agents_md` returns ``stale`` when multiple managed blocks present (#1044)."""
        _patch_template(monkeypatch, deft_run_module)
        duplicate = (
            f"{_BARE_V1_OPEN}\nold\n{_MARKER_CLOSE}\n"
            f"\n{_BARE_V3_OPEN}\n# Deft\nBody\n{_MARKER_CLOSE}\n"
        )
        (tmp_path / "AGENTS.md").write_text(duplicate, encoding="utf-8")
        assert deft_run_module._classify_agents_md(tmp_path) == "stale"

    def test_v1_refresh_is_idempotent(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        """Running refresh twice from a v1-only baseline produces byte-identical output (#1044)."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module)
        (tmp_path / "AGENTS.md").write_text(
            f"preamble\n{_BARE_V1_OPEN}\nold\n{_MARKER_CLOSE}\n",
            encoding="utf-8",
        )

        run_command("cmd_agents_refresh", [])
        first = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")
        run_command("cmd_agents_refresh", [])
        second = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")

        assert first == second
        # And the file still carries exactly one managed block.
        assert _count_managed_blocks(second) == 1


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
