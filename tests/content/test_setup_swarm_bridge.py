"""
test_setup_swarm_bridge.py -- Regression tests for the #1025 setup -> swarm
lifecycle bridge.

The deft-directive-setup skill Phase 3 deposits scope vBRIEFs in
``vbrief/proposed/``; the deft-directive-swarm skill Phase 0 Step 1 preflight
gate (``task vbrief:preflight``) only accepts vBRIEFs in ``vbrief/active/``
with ``plan.status == "running"``. Before #1025 there was no bridge between
these two skills, so the monitor discovered the gap at runtime as a wholesale
preflight rejection (``Invalid transition: 'activate' requires file in
pending/``).

These tests pin the resolution contract:

  * ``skills/deft-directive-swarm/SKILL.md`` Phase 0 carries a Step 0.5
    Lifecycle Bridge block with explicit RFC2119 markers (``!`` MUST for the
    scan/present/approve/bridge/verify steps, ``\u2297`` MUST NOT for the
    legacy gap behaviours).
  * The swarm ``## Anti-Patterns`` block carries a ``\u2297`` bullet citing
    #1025 so future agents reading the anti-patterns block see the rule.
  * ``skills/deft-directive-setup/SKILL.md`` Phase 3 carries a
    ``### Lifecycle Bridge to Downstream Skills (#1025)`` section that
    cross-references the swarm Phase 0 Step 0.5 bridge, so a user reading
    either skill sees the other side of the contract.

Stable substring matches (not full-text) so minor copy-edits do not break the
contract while preserving the rule's intent. Mirrors the pattern in
``tests/content/test_swarm_skill.py`` for the #800 worktree-boundary tokens.

Recurrence record: issue #1025 -- 2026-05-10 first-session consumer
tic-tac-toe swarm; monitor hit ``Invalid transition: 'activate' requires file
in pending/`` on all four candidate vBRIEFs because they were still in
``proposed/``.
"""

from __future__ import annotations

from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Repo root + skill paths
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_SWARM_PATH = "skills/deft-directive-swarm/SKILL.md"
_SETUP_PATH = "skills/deft-directive-setup/SKILL.md"


def _read_skill(rel_path: str) -> str:
    return (_REPO_ROOT / rel_path).read_text(encoding="utf-8")


def _swarm_step0_5_block(text: str) -> str:
    """Return the swarm Phase 0 Step 0.5 lifecycle bridge block."""
    start = text.find("### Step 0.5: Lifecycle Bridge")
    assert start != -1, (
        f"{_SWARM_PATH}: missing '### Step 0.5: Lifecycle Bridge' heading -- "
        "the #1025 bridge step is required between Step 0 and Step 1"
    )
    end = text.find("### Step 1: Read Project State", start)
    assert end != -1 and end > start, (
        f"{_SWARM_PATH}: '### Step 1: Read Project State' heading not found "
        "after Step 0.5 -- cannot bound the Step 0.5 block"
    )
    return text[start:end]


def _setup_phase3_bridge_block(text: str) -> str:
    """Return the setup Phase 3 lifecycle-bridge cross-reference block."""
    start = text.find("### Lifecycle Bridge to Downstream Skills")
    assert start != -1, (
        f"{_SETUP_PATH}: missing '### Lifecycle Bridge to Downstream Skills' "
        "heading -- the #1025 cross-reference is required in Phase 3"
    )
    end = text.find("### End-of-Phase-3 Export Prompt", start)
    assert end != -1 and end > start, (
        f"{_SETUP_PATH}: '### End-of-Phase-3 Export Prompt' heading not "
        "found after the bridge block -- cannot bound the bridge block"
    )
    return text[start:end]


# ---------------------------------------------------------------------------
# Stable token sets for the #1025 bridge contract
# ---------------------------------------------------------------------------

# Swarm Phase 0 Step 0.5 MUST tokens. The bridge step carries explicit ! MUST
# rules for each of the five sub-steps (scan, present, approve, bridge,
# verify) plus the canonical task names.
_SWARM_STEP0_5_MUST_TOKENS = (
    "### Step 0.5: Lifecycle Bridge",
    # Self-citation back to the issue.
    "#1025",
    # Scope of the scan.
    "vbrief/proposed/",
    "vbrief/pending/",
    "vbrief/active/",
    # Canonical lifecycle commands.
    "task scope:promote",
    "task scope:activate",
    # Cross-references to the originating skills.
    "skills/deft-directive-setup/SKILL.md",
    "skills/deft-directive-refinement/SKILL.md",
    # Underlying CLI cross-reference.
    "scripts/scope_lifecycle.py",
    # The originating error string -- pinning this guards against a future
    # rewrite that drops the recurrence record.
    "Invalid transition",
)

# Swarm Phase 0 Step 0.5 MUST NOT (⊗) tokens. The bridge block MUST carry the
# three prohibitions: auto-promote without approval, skip-the-bridge, and
# promote-outside-scope.
_SWARM_STEP0_5_MUST_NOT_TOKENS = (
    # Canonical MUST NOT glyph (U+2297).
    "\u2297",
    "Auto-promote",
    "without explicit user approval",
    "Skip the lifecycle bridge",
    "outside the user's stated swarm scope",
)

# Swarm Anti-Patterns block bullet tokens (#1025).
_SWARM_ANTI_PATTERN_TOKENS = (
    "#1025",
    "Phase 0 Step 0.5",
    "lifecycle bridge",
    # The MUST NOT marker.
    "\u2297",
)

# Setup Phase 3 bridge cross-reference tokens.
_SETUP_BRIDGE_TOKENS = (
    "### Lifecycle Bridge to Downstream Skills",
    "#1025",
    "vbrief/proposed/",
    "vbrief/active/",
    "task scope:promote",
    "task scope:activate",
    # Cross-reference to the swarm bridge step.
    "skills/deft-directive-swarm/SKILL.md",
    "Phase 0 Step 0.5",
    # Cross-reference to refinement.
    "skills/deft-directive-refinement/SKILL.md",
    # Underlying CLI cross-reference.
    "scripts/scope_lifecycle.py",
    # MUST NOT glyph for the prohibitions.
    "\u2297",
    "Auto-run",
)


# ---------------------------------------------------------------------------
# 1. Swarm Phase 0 Step 0.5 lifecycle bridge present (#1025)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("token", _SWARM_STEP0_5_MUST_TOKENS)
def test_swarm_step0_5_must_tokens_present(token: str) -> None:
    """Swarm Phase 0 Step 0.5 must carry the #1025 lifecycle-bridge MUST tokens."""
    block = _swarm_step0_5_block(_read_skill(_SWARM_PATH))
    assert token in block, (
        f"{_SWARM_PATH}: Phase 0 Step 0.5 missing #1025 MUST token "
        f"{token!r} -- see the bridge block contract"
    )


@pytest.mark.parametrize("token", _SWARM_STEP0_5_MUST_NOT_TOKENS)
def test_swarm_step0_5_must_not_tokens_present(token: str) -> None:
    """Swarm Phase 0 Step 0.5 must carry the #1025 ⊗ MUST NOT prohibition tokens."""
    block = _swarm_step0_5_block(_read_skill(_SWARM_PATH))
    assert token in block, (
        f"{_SWARM_PATH}: Phase 0 Step 0.5 missing #1025 \u2297 MUST NOT token "
        f"{token!r} -- see the bridge block contract"
    )


def test_swarm_step0_5_bridge_uses_canonical_glyph() -> None:
    """The ⊗ MUST NOT markers MUST be U+2297, not the cp1252 mojibake form (#798)."""
    block = _swarm_step0_5_block(_read_skill(_SWARM_PATH))
    # The cp1252 round-trip mojibake of U+2297 (the three-codepoint sequence
    # U+0393 U+00E8 U+00F9) would have shipped if a swarm agent followed a
    # corrupted vBRIEF verbatim. Pre-PR fix-up gate per #798.
    assert "\u0393\u00e8\u00f9" not in block, (
        f"{_SWARM_PATH}: Phase 0 Step 0.5 contains cp1252 mojibake "
        f"('\u0393\u00e8\u00f9') instead of canonical \u2297 (U+2297)"
    )


# ---------------------------------------------------------------------------
# 2. Swarm Anti-Patterns block carries the #1025 bullet
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("token", _SWARM_ANTI_PATTERN_TOKENS)
def test_swarm_anti_patterns_1025_bullet_tokens_present(token: str) -> None:
    """Swarm Anti-Patterns block must carry a #1025 bullet with the contract tokens."""
    text = _read_skill(_SWARM_PATH)
    anti_start = text.find("## Anti-Patterns")
    assert anti_start != -1, (
        f"{_SWARM_PATH}: missing '## Anti-Patterns' section heading"
    )
    anti_block = text[anti_start:]
    assert token in anti_block, (
        f"{_SWARM_PATH}: Anti-Patterns missing #1025 bullet token "
        f"{token!r} -- mirror the #800 worktree-boundary anti-pattern shape"
    )


def test_swarm_anti_patterns_1025_bullet_is_prohibition() -> None:
    """The #1025 anti-pattern bullet must use the ⊗ MUST NOT marker."""
    text = _read_skill(_SWARM_PATH)
    anti_start = text.find("## Anti-Patterns")
    assert anti_start != -1, (
        f"{_SWARM_PATH}: missing '## Anti-Patterns' section heading"
    )
    anti_block = text[anti_start:]
    found = False
    for line in anti_block.splitlines():
        if "#1025" in line and "lifecycle bridge" in line:
            assert "\u2297" in line, (
                f"{_SWARM_PATH}: #1025 anti-pattern bullet must use \u2297 marker; "
                f"found: {line.strip()!r}"
            )
            found = True
            break
    assert found, (
        f"{_SWARM_PATH}: no Anti-Patterns bullet citing #1025 + 'lifecycle "
        "bridge' found -- the #1025 anti-pattern is missing"
    )


# ---------------------------------------------------------------------------
# 3. Setup Phase 3 cross-reference present (#1025)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("token", _SETUP_BRIDGE_TOKENS)
def test_setup_phase3_bridge_tokens_present(token: str) -> None:
    """Setup Phase 3 must carry the #1025 lifecycle-bridge cross-reference."""
    block = _setup_phase3_bridge_block(_read_skill(_SETUP_PATH))
    assert token in block, (
        f"{_SETUP_PATH}: Phase 3 Lifecycle Bridge cross-reference missing "
        f"token {token!r} -- see the setup-side bridge block"
    )


def test_setup_phase3_bridge_uses_canonical_glyph() -> None:
    """The ⊗ MUST NOT markers MUST be U+2297, not the cp1252 mojibake form (#798)."""
    block = _setup_phase3_bridge_block(_read_skill(_SETUP_PATH))
    assert "\u0393\u00e8\u00f9" not in block, (
        f"{_SETUP_PATH}: Phase 3 Lifecycle Bridge contains cp1252 mojibake "
        f"('\u0393\u00e8\u00f9') instead of canonical \u2297 (U+2297)"
    )


# ---------------------------------------------------------------------------
# 4. Bi-directional cross-reference contract (#1025 acceptance item 3)
# ---------------------------------------------------------------------------

def test_swarm_phase0_5_references_setup_skill() -> None:
    """Swarm Phase 0 Step 0.5 must cross-reference the setup skill."""
    block = _swarm_step0_5_block(_read_skill(_SWARM_PATH))
    assert "skills/deft-directive-setup/SKILL.md" in block, (
        f"{_SWARM_PATH}: Phase 0 Step 0.5 must cross-reference "
        "'skills/deft-directive-setup/SKILL.md' so a user reading the swarm "
        "skill sees where scope vBRIEFs originate (#1025 acceptance item 3)"
    )


def test_setup_phase3_bridge_references_swarm_skill() -> None:
    """Setup Phase 3 lifecycle bridge must cross-reference the swarm skill."""
    block = _setup_phase3_bridge_block(_read_skill(_SETUP_PATH))
    assert "skills/deft-directive-swarm/SKILL.md" in block, (
        f"{_SETUP_PATH}: Phase 3 Lifecycle Bridge must cross-reference "
        "'skills/deft-directive-swarm/SKILL.md' so a user reading the setup "
        "skill sees where the bridge runs (#1025 acceptance item 3)"
    )
