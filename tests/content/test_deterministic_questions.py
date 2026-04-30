"""Content tests for the deterministic-questions canonical contract (#767).

Scans skill prose for documented numbered menus and asserts:

1. ``contracts/deterministic-questions.md`` exists and documents the
   Discuss-pause semantic verbatim.
2. Each affected skill carries a ``!`` cross-reference pointing back to
   the contract (so individual skills don't duplicate the rule body, per
   the Rule Authority [AXIOM] block in main.md).
3. ``glossary.md`` carries a ``Deterministic mode`` entry pointing to
   the contract.

The file-level scope intentionally excludes:

- ``skills/deft-directive-interview/SKILL.md`` (Agent 2 owns this surface)
- ``skills/deft-directive-build/SKILL.md`` (Agent 3 owns this surface)

Both will land their cross-references in their own PRs.
"""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACT_PATH = REPO_ROOT / "contracts" / "deterministic-questions.md"

# Skills that own a Discuss/Back cross-reference under #767. Interview and
# build are EXCLUDED on purpose -- those are owned by Agents 2 and 3.
AFFECTED_SKILLS = (
    "skills/deft-directive-swarm/SKILL.md",
    "skills/deft-directive-setup/SKILL.md",
    "skills/deft-directive-refinement/SKILL.md",
    "skills/deft-directive-pre-pr/SKILL.md",
    "skills/deft-directive-review-cycle/SKILL.md",
    "skills/deft-directive-release/SKILL.md",
)


def test_contract_file_exists():
    assert CONTRACT_PATH.is_file(), (
        f"contracts/deterministic-questions.md missing at {CONTRACT_PATH}"
    )


def test_contract_documents_discuss_back_rule():
    text = CONTRACT_PATH.read_text(encoding="utf-8")
    # Canonical rule body. The contract phrases this as "include `Discuss`
    # and `Back` as the final two numbered options".
    assert "`Discuss` and `Back`" in text
    assert "final two numbered options" in text
    assert "in that order" in text


def test_contract_discuss_pause_semantic_verbatim():
    """The exact phrasing from the vBRIEF acceptance criteria MUST appear."""
    text = CONTRACT_PATH.read_text(encoding="utf-8")
    # Pieces of the verbatim semantic.
    assert "the agent MUST pause IMMEDIATELY" in text
    assert "halt the in-progress sequence" in text
    assert "no further tool calls beyond acknowledging the pause" in text
    assert "What would you like to discuss?" in text
    assert "Implicit resumption" in text
    assert "forbidden" in text
    # Three resume signals.
    assert "re-asks the original question" in text
    assert "resume" in text
    assert "continue" in text
    assert "re-issues the prior selection" in text


def test_contract_prior_art_section_present():
    """The contract MUST include a Prior art reviewed section (#767 → #431)."""
    text = CONTRACT_PATH.read_text(encoding="utf-8")
    assert "## Prior art reviewed" in text
    assert "#431" in text
    # Must NOT introduce a competing Other option (#431 escape-hatch principle).
    assert "It does NOT introduce a separate `Other` option" in text


def test_contract_lists_discuss_not_subchoice_of_other():
    text = CONTRACT_PATH.read_text(encoding="utf-8")
    # The rule that Discuss is a top-level numbered option, not under Other.
    assert "NOT a sub-choice of any `Other` / `Custom` option" in text


def test_each_affected_skill_cross_references_contract():
    """Each affected skill MUST cross-reference contracts/deterministic-questions.md."""
    missing = []
    for rel in AFFECTED_SKILLS:
        p = REPO_ROOT / rel
        text = p.read_text(encoding="utf-8")
        if "contracts/deterministic-questions.md" not in text:
            missing.append(rel)
    assert not missing, (
        f"Skills missing Discuss/Back contract cross-reference: {missing}"
    )


def test_each_affected_skill_documents_discuss_back():
    """Each affected skill must mention `Discuss` and `Back` together."""
    missing = []
    for rel in AFFECTED_SKILLS:
        p = REPO_ROOT / rel
        text = p.read_text(encoding="utf-8")
        # Loose check: both literal tokens appear in the file.
        if "Discuss" not in text or "Back" not in text:
            missing.append(rel)
    assert not missing, f"Skills missing Discuss/Back tokens: {missing}"


def test_glossary_has_deterministic_mode_entry():
    glossary = (REPO_ROOT / "glossary.md").read_text(encoding="utf-8")
    assert "**Deterministic mode**" in glossary
    assert "contracts/deterministic-questions.md" in glossary
    assert "#767" in glossary


def test_glossary_has_branch_protection_policy_entry():
    """Companion glossary entry for #746 / #747 lands alongside #767."""
    glossary = (REPO_ROOT / "glossary.md").read_text(encoding="utf-8")
    assert "**Branch-protection policy**" in glossary
    assert "allowDirectCommitsToMaster" in glossary
    assert "#746" in glossary
    assert "#747" in glossary


def test_review_cycle_documents_stall_rubric():
    """Issue #564 -- Stall Detection Rubric subsection lives under Step 4."""
    text = (REPO_ROOT / "skills" / "deft-directive-review-cycle" / "SKILL.md").read_text(
        encoding="utf-8"
    )
    assert "Stall Detection Rubric" in text
    assert "#564" in text
    # 3x expected duration threshold.
    assert "3x" in text or "3-x" in text
    # User-decision options.
    assert "Wait another" in text
    assert "Manually re-trigger Greptile" in text
    # Auto-restart detection rule.
    assert "auto-restart" in text.lower()
    # Override audit rule.
    assert "PR comment" in text


def test_lessons_md_has_stall_entry():
    lessons = (REPO_ROOT / "meta" / "lessons.md").read_text(encoding="utf-8")
    assert "## Greptile Review Stall Detection" in lessons
    assert "21 minute" in lessons or "21-minute" in lessons or "21 min" in lessons
    assert "PR #561" in lessons or "rc4" in lessons
