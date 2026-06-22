"""
test_patterns_role_as_overlay.py -- Content gates for `patterns/role-as-overlay.md` (#816).

Covers the deft-side contract from issue #816: the new
`patterns/role-as-overlay.md` file MUST exist with an RFC2119 legend,
the canonical sections, the call > session > agent precedence chain,
the implementation contract for directive's own skills, the provider-
surface mapping, and the anti-pattern catalogue. The companion edit to
`REFERENCES.md` MUST carry the lazy-load entry so the new pattern stays
discoverable from the canonical index.

Mirrors the shape of `tests/content/test_patterns_llm_app.py`.
"""

from __future__ import annotations

from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

PATTERNS_ROLE_AS_OVERLAY = _REPO_ROOT / "content/patterns/role-as-overlay.md"
REFERENCES_MD = _REPO_ROOT / "REFERENCES.md"

RFC2119_LEGEND = "!=MUST, ~=SHOULD"

REQUIRED_SECTIONS = (
    "## The principle",
    "## Why this matters",
    "## Precedence",
    "## Implementation contract for skills and agents",
    "### Provider mapping",
    "## Anti-patterns",
    "## Cross-references",
)

FAILURE_MODES = (
    "History pollution",
    "Retrieval corruption",
    "Context rot acceleration",
    "False memory propagation",
    "Resumption breakage",
)

PRECEDENCE_TOKENS = (
    "call role",
    "session role",
    "agent role",
)

DIRECTIVE_SKILL_REFERENCES = (
    "deft-directive-review-cycle",
    "deft-directive-build",
    "deft-directive-pre-pr",
)

PROVIDER_SURFACE_TOKENS = (
    "Anthropic",
    "OpenAI Chat",
    "OpenAI Responses",
    "Gemini",
    "system_instruction",
    "instructions",
)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Existence + structural gates
# ---------------------------------------------------------------------------


def test_patterns_role_as_overlay_exists() -> None:
    """patterns/role-as-overlay.md MUST exist and be non-empty."""
    assert PATTERNS_ROLE_AS_OVERLAY.is_file(), (
        f"missing required file: {PATTERNS_ROLE_AS_OVERLAY.relative_to(_REPO_ROOT)} -- "
        "see issue #816 scope manifest"
    )
    text = _read(PATTERNS_ROLE_AS_OVERLAY)
    assert text.strip(), (
        f"{PATTERNS_ROLE_AS_OVERLAY.relative_to(_REPO_ROOT)}: file is empty"
    )


def test_patterns_role_as_overlay_has_rfc2119_legend() -> None:
    """patterns/role-as-overlay.md MUST carry the canonical RFC2119 legend."""
    text = _read(PATTERNS_ROLE_AS_OVERLAY)
    assert RFC2119_LEGEND in text, (
        f"patterns/role-as-overlay.md: missing RFC2119 legend "
        f"'{RFC2119_LEGEND}' -- add the Legend line near the top of the file"
    )


def test_patterns_role_as_overlay_cites_issue_number() -> None:
    """patterns/role-as-overlay.md MUST cite #816 so the origin trail is discoverable."""
    text = _read(PATTERNS_ROLE_AS_OVERLAY)
    assert "#816" in text, (
        "patterns/role-as-overlay.md: missing issue-number citation (#816) -- "
        "the acceptance issue MUST be discoverable from the file body"
    )


@pytest.mark.parametrize("heading", REQUIRED_SECTIONS)
def test_patterns_role_as_overlay_required_sections(heading: str) -> None:
    """Every canonical section heading MUST be present (#816)."""
    text = _read(PATTERNS_ROLE_AS_OVERLAY)
    assert heading in text, (
        f"patterns/role-as-overlay.md: missing required section "
        f"heading '{heading}' -- see issue #816 body for the canonical "
        "section structure"
    )


# ---------------------------------------------------------------------------
# Load-bearing tokens per section
# ---------------------------------------------------------------------------


def test_principle_carries_configuration_not_content_framing() -> None:
    """The principle section MUST frame role instructions as configuration not content."""
    text = _read(PATTERNS_ROLE_AS_OVERLAY).lower()
    assert "configuration" in text, (
        "patterns/role-as-overlay.md: missing 'configuration' framing in "
        "'## The principle' -- the load-bearing distinction is "
        "configuration vs content"
    )
    assert "content" in text, (
        "patterns/role-as-overlay.md: missing 'content' framing in "
        "'## The principle'"
    )
    assert "ephemeral" in text, (
        "patterns/role-as-overlay.md: missing 'ephemeral' rule in "
        "'## The principle' -- overlays MUST be ephemeral by definition"
    )


@pytest.mark.parametrize("mode", FAILURE_MODES)
def test_why_this_matters_enumerates_failure_modes(mode: str) -> None:
    """The 'Why this matters' section MUST enumerate the five failure modes (#816)."""
    text = _read(PATTERNS_ROLE_AS_OVERLAY)
    assert mode in text, (
        f"patterns/role-as-overlay.md: missing failure mode '{mode}' -- "
        "the five failure modes (history pollution, retrieval corruption, "
        "context rot acceleration, false memory propagation, resumption "
        "breakage) are the load-bearing justification for the rule"
    )


@pytest.mark.parametrize("token", PRECEDENCE_TOKENS)
def test_precedence_chain_tokens_present(token: str) -> None:
    """Precedence chain MUST name call > session > agent tiers verbatim."""
    text = _read(PATTERNS_ROLE_AS_OVERLAY).lower()
    assert token in text, (
        f"patterns/role-as-overlay.md: missing precedence-chain token "
        f"'{token}' -- the canonical chain is call > session > agent"
    )


def test_precedence_section_pins_call_greater_than_session_greater_than_agent() -> None:
    """The precedence chain MUST be expressed as call > session > agent."""
    text = _read(PATTERNS_ROLE_AS_OVERLAY).lower()
    # Accept either the bare chain string or the role-suffixed form
    # ("call role > session role > agent role") -- both are canonical.
    bare_chain = "call > session > agent"
    suffixed_chain = "call role > session role > agent role"
    assert bare_chain in text or suffixed_chain in text, (
        "patterns/role-as-overlay.md: missing canonical chain string "
        "'call > session > agent' (or the role-suffixed equivalent) -- "
        "the precedence section MUST state the ordering verbatim"
    )


@pytest.mark.parametrize("skill_name", DIRECTIVE_SKILL_REFERENCES)
def test_implementation_contract_names_directive_skills(skill_name: str) -> None:
    """Implementation contract MUST name directive's own skills (#816)."""
    text = _read(PATTERNS_ROLE_AS_OVERLAY)
    assert skill_name in text, (
        f"patterns/role-as-overlay.md: missing reference to '{skill_name}' "
        "-- the implementation contract MUST name directive's skills that "
        "implicitly carry roles"
    )


@pytest.mark.parametrize("token", PROVIDER_SURFACE_TOKENS)
def test_provider_mapping_carries_canonical_surfaces(token: str) -> None:
    """Provider mapping MUST cover Anthropic, OpenAI Chat / Responses, and Gemini surfaces."""
    text = _read(PATTERNS_ROLE_AS_OVERLAY)
    assert token in text, (
        f"patterns/role-as-overlay.md: missing provider-surface token "
        f"'{token}' -- the provider mapping MUST cover Anthropic / "
        "OpenAI Chat / OpenAI Responses / Gemini"
    )


def test_role_as_overlay_uses_must_and_must_not_tokens() -> None:
    """The file MUST carry both '!' MUST and '⊗' MUST NOT rules."""
    text = _read(PATTERNS_ROLE_AS_OVERLAY)
    must_count = text.count("- ! ")
    must_not_count = text.count("- ⊗ ")
    assert must_count >= 5, (
        f"patterns/role-as-overlay.md: too few '! MUST' bullets "
        f"({must_count}); the rule body should be predominantly "
        "RFC2119-strength"
    )
    assert must_not_count >= 5, (
        f"patterns/role-as-overlay.md: too few '⊗ MUST NOT' bullets "
        f"({must_not_count}); MUST NOT prohibitions are load-bearing"
    )


def test_role_as_overlay_cross_references_neighbouring_patterns() -> None:
    """The file MUST cross-reference the three neighbouring pattern docs."""
    text = _read(PATTERNS_ROLE_AS_OVERLAY)
    assert "patterns/llm-app.md" in text or "llm-app.md" in text, (
        "patterns/role-as-overlay.md: missing cross-reference to "
        "patterns/llm-app.md -- the trust-tier framework is required context"
    )
    assert "coding/security.md" in text or "security.md" in text, (
        "patterns/role-as-overlay.md: missing cross-reference to "
        "coding/security.md -- the Agent-Specific Threats section is the "
        "security-side framing of this boundary"
    )
    assert "patterns/multi-agent.md" in text or "multi-agent.md" in text, (
        "patterns/role-as-overlay.md: missing cross-reference to "
        "patterns/multi-agent.md -- the dispatch envelope is the "
        "orchestration analogue of this rule"
    )


# ---------------------------------------------------------------------------
# REFERENCES.md lazy-load entry
# ---------------------------------------------------------------------------


def test_references_md_has_role_as_overlay_lazy_load_entry() -> None:
    """REFERENCES.md MUST register patterns/role-as-overlay.md as a lazy-load entry (#816)."""
    text = _read(REFERENCES_MD)
    assert "patterns/role-as-overlay.md" in text, (
        "REFERENCES.md: missing lazy-load entry for "
        "patterns/role-as-overlay.md -- the new pattern MUST stay "
        "discoverable from the canonical loading index per #816"
    )
    assert "#816" in text, (
        "REFERENCES.md: missing #816 citation on the role-as-overlay "
        "lazy-load entry"
    )


def test_references_md_role_as_overlay_under_llm_applications_section() -> None:
    """Lazy-load entry MUST live under '### When Building LLM Applications'."""
    text = _read(REFERENCES_MD)
    section_marker = "### When Building LLM Applications"
    assert section_marker in text, (
        f"REFERENCES.md: missing '{section_marker}' section anchor"
    )
    section_idx = text.index(section_marker)
    after_section = text[section_idx:]
    # The entry should appear within ~2 KB of the section anchor; if it
    # appears much later it has drifted to a different section.
    role_idx = after_section.find("content/patterns/role-as-overlay.md")
    assert 0 <= role_idx < 4096, (
        "REFERENCES.md: patterns/role-as-overlay.md lazy-load entry MUST "
        "live under '### When Building LLM Applications' (alongside "
        "patterns/llm-app.md)"
    )
