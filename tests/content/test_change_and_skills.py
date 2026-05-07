"""
test_change_and_skills.py -- Acceptance criteria tests for issues #371, #372, #345, #359.

Verifies:
  - commands.md references proposal.vbrief.json (not proposal.md as output)
  - commands.md references delta.vbrief.json format
  - deft-directive-build SKILL.md references proposal.vbrief.json in Change Lifecycle Gate
  - deft-directive-interview SKILL.md does NOT reference PRD.md as authoritative output
  - deft-directive-interview SKILL.md contains confirmation step
  - deft-directive-interview SKILL.md contains backward navigation
  - deft-directive-setup SKILL.md Phase 3 references vBRIEF draft approval

Author: agent (swarm-agent4) -- 2026-04-14
"""

from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Repo root
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read(rel_path: str) -> str:
    return (_REPO_ROOT / rel_path).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# #371: commands.md references proposal.vbrief.json (not proposal.md as output)
# ---------------------------------------------------------------------------

def test_commands_md_references_proposal_vbrief_json() -> None:
    """commands.md must reference proposal.vbrief.json in the Artifacts section."""
    text = _read("commands.md")
    assert "proposal.vbrief.json" in text, (
        "commands.md: must reference proposal.vbrief.json in the Artifacts section"
    )


def test_commands_md_no_proposal_md_as_output_artifact() -> None:
    """commands.md must not list proposal.md as an output artifact in the tree."""
    text = _read("commands.md")
    # The artifact tree should not contain proposal.md as a created file
    # (it may still appear in CHANGELOG references to old behavior)
    lines = text.split("\n")
    in_artifacts = False
    for line in lines:
        if "### Artifacts" in line:
            in_artifacts = True
        elif line.startswith("### ") and in_artifacts:
            break
        if in_artifacts and "proposal.md" in line and "proposal.vbrief.json" not in line:
            pytest.fail(
                "commands.md: Artifacts section still references proposal.md "
                "as an output -- should be proposal.vbrief.json"
            )


def test_commands_md_no_design_md_as_output_artifact() -> None:
    """commands.md must not list design.md as an output artifact in the tree."""
    text = _read("commands.md")
    lines = text.split("\n")
    in_artifacts = False
    for line in lines:
        if "### Artifacts" in line:
            in_artifacts = True
        elif line.startswith("### ") and in_artifacts:
            break
        if in_artifacts and "design.md" in line:
            pytest.fail(
                "commands.md: Artifacts section still references design.md "
                "as an output -- should be proposal.vbrief.json"
            )


# ---------------------------------------------------------------------------
# #372: commands.md references delta.vbrief.json format
# ---------------------------------------------------------------------------

def test_commands_md_references_delta_vbrief_json() -> None:
    """commands.md specs/ section must reference delta.vbrief.json format."""
    text = _read("commands.md")
    assert "delta.vbrief.json" in text, (
        "commands.md: specs/ section must reference delta.vbrief.json format"
    )


def test_commands_md_no_spec_md_in_specs_section() -> None:
    """commands.md specs/ section must not reference spec.md as the active format."""
    text = _read("commands.md")
    lines = text.split("\n")
    in_specs = False
    for line in lines:
        if line.strip() == "### specs/":
            in_specs = True
        elif line.startswith("### ") and in_specs:
            break
        if in_specs and "spec.md" in line and "delta.vbrief.json" not in line:
            # Anti-pattern lines that prohibit spec.md are OK
            if "\u2297" in line:
                continue
            pytest.fail(
                "commands.md: specs/ section still references spec.md "
                "-- should use delta.vbrief.json format"
            )


# ---------------------------------------------------------------------------
# #371: deft-directive-build SKILL.md references proposal.vbrief.json
# ---------------------------------------------------------------------------

def test_build_skill_references_proposal_vbrief_json() -> None:
    """deft-directive-build SKILL.md Change Lifecycle Gate must reference proposal.vbrief.json."""
    text = _read("skills/deft-directive-build/SKILL.md")
    assert "proposal.vbrief.json" in text, (
        "skills/deft-directive-build/SKILL.md: Change Lifecycle Gate must "
        "reference proposal.vbrief.json"
    )


# ---------------------------------------------------------------------------
# #345: deft-directive-interview SKILL.md does NOT reference PRD.md as
# authoritative output
# ---------------------------------------------------------------------------

def test_interview_skill_no_authoritative_prd() -> None:
    """deft-directive-interview SKILL.md must not reference PRD.md as authoritative output."""
    text = _read("skills/deft-directive-interview/SKILL.md")
    # PRD.md may appear in deprecation notes, but never as an authoritative artifact
    for line in text.split("\n"):
        lowered = line.lower()
        if "prd.md" in lowered and "authoritative" in lowered:
            # Allowed: lines that say PRD.md is NOT authoritative (contains negation)
            if "never" in lowered or "not" in lowered or "\u2297" in line:
                continue
            pytest.fail(
                "skills/deft-directive-interview/SKILL.md: must not reference "
                "PRD.md as authoritative output -- found: " + line.strip()
            )


def test_interview_skill_output_targets_vbrief() -> None:
    """deft-directive-interview output must target specification.vbrief.json."""
    text = _read("skills/deft-directive-interview/SKILL.md")
    assert "specification.vbrief.json" in text, (
        "skills/deft-directive-interview/SKILL.md: Output Targets must "
        "reference specification.vbrief.json as the target"
    )


# ---------------------------------------------------------------------------
# #359: deft-directive-interview SKILL.md contains confirmation step
# ---------------------------------------------------------------------------

def test_interview_skill_has_selection_confirmation() -> None:
    """deft-directive-interview must require confirmation after number selection."""
    text = _read("skills/deft-directive-interview/SKILL.md")
    assert "Deterministic Selection Confirmation" in text, (
        "skills/deft-directive-interview/SKILL.md: must contain a "
        "'Deterministic Selection Confirmation' rule (issue #359)"
    )


def test_interview_skill_has_backward_navigation() -> None:
    """deft-directive-interview must support backward navigation."""
    text = _read("skills/deft-directive-interview/SKILL.md")
    assert "Backward Navigation" in text, (
        "skills/deft-directive-interview/SKILL.md: must contain a "
        "'Backward Navigation' rule (issue #359)"
    )


def test_interview_skill_has_option_zero_escape() -> None:
    """deft-directive-interview must include option 0 freeform escape hatch."""
    text = _read("skills/deft-directive-interview/SKILL.md")
    assert "Option 0" in text or "option 0" in text or "Freeform Conversation Escape" in text, (
        "skills/deft-directive-interview/SKILL.md: must contain an "
        "option 0 / freeform conversation escape rule (issue #359)"
    )


# ---------------------------------------------------------------------------
# #345: deft-directive-setup SKILL.md Phase 3 references vBRIEF draft approval
# ---------------------------------------------------------------------------

def test_setup_skill_phase3_vbrief_draft_approval() -> None:
    """deft-directive-setup Phase 3 must reference vBRIEF draft approval gate."""
    text = _read("skills/deft-directive-setup/SKILL.md")
    # Phase 3 must mention specification.vbrief.json as the draft and
    # the human approval gate
    assert "specification.vbrief.json" in text, (
        "skills/deft-directive-setup/SKILL.md: Phase 3 must reference "
        "specification.vbrief.json as the draft output"
    )
    assert "approval" in text.lower() and "vbrief" in text.lower(), (
        "skills/deft-directive-setup/SKILL.md: Phase 3 must reference "
        "vBRIEF draft approval"
    )


def test_setup_skill_phase3_no_authoritative_prd() -> None:
    """deft-directive-setup Phase 3 must not generate authoritative PRD.md."""
    text = _read("skills/deft-directive-setup/SKILL.md")
    # Should have anti-pattern against authoritative PRD.md
    assert "\u2297" in text and "authoritative PRD.md" in text, (
        "skills/deft-directive-setup/SKILL.md: must contain a \u2297 rule "
        "against generating an authoritative PRD.md"
    )
