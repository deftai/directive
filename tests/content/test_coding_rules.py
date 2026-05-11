"""
test_coding_rules.py -- Regression coverage for two coding rules
landed in PRs #1005 (surface-conflicts) and #1006 (fail-loud).

Spec: vbrief/active/2026-05-11-1005-...vbrief.json (#1005)
      vbrief/active/2026-05-11-1006-...vbrief.json (#1006)

Per the Rule Authority [AXIOM] in main.md, the strongest applicable
encoding tier for a prose rule is a deterministic content test that
fails CI if the rule body or its skill-side enforcement surface is
removed or renamed. This module is that contract for two rules:

1. #1005 -- Surface Conflicts: Pick One, Explain, Flag the Other
   Host: coding/hygiene.md
   Skill enforcement: skills/deft-directive-build/SKILL.md Step 1
   Cross-reference: coding/coding.md Anti-Patterns

2. #1006 -- Fail Loud: Completion Claims Require Outcome Verification
   Host: coding/coding.md
   Skill enforcement: skills/deft-directive-review-cycle/SKILL.md Step 3
   Cross-reference: coding/coding.md Anti-Patterns (own file)

The tests assert (a) the rule heading is present verbatim in the
expected file, (b) the rule body carries the canonical RFC2119
`!` MUST + `\u2297` MUST NOT token mix, (c) the anti-pattern index
in coding/coding.md cross-references each rule with the issue
number tag, and (d) the skill-side cross-references cite the rule
issue number so a future rename of the rule heading flags here
first.
"""

import re
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

CODING_MD = _REPO_ROOT / "coding" / "coding.md"
HYGIENE_MD = _REPO_ROOT / "coding" / "hygiene.md"
BUILD_SKILL = _REPO_ROOT / "skills" / "deft-directive-build" / "SKILL.md"
REVIEW_CYCLE_SKILL = (
    _REPO_ROOT / "skills" / "deft-directive-review-cycle" / "SKILL.md"
)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Issue #1005 -- Surface Conflicts rule
# ---------------------------------------------------------------------------


class TestSurfaceConflictsRule1005:
    """The surface-conflicts rule body must live in coding/hygiene.md
    with the canonical heading, the RFC2119 token mix, and the
    skill-side enforcement cross-reference."""

    def test_rule_heading_present_in_hygiene_md(self) -> None:
        text = _read(HYGIENE_MD)
        assert "## Surface Conflicts: Pick One, Explain, Flag the Other (#1005)" in text, (
            "coding/hygiene.md: missing surface-conflicts rule heading -- "
            "the #1005 rule body must live under this exact section heading"
        )

    def test_rule_body_carries_must_token(self) -> None:
        text = _read(HYGIENE_MD)
        # Find the surface-conflicts section body
        m = re.search(
            r"## Surface Conflicts: Pick One, Explain, Flag the Other \(#1005\)\s*"
            r"(.*?)(?=^---|^## |\Z)",
            text,
            re.DOTALL | re.MULTILINE,
        )
        assert m is not None, "could not locate surface-conflicts section body"
        body = m.group(1)
        # The rule body MUST carry at least one ! MUST bullet
        assert re.search(r"^- ! ", body, re.MULTILINE), (
            "coding/hygiene.md surface-conflicts section: missing '! MUST' "
            "bullet -- the rule MUST be encoded as a `!` RFC2119 MUST, not "
            "as advisory prose"
        )

    def test_rule_body_carries_must_not_anti_pattern(self) -> None:
        text = _read(HYGIENE_MD)
        m = re.search(
            r"## Surface Conflicts: Pick One, Explain, Flag the Other \(#1005\)\s*"
            r"(.*?)(?=^---|^## |\Z)",
            text,
            re.DOTALL | re.MULTILINE,
        )
        assert m is not None
        body = m.group(1)
        # MUST carry at least one \u2297 MUST NOT entry
        assert "\u2297" in body, (
            "coding/hygiene.md surface-conflicts section: missing '\u2297 "
            "MUST NOT' anti-pattern -- the rule MUST name the dropped "
            "behaviour explicitly per the Rule Authority [AXIOM]"
        )

    def test_rule_body_mentions_pick_one(self) -> None:
        """Load-bearing semantic: the rule MUST encode 'pick one'
        (not 'pick one or both', not 'consider both')."""
        text = _read(HYGIENE_MD)
        m = re.search(
            r"## Surface Conflicts: Pick One, Explain, Flag the Other \(#1005\)\s*"
            r"(.*?)(?=^---|^## |\Z)",
            text,
            re.DOTALL | re.MULTILINE,
        )
        assert m is not None
        body = m.group(1).lower()
        assert "pick one" in body, (
            "coding/hygiene.md surface-conflicts: rule body MUST contain "
            "the 'pick one' phrasing -- the load-bearing semantic"
        )

    def test_rule_body_forbids_blending(self) -> None:
        """The rule MUST explicitly forbid the 'satisfy both' / blend
        behaviour that is the failure mode this rule prevents."""
        text = _read(HYGIENE_MD)
        m = re.search(
            r"## Surface Conflicts: Pick One, Explain, Flag the Other \(#1005\)\s*"
            r"(.*?)(?=^---|^## |\Z)",
            text,
            re.DOTALL | re.MULTILINE,
        )
        assert m is not None
        body = m.group(1).lower()
        assert "blend" in body or "satisfy both" in body or "average" in body, (
            "coding/hygiene.md surface-conflicts: rule MUST forbid blending / "
            "satisfying both / averaging -- the failure mode this rule prevents"
        )

    def test_coding_md_anti_pattern_cross_reference(self) -> None:
        text = _read(CODING_MD)
        # The global anti-pattern index MUST reference #1005
        assert re.search(r"#1005", text), (
            "coding/coding.md: missing #1005 cross-reference in Anti-Patterns "
            "-- the global anti-pattern index MUST surface the surface-conflicts rule"
        )

    def test_build_skill_step1_enforces_rule(self) -> None:
        text = _read(BUILD_SKILL)
        # The build skill Step 1 MUST cite the rule by issue number
        assert "#1005" in text, (
            "skills/deft-directive-build/SKILL.md: missing #1005 "
            "cross-reference -- the build skill MUST enforce the "
            "surface-conflicts rule during scope understanding"
        )
        # MUST appear as a `!` MUST rule, not advisory prose
        assert re.search(
            r"- ! .*Surface Conflicts.*#1005",
            text,
            re.IGNORECASE,
        ) or re.search(
            r"- ! .*contradicting patterns.*#1005",
            text,
            re.IGNORECASE,
        ), (
            "skills/deft-directive-build/SKILL.md: surface-conflicts "
            "cross-reference MUST be a `!` MUST bullet, not advisory prose"
        )


# ---------------------------------------------------------------------------
# Issue #1006 -- Fail Loud rule
# ---------------------------------------------------------------------------


class TestFailLoudRule1006:
    """The fail-loud rule body must live in coding/coding.md with the
    canonical heading, the RFC2119 token mix, and the review-cycle
    skill-side enforcement cross-reference."""

    def test_rule_heading_present_in_coding_md(self) -> None:
        text = _read(CODING_MD)
        assert "## Fail Loud: Completion Claims Require Outcome Verification (#1006)" in text, (
            "coding/coding.md: missing fail-loud rule heading -- "
            "the #1006 rule body must live under this exact section heading"
        )

    def test_rule_body_carries_must_token(self) -> None:
        text = _read(CODING_MD)
        m = re.search(
            r"## Fail Loud: Completion Claims Require Outcome Verification \(#1006\)\s*"
            r"(.*?)(?=^## |\Z)",
            text,
            re.DOTALL | re.MULTILINE,
        )
        assert m is not None, "could not locate fail-loud section body"
        body = m.group(1)
        assert re.search(r"^- ! ", body, re.MULTILINE), (
            "coding/coding.md fail-loud section: missing '! MUST' bullet -- "
            "the rule MUST be encoded as a `!` RFC2119 MUST"
        )

    def test_rule_body_carries_must_not_anti_pattern(self) -> None:
        text = _read(CODING_MD)
        m = re.search(
            r"## Fail Loud: Completion Claims Require Outcome Verification \(#1006\)\s*"
            r"(.*?)(?=^## |\Z)",
            text,
            re.DOTALL | re.MULTILINE,
        )
        assert m is not None
        body = m.group(1)
        assert "\u2297" in body, (
            "coding/coding.md fail-loud section: missing '\u2297 MUST NOT' "
            "anti-pattern -- the rule MUST name the dropped behaviour explicitly"
        )

    def test_rule_body_mentions_outcome_verification(self) -> None:
        """Load-bearing semantic: the rule distinguishes intent-level
        claims from outcome-level verification."""
        text = _read(CODING_MD)
        m = re.search(
            r"## Fail Loud: Completion Claims Require Outcome Verification \(#1006\)\s*"
            r"(.*?)(?=^## |\Z)",
            text,
            re.DOTALL | re.MULTILINE,
        )
        assert m is not None
        body = m.group(1).lower()
        assert "outcome" in body, (
            "coding/coding.md fail-loud: rule body MUST distinguish 'outcome' "
            "verification from intent-level claims -- the load-bearing semantic"
        )

    def test_rule_body_covers_three_canonical_examples(self) -> None:
        """The source examples (migration / tests pass / feature works)
        must be present in the rule body so the rule stays anchored
        to its origin failure modes."""
        text = _read(CODING_MD)
        m = re.search(
            r"## Fail Loud: Completion Claims Require Outcome Verification \(#1006\)\s*"
            r"(.*?)(?=^## |\Z)",
            text,
            re.DOTALL | re.MULTILINE,
        )
        assert m is not None
        body = m.group(1).lower()
        # All three canonical examples from the source MUST appear
        assert "migration" in body, "fail-loud rule MUST cite the migration example"
        assert "tests pass" in body, "fail-loud rule MUST cite the 'tests pass' example"
        assert "feature works" in body, "fail-loud rule MUST cite the 'feature works' example"

    def test_coding_md_anti_pattern_cross_reference(self) -> None:
        text = _read(CODING_MD)
        assert re.search(r"#1006", text), (
            "coding/coding.md: missing #1006 cross-reference in Anti-Patterns "
            "-- the global anti-pattern index MUST surface the fail-loud rule"
        )

    def test_review_cycle_skill_step3_enforces_rule(self) -> None:
        text = _read(REVIEW_CYCLE_SKILL)
        assert "#1006" in text, (
            "skills/deft-directive-review-cycle/SKILL.md: missing #1006 "
            "cross-reference -- the review-cycle skill MUST enforce the "
            "fail-loud rule on fix-batch completion claims"
        )
        # MUST appear as a `!` MUST rule in Step 3
        assert re.search(
            r"- ! .*Fail-loud.*#1006",
            text,
            re.IGNORECASE,
        ) or re.search(
            r"- ! .*#1006",
            text,
        ), (
            "skills/deft-directive-review-cycle/SKILL.md: fail-loud "
            "cross-reference MUST be a `!` MUST bullet"
        )


# ---------------------------------------------------------------------------
# Lessons cross-reference (Rule Authority [AXIOM] discoverability)
# ---------------------------------------------------------------------------


class TestLessonsCrossReference:
    """Per Rule Authority [AXIOM], a rule body lives at the strongest
    applicable layer (here: prose in coding.md / hygiene.md + content
    test). The lessons.md cross-reference is the discoverability
    surface; it MUST exist so future agents searching for #1005 or
    #1006 in lessons.md can find the canonical encoding."""

    @pytest.mark.parametrize("issue_tag", ["#1005", "#1006"])
    def test_lessons_md_has_short_cross_reference(self, issue_tag: str) -> None:
        lessons = _read(_REPO_ROOT / "meta" / "lessons.md")
        assert issue_tag in lessons, (
            f"meta/lessons.md: missing {issue_tag} cross-reference -- per "
            "Rule Authority [AXIOM] every prose rule MUST have a short "
            "lessons cross-reference for discoverability, even when the "
            "canonical encoding lives elsewhere"
        )
