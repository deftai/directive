"""
test_patterns_llm_app.py -- Content gates for `patterns/llm-app.md` (#481).

Covers the deft-side contract from issue #481: the new
`patterns/llm-app.md` file MUST exist with an RFC2119 legend, the seven
canonical sections, the trust-tier ordering tokens, and the load-bearing
rule tokens per section. The companion edits to `REFERENCES.md`,
`coding/coding.md`, and `tools/telemetry.md` MUST carry the cross-
references so the lazy-load trigger and observability addendum stay
discoverable from those surfaces.

Mirrors the shape of `tests/content/test_standards.py` and
`tests/content/test_coding_rules.py`.
"""

from __future__ import annotations

from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

PATTERNS_LLM_APP = _REPO_ROOT / "content/patterns/llm-app.md"
REFERENCES_MD = _REPO_ROOT / "REFERENCES.md"
CODING_CODING_MD = _REPO_ROOT / "content/coding/coding.md"
TOOLS_TELEMETRY_MD = _REPO_ROOT / "content/tools/telemetry.md"

RFC2119_LEGEND = "!=MUST, ~=SHOULD"

REQUIRED_SECTIONS = (
    "## Prompt construction",
    "## Trust tiers",
    "## Tool / function calling",
    "## RAG and retrieval",
    "## Output handling",
    "## Multi-agent and orchestration",
    "## LLM-specific observability",
)

TRUST_TIER_TOKENS = (
    "system prompt",
    "few-shot examples",
    "user turn",
    "retrieved content",
    "web / file content",
)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Existence + structural gates
# ---------------------------------------------------------------------------


def test_patterns_llm_app_exists() -> None:
    """patterns/llm-app.md MUST exist and be non-empty."""
    assert PATTERNS_LLM_APP.is_file(), (
        f"missing required file: {PATTERNS_LLM_APP.relative_to(_REPO_ROOT)} -- "
        "see issue #481 scope manifest"
    )
    text = _read(PATTERNS_LLM_APP)
    assert text.strip(), (
        f"{PATTERNS_LLM_APP.relative_to(_REPO_ROOT)}: file is empty"
    )


def test_patterns_llm_app_has_rfc2119_legend() -> None:
    """patterns/llm-app.md MUST carry the canonical RFC2119 legend."""
    text = _read(PATTERNS_LLM_APP)
    assert RFC2119_LEGEND in text, (
        f"patterns/llm-app.md: missing RFC2119 legend '{RFC2119_LEGEND}' -- "
        "add the Legend line near the top of the file"
    )


def test_patterns_llm_app_cites_issue_number() -> None:
    """patterns/llm-app.md MUST cite #481 so the origin trail is discoverable."""
    text = _read(PATTERNS_LLM_APP)
    assert "#481" in text, (
        "patterns/llm-app.md: missing issue-number citation (#481) -- "
        "the acceptance issue MUST be discoverable from the file body"
    )


@pytest.mark.parametrize("heading", REQUIRED_SECTIONS)
def test_patterns_llm_app_required_sections(heading: str) -> None:
    """Every canonical section heading from the #481 acceptance MUST be present."""
    text = _read(PATTERNS_LLM_APP)
    assert heading in text, (
        f"patterns/llm-app.md: missing required section heading '{heading}' -- "
        "see issue #481 body for the canonical seven-section structure"
    )


@pytest.mark.parametrize("token", TRUST_TIER_TOKENS)
def test_patterns_llm_app_trust_tier_ordering_tokens(token: str) -> None:
    """Trust-tier ordering tokens MUST all be present (#481)."""
    text = _read(PATTERNS_LLM_APP)
    assert token in text, (
        f"patterns/llm-app.md: missing trust-tier token '{token}' -- "
        "the canonical ordering is system > few-shot > user > retrieved > web"
    )


# ---------------------------------------------------------------------------
# Load-bearing rule tokens per section
# ---------------------------------------------------------------------------


def test_prompt_construction_carries_delimiter_envelope_tokens() -> None:
    """Prompt construction MUST encode the delimiter envelope rule."""
    text = _read(PATTERNS_LLM_APP)
    for token in ("<user_input>", "<document>", "<tool_result>"):
        assert token in text, (
            f"patterns/llm-app.md: missing prompt-construction delimiter "
            f"token '{token}' -- the envelope wrapping rule is load-bearing"
        )


def test_tool_calling_carries_confused_deputy_rule() -> None:
    """Tool/function calling MUST name the confused-deputy mitigation."""
    text = _read(PATTERNS_LLM_APP).lower()
    assert "confused deputy" in text, (
        "patterns/llm-app.md: missing 'confused deputy' framing in the "
        "tool/function calling section -- this is the load-bearing rule"
    )


def test_rag_section_carries_no_writeback_rule() -> None:
    """RAG section MUST encode the no-LLM-write-back-without-validation rule."""
    text = _read(PATTERNS_LLM_APP).lower()
    assert "rag poisoning" in text or "rag-poisoning" in text, (
        "patterns/llm-app.md: missing 'RAG poisoning' citation in the RAG "
        "section -- the no-write-back rule MUST name its failure mode"
    )
    assert "provenance" in text, (
        "patterns/llm-app.md: missing 'provenance' token in the RAG "
        "section -- per-chunk provenance is a load-bearing rule"
    )


def test_output_handling_carries_schema_validation_rule() -> None:
    """Output handling MUST name schema validation as the gate."""
    text = _read(PATTERNS_LLM_APP).lower()
    assert "schema" in text, (
        "patterns/llm-app.md: missing 'schema' token in output handling -- "
        "schema-validate-before-act is the load-bearing rule"
    )
    assert "xss" in text, (
        "patterns/llm-app.md: missing 'XSS' token in output handling -- "
        "renderer-boundary sanitization is a load-bearing rule"
    )


def test_multi_agent_carries_compositional_fragment_rule() -> None:
    """Multi-agent section MUST encode the compositional-fragment attack name."""
    text = _read(PATTERNS_LLM_APP).lower()
    assert "compositional fragment" in text, (
        "patterns/llm-app.md: missing 'compositional fragment' citation "
        "in the multi-agent section -- this is the load-bearing attack name"
    )


def test_observability_carries_per_call_audit_log_rule() -> None:
    """Observability section MUST name the per-call audit log requirement."""
    text = _read(PATTERNS_LLM_APP).lower()
    assert "audit log" in text, (
        "patterns/llm-app.md: missing 'audit log' token in the "
        "LLM-specific observability section -- this is the load-bearing rule"
    )
    assert "token count" in text or "token budget" in text, (
        "patterns/llm-app.md: missing token tracking guidance in the "
        "LLM-specific observability section"
    )


def test_patterns_llm_app_uses_must_and_must_not_tokens() -> None:
    """The file MUST carry both '!' MUST and '⊗' MUST NOT rules."""
    text = _read(PATTERNS_LLM_APP)
    must_count = text.count("- ! ")
    must_not_count = text.count("- ⊗ ")
    assert must_count >= 5, (
        f"patterns/llm-app.md: too few '! MUST' bullets ({must_count}); "
        "the rule body should be predominantly RFC2119-strength"
    )
    assert must_not_count >= 5, (
        f"patterns/llm-app.md: too few '⊗ MUST NOT' bullets "
        f"({must_not_count}); MUST NOT prohibitions are load-bearing"
    )


# ---------------------------------------------------------------------------
# Bi-directional cross-references
# ---------------------------------------------------------------------------


def test_references_md_carries_lazy_load_trigger() -> None:
    """REFERENCES.md MUST advertise the lazy-load trigger for patterns/llm-app.md."""
    text = _read(REFERENCES_MD)
    assert "patterns/llm-app.md" in text, (
        "REFERENCES.md: missing lazy-load trigger for patterns/llm-app.md "
        "-- add an entry under a 'When Building LLM Applications' (or "
        "equivalent) section"
    )


def test_coding_coding_md_carries_addendum() -> None:
    """coding/coding.md MUST carry the short addendum cross-linking patterns/llm-app.md."""
    text = _read(CODING_CODING_MD)
    assert "patterns/llm-app.md" in text, (
        "coding/coding.md: missing cross-link addendum to "
        "patterns/llm-app.md (#481 acceptance criterion)"
    )
    assert "#481" in text, (
        "coding/coding.md: missing #481 issue citation in the LLM-API addendum"
    )


def test_tools_telemetry_md_carries_llm_observability_section() -> None:
    """tools/telemetry.md MUST gain an LLM-specific observability section per #481."""
    text = _read(TOOLS_TELEMETRY_MD)
    assert "LLM-specific observability" in text, (
        "tools/telemetry.md: missing 'LLM-specific observability' "
        "section -- #481 mandates this surface alongside the patterns file"
    )
    assert "patterns/llm-app.md" in text, (
        "tools/telemetry.md: LLM observability section must cross-reference "
        "patterns/llm-app.md so readers can find the full standards body"
    )
    assert "#481" in text, (
        "tools/telemetry.md: LLM observability section MUST cite #481"
    )
