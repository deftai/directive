"""
test_debugging.py -- Regression coverage for the debugging / root-cause
coding standard landed for #1621 (consolidates the stale #659 + #1173).

Per the Rule Authority [AXIOM] in main.md, the strongest applicable
encoding tier for a prose rule is a deterministic content test that
fails CI if the rule body or its cross-reference surface is removed or
renamed. This module is that contract for the debugging standard:

1. The rule body lives in coding/debugging.md under canonical headings,
   with the RFC2119 ! MUST + U+2297 MUST NOT token mix.
2. coding/coding.md carries a short-form cross-reference section and a
   #1621 anti-pattern entry.
3. meta/lessons.md carries a discoverability cross-reference.
"""

import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

DEBUGGING_MD = _REPO_ROOT / "content/coding/debugging.md"
CODING_MD = _REPO_ROOT / "content/coding/coding.md"
LESSONS_MD = _REPO_ROOT / "meta" / "lessons.md"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


class TestDebuggingStandard1621:
    """The debugging rule body must live in coding/debugging.md with the
    canonical sections, the RFC2119 token mix, and the load-bearing
    evidence-discipline semantics."""

    def test_file_exists(self) -> None:
        assert DEBUGGING_MD.is_file(), (
            "coding/debugging.md is missing -- the #1621 root-cause "
            "coding standard MUST live in this file"
        )

    def test_canonical_heading_present(self) -> None:
        text = _read(DEBUGGING_MD)
        assert "# Debugging and Root-Cause Investigation (#1621)" in text, (
            "coding/debugging.md: missing the canonical #1621 title heading"
        )

    def test_iron_law_present(self) -> None:
        text = _read(DEBUGGING_MD).lower()
        assert "iron law" in text, (
            "coding/debugging.md: missing the Iron Law section"
        )
        assert "no fixes without root-cause investigation first" in text, (
            "coding/debugging.md: missing the Iron Law body (no fixes "
            "without root-cause investigation first)"
        )

    def test_four_phases_present(self) -> None:
        text = _read(DEBUGGING_MD).lower()
        for phase in ("phase 1", "phase 2", "phase 3", "phase 4"):
            assert phase in text, (
                f"coding/debugging.md: missing {phase} of the four-phase "
                "root-cause process"
            )

    def test_three_fix_architecture_gate(self) -> None:
        text = _read(DEBUGGING_MD).lower()
        assert "3-fix" in text or "three fix" in text or "fourth fix" in text, (
            "coding/debugging.md: missing the 3-fix architecture gate "
            "(after 3 failed fixes, stop and escalate)"
        )
        assert "architectural review" in text, (
            "coding/debugging.md: the 3-fix gate MUST escalate to "
            "architectural review"
        )

    def test_evidence_discipline_rules(self) -> None:
        """Load-bearing forensic-rigor semantics adapted from the vendored
        reference design."""
        text = _read(DEBUGGING_MD).lower()
        assert "evidence before narrative" in text, (
            "coding/debugging.md: missing the evidence-before-narrative rule"
        )
        assert "config is not code" in text, (
            "coding/debugging.md: missing the config-is-not-code rule"
        )
        assert "tautolog" in text, (
            "coding/debugging.md: missing the no-tautologies rule (a duration "
            "or exit status is not a root cause)"
        )

    def test_fact_vs_hypothesis_labeling(self) -> None:
        text = _read(DEBUGGING_MD)
        assert "Fact" in text and "Hypothesis" in text, (
            "coding/debugging.md: missing Fact vs Hypothesis labeling"
        )
        assert "#1580" in text, (
            "coding/debugging.md: Fact vs Hypothesis labeling MUST cross-"
            "reference #1580 (the owner of the findings-format surface)"
        )

    def test_observability_gap_loop(self) -> None:
        text = _read(DEBUGGING_MD).lower()
        assert "observability" in text, (
            "coding/debugging.md: missing the observability-gap loop (emit "
            "what to log/measure next time when the cause was inferred)"
        )

    def test_rule_body_carries_must_token(self) -> None:
        text = _read(DEBUGGING_MD)
        assert re.search(r"^- ! ", text, re.MULTILINE), (
            "coding/debugging.md: missing '! MUST' bullets -- the rules MUST "
            "be encoded with RFC2119 `!` MUST tokens"
        )

    def test_rule_body_carries_must_not_token(self) -> None:
        text = _read(DEBUGGING_MD)
        assert "\u2297" in text, (
            "coding/debugging.md: missing '\u2297 MUST NOT' anti-patterns -- "
            "the standard MUST name prohibited behaviours explicitly"
        )


class TestCodingMdCrossReference1621:
    """coding/coding.md must surface the debugging standard."""

    def test_cross_reference_section_present(self) -> None:
        text = _read(CODING_MD)
        assert "## Debugging and Root-Cause Investigation (#1621)" in text, (
            "coding/coding.md: missing the debugging cross-reference section"
        )
        assert "debugging.md" in text, (
            "coding/coding.md: the debugging section MUST link to debugging.md"
        )

    def test_anti_pattern_cross_reference(self) -> None:
        text = _read(CODING_MD)
        m = re.search(
            r"## Anti-Patterns\s*(.*)\Z",
            text,
            re.DOTALL,
        )
        assert m is not None, "coding/coding.md: missing Anti-Patterns section"
        anti = m.group(1)
        assert "#1621" in anti, (
            "coding/coding.md Anti-Patterns: missing the #1621 debugging "
            "anti-pattern entry"
        )


class TestLessonsCrossReference1621:
    """meta/lessons.md must carry a discoverability cross-reference."""

    def test_lessons_md_cross_reference(self) -> None:
        text = _read(LESSONS_MD)
        assert "#1621" in text, (
            "meta/lessons.md: missing the #1621 discoverability cross-"
            "reference for the debugging standard"
        )


DEBUG_SKILL = _REPO_ROOT / "content/skills/deft-directive-debug/SKILL.md"
DEBUG_SKILL_POINTER = _REPO_ROOT / "content/.agents/skills/deft-directive-debug/SKILL.md"
AGENTS_MD = _REPO_ROOT / "AGENTS.md"
AGENTS_ENTRY = _REPO_ROOT / "content/templates/agents-entry.md"


class TestDebugSkill1621:
    """The deft-directive-debug skill (D2) must exist with the canonical
    structure and operationalize the debugging standard + close gate."""

    def test_skill_exists(self) -> None:
        assert DEBUG_SKILL.is_file(), (
            "skills/deft-directive-debug/SKILL.md is missing (#1621 D2)"
        )

    def test_skill_frontmatter_name(self) -> None:
        text = _read(DEBUG_SKILL)
        assert text.startswith("---"), (
            "deft-directive-debug SKILL.md must start with YAML frontmatter"
        )
        assert "name: deft-directive-debug" in text, (
            "deft-directive-debug SKILL.md frontmatter must declare "
            "'name: deft-directive-debug'"
        )

    def test_skill_rfc2119_legend(self) -> None:
        text = _read(DEBUG_SKILL)
        assert "!=MUST, ~=SHOULD" in text, (
            "deft-directive-debug SKILL.md missing the RFC2119 legend"
        )

    def test_skill_iron_law(self) -> None:
        text = _read(DEBUG_SKILL).lower()
        assert "iron law" in text and "embargo" in text, (
            "deft-directive-debug SKILL.md must carry the Iron Law + the "
            "chat answer-embargo"
        )

    def test_skill_references_close_gate(self) -> None:
        text = _read(DEBUG_SKILL)
        assert "task verify:investigation" in text, (
            "deft-directive-debug SKILL.md must reference the "
            "`task verify:investigation` close gate (D3)"
        )

    def test_skill_references_coding_standard(self) -> None:
        text = _read(DEBUG_SKILL)
        assert "coding/debugging.md" in text, (
            "deft-directive-debug SKILL.md must reference coding/debugging.md "
            "(the standard it operationalizes)"
        )

    def test_skill_references_vendored_design(self) -> None:
        text = _read(DEBUG_SKILL)
        assert "docs/reference/forensic-research/" in text, (
            "deft-directive-debug SKILL.md must cite the vendored reference "
            "design under docs/reference/forensic-research/"
        )

    def test_skill_falsification_waves(self) -> None:
        text = _read(DEBUG_SKILL).lower()
        assert "falsif" in text and "red-team" in text, (
            "deft-directive-debug SKILL.md must require the Falsify + "
            "Red-team waves"
        )

    def test_skill_completion_gate(self) -> None:
        text = _read(DEBUG_SKILL)
        assert "Skill Completion Gate" in text and "exiting skill" in text, (
            "deft-directive-debug SKILL.md must carry a Skill Completion Gate "
            "with an unambiguous exit confirmation"
        )

    def test_thin_pointer_exists(self) -> None:
        assert DEBUG_SKILL_POINTER.is_file(), (
            ".agents/skills/deft-directive-debug/SKILL.md thin pointer missing"
        )
        text = _read(DEBUG_SKILL_POINTER)
        assert "skills/deft-directive-debug/SKILL.md" in text, (
            "the thin pointer must redirect to skills/deft-directive-debug/SKILL.md"
        )


class TestDebugSkillRouting1621:
    """The skill must be discoverable via routing in both the maintainer
    AGENTS.md and the consumer template (#1309 propagation)."""

    def test_agents_md_routing(self) -> None:
        text = _read(AGENTS_MD)
        assert "skills/deft-directive-debug/SKILL.md" in text, (
            "AGENTS.md Skill Routing must route to deft-directive-debug"
        )
        assert "debug" in text and "root cause" in text, (
            "AGENTS.md routing must list debug trigger keywords"
        )

    def test_template_routing(self) -> None:
        text = _read(AGENTS_ENTRY)
        assert ".deft/core/skills/deft-directive-debug/SKILL.md" in text, (
            "templates/agents-entry.md Skill Routing must route to "
            "deft-directive-debug (#1309 propagation)"
        )
