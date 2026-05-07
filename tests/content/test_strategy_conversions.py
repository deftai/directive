"""
test_strategy_conversions.py -- Content tests for strategy vBRIEF conversions.

Validates:
  - research.md references vBRIEF output with DontHandRoll/CommonPitfalls narratives (#367)
  - map.md references vBRIEF output with Stack/Architecture/Conventions/Concerns narratives (#368)
  - roadmap.md is a superseded redirect to deft-directive-refinement (#369)

Author: agent3 -- 2026-04-14
"""

from pathlib import Path

# ---------------------------------------------------------------------------
# Module-level constants
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def _read(relpath: str) -> str:
    return (_REPO_ROOT / relpath).read_text(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# research.md -- vBRIEF-centric output (#367)
# ---------------------------------------------------------------------------

class TestResearchVBRIEF:
    """research.md must reference vBRIEF output, not hand-authored .md."""

    _text = _read("strategies/research.md")

    def test_references_vbrief_proposed_path(self) -> None:
        assert "vbrief/proposed/" in self._text, (
            "strategies/research.md must reference vbrief/proposed/ output path"
        )

    def test_references_dont_hand_roll_narrative(self) -> None:
        assert "DontHandRoll" in self._text, (
            "strategies/research.md must reference DontHandRoll narrative"
        )

    def test_references_common_pitfalls_narrative(self) -> None:
        assert "CommonPitfalls" in self._text, (
            "strategies/research.md must reference CommonPitfalls narrative"
        )

    def test_no_feature_research_md_output(self) -> None:
        assert "Produce `{feature}-research.md`" not in self._text, (
            "strategies/research.md must not reference {feature}-research.md as output"
        )

    def test_chaining_gate_references_vbrief(self) -> None:
        assert "vbrief/proposed/{feature}-research.vbrief.json" in self._text, (
            "strategies/research.md chaining gate must reference vBRIEF artifact path"
        )


# ---------------------------------------------------------------------------
# map.md -- vBRIEF-centric output (#368)
# ---------------------------------------------------------------------------

class TestMapVBRIEF:
    """map.md must reference vBRIEF output, not .planning/codebase/ .md files."""

    _text = _read("strategies/map.md")

    def test_references_vbrief_proposed_path(self) -> None:
        assert "vbrief/proposed/" in self._text, (
            "strategies/map.md must reference vbrief/proposed/ output path"
        )

    def test_references_stack_narrative(self) -> None:
        assert "`Stack`" in self._text, (
            "strategies/map.md must reference Stack narrative"
        )

    def test_references_architecture_narrative(self) -> None:
        assert "`Architecture`" in self._text, (
            "strategies/map.md must reference Architecture narrative"
        )

    def test_references_conventions_narrative(self) -> None:
        assert "`Conventions`" in self._text, (
            "strategies/map.md must reference Conventions narrative"
        )

    def test_references_concerns_narrative(self) -> None:
        assert "`Concerns`" in self._text, (
            "strategies/map.md must reference Concerns narrative"
        )

    def test_no_planning_codebase_output(self) -> None:
        assert ".planning/codebase/" not in self._text, (
            "strategies/map.md must not reference .planning/codebase/ as output"
        )

    def test_chaining_gate_references_vbrief(self) -> None:
        assert "vbrief/proposed/{project}-codebase-map.vbrief.json" in self._text, (
            "strategies/map.md chaining gate must reference vBRIEF artifact path"
        )


# ---------------------------------------------------------------------------
# roadmap.md -- superseded redirect (#369)
# ---------------------------------------------------------------------------

class TestRoadmapRedirect:
    """roadmap.md must be a superseded redirect to refinement skill."""

    _text = _read("strategies/roadmap.md")

    def test_contains_superseded(self) -> None:
        assert "superseded" in self._text.lower(), (
            "strategies/roadmap.md must contain 'superseded'"
        )

    def test_references_refinement_skill(self) -> None:
        assert "deft-directive-refinement" in self._text, (
            "strategies/roadmap.md must reference deft-directive-refinement skill"
        )

    def test_references_roadmap_render(self) -> None:
        assert "roadmap:render" in self._text, (
            "strategies/roadmap.md must reference task roadmap:render"
        )

    def test_no_workflow_sections(self) -> None:
        assert "### Step 1" not in self._text, (
            "strategies/roadmap.md redirect must not contain original workflow steps"
        )
