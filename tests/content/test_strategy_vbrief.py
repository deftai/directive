"""
test_strategy_vbrief.py -- Content tests for vBRIEF-centric strategy outputs.

Verifies that speckit.md and enterprise.md reference vBRIEF artifacts
(specification.vbrief.json, PROJECT-DEFINITION.vbrief.json) and render
commands (task spec:render, task prd:render) instead of hand-authored
markdown files.

Covers: #361, #362, #364

Author: agent:deft-directive-swarm -- 2026-04-14
"""

from pathlib import Path

# ---------------------------------------------------------------------------
# Module-level constants
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read(relpath: str) -> str:
    return (_REPO_ROOT / relpath).read_text(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# speckit.md -- vBRIEF-centric outputs (#361, #362)
# ---------------------------------------------------------------------------

class TestSpeckitVbriefOutputs:
    """speckit.md must reference vBRIEF artifacts, not hand-authored files."""

    _text = _read("strategies/speckit.md")

    def test_speckit_references_project_definition_vbrief(self) -> None:
        """Phase 1 must target PROJECT-DEFINITION.vbrief.json (#361)."""
        assert "PROJECT-DEFINITION.vbrief.json" in self._text, (
            "strategies/speckit.md must reference PROJECT-DEFINITION.vbrief.json "
            "for Phase 1 Principles output"
        )

    def test_speckit_references_specification_vbrief(self) -> None:
        """Phase 2/3 must target specification.vbrief.json (#362)."""
        assert "specification.vbrief.json" in self._text, (
            "strategies/speckit.md must reference specification.vbrief.json "
            "for Phase 2/3 outputs"
        )

    def test_speckit_no_specs_output_directory(self) -> None:
        """speckit must NOT reference specs/ as an output directory (#362)."""
        # Check for specs/ used as output paths -- patterns like
        # specs/[feature], specs/{feature}, or `specs/` directory references.
        # The word "specs" may appear in other contexts (e.g. "specifications"),
        # so we specifically check for the directory path pattern.
        assert "specs/[feature]" not in self._text, (
            "strategies/speckit.md must not reference specs/[feature] as an "
            "output path -- use vbrief/specification.vbrief.json instead"
        )
        assert "specs/{feature}" not in self._text, (
            "strategies/speckit.md must not reference specs/{feature} as an "
            "output path -- use vbrief/specification.vbrief.json instead"
        )

    def test_speckit_references_spec_render(self) -> None:
        """Phase 3 must instruct running task spec:render (#362)."""
        assert "task spec:render" in self._text, (
            "strategies/speckit.md must reference 'task spec:render' to "
            "produce SPECIFICATION.md as a rendered export"
        )


# ---------------------------------------------------------------------------
# enterprise.md -- vBRIEF-centric outputs (#364)
# ---------------------------------------------------------------------------

class TestEnterpriseVbriefOutputs:
    """enterprise.md must reference vBRIEF artifacts and render commands."""

    _text = _read("strategies/enterprise.md")

    def test_enterprise_references_prd_render(self) -> None:
        """Stage 1 must reference task prd:render (#364)."""
        assert "task prd:render" in self._text, (
            "strategies/enterprise.md must reference 'task prd:render' to "
            "produce PRD.md as a rendered export"
        )

    def test_enterprise_references_spec_render(self) -> None:
        """Stage 3 must reference task spec:render (#364)."""
        assert "task spec:render" in self._text, (
            "strategies/enterprise.md must reference 'task spec:render' to "
            "produce SPECIFICATION.md as a rendered export"
        )

    def test_enterprise_references_specification_vbrief(self) -> None:
        """enterprise.md must reference specification.vbrief.json (#364)."""
        assert "specification.vbrief.json" in self._text, (
            "strategies/enterprise.md must reference "
            "vbrief/specification.vbrief.json as the source of truth"
        )

    def test_enterprise_preserves_approval_gates(self) -> None:
        """Approval gates must be preserved (#364)."""
        assert "Gate 1: PRD Approval" in self._text, (
            "strategies/enterprise.md must preserve Gate 1: PRD Approval"
        )
        assert "Gate 2: ADR Approval" in self._text, (
            "strategies/enterprise.md must preserve Gate 2: ADR Approval"
        )
        assert "Gate 3: Specification Approval" in self._text, (
            "strategies/enterprise.md must preserve Gate 3: Specification Approval"
        )

    def test_enterprise_adrs_unaffected(self) -> None:
        """ADRs in docs/adr/ must remain unaffected (#364)."""
        assert "docs/adr/" in self._text, (
            "strategies/enterprise.md must still reference docs/adr/ for ADRs"
        )
