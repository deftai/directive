"""
test_interview_always_structured.py -- Content assertions for the #478
Option A (always-structured) rendering rule + mode-restore + preamble
guidance in skills/deft-directive-interview/SKILL.md, plus the setup skill
phase-transition prose rewrites.

Covers sub-tasks 478-1 through 478-6 from vbrief/active/2026-04-21-478-
interview-always-structured.vbrief.json:

    478-1 -- Option A always-structured MUST rule in interview SKILL.md
    478-2 -- Rule 6 mode-restore clause (plain-text gate does not stick)
    478-3 -- Preamble-above-tool-call guidance
    478-4 -- setup SKILL.md phase-transition prompts rewritten as structured-
             tool MUSTs (no more `~ Ask if user wants to continue to Phase X`)
    478-5 -- This test file itself
    478-6 -- Explicitly do NOT add the `rendering_policy` frontmatter flag
             (reserved for #476, deferred)
"""

from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Repo root + target files
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_INTERVIEW_PATH = "skills/deft-directive-interview/SKILL.md"
_SETUP_PATH = "skills/deft-directive-setup/SKILL.md"


@pytest.fixture(scope="module")
def interview_text() -> str:
    return (_REPO_ROOT / _INTERVIEW_PATH).read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def setup_text() -> str:
    return (_REPO_ROOT / _SETUP_PATH).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# 478-1: Option A always-structured MUST rule in interview SKILL.md
# ---------------------------------------------------------------------------


def test_always_structured_subsection_present(interview_text: str) -> None:
    """An Always-Structured Rendering subsection MUST exist (#478 Fix 1 /
    Option A)."""
    assert "Always-Structured Rendering" in interview_text, (
        f"{_INTERVIEW_PATH}: missing 'Always-Structured Rendering' subsection "
        "(Option A, #478)"
    )


def test_always_structured_option_a_label(interview_text: str) -> None:
    """The always-structured subsection MUST be labelled as Option A to
    match #478's terminology (#478 Fix 1)."""
    assert "Option A" in interview_text, (
        f"{_INTERVIEW_PATH}: Always-Structured Rendering subsection MUST be "
        "labelled 'Option A' to match #478 (#478 Fix 1)"
    )


def test_always_structured_every_user_facing_question(
    interview_text: str,
) -> None:
    """The always-structured rule MUST require EVERY user-facing question to
    render via the structured tool (#478 Fix 1)."""
    lower = interview_text.lower()
    assert "every user-facing question must render via the structured" in lower, (
        f"{_INTERVIEW_PATH}: Always-Structured Rendering MUST require EVERY "
        "user-facing question to render via the structured tool (#478 Fix 1)"
    )


def test_always_structured_two_step_freeform(interview_text: str) -> None:
    """Freeform answer collection MUST be described as a two-step flow
    (#478 Fix 1)."""
    lower = interview_text.lower()
    assert "two-step flow" in lower, (
        f"{_INTERVIEW_PATH}: Always-Structured Rendering MUST describe freeform "
        "answer collection as a two-step flow (#478 Fix 1)"
    )


def test_always_structured_permissible_plain_text_emissions(
    interview_text: str,
) -> None:
    """The always-structured rule MUST enumerate the only permissible plain-
    text-to-user emissions: Rule 6 Gate + non-question status updates
    (#478 Fix 1)."""
    lower = interview_text.lower()
    assert "only permissible plain-text-to-user emissions" in lower, (
        f"{_INTERVIEW_PATH}: Always-Structured Rendering MUST enumerate the "
        "only permissible plain-text-to-user emissions (#478 Fix 1)"
    )
    assert "status update" in lower, (
        f"{_INTERVIEW_PATH}: non-question status updates MUST be named as a "
        "permissible plain-text emission (#478 Fix 1)"
    )


def test_always_structured_prose_anti_pattern(interview_text: str) -> None:
    """There MUST be a MUST NOT against emitting a user-facing question as
    conversational prose for any of the four named reasons (#478 Fix 1)."""
    lower = interview_text.lower()
    assert (
        "answer content is prose" in lower
        and "preamble is long" in lower
        and "feels conversational" in lower
        and "prior question was plain-text" in lower
    ), (
        f"{_INTERVIEW_PATH}: MUST NOT rule MUST cover all four invalid "
        "reasons (prose content, long preamble, 'feels conversational', "
        "prior question was plain-text) (#478 Fix 1)"
    )


# ---------------------------------------------------------------------------
# 478-2: Rule 6 mode-restore clause
# ---------------------------------------------------------------------------


def test_rule6_mode_restore_subsection(interview_text: str) -> None:
    """Rule 6 MUST contain a Mode Restore subsection declaring plain-text
    mode is released after the typed commit (#478 Fix 2)."""
    rule6_start = interview_text.find("### Rule 6:")
    rule7_start = interview_text.find("### Rule 7:")
    assert rule6_start != -1 and rule7_start != -1
    rule6_block = interview_text[rule6_start:rule7_start]
    assert "Mode Restore" in rule6_block, (
        f"{_INTERVIEW_PATH}: Rule 6 MUST contain a Mode Restore subsection "
        "(#478 Fix 2)"
    )


def test_rule6_mode_released_after_commit(interview_text: str) -> None:
    """Rule 6 mode-restore MUST state plain-text mode is RELEASED after the
    typed commit (#478 Fix 2)."""
    rule6_start = interview_text.find("### Rule 6:")
    rule7_start = interview_text.find("### Rule 7:")
    rule6_block = interview_text[rule6_start:rule7_start]
    assert "RELEASED" in rule6_block, (
        f"{_INTERVIEW_PATH}: Rule 6 mode-restore MUST state plain-text mode "
        "is RELEASED after the typed commit (#478 Fix 2)"
    )


def test_rule6_sticky_mode_anti_pattern(interview_text: str) -> None:
    """Rule 6 MUST carry a MUST NOT against rendering the next question as
    plain-text because the Gate was plain-text (#478 Fix 2)."""
    rule6_start = interview_text.find("### Rule 6:")
    rule7_start = interview_text.find("### Rule 7:")
    rule6_block = interview_text[rule6_start:rule7_start].lower()
    assert (
        "\u2297 render the next user-facing question as plain-text" in rule6_block
    ), (
        f"{_INTERVIEW_PATH}: Rule 6 MUST carry a MUST NOT against rendering "
        "the next question as plain-text because the Gate was plain-text "
        "(#478 Fix 2)"
    )


def test_rule6_gate_does_not_establish_sticky_mode(
    interview_text: str,
) -> None:
    """Rule 6 mode-restore MUST explicitly state the gate does NOT establish
    a sticky mode (#478 Fix 2)."""
    rule6_start = interview_text.find("### Rule 6:")
    rule7_start = interview_text.find("### Rule 7:")
    rule6_block = interview_text[rule6_start:rule7_start].lower()
    assert "does not establish a sticky mode" in rule6_block, (
        f"{_INTERVIEW_PATH}: Rule 6 mode-restore MUST state the gate does "
        "NOT establish a sticky mode (#478 Fix 2)"
    )


# ---------------------------------------------------------------------------
# 478-3: Preamble-above-tool-call guidance
# ---------------------------------------------------------------------------


def test_preamble_placement_subsection(interview_text: str) -> None:
    """A Preamble Placement subsection MUST exist (#478 Fix 3)."""
    assert "Preamble Placement" in interview_text, (
        f"{_INTERVIEW_PATH}: missing 'Preamble Placement' subsection "
        "(#478 Fix 3)"
    )


def test_preamble_above_tool_call(interview_text: str) -> None:
    """Preamble guidance MUST state the preamble appears ABOVE the
    structured-tool call, not instead of it (#478 Fix 3)."""
    lower = interview_text.lower()
    assert "above the structured-tool call" in lower, (
        f"{_INTERVIEW_PATH}: Preamble Placement MUST state preamble appears "
        "ABOVE the structured-tool call (#478 Fix 3)"
    )


def test_preamble_question_in_tool_field(interview_text: str) -> None:
    """Preamble guidance MUST name the structured tool's `question` and
    `options` fields as the home of the question and its enumerable options
    (#478 Fix 3)."""
    lower = interview_text.lower()
    assert "`question` field" in lower and "`options` field" in lower, (
        f"{_INTERVIEW_PATH}: Preamble Placement MUST name the tool's "
        "`question` and `options` fields (#478 Fix 3)"
    )


def test_preamble_anti_pattern(interview_text: str) -> None:
    """There MUST be a MUST NOT against rendering a question as plain-text
    because you wanted preamble (#478 Fix 3)."""
    lower = interview_text.lower()
    assert (
        "\u2297 render a user-facing question as plain-text because you wanted"
        in lower
        or "\u2297 render a user-facing question as plain-text because you wanted "
        "to include" in lower
    ), (
        f"{_INTERVIEW_PATH}: MUST NOT rule against prose-because-preamble "
        "(#478 Fix 3)"
    )


# ---------------------------------------------------------------------------
# 478-4: setup SKILL.md phase-transition prompts rewritten
# ---------------------------------------------------------------------------


def test_setup_no_ask_if_user_wants_to_continue(setup_text: str) -> None:
    """skills/deft-directive-setup/SKILL.md MUST NOT contain the old
    `Ask if user wants to continue` phrasing (#478 Fix 4)."""
    assert "Ask if user wants to continue" not in setup_text, (
        f"{_SETUP_PATH}: old phase-transition phrasing 'Ask if user wants to "
        "continue' MUST be replaced by the structured-tool MUST rule "
        "(#478 Fix 4)"
    )


def test_setup_phase_transition_structured_tool_must_rule(
    setup_text: str,
) -> None:
    """skills/deft-directive-setup/SKILL.md phase-transition prompts MUST use
    the `! Emit a structured-tool question` phrasing (#478 Fix 4)."""
    # Expect at least three occurrences: Phase 1->2, Phase 2->3, Phase 3->build
    count = setup_text.count("Emit a structured-tool question")
    assert count >= 3, (
        f"{_SETUP_PATH}: expected >=3 occurrences of 'Emit a structured-tool "
        f"question' (Phase 1->2, Phase 2->3, Phase 3->build); found {count} "
        "(#478 Fix 4)"
    )


def test_setup_phase_transition_options_yes_not_now_discuss_back(
    setup_text: str,
) -> None:
    """Phase-transition prompts MUST enumerate the four options: Yes,
    Not now, Discuss, Back (#478 Fix 4)."""
    # Match the canonical options list format.
    assert (
        "Yes (continue)" in setup_text
        and "Not now" in setup_text
        and "Discuss" in setup_text
        and "Back (revisit previous phase)" in setup_text
    ), (
        f"{_SETUP_PATH}: phase-transition prompts MUST enumerate Yes / Not "
        "now / Discuss / Back options (#478 Fix 4)"
    )


def test_setup_phase1_to_phase2_transition_structured(setup_text: str) -> None:
    """The Phase 1 -> Phase 2 transition MUST use the structured-tool MUST
    rule (#478 Fix 4)."""
    phase1_then_start = setup_text.find("### Then", setup_text.find("## Phase 1"))
    phase2_start = setup_text.find("## Phase 2")
    assert phase1_then_start != -1 and phase2_start != -1 and phase1_then_start < phase2_start, (
        f"{_SETUP_PATH}: missing Phase 1 '### Then' before '## Phase 2'"
    )
    block = setup_text[phase1_then_start:phase2_start]
    assert "Emit a structured-tool question" in block and "Phase 2" in block, (
        f"{_SETUP_PATH}: Phase 1->2 transition MUST use the structured-tool "
        "MUST rule and name Phase 2 (#478 Fix 4)"
    )


def test_setup_phase2_to_phase3_transition_structured(setup_text: str) -> None:
    """The Phase 2 -> Phase 3 transition MUST use the structured-tool MUST
    rule (#478 Fix 4)."""
    phase2_then_start = setup_text.find("### Then", setup_text.find("## Phase 2"))
    phase3_start = setup_text.find("## Phase 3")
    assert phase2_then_start != -1 and phase3_start != -1 and phase2_then_start < phase3_start, (
        f"{_SETUP_PATH}: missing Phase 2 '### Then' before '## Phase 3'"
    )
    block = setup_text[phase2_then_start:phase3_start]
    assert "Emit a structured-tool question" in block and "Phase 3" in block, (
        f"{_SETUP_PATH}: Phase 2->3 transition MUST use the structured-tool "
        "MUST rule and name Phase 3 (#478 Fix 4)"
    )


def test_setup_phase3_to_build_transition_structured(setup_text: str) -> None:
    """The Phase 3 -> build handoff MUST use the structured-tool MUST rule
    (#478 Fix 4)."""
    handoff_start = setup_text.find("### Handoff to deft-directive-build")
    assert handoff_start != -1, (
        f"{_SETUP_PATH}: missing 'Handoff to deft-directive-build' section"
    )
    # Capture roughly 1 KB from the heading as the handoff block.
    block = setup_text[handoff_start:handoff_start + 2000]
    assert "Emit a structured-tool question" in block and "build phase" in block, (
        f"{_SETUP_PATH}: Phase 3->build handoff MUST use the structured-tool "
        "MUST rule and name the build phase (#478 Fix 4)"
    )


# ---------------------------------------------------------------------------
# 478-6: rendering_policy frontmatter flag is OUT OF SCOPE (reserved for #476)
# ---------------------------------------------------------------------------


def test_no_rendering_policy_frontmatter(interview_text: str) -> None:
    """The interview SKILL.md frontmatter MUST NOT contain a
    `rendering_policy` field; that flag is reserved for #476 (deferred)
    (#478 Fix 6)."""
    # Extract the frontmatter (bounded by leading `---` and the next `---`).
    assert interview_text.startswith("---"), (
        f"{_INTERVIEW_PATH}: expected YAML frontmatter starting with '---'"
    )
    frontmatter_end = interview_text.find("---", 3)
    assert frontmatter_end != -1, (
        f"{_INTERVIEW_PATH}: expected closing '---' for YAML frontmatter"
    )
    frontmatter = interview_text[:frontmatter_end]
    assert "rendering_policy" not in frontmatter, (
        f"{_INTERVIEW_PATH}: `rendering_policy` frontmatter flag MUST NOT be "
        "present -- it is reserved for #476 (deferred), per #478 review "
        "comment and #506 D1 (#478 Fix 6)"
    )
