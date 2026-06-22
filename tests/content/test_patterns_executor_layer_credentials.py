"""
test_patterns_executor_layer_credentials.py -- Content gates for
`patterns/executor-layer-credentials.md` (#806).

Pins the deft-side contract from issue #806: the new
`patterns/executor-layer-credentials.md` MUST exist with an RFC2119
legend, the canonical sections, the three-anti-patterns enumeration,
the implementation-agnostic example surfaces (CLI / HTTP / SDK / MCP),
the load-bearing rule tokens, and cross-references to the related
issues (#587, #686) and to `coding/security.md`.

Mirrors the shape of `tests/content/test_patterns_llm_app.py` (#481)
and `tests/content/test_security_standards.py` (#661).
"""

from __future__ import annotations

from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

PATTERNS_EXECUTOR = _REPO_ROOT / "content/patterns/executor-layer-credentials.md"

RFC2119_LEGEND = "!=MUST, ~=SHOULD"

REQUIRED_SECTIONS = (
    "## The principle",
    "## Implementation-agnostic examples",
    "### CLI tools",
    "### HTTP APIs",
    "### SDKs",
    "### MCP servers",
    "### Shells and arbitrary subprocesses",
    "## Operator runbook",
    "## Anti-patterns",
    "## Cross-references",
)

# The three canonical wrong placements enumerated in the issue body.
WRONG_PLACEMENT_TOKENS = (
    "prompt",
    "file",
    "environment variable",
)

# Cross-reference issue numbers required to be present.
REQUIRED_ISSUE_REFS = (
    "#587",
    "#686",
    "#806",
)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Existence + structural gates
# ---------------------------------------------------------------------------


def test_patterns_executor_layer_credentials_exists() -> None:
    """patterns/executor-layer-credentials.md MUST exist and be non-empty."""
    assert PATTERNS_EXECUTOR.is_file(), (
        f"missing required file: {PATTERNS_EXECUTOR.relative_to(_REPO_ROOT)} -- "
        "see issue #806 scope manifest"
    )
    text = _read(PATTERNS_EXECUTOR)
    assert text.strip(), (
        f"{PATTERNS_EXECUTOR.relative_to(_REPO_ROOT)}: file is empty"
    )


def test_patterns_executor_layer_credentials_has_rfc2119_legend() -> None:
    """The file MUST carry the canonical RFC2119 legend."""
    text = _read(PATTERNS_EXECUTOR)
    assert RFC2119_LEGEND in text, (
        f"patterns/executor-layer-credentials.md: missing RFC2119 legend "
        f"'{RFC2119_LEGEND}' -- add the Legend line near the top of the file"
    )


@pytest.mark.parametrize("issue_ref", REQUIRED_ISSUE_REFS)
def test_patterns_executor_layer_credentials_cites_required_issues(
    issue_ref: str,
) -> None:
    """The file MUST cite #806 (origin) plus #587 and #686 (the
    affirmative-complement framing from the issue body)."""
    text = _read(PATTERNS_EXECUTOR)
    assert issue_ref in text, (
        f"patterns/executor-layer-credentials.md: missing required issue "
        f"citation '{issue_ref}' -- the cross-reference contract from "
        "#806 names #587 (no-read-secret) and #686 (tool-call safety) as "
        "complementary rules"
    )


@pytest.mark.parametrize("heading", REQUIRED_SECTIONS)
def test_patterns_executor_layer_credentials_required_sections(
    heading: str,
) -> None:
    """Every canonical section heading from the #806 acceptance MUST be
    present."""
    text = _read(PATTERNS_EXECUTOR)
    assert heading in text, (
        f"patterns/executor-layer-credentials.md: missing required section "
        f"heading '{heading}' -- see issue #806 body for the canonical "
        "structure (principle, examples, runbook, anti-patterns, cross-refs)"
    )


# ---------------------------------------------------------------------------
# Load-bearing content tokens
# ---------------------------------------------------------------------------


def test_principle_enumerates_three_wrong_placements() -> None:
    """## The principle MUST enumerate all three wrong placements from
    the issue body (prompt, file, env var) so the failure-mode taxonomy
    stays discoverable."""
    text = _read(PATTERNS_EXECUTOR).lower()
    for token in WRONG_PLACEMENT_TOKENS:
        assert token in text, (
            f"patterns/executor-layer-credentials.md: missing wrong-"
            f"placement token '{token}' -- the principle section MUST "
            "enumerate the three failure modes from #806: prompt, file, "
            "globally-inherited env var"
        )


def test_invocation_layer_phrase_is_load_bearing() -> None:
    """The canonical phrase 'invocation layer' MUST appear -- this is
    the load-bearing name of the pattern."""
    text = _read(PATTERNS_EXECUTOR).lower()
    assert "invocation layer" in text, (
        "patterns/executor-layer-credentials.md: missing 'invocation "
        "layer' phrase -- this is the canonical name of the pattern "
        "from #806 and MUST appear in the body"
    )


def test_capability_vs_credential_distinction_is_present() -> None:
    """The capability-vs-credential distinction MUST be stated -- it is
    the one-sentence summary of the pattern."""
    text = _read(PATTERNS_EXECUTOR).lower()
    assert "capability" in text and "credential" in text, (
        "patterns/executor-layer-credentials.md: missing the "
        "capability/credential distinction -- the agent receives the "
        "capability, not the credential; this is the load-bearing summary"
    )


def test_examples_cover_four_canonical_surfaces() -> None:
    """The implementation-agnostic examples MUST cover the four
    canonical surfaces named in the issue body: CLI tools, HTTP APIs,
    SDKs, MCP servers."""
    text = _read(PATTERNS_EXECUTOR)
    for surface in ("### CLI tools", "### HTTP APIs", "### SDKs", "### MCP servers"):
        assert surface in text, (
            f"patterns/executor-layer-credentials.md: missing example "
            f"surface heading '{surface}' -- #806 names four canonical "
            "surfaces (CLI, HTTP, SDK, MCP)"
        )


def test_flue_sdk_canonical_example_is_cited() -> None:
    """The Flue SDK `defineCommand` shape -- the canonical worked
    example cited in the issue body -- MUST appear in the CLI section."""
    text = _read(PATTERNS_EXECUTOR)
    assert "defineCommand" in text, (
        "patterns/executor-layer-credentials.md: missing the canonical "
        "Flue SDK `defineCommand` example -- this is the worked example "
        "cited verbatim in the #806 issue body"
    )


def test_patterns_executor_uses_must_and_must_not_tokens() -> None:
    """The file MUST carry both '!' MUST and '⊗' MUST NOT rules so the
    rule body is predominantly RFC2119-strength."""
    text = _read(PATTERNS_EXECUTOR)
    # Count `! MUST` only (the canonical RFC2119 strength marker in this file).
    # Avoid double-counting lines that match both `- ! ` and `! MUST`.
    must_count = text.count("! MUST")
    must_not_count = text.count("- ⊗ ")
    assert must_count >= 5, (
        f"patterns/executor-layer-credentials.md: too few MUST rules "
        f"({must_count}); the rule body should be predominantly "
        "RFC2119-strength"
    )
    assert must_not_count >= 5, (
        f"patterns/executor-layer-credentials.md: too few '⊗ MUST NOT' "
        f"bullets ({must_not_count}); MUST NOT prohibitions are "
        "load-bearing"
    )


# ---------------------------------------------------------------------------
# Cross-references
# ---------------------------------------------------------------------------


def test_cross_references_to_security_md() -> None:
    """The file MUST cross-reference `coding/security.md` -- #806 names
    it as the partner placement for the positive pattern of privileged
    capability access."""
    text = _read(PATTERNS_EXECUTOR)
    assert "coding/security.md" in text, (
        "patterns/executor-layer-credentials.md: missing cross-reference "
        "to coding/security.md -- #806 mandates this cross-link"
    )


def test_cross_references_to_sibling_patterns() -> None:
    """The file MUST cross-reference the sibling pattern files
    (`patterns/llm-app.md`, `patterns/multi-agent.md`) -- they describe
    adjacent surfaces of the same agent-security model."""
    text = _read(PATTERNS_EXECUTOR)
    for sibling in ("patterns/llm-app.md", "patterns/multi-agent.md"):
        assert sibling in text, (
            f"patterns/executor-layer-credentials.md: missing cross-"
            f"reference to sibling pattern '{sibling}' -- the "
            "Cross-references section MUST link both adjacent patterns"
        )
