"""
test_strategy_outputs.py — Content tests for vBRIEF-centric strategy outputs.

Verifies that rapid, bdd, and discuss strategies reference vBRIEF artifacts
as their primary outputs instead of hand-authored markdown files.

Issues: #363 (rapid), #365 (bdd), #366 (discuss)

Author: Agent — 2026-04-14
"""

from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Module-level constants
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def _read(relpath: str) -> str:
    return (_REPO_ROOT / relpath).read_text(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# rapid.md — issue #363
# ---------------------------------------------------------------------------

class TestRapidVbriefOutput:
    """rapid.md must reference vbrief/specification.vbrief.json and task spec:render."""

    _text = _read("strategies/rapid.md")

    def test_references_specification_vbrief_json(self) -> None:
        assert "vbrief/specification.vbrief.json" in self._text, (
            "strategies/rapid.md must reference vbrief/specification.vbrief.json"
        )

    def test_references_task_spec_render(self) -> None:
        assert "task spec:render" in self._text, (
            "strategies/rapid.md must reference 'task spec:render' for rendering SPECIFICATION.md"
        )

    def test_specification_md_not_direct_output(self) -> None:
        """SPECIFICATION.md should appear only as a rendered export, not as the primary artifact."""
        output_section = self._text.split("## Output Artifacts")[1].split("##")[0]
        # The primary artifact line should be vbrief, not SPECIFICATION.md
        lines = output_section.strip().splitlines()
        first_artifact_line = next(
            (ln for ln in lines if ln.strip().startswith("- ")), ""
        )
        assert "vbrief/specification.vbrief.json" in first_artifact_line, (
            "The first output artifact in rapid.md must be vbrief/specification.vbrief.json, "
            "not SPECIFICATION.md"
        )


# ---------------------------------------------------------------------------
# bdd.md — issue #365
# ---------------------------------------------------------------------------

class TestBddVbriefOutput:
    """bdd.md must reference vbrief/proposed/ and not specs/ as output."""

    _text = _read("strategies/bdd.md")

    def test_references_vbrief_proposed(self) -> None:
        assert "vbrief/proposed/" in self._text, (
            "strategies/bdd.md must reference vbrief/proposed/ for BDD output"
        )

    def test_no_specs_folder_as_output(self) -> None:
        """specs/ folder must not appear as a BDD output target."""
        output_section = self._text.split("## Output Artifacts")[1].split("##")[0]
        assert "specs/" not in output_section, (
            "strategies/bdd.md Output Artifacts must not reference specs/ folder"
        )

    def test_contains_locked_decisions_narrative(self) -> None:
        assert "LockedDecisions" in self._text, (
            "strategies/bdd.md must reference LockedDecisions narrative"
        )

    def test_no_bdd_context_md_as_primary_output(self) -> None:
        """bdd-context.md should not appear as a primary output artifact."""
        output_section = self._text.split("## Output Artifacts")[1].split("##")[0]
        assert "bdd-context.md" not in output_section, (
            "strategies/bdd.md Output Artifacts must not reference "
            "{feature}-bdd-context.md as a primary artifact"
        )

    def test_scenarios_narrative(self) -> None:
        assert "Scenarios" in self._text, (
            "strategies/bdd.md must reference Scenarios narrative in vBRIEF"
        )


# ---------------------------------------------------------------------------
# discuss.md — issue #366
# ---------------------------------------------------------------------------

class TestDiscussVbriefOutput:
    """discuss.md must reference vbrief/proposed/ and not {scope}-context.md as output."""

    _text = _read("strategies/discuss.md")

    def test_references_vbrief_proposed(self) -> None:
        assert "vbrief/proposed/" in self._text, (
            "strategies/discuss.md must reference vbrief/proposed/ for discuss output"
        )

    def test_no_context_md_as_primary_output(self) -> None:
        """Output section must not reference {scope}-context.md as primary artifact."""
        output_section = self._text.split("## Output")[1].split("##")[0]
        assert "context.md" not in output_section.replace("context.vbrief.json", ""), (
            "strategies/discuss.md Output must not reference "
            "{scope}-context.md as a primary artifact"
        )

    def test_locked_decisions_narrative(self) -> None:
        assert "LockedDecisions" in self._text, (
            "strategies/discuss.md must reference LockedDecisions narrative"
        )

    def test_vbrief_persist_is_must(self) -> None:
        """The 'persist decisions as vBRIEF narratives' rule must be ! (MUST), not ~ (SHOULD)."""
        # Find the line about persisting as vBRIEF narratives
        for line in self._text.splitlines():
            if "Persist decisions as vBRIEF narratives" in line:
                assert line.strip().startswith("- !"), (
                    "strategies/discuss.md: 'Persist decisions as vBRIEF narratives' "
                    "must be a ! (MUST) rule, not ~ (SHOULD)"
                )
                return
        pytest.fail(
            "strategies/discuss.md must contain a 'Persist decisions as vBRIEF narratives' rule"
        )
