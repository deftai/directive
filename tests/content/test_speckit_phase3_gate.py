"""test_speckit_phase3_gate.py -- Content tests for #432.

Verifies:
- strategies/speckit.md has a restructured Post-Phase 3 Transition Gate with
  numbered steps (replacing the old prose block).
- Phase 3 Transition Criteria include the SPECIFICATION.md hash-match rule.
- skills/deft-directive-setup/SKILL.md invokes task spec:render at the
  Phase 3 -> Phase 4 boundary.

Story: #432 (speckit Phase 3 -> 4 spec:render enforcement)
"""

from __future__ import annotations

from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]


def _read(relpath: str) -> str:
    return (_REPO_ROOT / relpath).read_text(encoding="utf-8", errors="replace")


class TestSpeckitPhase3TransitionGate:
    _text = _read("strategies/speckit.md")

    def test_post_phase_3_is_numbered_transition_gate(self) -> None:
        assert "### Post-Phase 3 Transition Gate" in self._text, (
            "Post-Phase 3 section must be restructured as a transition gate (#432)"
        )

    def test_gate_is_numbered_list_mirroring_phase2_approval(self) -> None:
        # A numbered list starting with `1. ! Run task spec:render`
        assert "1. ! Run `task spec:render`" in self._text, (
            "Transition gate must start with a numbered step invoking "
            "`task spec:render` (#432)"
        )
        assert "2. ! Confirm `SPECIFICATION.md` exists" in self._text, (
            "Step 2 must confirm SPECIFICATION.md exists (#432)"
        )

    def test_transition_criterion_references_specification_md(self) -> None:
        assert "Phase 3 -> Phase 4 transition criterion" in self._text, (
            "Phase 3 Transition Criteria must include the Phase 3 -> Phase 4 "
            "criterion (#432)"
        )
        assert "SPECIFICATION.md` exists AND its hash matches" in self._text, (
            "Transition criterion must require SPECIFICATION.md exists AND "
            "its hash matches vBRIEF narratives (#432)"
        )

    def test_gate_references_setup_skill_invocation(self) -> None:
        assert "deft-directive-setup/SKILL.md" in self._text, (
            "Phase 3 gate must reference the setup skill (which invokes "
            "task spec:render at the boundary) (#432)"
        )


class TestSetupSkillPhase3RenderBoundary:
    _text = _read("skills/deft-directive-setup/SKILL.md")

    def test_end_of_phase_3_export_prompt_exists(self) -> None:
        assert "End-of-Phase-3 Export Prompt" in self._text, (
            "Setup skill must have an End-of-Phase-3 Export Prompt section "
            "(#432, #433)"
        )

    def test_setup_invokes_task_spec_render_at_boundary(self) -> None:
        assert "task spec:render" in self._text, (
            "Setup skill must invoke `task spec:render` at the Phase 3 -> 4 "
            "boundary (#432)"
        )

    def test_setup_prompts_for_prd_and_spec(self) -> None:
        assert "Generate `SPECIFICATION.md` and/or `PRD.md` now" in self._text, (
            "Setup skill must prompt the user to generate SPECIFICATION.md "
            "and/or PRD.md (#433)"
        )

    def test_speckit_phase_4_gate_wiring(self) -> None:
        assert (
            "speckit Phase 3 \u2192 Phase 4" in self._text
            or "speckit Phase 3 -> Phase 4" in self._text
        ), (
            "Setup skill must explicitly reference the speckit Phase 3 -> "
            "Phase 4 boundary (#432)"
        )
