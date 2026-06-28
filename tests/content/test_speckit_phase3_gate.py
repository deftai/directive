"""test_speckit_phase3_gate.py -- Content tests for #432 / #2013 / #2050.

Verifies:
- strategies/speckit.md has a restructured Post-Phase 3 Transition Gate with
  numbered steps (replacing the old prose block).
- Phase 3 Transition Criteria include export-succeeded gate (#2013).
- skills/deft-directive-setup/SKILL.md invokes task project:export-spec at the
  Phase 3 -> Phase 4 boundary.

Story: #432 (speckit Phase 3 -> 4 spec export enforcement), #2050 (docs follow-up)
"""

from __future__ import annotations

from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]


def _read(relpath: str) -> str:
    return (_REPO_ROOT / relpath).read_text(encoding="utf-8", errors="replace")


class TestSpeckitPhase3TransitionGate:
    _text = _read("content/strategies/speckit.md")

    def test_post_phase_3_is_numbered_transition_gate(self) -> None:
        assert "### Post-Phase 3 Transition Gate" in self._text, (
            "Post-Phase 3 section must be restructured as a transition gate (#432)"
        )
        assert "Export for Review" in self._text, (
            "Post-Phase 3 gate must be renamed Export for Review (#2050)"
        )

    def test_gate_is_numbered_list_mirroring_phase2_approval(self) -> None:
        assert "task project:export-spec" in self._text, (
            "Transition gate must invoke task project:export-spec (#2050)"
        )
        assert "export **succeeded**" in self._text or "export succeeded" in self._text, (
            "Step 2 must gate on export succeeded (#2013, #2050)"
        )

    def test_transition_criterion_references_export_succeeded(self) -> None:
        assert "Phase 3 -> Phase 4 transition criterion" in self._text, (
            "Phase 3 Transition Criteria must include the Phase 3 -> Phase 4 "
            "criterion (#432)"
        )
        assert "task project:export-spec" in self._text, (
            "Transition criterion must reference project:export-spec (#2050)"
        )
        assert "without review of the v0.20 artifacts" in self._text, (
            "Transition must reference v0.20 artifacts + proposed/ + PROJECT-DEFINITION (s5)"
        )

    def test_gate_references_setup_skill_invocation(self) -> None:
        assert "deft-directive-setup/SKILL.md" in self._text, (
            "Phase 3 gate must reference the setup skill (which invokes "
            "task project:export-spec at the boundary) (#432, #2050)"
        )


class TestSetupSkillPhase3RenderBoundary:
    _text = _read("content/skills/deft-directive-setup/SKILL.md")

    def test_end_of_phase_3_export_prompt_exists(self) -> None:
        assert "End-of-Phase-3 Export Prompt" in self._text, (
            "Setup skill must have an End-of-Phase-3 Export Prompt section "
            "(#432, #433, #2050)"
        )

    def test_setup_invokes_task_project_export_spec_at_boundary(self) -> None:
        assert "task project:export-spec" in self._text, (
            "Setup skill must invoke `task project:export-spec` at the Phase 3 -> 4 "
            "boundary (#2050)"
        )

    def test_setup_prompts_for_prd_and_spec(self) -> None:
        assert "stakeholder-facing spec export" in self._text or (
            "SPECIFICATION.md" in self._text and "PRD.md" in self._text
        ), (
            "Setup skill must prompt the user to generate spec export "
            "and/or PRD.md (#433, #2050)"
        )

    def test_speckit_phase_4_gate_wiring(self) -> None:
        assert (
            "speckit Phase 3 \u2192 Phase 4" in self._text
            or "speckit Phase 3 -> Phase 4" in self._text
        ), (
            "Setup skill must explicitly reference the speckit Phase 3 -> "
            "Phase 4 boundary (#432)"
        )
        assert "export succeeded" in self._text, (
            "Setup skill must gate speckit on export succeeded (#2013, #2050)"
        )
