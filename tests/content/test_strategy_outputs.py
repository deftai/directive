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
    """rapid.md must reference v0.20 date-prefixed proposed/ vBRIEFs,
    PROJECT-DEFINITION, contract, and never legacy specification.vbrief.json (s5 migration)."""

    _text = _read("strategies/rapid.md")

    def test_v020_note_and_contract_citation(self) -> None:
        assert "v0.20 note (s5-migrate-speckit-rapid-enterprise / #1166)" in self._text
        assert "strategies/v0-20-contract.md" in self._text, (
            "rapid.md must cite the canonical v0.20 contract"
        )

    def test_references_proposed_date_prefixed_vbrief(self) -> None:
        assert "vbrief/proposed/YYYY-MM-DD-" in self._text, (
            "rapid.md must reference date-prefixed vBRIEFs in proposed/ per v0.20 contract"
        )

    def test_references_project_definition_and_task_project_render(self) -> None:
        assert "vbrief/PROJECT-DEFINITION.vbrief.json" in self._text
        assert "task project:render" in self._text, (
            "rapid.md must reference task project:render for PROJECT-DEFINITION (v0.20)"
        )

    def test_no_legacy_specification_vbrief(self) -> None:
        """Must not instruct or list legacy specification.vbrief.json as primary output
        (anti-pattern mention of the prohibition is allowed and expected)."""
        # Main output sections must not promote legacy; anti-patterns documents the rule.
        anti = self._text.split("## Anti-Patterns")[1] if "## Anti-Patterns" in self._text else ""
        pre = self._text.split("## Anti-Patterns")[0] if "## Anti-Patterns" in self._text else self._text  # noqa: E501 (temporary for release)
        assert "vbrief/specification.vbrief.json" not in pre, (
            "rapid.md pre-anti sections must not reference legacy specification.vbrief.json"
        )
        # Anti-patterns correctly calls out the prohibition.
        has_good = (
            "specification artifact" in anti
            or "legacy" in anti.lower()
            or "v0.20 contract" in anti
        )
        assert has_good

    def test_v020_output_shape_section_and_artifacts(self) -> None:
        assert "## v0.20 Output Shape (s5-migrate-speckit-rapid-enterprise / #1166)" in self._text
        assert "## Artifacts Summary (v0.20)" in self._text
        assert "proposed/YYYY-MM-DD-*.vbrief.json" in self._text
        has_depr = (
            "deprecation-redirect" in self._text.lower()
            or "deprecated-redirect" in self._text.lower()
        )
        assert has_depr

    def test_follows_artifact_guards_and_gates(self) -> None:
        assert "artifact-guards.md" in self._text
        assert "Preparatory Guard" in self._text or "Spec-Generating Guard" in self._text

    def test_step1_writes_to_proposed_vbrief_not_spec(self) -> None:
        """Step 1 must instruct date-prefixed proposed/ vBRIEF, not legacy spec."""
        step1_section = self._text.split("### Step 1:")[1].split("### Step 2:")[0]
        assert "vbrief/proposed/YYYY-MM-DD-" in step1_section
        assert "specification.vbrief.json" not in step1_section


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

    def test_no_legacy_context_md_as_primary_output(self) -> None:
        """Output section must not reference legacy {scope}-context.md
        (vBRIEF is v0.20 primary; this guards absence of legacy .md form)."""
        output_section = self._text.split("## Output")[1].split("##")[0]
        assert "context.md" not in output_section.replace("context.vbrief.json", ""), (
            "strategies/discuss.md must not reference legacy context.md "
            "(vBRIEF form allowed/required)"
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


# ---------------------------------------------------------------------------
# interview.md — v0.20 migration (s4 from #1166)
# ---------------------------------------------------------------------------

class TestInterviewV020Output:
    """interview.md (light + full) must follow v0.20 contract: date-prefixed
    scope vBRIEFs in proposed/, task project:render for PROJECT-DEFINITION,
    no primary write of legacy specification.vbrief.json.
    """

    _text = _read("strategies/interview.md")

    def test_references_date_prefixed_proposed_vbrief(self) -> None:
        assert (
            "YYYY-MM-DD-<slug>.vbrief.json" in self._text
            or "vbrief/proposed/YYYY-MM-DD" in self._text
        ), "interview.md must document date-prefixed vBRIEF filenames in proposed/"
        assert "date-prefixed" in self._text.lower() or "date prefix" in self._text.lower(), (
            "interview.md must mention date prefix convention for scope vBRIEFs"
        )

    def test_references_task_project_render(self) -> None:
        msg = "interview.md must reference 'task project:render' at correct point in flows"
        assert "task project:render" in self._text, msg

    def test_references_project_definition_vbrief(self) -> None:
        msg = "interview.md must reference PROJECT-DEFINITION.vbrief.json via project:render"
        assert "PROJECT-DEFINITION.vbrief.json" in self._text, msg

    def test_no_primary_write_of_specification_vbrief(self) -> None:
        """Must not instruct writing specification.vbrief.json as primary step."""
        assert "Write `./vbrief/specification.vbrief.json`" not in self._text, (
            "no Write specification.vbrief (use scope vBRIEFs for v0.20)"
        )
        assert "Write scope vBRIEF" in self._text, (
            "must contain v0.20 scope vBRIEF write instruction"
        )

    def test_artifacts_table_mentions_v0_20_and_legacy(self) -> None:
        assert "v0.20 contract" in self._text or "Legacy artifact" in self._text, (
            "Artifacts Summary must document v0.20 shape + legacy note"
        )
