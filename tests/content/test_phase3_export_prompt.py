"""test_phase3_export_prompt.py -- Content tests for #433.

Verifies:
- strategies/speckit.md Artifacts Summary has both a 3b Render SPECIFICATION
  row AND a 3c Render PRD row so greenfield users see both export options.
- skills/deft-directive-setup/SKILL.md emits an end-of-Phase-3 export prompt
  asking whether to generate SPECIFICATION.md and/or PRD.md, with numbered
  options covering both / spec-only / PRD-only / skip.

Story: #433 (Greenfield PRD/SPECIFICATION export prompt)
"""

from __future__ import annotations

import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]


def _read(relpath: str) -> str:
    return (_REPO_ROOT / relpath).read_text(encoding="utf-8", errors="replace")


class TestSpeckitArtifactsSummary3c:
    _text = _read("strategies/speckit.md")

    def test_artifacts_summary_has_3b_spec_render(self) -> None:
        assert "3b. Render SPECIFICATION" in self._text, (
            "Artifacts Summary must retain the 3b. Render SPECIFICATION row (#433)"
        )

    def test_artifacts_summary_has_3c_prd_render(self) -> None:
        assert "3c. Render PRD" in self._text, (
            "Artifacts Summary must add a 3c. Render PRD row (#433)"
        )

    def test_3c_references_task_prd_render(self) -> None:
        # The 3c row must reference the task command so users can run it.
        assert "task prd:render" in self._text, (
            "Artifacts Summary 3c row must reference `task prd:render` (#433)"
        )


class TestSetupSkillExportPrompt:
    _text = _read("skills/deft-directive-setup/SKILL.md")

    def test_prompt_asks_for_prd_or_specification(self) -> None:
        assert re.search(
            r"Generate `SPECIFICATION\.md` and/or `PRD\.md`",
            self._text,
        ), (
            "Setup skill must include an end-of-Phase-3 prompt asking whether "
            "to generate SPECIFICATION.md and/or PRD.md (#433)"
        )

    def test_prompt_offers_four_numbered_choices(self) -> None:
        # The prompt enumerates 4 choices: both / spec-only / PRD-only / skip.
        assert "`SPECIFICATION.md` only" in self._text, (
            "Export prompt must offer a SPECIFICATION.md-only option (#433)"
        )
        assert "`PRD.md` only" in self._text, (
            "Export prompt must offer a PRD.md-only option (#433)"
        )

    def test_prompt_recommends_stakeholder_review(self) -> None:
        assert "stakeholder review" in self._text, (
            "Export prompt must frame the exports as recommended for "
            "stakeholder review (#433)"
        )

    def test_prompt_runs_before_handoff_to_build(self) -> None:
        # The prompt must be ordered BEFORE the 'Handoff to deft-directive-build'
        # section so greenfield users see it before the skill hands off.
        prompt_idx = self._text.find("End-of-Phase-3 Export Prompt")
        handoff_idx = self._text.find("Handoff to deft-directive-build")
        assert prompt_idx != -1, "Export prompt section must exist (#433)"
        assert handoff_idx != -1, "Handoff section must still exist"
        assert prompt_idx < handoff_idx, (
            "Export prompt must appear BEFORE the deft-directive-build handoff "
            "so users see it before leaving Phase 3 (#433)"
        )
