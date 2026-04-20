"""
test_interview_deterministic.py -- Content assertions for the
deterministic-question UX in skills/deft-directive-interview/SKILL.md.

Covers the four behaviors restored by #431 (RC2 defects) and originally
introduced in #359:

1. Confirm-after-number-press step (Rule 8)
2. Back-navigation affordance (Rule 9)
3. Slot-0 "Discuss with agent" label, visually distinct from "Other"
   (Rule 10)
4. Persistent one-line legend under each deterministic question
   (Rule 11) -- "Enter confirm / b back / 0 discuss"

These assertions run against the canonical SKILL.md; the thin pointer
at .agents/skills/deft-directive-interview/SKILL.md reads the canonical
file at runtime so a single source is sufficient.
"""

from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Repo root + target file
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_INTERVIEW_PATH = "skills/deft-directive-interview/SKILL.md"
_AGENTS_POINTER_PATH = ".agents/skills/deft-directive-interview/SKILL.md"

# Canonical legend text required under every deterministic question.
_CANONICAL_LEGEND = "Enter confirm / b back / 0 discuss"


@pytest.fixture(scope="module")
def interview_text() -> str:
    return (_REPO_ROOT / _INTERVIEW_PATH).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# 1. Confirm-after-number-press step (Rule 8)
# ---------------------------------------------------------------------------


def test_rule8_heading_present(interview_text: str) -> None:
    """Rule 8 (Deterministic Selection Confirmation) must be a named section."""
    assert "### Rule 8: Deterministic Selection Confirmation" in interview_text, (
        f"{_INTERVIEW_PATH}: Rule 8 heading missing (#431, #359)"
    )


def test_rule8_confirm_step_is_mandatory(interview_text: str) -> None:
    """Rule 8 must declare the confirm-after-number-press step as MANDATORY."""
    lower = interview_text.lower()
    assert "confirm-after-number-press" in lower, (
        f"{_INTERVIEW_PATH}: Rule 8 must name the confirm-after-number-press step "
        "(#431)"
    )
    assert "number entry alone must not advance" in lower, (
        f"{_INTERVIEW_PATH}: Rule 8 must prohibit advancing on bare number entry "
        "(#431)"
    )


def test_rule8_echoes_selected_option(interview_text: str) -> None:
    """Rule 8 must require the agent to echo the selected option text."""
    lower = interview_text.lower()
    assert "echo the selected option" in lower, (
        f"{_INTERVIEW_PATH}: Rule 8 must require echoing the selected option "
        "before advancing (#431, #359)"
    )


def test_rule8_waits_for_enter(interview_text: str) -> None:
    """Rule 8 must require Enter / explicit confirmation before advancing."""
    lower = interview_text.lower()
    assert "enter to confirm" in lower, (
        f"{_INTERVIEW_PATH}: Rule 8 must require Enter for confirmation (#431)"
    )
    assert "wait for enter" in lower, (
        f"{_INTERVIEW_PATH}: Rule 8 must instruct the agent to wait for Enter "
        "before advancing (#431)"
    )


def test_rule8_anti_pattern_auto_advance(interview_text: str) -> None:
    """Anti-patterns must prohibit auto-advance on number press."""
    lower = interview_text.lower()
    assert "auto-advance" in lower and "number key" in lower, (
        f"{_INTERVIEW_PATH}: must prohibit auto-advance on number press (#431)"
    )


# ---------------------------------------------------------------------------
# 2. Back-navigation affordance (Rule 9)
# ---------------------------------------------------------------------------


def test_rule9_heading_present(interview_text: str) -> None:
    """Rule 9 (Backward Navigation) must be present."""
    assert "### Rule 9: Backward Navigation" in interview_text, (
        f"{_INTERVIEW_PATH}: Rule 9 heading missing (#431, #359)"
    )


def test_rule9_back_keys_listed(interview_text: str) -> None:
    """Rule 9 must list `b`, `back`, and `prev` as valid back-nav inputs."""
    for key in ("`b`", "`back`", "`prev`"):
        assert key in interview_text, (
            f"{_INTERVIEW_PATH}: Rule 9 must list {key} as a back-nav input "
            "(#431, #359)"
        )


def test_rule9_back_nav_visible_in_legend(interview_text: str) -> None:
    """Rule 9 must require the back affordance to be visible on every question
    via the persistent legend (Rule 11) -- not only announced once."""
    lower = interview_text.lower()
    assert "back-navigation affordance must be visible on every question" in lower, (
        f"{_INTERVIEW_PATH}: Rule 9 must require back-nav visibility on every "
        "question (#431)"
    )


def test_rule9_anti_pattern_hidden_back(interview_text: str) -> None:
    """Anti-patterns must prohibit hiding the back-navigation affordance."""
    lower = interview_text.lower()
    assert "hide the back-navigation affordance" in lower, (
        f"{_INTERVIEW_PATH}: must prohibit hiding the back-nav affordance "
        "(#431)"
    )


# ---------------------------------------------------------------------------
# 3. Slot-0 "Discuss with agent" label, visually distinct from "Other" (Rule 10)
# ---------------------------------------------------------------------------


def test_rule10_heading_present(interview_text: str) -> None:
    """Rule 10 (Freeform Conversation Escape) must be a named section."""
    assert "### Rule 10: Freeform Conversation Escape" in interview_text, (
        f"{_INTERVIEW_PATH}: Rule 10 heading missing (#431, #359)"
    )


def test_rule10_slot0_label_is_discuss_with_agent(interview_text: str) -> None:
    """Slot 0 must carry the literal label `0. Discuss with agent`."""
    assert "0. Discuss with agent" in interview_text, (
        f"{_INTERVIEW_PATH}: slot 0 must be labelled `0. Discuss with agent` "
        "(#431, #359)"
    )


def test_rule10_slot0_distinct_from_other(interview_text: str) -> None:
    """Rule 10 must declare slot-0 DISTINCT from `Other / I don't know`."""
    lower = interview_text.lower()
    assert "distinct from `other / i don't know`" in lower, (
        f"{_INTERVIEW_PATH}: Rule 10 must state slot-0 is distinct from "
        "`Other / I don't know` (#431)"
    )


def test_rule10_slot0_visually_separated(interview_text: str) -> None:
    """Rule 10 must require visual separation between slot 0 and the numbered
    answer options (e.g. horizontal rule or blank line)."""
    lower = interview_text.lower()
    assert "visually separated" in lower, (
        f"{_INTERVIEW_PATH}: Rule 10 must require visual separation of slot 0 "
        "(#431)"
    )
    assert "horizontal rule" in lower or "blank line" in lower, (
        f"{_INTERVIEW_PATH}: Rule 10 must name the separator mechanism "
        "(horizontal rule or blank line) (#431)"
    )


def test_rule10_anti_pattern_merge_discuss_with_other(interview_text: str) -> None:
    """Anti-patterns must prohibit merging slot-0 Discuss with Other/IDK."""
    lower = interview_text.lower()
    assert "merge slot-0 `discuss with agent` with `other" in lower, (
        f"{_INTERVIEW_PATH}: must prohibit merging slot-0 `Discuss with agent` "
        "with `Other / I don't know` (#431)"
    )


def test_rule10_anti_pattern_no_pause_escape_labels(interview_text: str) -> None:
    """Anti-patterns must prohibit non-self-describing slot-0 labels such as
    `Pause`, `Escape`, `Other..`."""
    lower = interview_text.lower()
    assert "non-self-describing label for slot 0" in lower, (
        f"{_INTERVIEW_PATH}: must prohibit non-self-describing slot-0 labels "
        "(#431)"
    )


def test_rule10_old_pause_label_not_present(interview_text: str) -> None:
    """The old `Pause -- discuss this question with the agent` label must be
    gone -- it was renamed to `Discuss with agent` in #431."""
    assert "Pause -- discuss this question with the agent" not in interview_text, (
        f"{_INTERVIEW_PATH}: old slot-0 label `Pause -- discuss this question "
        "with the agent` must be replaced with `Discuss with agent` (#431)"
    )


# ---------------------------------------------------------------------------
# 4. Persistent one-line legend (Rule 11)
# ---------------------------------------------------------------------------


def test_rule11_heading_present(interview_text: str) -> None:
    """Rule 11 (Persistent Legend) must be a named section."""
    assert "### Rule 11: Persistent Legend Under Each Question" in interview_text, (
        f"{_INTERVIEW_PATH}: Rule 11 heading missing (#431)"
    )


def test_rule11_canonical_legend_present(interview_text: str) -> None:
    """The canonical legend string must appear verbatim at least once."""
    assert _CANONICAL_LEGEND in interview_text, (
        f"{_INTERVIEW_PATH}: canonical legend '{_CANONICAL_LEGEND}' must appear "
        "verbatim in Rule 11 (#431)"
    )


def test_rule11_legend_in_rule2_example(interview_text: str) -> None:
    """The Rule 2 example (numbered options) must show the legend so agents
    see the canonical layout in a non-trivial example."""
    # Find the first options block example and confirm the legend follows it.
    rule2_start = interview_text.find("### Rule 2:")
    rule3_start = interview_text.find("### Rule 3:")
    assert rule2_start != -1 and rule3_start != -1, (
        f"{_INTERVIEW_PATH}: Rule 2 and Rule 3 headings must both be present"
    )
    rule2_block = interview_text[rule2_start:rule3_start]
    assert _CANONICAL_LEGEND in rule2_block, (
        f"{_INTERVIEW_PATH}: Rule 2 example must show the canonical legend "
        "'{0}' under the options block (#431)".format(_CANONICAL_LEGEND)
    )


def test_rule11_legend_in_rule8_example(interview_text: str) -> None:
    """The Rule 8 example (confirm step) must also show the legend."""
    rule8_start = interview_text.find("### Rule 8:")
    rule9_start = interview_text.find("### Rule 9:")
    assert rule8_start != -1 and rule9_start != -1, (
        f"{_INTERVIEW_PATH}: Rule 8 and Rule 9 headings must both be present"
    )
    rule8_block = interview_text[rule8_start:rule9_start]
    assert _CANONICAL_LEGEND in rule8_block, (
        f"{_INTERVIEW_PATH}: Rule 8 example must show the canonical legend "
        "under the options block (#431)"
    )


def test_rule11_legend_every_question(interview_text: str) -> None:
    """Rule 11 must require the legend to appear on EVERY deterministic
    question (not only at the start of the interview)."""
    lower = interview_text.lower()
    assert "must be present under every deterministic question" in lower, (
        f"{_INTERVIEW_PATH}: Rule 11 must require the legend under every "
        "deterministic question (#431)"
    )


def test_rule11_anti_pattern_missing_legend(interview_text: str) -> None:
    """Anti-patterns must prohibit rendering a question without the legend."""
    lower = interview_text.lower()
    assert "without the persistent" in lower and "legend" in lower, (
        f"{_INTERVIEW_PATH}: must have anti-pattern against omitting the "
        "persistent legend (#431)"
    )


# ---------------------------------------------------------------------------
# 5. Mirror: .agents thin pointer remains in place
# ---------------------------------------------------------------------------


def test_agents_pointer_exists_and_points_to_canonical() -> None:
    """The .agents thin pointer must still exist and redirect to the canonical
    skill path -- mirroring is by reference, not by copy."""
    pointer = (_REPO_ROOT / _AGENTS_POINTER_PATH)
    assert pointer.is_file(), (
        f"Thin pointer missing: {_AGENTS_POINTER_PATH} (#431)"
    )
    text = pointer.read_text(encoding="utf-8")
    assert "skills/deft-directive-interview/SKILL.md" in text, (
        f"{_AGENTS_POINTER_PATH}: must redirect to the canonical SKILL.md "
        "(#431)"
    )
