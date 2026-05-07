"""test_pre_pr_skill_closing_keyword_rule.py -- content guard for #737.

Asserts that the prose changes for issue #737 land verbatim in the
relevant skill files:

- ``skills/deft-directive-pre-pr/SKILL.md`` Phase 4 (Diff) MUST carry
  the ``!`` MUST rule pointing at ``task pr:check-closing-keywords``,
  and the Anti-Patterns block MUST carry the corresponding ``\u2297``
  MUST NOT entry citing the recurrence record (#697, #401, #700, #735).

- ``skills/deft-directive-swarm/SKILL.md`` Phase 6 Step 1 MUST carry a
  Layer 0 (prevention) cross-reference to the lint, distinguishing it
  from the existing Layer 3 (recovery) ``pr:check-protected-issues``
  rule (#701).

The test mirrors the existing ``tests/content/test_skills.py`` pattern
of asserting stable substrings rather than full-text matches so minor
phrasing edits do not regress the guard.

Story: #737. Layer 0 (prevention) prose codification.
"""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _read(rel: str) -> str:
    return (REPO_ROOT / rel).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# pre-pr SKILL Phase 4 ! rule
# ---------------------------------------------------------------------------


def test_pre_pr_skill_phase4_rule_present() -> None:
    """Phase 4 (Diff) MUST carry the !-rule invoking pr:check-closing-keywords."""
    text = _read("skills/deft-directive-pre-pr/SKILL.md")
    # The rule MUST live under the Phase 4 -- Diff heading.
    assert "### Phase 4 -- Diff" in text, (
        "skills/deft-directive-pre-pr/SKILL.md missing Phase 4 (Diff) heading"
    )
    # Stable substring tokens (#737, the canonical command, the trigger
    # word list, and the offline / known-false-positives flags).
    expected_tokens = [
        "task pr:check-closing-keywords",
        "(#737)",
        "--body-file",
        "--commits-file",
        "negation",
        "quotation",
        "code-block",
        "--allow-known-false-positives",
    ]
    for tok in expected_tokens:
        assert tok in text, (
            f"skills/deft-directive-pre-pr/SKILL.md missing Phase 4 token {tok!r} (#737)"
        )


def test_pre_pr_skill_phase4_recurrence_record_present() -> None:
    """The rule + anti-pattern MUST cite the Layer 1/2/3 recurrence stack."""
    text = _read("skills/deft-directive-pre-pr/SKILL.md")
    for issue_ref in ("#167", "#697", "#401", "#700", "#735"):
        assert issue_ref in text, (
            f"skills/deft-directive-pre-pr/SKILL.md MUST cite {issue_ref} as part of "
            "the closing-keyword recurrence stack (#737)"
        )


def test_pre_pr_skill_phase4_anti_pattern_present() -> None:
    """The Anti-Patterns block MUST carry the \u2297 entry for the lint."""
    text = _read("skills/deft-directive-pre-pr/SKILL.md")
    # The \u2297 (MUST NOT) anti-pattern citing #737 MUST exist.
    assert "## Anti-Patterns" in text
    # Stable substring on the anti-pattern itself.
    assert "Skip `task pr:check-closing-keywords`" in text, (
        "skills/deft-directive-pre-pr/SKILL.md Anti-Patterns block MUST contain a "
        "\u2297 entry prohibiting skipping `task pr:check-closing-keywords` (#737)"
    )


# ---------------------------------------------------------------------------
# swarm SKILL Phase 6 Step 1 cross-reference (Layer 0 vs Layer 3)
# ---------------------------------------------------------------------------


def test_swarm_skill_phase6_layer0_cross_reference_present() -> None:
    """Phase 6 Step 1 MUST carry a Layer 0 (prevention) cross-reference."""
    text = _read("skills/deft-directive-swarm/SKILL.md")
    assert "### Step 1: Merge" in text, (
        "skills/deft-directive-swarm/SKILL.md missing Phase 6 Step 1 heading"
    )
    # The cross-reference MUST mention BOTH Layer 0 and Layer 3 to
    # disambiguate from the existing Layer 3 rule.
    assert "Layer 0" in text, (
        "skills/deft-directive-swarm/SKILL.md MUST mention Layer 0 in the "
        "Phase 6 Step 1 closing-keyword section (#737)"
    )
    assert "Layer 3" in text, (
        "skills/deft-directive-swarm/SKILL.md Phase 6 Step 1 MUST mention "
        "Layer 3 (recovery, #701) to disambiguate"
    )
    # The cross-reference MUST link to the pre-PR skill where the rule
    # lives (not duplicate the rule body).
    assert "skills/deft-directive-pre-pr/SKILL.md" in text, (
        "swarm SKILL Phase 6 Step 1 MUST cross-reference the pre-PR skill (#737)"
    )
    # The canonical command surface for Layer 0.
    assert "pr:check-closing-keywords" in text, (
        "swarm SKILL Phase 6 Step 1 MUST reference task pr:check-closing-keywords (#737)"
    )
