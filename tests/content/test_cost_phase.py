"""
test_cost_phase.py -- Structural and content checks for the pre-build cost
& budget transparency phase (#739, refs #151 umbrella).

Verifies:
  - skills/deft-directive-cost/SKILL.md exists with required sections
  - templates/COST-ESTIMATE.md exists as the canonical artifact body
  - references/cost-models.md exists capturing the cost-model methodology
  - skills/deft-directive-build/SKILL.md gates kickoff on COST-ESTIMATE.md
    and a recorded build/rescope/no-build/skip(+reason) decision
  - The build kickoff confirmation menu has Discuss + Back as the final two
    numbered options per the #767 framework rule
  - Plain-English voice -- jargon terms are absent from the user-facing
    artifact body and skill prose

Author: agent3 (swarm) -- 2026-04-30
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Repo root
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_COST_SKILL_PATH = "skills/deft-directive-cost/SKILL.md"
_BUILD_SKILL_PATH = "skills/deft-directive-build/SKILL.md"
_COST_TEMPLATE_PATH = "templates/COST-ESTIMATE.md"
_COST_MODELS_PATH = "references/cost-models.md"

_RFC2119_LEGEND = "!=MUST, ~=SHOULD"

# Jargon terms that MUST NOT appear in the user-facing artifact body or the
# user-facing skill prose. Audience is non-technical end users; the cost-models
# methodology document is allowed to mention these terms in its anti-pattern
# block (it is a methodology reference for agents, not the artifact).
_JARGON_TERMS = (
    "TCO",
    "burn rate",
    "p50",
    "OPEX vs CAPEX",
    "amortised",
    "blended rate",
    "unit economics",
    "FTE",
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read(rel_path: str) -> str:
    return (_REPO_ROOT / rel_path).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# 1. Files exist at their expected paths
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "rel_path",
    [_COST_SKILL_PATH, _COST_TEMPLATE_PATH, _COST_MODELS_PATH],
)
def test_cost_phase_artifact_exists(rel_path: str) -> None:
    """Each cost-phase artifact must exist at its expected path (#739)."""
    assert (_REPO_ROOT / rel_path).is_file(), (
        f"Cost-phase artifact missing: {rel_path} (#739)"
    )


# ---------------------------------------------------------------------------
# 2. skills/deft-directive-cost/SKILL.md structure
# ---------------------------------------------------------------------------

def test_cost_skill_has_frontmatter() -> None:
    """deft-directive-cost must start with YAML frontmatter and have name."""
    text = _read(_COST_SKILL_PATH)
    assert text.startswith("---"), (
        f"{_COST_SKILL_PATH}: must start with YAML frontmatter '---'"
    )
    assert "name: deft-directive-cost" in text, (
        f"{_COST_SKILL_PATH}: frontmatter must contain 'name: deft-directive-cost'"
    )


def test_cost_skill_rfc2119_legend_present() -> None:
    """deft-directive-cost must contain the RFC2119 legend line."""
    text = _read(_COST_SKILL_PATH)
    assert _RFC2119_LEGEND in text, (
        f"{_COST_SKILL_PATH}: missing RFC2119 legend '{_RFC2119_LEGEND}'"
    )


def test_cost_skill_platform_detection_section() -> None:
    """deft-directive-cost must contain a Platform Detection section."""
    text = _read(_COST_SKILL_PATH)
    assert "## Platform Detection" in text, (
        f"{_COST_SKILL_PATH}: missing '## Platform Detection' section"
    )
    assert "%APPDATA%" in text and "~/.config/deft/USER.md" in text, (
        f"{_COST_SKILL_PATH}: Platform Detection must cover Windows + Unix paths"
    )
    assert "$DEFT_USER_PATH" in text, (
        f"{_COST_SKILL_PATH}: Platform Detection must mention $DEFT_USER_PATH"
    )


def test_cost_skill_decision_point_phase() -> None:
    """deft-directive-cost must contain a decision-point phase covering all four
    user choices (build / rescope / no-build / skip)."""
    text = _read(_COST_SKILL_PATH)
    assert "Decision point" in text or "decision point" in text, (
        f"{_COST_SKILL_PATH}: missing decision-point phase"
    )
    for choice in ("Build", "Rescope", "No-build", "Skip"):
        assert choice in text, (
            f"{_COST_SKILL_PATH}: decision menu must include '{choice}' option"
        )


def test_cost_skill_kickoff_menu_discuss_back_final_two_options() -> None:
    """Build kickoff confirmation menu MUST place Discuss + Back as the final
    two numbered options per the #767 framework rule."""
    text = _read(_COST_SKILL_PATH)
    # Stable token from the menu block: lines like "5. Discuss" and "6. Back"
    # MUST appear, with Discuss strictly before Back, and Back as the last
    # numbered option.
    discuss_match = re.search(r"^(\d+)\.\s+Discuss\b", text, flags=re.MULTILINE)
    back_match = re.search(r"^(\d+)\.\s+Back\b", text, flags=re.MULTILINE)
    assert discuss_match is not None, (
        f"{_COST_SKILL_PATH}: kickoff menu must contain a numbered 'Discuss' option (#767)"
    )
    assert back_match is not None, (
        f"{_COST_SKILL_PATH}: kickoff menu must contain a numbered 'Back' option (#767)"
    )
    discuss_n = int(discuss_match.group(1))
    back_n = int(back_match.group(1))
    # Back must be exactly one greater than Discuss (Discuss is penultimate,
    # Back is the final numbered option).
    assert back_n == discuss_n + 1, (
        f"{_COST_SKILL_PATH}: kickoff menu must place Discuss + Back as the final "
        f"two consecutive numbered options (got Discuss={discuss_n}, Back={back_n}) (#767)"
    )
    # No numbered option after Back -- WITHIN THE MENU BLOCK ONLY. The scan
    # is scoped to the fence-delimited code block surrounding `Discuss` /
    # `Back` so an unrelated numbered list elsewhere in the SKILL (e.g. a
    # 7-item anti-pattern enumeration in the future) does not cause a
    # spurious failure on a structurally correct menu (Greptile P2 #772).
    fence_pattern = re.compile(r"```[^\n]*\n(.*?)```", flags=re.DOTALL)
    menu_blocks = [
        block for block in fence_pattern.findall(text)
        if "Discuss" in block and "Back" in block
    ]
    assert menu_blocks, (
        f"{_COST_SKILL_PATH}: could not locate the fence-delimited kickoff menu "
        f"block containing both 'Discuss' and 'Back' (#767)"
    )
    # Pick the menu block (first match) and assert no later numbered option.
    menu_block = menu_blocks[0]
    later_options = re.findall(r"^(\d+)\.\s+\w+", menu_block, flags=re.MULTILINE)
    later_options_int = [int(n) for n in later_options]
    assert back_n == max(later_options_int), (
        f"{_COST_SKILL_PATH}: 'Back' must be the FINAL numbered option in the kickoff "
        f"menu block (#767) -- found a higher-numbered option after Back"
    )


def test_cost_skill_skip_requires_reason() -> None:
    """deft-directive-cost must require a recorded reason on skip."""
    text = _read(_COST_SKILL_PATH)
    lower = text.lower()
    # Skill must call out that skip records a short reason / required.
    assert "skip" in lower and "reason" in lower, (
        f"{_COST_SKILL_PATH}: must require a recorded reason on skip"
    )


def test_cost_skill_rescope_loop() -> None:
    """deft-directive-cost must describe a rescope loop back to spec edits."""
    text = _read(_COST_SKILL_PATH)
    assert "Rescope" in text, (
        f"{_COST_SKILL_PATH}: must surface a Rescope decision option"
    )
    # Rescope must chain back to spec edits / setup before re-running.
    lower = text.lower()
    assert "spec edit" in lower or "spec edits" in lower, (
        f"{_COST_SKILL_PATH}: rescope must redirect to spec edits"
    )
    assert "re-run" in lower or "re-runs" in lower, (
        f"{_COST_SKILL_PATH}: rescope must re-run the cost phase after spec edits"
    )


def test_cost_skill_anti_patterns_section() -> None:
    """deft-directive-cost must have an Anti-Patterns section."""
    text = _read(_COST_SKILL_PATH)
    assert "## Anti-Patterns" in text, (
        f"{_COST_SKILL_PATH}: missing '## Anti-Patterns' section"
    )


def test_cost_skill_exit_block() -> None:
    """deft-directive-cost must have an EXIT block per AGENTS.md skill completion gate."""
    text = _read(_COST_SKILL_PATH)
    assert "## EXIT" in text, (
        f"{_COST_SKILL_PATH}: missing '## EXIT' block"
    )
    assert "exiting skill" in text.lower(), (
        f"{_COST_SKILL_PATH}: EXIT block must contain 'exiting skill' confirmation"
    )


# ---------------------------------------------------------------------------
# 3. templates/COST-ESTIMATE.md structure
# ---------------------------------------------------------------------------

def test_cost_template_has_required_sections() -> None:
    """COST-ESTIMATE.md template must cover the required structural sections."""
    text = _read(_COST_TEMPLATE_PATH)
    required = (
        "# Cost & Budget Estimate",
        "## TL;DR",
        "## What you will need to sign up for",
        "## Hosting & infrastructure",
        "## API & third-party fees",
        "## Monthly band",
        "## Scale considerations",
        "## Decision point",
        "### Decision recorded",
    )
    for heading in required:
        assert heading in text, (
            f"{_COST_TEMPLATE_PATH}: missing required section '{heading}' (#739)"
        )


def test_cost_template_low_typical_high_band() -> None:
    """Monthly band MUST express low / typical / high -- not point estimates."""
    text = _read(_COST_TEMPLATE_PATH)
    for token in ("**Low**", "**Typical**", "**High**"):
        assert token in text, (
            f"{_COST_TEMPLATE_PATH}: monthly band must include '{token}'"
        )


def test_cost_template_decision_options_all_four() -> None:
    """Decision point in the template must list all four user choices."""
    text = _read(_COST_TEMPLATE_PATH)
    for choice in ("Build", "Rescope", "No-build", "Skip"):
        assert f"**{choice}**" in text, (
            f"{_COST_TEMPLATE_PATH}: decision point must list '{choice}' option"
        )


def test_cost_template_usd_only_first_pass() -> None:
    """COST-ESTIMATE.md must state USD up top so international users convert."""
    text = _read(_COST_TEMPLATE_PATH)
    assert "USD" in text, (
        f"{_COST_TEMPLATE_PATH}: must state 'USD' explicitly (USD-only first pass)"
    )


def test_cost_template_no_jargon_in_user_artifact() -> None:
    """Plain-English voice: jargon terms MUST NOT appear in the artifact body."""
    text = _read(_COST_TEMPLATE_PATH)
    for term in _JARGON_TERMS:
        assert term not in text, (
            f"{_COST_TEMPLATE_PATH}: jargon term '{term}' must not appear in the "
            f"user-facing artifact body (audience is non-technical) (#739)"
        )


# ---------------------------------------------------------------------------
# 4. references/cost-models.md methodology
# ---------------------------------------------------------------------------

def test_cost_models_has_methodology_sections() -> None:
    """cost-models.md must capture the methodology sections."""
    text = _read(_COST_MODELS_PATH)
    required = (
        "## Scope",
        "## Core Principles",
        "## Where Costs Come From",
        "## Building the Monthly Band",
        "## Decision Point",
        "## Plain-English Voice",
        "## Anti-Patterns",
    )
    for heading in required:
        assert heading in text, (
            f"{_COST_MODELS_PATH}: missing methodology section '{heading}' (#739)"
        )


def test_cost_models_usd_only_documented() -> None:
    """cost-models.md must document the USD-only first-pass contract."""
    text = _read(_COST_MODELS_PATH)
    lower = text.lower()
    assert "usd-only" in lower or "usd only" in lower, (
        f"{_COST_MODELS_PATH}: must document USD-only first pass"
    )


def test_cost_models_no_hard_numbers_promise() -> None:
    """cost-models.md must declare loose ranges over hard numbers."""
    text = _read(_COST_MODELS_PATH)
    lower = text.lower()
    assert "loose ranges" in lower, (
        f"{_COST_MODELS_PATH}: must promise loose ranges, not hard numbers"
    )


# ---------------------------------------------------------------------------
# 5. Build skill cost-phase gate (#739)
# ---------------------------------------------------------------------------

def test_build_skill_cost_phase_gate_section() -> None:
    """deft-directive-build must contain a Cost Phase Gate section."""
    text = _read(_BUILD_SKILL_PATH)
    assert "## Cost Phase Gate" in text, (
        f"{_BUILD_SKILL_PATH}: missing '## Cost Phase Gate' section (#739)"
    )
    assert "#739" in text, (
        f"{_BUILD_SKILL_PATH}: Cost Phase Gate must cite issue #739"
    )


def test_build_skill_cost_gate_refuses_without_artifact() -> None:
    """Build skill's Cost Phase Gate must refuse kickoff without COST-ESTIMATE.md."""
    text = _read(_BUILD_SKILL_PATH)
    assert "COST-ESTIMATE.md" in text, (
        f"{_BUILD_SKILL_PATH}: Cost Phase Gate must reference COST-ESTIMATE.md"
    )
    # Must redirect to the cost skill on miss
    assert "skills/deft-directive-cost/SKILL.md" in text, (
        f"{_BUILD_SKILL_PATH}: must redirect to deft-directive-cost on miss"
    )


def test_build_skill_cost_gate_decision_states() -> None:
    """Build skill's gate must handle all four decisions: build/rescope/no-build/skip."""
    text = _read(_BUILD_SKILL_PATH)
    # Locate the Cost Phase Gate section and check decision-state coverage there.
    gate_start = text.find("## Cost Phase Gate")
    gate_end = text.find("\n## ", gate_start + 1)
    gate_section = text[gate_start:gate_end] if gate_end != -1 else text[gate_start:]
    for state in ("build", "rescope", "no-build", "skip"):
        assert state in gate_section.lower(), (
            f"{_BUILD_SKILL_PATH}: Cost Phase Gate must describe '{state}' decision (#739)"
        )


def test_build_skill_cost_gate_skip_requires_reason() -> None:
    """Build skill's gate must require a reason on skip."""
    text = _read(_BUILD_SKILL_PATH)
    gate_start = text.find("## Cost Phase Gate")
    gate_end = text.find("\n## ", gate_start + 1)
    gate_section = text[gate_start:gate_end] if gate_end != -1 else text[gate_start:]
    assert "reason" in gate_section.lower(), (
        f"{_BUILD_SKILL_PATH}: Cost Phase Gate must require a reason on "
        f"skip / rescope / no-build decisions (#739)"
    )


def test_build_skill_cost_gate_anti_pattern() -> None:
    """Build skill's Anti-Patterns must prohibit proceeding without the cost decision."""
    text = _read(_BUILD_SKILL_PATH)
    lower = text.lower()
    assert "cost-estimate.md" in lower and "cost phase gate" in lower, (
        f"{_BUILD_SKILL_PATH}: Anti-Patterns must prohibit proceeding without "
        f"COST-ESTIMATE.md and a Cost Phase Gate decision (#739)"
    )


# ---------------------------------------------------------------------------
# 6. AGENTS.md routing entry
# ---------------------------------------------------------------------------

def test_agents_md_cost_routing_entry() -> None:
    """AGENTS.md Skill Routing must include a cost / budget keyword mapping."""
    text = _read("AGENTS.md")
    # Routing table line shape: '- "cost" / ... -> skills/deft-directive-cost/SKILL.md'
    assert "skills/deft-directive-cost/SKILL.md" in text, (
        "AGENTS.md: missing routing entry mapping to skills/deft-directive-cost/SKILL.md (#739)"
    )
    # At least one of the trigger keywords must be present near the path.
    assert '"cost"' in text or '"budget"' in text or '"pre-build cost"' in text, (
        "AGENTS.md: cost-routing entry must list at least one of "
        "'cost', 'budget', or 'pre-build cost' as a trigger keyword (#739)"
    )


# ---------------------------------------------------------------------------
# 7. Plain-English voice -- jargon terms absent from user-facing surfaces
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("term", _JARGON_TERMS)
def test_cost_skill_no_jargon_outside_anti_pattern(term: str) -> None:
    """Plain-English voice: jargon terms must not appear in user-facing skill
    prose outside the Anti-Patterns block (where they are explicitly listed
    as terms to AVOID)."""
    text = _read(_COST_SKILL_PATH)
    # Split on the Anti-Patterns heading; the AP block is allowed to enumerate
    # terms users should not see. The body before AP is user-facing prose.
    ap_marker = "## Anti-Patterns"
    if ap_marker in text:
        prose, _ap_block = text.split(ap_marker, 1)
    else:
        prose = text
    # The "Audience & Voice" block is also allowed to list terms as
    # forbidden-jargon examples; treat it the same way as Anti-Patterns.
    audience_marker = "## Audience & Voice"
    next_section = "## Platform Detection"
    if audience_marker in prose and next_section in prose:
        before = prose.split(audience_marker, 1)[0]
        after = prose.split(next_section, 1)[1]
        prose_for_check = before + after
    else:
        prose_for_check = prose
    assert term not in prose_for_check, (
        f"{_COST_SKILL_PATH}: jargon term '{term}' appears in user-facing "
        f"prose outside the Anti-Patterns / Audience & Voice block -- the "
        f"audience is non-technical (#739)"
    )
