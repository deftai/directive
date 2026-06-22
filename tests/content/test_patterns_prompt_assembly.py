"""
test_patterns_prompt_assembly.py -- Content gates for
`patterns/prompt-assembly-layer-ordering.md` (#836).

Pins the deft-side contract from issue #836: the new
`patterns/prompt-assembly-layer-ordering.md` file MUST exist with an
RFC2119 legend, the canonical sections describing the cached-prefix
vs ephemeral-injection contract, the load-bearing tokens for each
layer, and the bi-directional cross-references in `REFERENCES.md`
plus the in-file cross-reference to `patterns/llm-app.md` (#481).

Mirrors the shape of `tests/content/test_patterns_llm_app.py`.
"""

from __future__ import annotations

from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

PATTERNS_FILE = _REPO_ROOT / "content/patterns/prompt-assembly-layer-ordering.md"
REFERENCES_MD = _REPO_ROOT / "REFERENCES.md"

RFC2119_LEGEND = "!=MUST, ~=SHOULD"

REQUIRED_SECTIONS = (
    "## The invariant",
    "## Cached prefix -- assembled once at session start",
    "## Ephemeral injection -- rebuilt on every API call",
    "## Why this matters for directive",
    "## Observability",
    "## Anti-patterns",
    "## Cross-references",
)

CACHED_PREFIX_FRAGMENTS = (
    "Agent identity",
    "Tool-aware behaviour guidance",
    "Frozen memory snapshot",
    "Skills index",
    "Context files",
    "Session timestamp",
)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Existence + structural gates
# ---------------------------------------------------------------------------


def test_patterns_file_exists() -> None:
    """patterns/prompt-assembly-layer-ordering.md MUST exist and be non-empty."""
    assert PATTERNS_FILE.is_file(), (
        f"missing required file: {PATTERNS_FILE.relative_to(_REPO_ROOT)} -- "
        "see issue #836 scope manifest"
    )
    text = _read(PATTERNS_FILE)
    assert text.strip(), (
        f"{PATTERNS_FILE.relative_to(_REPO_ROOT)}: file is empty"
    )


def test_patterns_file_has_rfc2119_legend() -> None:
    """The file MUST carry the canonical RFC2119 legend."""
    text = _read(PATTERNS_FILE)
    assert RFC2119_LEGEND in text, (
        "patterns/prompt-assembly-layer-ordering.md: missing RFC2119 "
        f"legend '{RFC2119_LEGEND}' -- add the Legend line near the top"
    )


def test_patterns_file_cites_issue_number() -> None:
    """The file MUST cite #836 so the origin trail is discoverable."""
    text = _read(PATTERNS_FILE)
    assert "#836" in text, (
        "patterns/prompt-assembly-layer-ordering.md: missing issue-number "
        "citation (#836) -- the acceptance issue MUST be discoverable from "
        "the file body"
    )


@pytest.mark.parametrize("heading", REQUIRED_SECTIONS)
def test_patterns_file_required_sections(heading: str) -> None:
    """Every canonical section heading from the #836 acceptance MUST be present."""
    text = _read(PATTERNS_FILE)
    assert heading in text, (
        "patterns/prompt-assembly-layer-ordering.md: missing required "
        f"section heading '{heading}' -- see issue #836 body for the "
        "canonical structure"
    )


# ---------------------------------------------------------------------------
# Load-bearing rule tokens
# ---------------------------------------------------------------------------


def test_invariant_section_carries_the_per_turn_rule() -> None:
    """The invariant section MUST encode the cached-vs-ephemeral split."""
    text = _read(PATTERNS_FILE).lower()
    assert "per-turn" in text, (
        "patterns/prompt-assembly-layer-ordering.md: missing 'per-turn' "
        "token -- the invariant rests on the per-turn vs session-stable split"
    )
    assert "ephemeral" in text, (
        "patterns/prompt-assembly-layer-ordering.md: missing 'ephemeral' "
        "token -- the ephemeral-injection layer name is load-bearing"
    )
    assert "cached" in text, (
        "patterns/prompt-assembly-layer-ordering.md: missing 'cached' "
        "token -- the cached-prefix layer name is load-bearing"
    )


@pytest.mark.parametrize("fragment", CACHED_PREFIX_FRAGMENTS)
def test_cached_prefix_fragments_enumerated(fragment: str) -> None:
    """All six canonical cached-prefix fragments MUST be named."""
    text = _read(PATTERNS_FILE)
    assert fragment in text, (
        "patterns/prompt-assembly-layer-ordering.md: missing cached-prefix "
        f"fragment '{fragment}' -- the canonical six-fragment list is the "
        "core of the acceptance criteria"
    )


def test_ordering_rule_present() -> None:
    """The most-stable-first ordering rule MUST be encoded."""
    text = _read(PATTERNS_FILE).lower()
    assert "most-stable" in text or "most stable" in text, (
        "patterns/prompt-assembly-layer-ordering.md: missing the "
        "'most-stable-first' ordering rule for the cached prefix"
    )


def test_cached_prefix_fragments_are_in_most_stable_first_order() -> None:
    """The six cached-prefix fragments MUST appear in most-stable-first order.

    Provider prefix caches are byte-prefix caches: one variable byte at
    position k invalidates every byte from k onward. The pattern body
    pins the canonical ordering (Agent identity -> Tool-aware behaviour
    guidance -> Frozen memory snapshot -> Skills index -> Context files
    -> Session timestamp) precisely because a reorder silently degrades
    prefix-cache effectiveness across deploys, sessions, and projects.

    Without this test, ``test_cached_prefix_fragments_enumerated`` only
    pins the presence of each fragment and ``test_ordering_rule_present``
    only pins the 'most-stable' token -- a future edit could reshuffle
    the list and the rule violation would not surface in CI. Pin the
    ordering directly by asserting first-occurrence indices in the file
    body are strictly ascending in the canonical sequence.
    """
    text = _read(PATTERNS_FILE)
    positions = [(name, text.find(name)) for name in CACHED_PREFIX_FRAGMENTS]
    missing = [name for name, idx in positions if idx < 0]
    assert not missing, (
        "patterns/prompt-assembly-layer-ordering.md: ordering check "
        f"cannot run because the following cached-prefix fragments are "
        f"absent from the file: {missing} -- see "
        "test_cached_prefix_fragments_enumerated for the presence gate"
    )
    indices = [idx for _name, idx in positions]
    assert indices == sorted(indices), (
        "patterns/prompt-assembly-layer-ordering.md: cached-prefix "
        "fragments MUST appear in most-stable-first order "
        f"({list(CACHED_PREFIX_FRAGMENTS)}); first-occurrence indices "
        f"in the file body are {indices}, which is not ascending -- "
        "a reorder collapses provider prefix-cache effectiveness and "
        "silently multiplies token cost (see lines 60-82 of the file "
        "body for the byte-prefix-cache rationale this gate enforces)"
    )


def test_frozen_memory_snapshot_cross_reference() -> None:
    """The file MUST cross-reference #832 (frozen-memory-snapshot)."""
    text = _read(PATTERNS_FILE)
    assert "#832" in text, (
        "patterns/prompt-assembly-layer-ordering.md: missing #832 "
        "cross-reference -- the frozen-snapshot rule is the load-bearing "
        "consequence of this pattern"
    )


def test_llm_app_cross_reference() -> None:
    """The file MUST cross-reference patterns/llm-app.md (#481)."""
    text = _read(PATTERNS_FILE)
    assert "patterns/llm-app.md" in text or "llm-app.md" in text, (
        "patterns/prompt-assembly-layer-ordering.md: missing cross-reference "
        "to patterns/llm-app.md -- this pattern extends the LLM-app "
        "standards (#481)"
    )


def test_role_as_overlay_cross_reference() -> None:
    """The file MUST cross-reference #816 (role-as-overlay).

    Role overlays are ephemeral, not cached; they live in the per-turn
    injection layer. The pattern body names this in three load-bearing
    places (ephemeral-content list, anti-patterns, cross-references)
    and the CHANGELOG promises this gate exists -- pinning it here
    prevents a future edit that drops all four references from
    passing CI silently.
    """
    text = _read(PATTERNS_FILE)
    assert "#816" in text, (
        "patterns/prompt-assembly-layer-ordering.md: missing #816 "
        "cross-reference -- role-as-overlay belongs to the ephemeral "
        "layer; the four citations in the file body are load-bearing"
    )


def test_patterns_file_uses_must_and_must_not_tokens() -> None:
    """The file MUST carry both '!' MUST and '⊗' MUST NOT rules."""
    text = _read(PATTERNS_FILE)
    must_count = text.count("- ! ")
    must_not_count = text.count("- ⊗ ")
    assert must_count >= 5, (
        f"patterns/prompt-assembly-layer-ordering.md: too few '! MUST' "
        f"bullets ({must_count}); the rule body should be predominantly "
        "RFC2119-strength"
    )
    assert must_not_count >= 5, (
        f"patterns/prompt-assembly-layer-ordering.md: too few '⊗ MUST NOT' "
        f"bullets ({must_not_count}); MUST NOT prohibitions are load-bearing"
    )


# ---------------------------------------------------------------------------
# Bi-directional cross-references
# ---------------------------------------------------------------------------


def test_references_md_carries_lazy_load_trigger() -> None:
    """REFERENCES.md MUST advertise a lazy-load trigger for the new pattern."""
    text = _read(REFERENCES_MD)
    assert "patterns/prompt-assembly-layer-ordering.md" in text, (
        "REFERENCES.md: missing lazy-load trigger for "
        "patterns/prompt-assembly-layer-ordering.md -- add an entry under "
        "the 'When Building LLM Applications' section (#836)"
    )
    assert "#836" in text, (
        "REFERENCES.md: the new lazy-load entry MUST cite #836 so the "
        "origin trail is discoverable"
    )
