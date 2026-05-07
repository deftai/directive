"""
test_interview_click_commit.py -- Content assertions for the #477 click-commit
rendering behavior in skills/deft-directive-interview/SKILL.md.

Covers sub-tasks 477-1, 477-2, 477-3 from vbrief/active/2026-04-21-477-interview-
click-commit-rendering.vbrief.json:

    477-1 -- Click-Commit Rendering subsection under Rule 2 (Back / Discuss /
             default-marker)
    477-2 -- Rule 6 plain-text Confirmation Gate requirement when the host's
             structured tool is click-commit
    477-3 -- Rule 11 two-mode legend behavior (plain-text vs click-commit)

These assertions run against the canonical SKILL.md; the thin pointer at
.agents/skills/deft-directive-interview/SKILL.md reads the canonical file at
runtime so a single source is sufficient.
"""

from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Repo root + target file
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_INTERVIEW_PATH = "skills/deft-directive-interview/SKILL.md"


@pytest.fixture(scope="module")
def interview_text() -> str:
    return (_REPO_ROOT / _INTERVIEW_PATH).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# 477-1: Click-Commit Rendering subsection under Rule 2
# ---------------------------------------------------------------------------


def test_click_commit_rendering_subsection_present(interview_text: str) -> None:
    """A Click-Commit Rendering subsection MUST exist in SKILL.md (#477 A)."""
    assert "Click-Commit Rendering" in interview_text, (
        f"{_INTERVIEW_PATH}: missing 'Click-Commit Rendering' subsection (#477 A)"
    )


def test_click_commit_rendering_under_rule2(interview_text: str) -> None:
    """The Click-Commit Rendering subsection MUST live inside Rule 2's scope
    (between '### Rule 2:' and '### Rule 3:') per #477 A."""
    rule2_start = interview_text.find("### Rule 2:")
    rule3_start = interview_text.find("### Rule 3:")
    assert rule2_start != -1 and rule3_start != -1, (
        f"{_INTERVIEW_PATH}: Rule 2 and Rule 3 headings must both be present"
    )
    rule2_block = interview_text[rule2_start:rule3_start]
    assert "Click-Commit Rendering" in rule2_block, (
        f"{_INTERVIEW_PATH}: 'Click-Commit Rendering' subsection MUST live "
        "under Rule 2 (#477 A)"
    )


def test_click_commit_back_on_every_question_except_first(
    interview_text: str,
) -> None:
    """Click-commit rendering MUST require `Back` on every question except
    the first (#477 A)."""
    lower = interview_text.lower()
    assert "back` must appear on every question except the first" in lower, (
        f"{_INTERVIEW_PATH}: Click-Commit Rendering MUST require `Back` on "
        "every question except the first (#477 A)"
    )


def test_click_commit_discuss_on_every_question(interview_text: str) -> None:
    """Click-commit rendering MUST require `Discuss with agent` on every
    question (#477 A)."""
    lower = interview_text.lower()
    assert "discuss with agent` must appear on every question" in lower, (
        f"{_INTERVIEW_PATH}: Click-Commit Rendering MUST require "
        "`Discuss with agent` on every question (#477 A)"
    )


def test_click_commit_default_marker(interview_text: str) -> None:
    """Click-commit rendering MUST require the `[default]` marker on answer
    options (the inline `[default: N]` notation doesn't render in click-commit
    tools) (#477 A)."""
    # Answer options render with the default marker in the options label.
    rule2_start = interview_text.find("### Rule 2:")
    rule3_start = interview_text.find("### Rule 3:")
    rule2_block = interview_text[rule2_start:rule3_start].lower()
    assert "default marker" in rule2_block and "[default]" in rule2_block, (
        f"{_INTERVIEW_PATH}: Click-Commit Rendering MUST require the "
        "`[default]` marker on answer options (#477 A)"
    )


def test_click_commit_back_anti_pattern(interview_text: str) -> None:
    """Click-commit rendering MUST carry a MUST NOT against omitting Back
    (#477 A)."""
    # Anti-pattern is a \u2297 bullet containing "Omit `Back`"
    assert "\u2297 Omit `Back`" in interview_text, (
        f"{_INTERVIEW_PATH}: MUST NOT omit `Back` in click-commit rendering "
        "(#477 A)"
    )


def test_click_commit_discuss_anti_pattern(interview_text: str) -> None:
    """Click-commit rendering MUST carry a MUST NOT against omitting
    `Discuss with agent` (#477 A)."""
    assert "\u2297 Omit `Discuss with agent`" in interview_text, (
        f"{_INTERVIEW_PATH}: MUST NOT omit `Discuss with agent` in click-commit "
        "rendering (#477 A)"
    )


def test_click_commit_not_rule8_compliant(interview_text: str) -> None:
    """Click-commit rendering MUST carry a MUST NOT against treating the
    click-commit return as a Rule-8-compliant commit (#477 A)."""
    lower = interview_text.lower()
    assert (
        "treat a click-commit tool's returned selection as a rule-8" in lower
        or "treat a click-commit tool's atomic return as a rule-8-compliant"
        in lower
    ), (
        f"{_INTERVIEW_PATH}: MUST NOT treat click-commit return as "
        "Rule-8-compliant commit (#477 A)"
    )


def test_click_commit_example_block_present(interview_text: str) -> None:
    """An example block SHOULD show the click-commit options shape including
    Back and Discuss (#477 A)."""
    # The example block uses [ Back -- ... ] and [ Discuss with agent ... ].
    assert "[ Back" in interview_text and "[ Discuss with agent" in interview_text, (
        f"{_INTERVIEW_PATH}: an example MUST show the click-commit options "
        "shape including [ Back ... ] and [ Discuss with agent ... ] (#477 A)"
    )


# ---------------------------------------------------------------------------
# 477-2: Rule 6 plain-text Confirmation Gate when host is click-commit
# ---------------------------------------------------------------------------


def test_rule6_click_commit_plain_text_gate(interview_text: str) -> None:
    """Rule 6 MUST require the Confirmation Gate to be rendered as plain-text
    with a typed response when the host's structured tool is click-commit
    (#477 B)."""
    rule6_start = interview_text.find("### Rule 6:")
    rule7_start = interview_text.find("### Rule 7:")
    assert rule6_start != -1 and rule7_start != -1, (
        f"{_INTERVIEW_PATH}: Rule 6 and Rule 7 headings must both be present"
    )
    rule6_block = interview_text[rule6_start:rule7_start].lower()
    assert "click-commit" in rule6_block and "plain-text" in rule6_block, (
        f"{_INTERVIEW_PATH}: Rule 6 MUST address click-commit hosts and "
        "require plain-text rendering (#477 B)"
    )
    assert "typed response" in rule6_block, (
        f"{_INTERVIEW_PATH}: Rule 6 MUST require a typed response on "
        "click-commit hosts (#477 B)"
    )


def test_rule6_click_commit_gate_anti_pattern(interview_text: str) -> None:
    """Rule 6 MUST carry a MUST NOT against rendering the Confirmation Gate
    via a click-commit structured tool (#477 B)."""
    rule6_start = interview_text.find("### Rule 6:")
    rule7_start = interview_text.find("### Rule 7:")
    rule6_block = interview_text[rule6_start:rule7_start].lower()
    assert (
        "\u2297 render the confirmation gate via a click-commit structured tool"
        in rule6_block
    ), (
        f"{_INTERVIEW_PATH}: Rule 6 MUST carry a MUST NOT against rendering "
        "the Gate via a click-commit tool (#477 B)"
    )


def test_rule6_strict_affirmative_tokens(interview_text: str) -> None:
    """Rule 6 MUST accept only strict affirmatives (`yes`, `confirmed`,
    `approve`) in the click-commit plain-text gate (#477 B)."""
    rule6_start = interview_text.find("### Rule 6:")
    rule7_start = interview_text.find("### Rule 7:")
    rule6_block = interview_text[rule6_start:rule7_start]
    assert (
        "`yes`" in rule6_block
        and "`confirmed`" in rule6_block
        and "`approve`" in rule6_block
    ), (
        f"{_INTERVIEW_PATH}: Rule 6 MUST accept only strict affirmative "
        "tokens (yes / confirmed / approve) (#477 B)"
    )


# ---------------------------------------------------------------------------
# 477-3: Rule 11 two-mode legend behavior
# ---------------------------------------------------------------------------


def test_rule11_plain_text_mode_subsection(interview_text: str) -> None:
    """Rule 11 MUST name a plain-text rendering mode for the keystroke legend
    (#477 C)."""
    rule11_start = interview_text.find("### Rule 11:")
    anti_patterns_start = interview_text.find("## Anti-Patterns")
    assert rule11_start != -1 and anti_patterns_start != -1, (
        f"{_INTERVIEW_PATH}: Rule 11 and Anti-Patterns headings must be present"
    )
    rule11_block = interview_text[rule11_start:anti_patterns_start]
    assert "Plain-Text Rendering Mode" in rule11_block, (
        f"{_INTERVIEW_PATH}: Rule 11 MUST name a Plain-Text Rendering Mode "
        "subsection (#477 C)"
    )


def test_rule11_click_commit_mode_subsection(interview_text: str) -> None:
    """Rule 11 MUST name a click-commit rendering mode for the affordances
    (#477 C)."""
    rule11_start = interview_text.find("### Rule 11:")
    anti_patterns_start = interview_text.find("## Anti-Patterns")
    rule11_block = interview_text[rule11_start:anti_patterns_start]
    assert "Click-Commit Rendering Mode" in rule11_block, (
        f"{_INTERVIEW_PATH}: Rule 11 MUST name a Click-Commit Rendering Mode "
        "subsection (#477 C)"
    )


def test_rule11_plain_text_legend_every_question(interview_text: str) -> None:
    """Rule 11 plain-text mode MUST require the legend under every
    deterministic question (#477 C)."""
    rule11_start = interview_text.find("### Rule 11:")
    anti_patterns_start = interview_text.find("## Anti-Patterns")
    rule11_block = interview_text[rule11_start:anti_patterns_start].lower()
    expected = "must be present under every deterministic question in plain-text mode"
    assert expected in rule11_block, (
        f"{_INTERVIEW_PATH}: Rule 11 plain-text mode MUST require the legend "
        "under every deterministic question (#477 C)"
    )


def test_rule11_click_commit_affordances_as_options(interview_text: str) -> None:
    """Rule 11 click-commit mode MUST render Back and Discuss as clickable
    options (#477 C)."""
    rule11_start = interview_text.find("### Rule 11:")
    anti_patterns_start = interview_text.find("## Anti-Patterns")
    rule11_block = interview_text[rule11_start:anti_patterns_start].lower()
    assert "clickable option" in rule11_block, (
        f"{_INTERVIEW_PATH}: Rule 11 click-commit mode MUST render "
        "affordances as clickable options (#477 C)"
    )


def test_rule11_click_commit_legend_may_be_omitted(interview_text: str) -> None:
    """Rule 11 click-commit mode MAY omit the keystroke legend since
    keystrokes are not accepted by the host tool (#477 C)."""
    rule11_start = interview_text.find("### Rule 11:")
    anti_patterns_start = interview_text.find("## Anti-Patterns")
    rule11_block = interview_text[rule11_start:anti_patterns_start].lower()
    assert "may be omitted in click-commit" in rule11_block, (
        f"{_INTERVIEW_PATH}: Rule 11 click-commit mode MAY omit the keystroke "
        "legend (#477 C)"
    )


def test_rule11_click_commit_affordances_still_present(
    interview_text: str,
) -> None:
    """Rule 11 click-commit mode MUST NOT omit Back or Discuss even when the
    keystroke legend is omitted (#477 C)."""
    rule11_start = interview_text.find("### Rule 11:")
    anti_patterns_start = interview_text.find("## Anti-Patterns")
    rule11_block = interview_text[rule11_start:anti_patterns_start]
    assert (
        "\u2297 Omit `Back`" in rule11_block
        and "Discuss with agent`" in rule11_block
    ), (
        f"{_INTERVIEW_PATH}: Rule 11 click-commit mode MUST carry a MUST NOT "
        "against omitting Back or Discuss as clickable options (#477 C)"
    )
