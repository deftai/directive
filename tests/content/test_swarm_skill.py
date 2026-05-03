"""
test_swarm_skill.py -- Phase 6 Step 3 worktree-boundary content tests for the
deft-directive-swarm SKILL (#800).

Asserts that ``skills/deft-directive-swarm/SKILL.md`` Phase 6 Step 3 (Update
Master) carries:

  * the canonical ``\u2297`` (U+2297) MUST NOT rule prohibiting ``git checkout``
    in a worktree the merging agent does not own;
  * the companion ``!`` MUST rule clarifying that the merger MAY remove its OWN
    worktree + orphaned local feature branch but MUST NOT touch any other
    worktree's HEAD or branch state;
  * an Anti-Patterns block bullet citing PR #797 as the recurrence record;
  * a cross-reference to the #727 Sub-Agent Role Separation companion rules.

Mirrors the pattern in ``tests/content/test_skills.py`` for the existing #727
Sub-Agent Role Separation tokens. Stable substring matches (not full-text)
so minor copy-edits don't break the contract; failure messages cite the file
path and the missing pattern.

Recurrence record: PR #797 merge session 2026-05-01 -- Agent B (merger) ran
``cd C:\\repos\\Deft\\directive; git checkout master --quiet`` against Agent A's
sibling worktree after merging its own PR.

Companion to: tests/content/test_skills.py section 39 (#727 -- Sub-Agent Role
Separation). #800 extends the same boundary discipline from sub-agent spawn
shape to worktree HEAD operations.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Repo root + skill path
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_SWARM_PATH = "skills/deft-directive-swarm/SKILL.md"


def _read_swarm() -> str:
    return (_REPO_ROOT / _SWARM_PATH).read_text(encoding="utf-8")


def _phase6_step3_block(text: str) -> str:
    """Return the Phase 6 Step 3 (Update Master) block, sliced to Step 4."""
    start = text.find("### Step 3: Update Master")
    assert start != -1, (
        f"{_SWARM_PATH}: missing '### Step 3: Update Master' heading -- "
        "the #800 rules anchor on this Phase 6 sub-section"
    )
    end = text.find("### Step 4", start)
    assert end != -1 and end > start, (
        f"{_SWARM_PATH}: '### Step 4' heading not found after Step 3 -- "
        "cannot bound the Step 3 block for the #800 assertions"
    )
    return text[start:end]


# ---------------------------------------------------------------------------
# Stable token sets for the #800 rules
# ---------------------------------------------------------------------------

# Tokens drawn from the verbatim "Proposed rule" block in issue #800. Stable
# substrings, not full-text matches, so minor copy-edits don't break the
# contract while preserving the rule's intent.
_STEP3_NO_CHECKOUT_TOKENS = (
    # The MUST NOT marker MUST be the canonical U+2297 glyph, not the cp1252
    # mojibake form (encoded here as escape sequences to keep this file
    # encoding-gate clean per #798).
    "\u2297",
    # Action prohibited.
    "git checkout",
    # Scope: a worktree the merger does NOT own.
    "worktree the merging agent does not own",
    # Canonical replacement for the post-merge state-update need.
    "git fetch origin",
    # Final reinforcement clause.
    "NEVER touch HEAD",
)

_STEP3_COMPANION_MAY_TOKENS = (
    # The companion is a ! MUST rule (positive permission + boundary).
    "merger MAY remove",
    "git worktree remove",
    "git branch -D",
    # The MUST NOT side of the companion: do not touch others.
    "MUST NOT alter any other worktree",
)

# Anti-Patterns block bullet tokens (citing PR #797 as the recurrence record
# and mirroring the existing #727 Sub-Agent Role Separation bullet shape).
_ANTI_PATTERN_TOKENS = (
    # Concrete shape that triggered the recurrence.
    "cd <other-worktree>; git checkout master --quiet",
    # Recurrence record citation.
    "PR #797",
    # Cross-reference to the #727 companion rule.
    "#727",
    # Self-citation back to the issue.
    "#800",
)


# ---------------------------------------------------------------------------
# 1. Phase 6 Step 3 carries the ⊗ MUST NOT rule (#800)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("token", _STEP3_NO_CHECKOUT_TOKENS)
def test_swarm_phase6_step3_no_checkout_rule_present(token: str) -> None:
    """Phase 6 Step 3 must carry the ⊗ no-checkout-in-others-worktree rule (#800)."""
    block = _phase6_step3_block(_read_swarm())
    assert token in block, (
        f"{_SWARM_PATH}: Phase 6 Step 3 missing #800 \u2297 rule token "
        f"{token!r} -- see issue #800 'Proposed rule' block"
    )


def test_swarm_phase6_step3_no_checkout_rule_uses_canonical_glyph() -> None:
    """The MUST NOT marker MUST be U+2297 (\u2297), not the cp1252 mojibake."""
    block = _phase6_step3_block(_read_swarm())
    # Defence-in-depth: the cp1252 round-trip mojibake of \u2297 (the
    # three-codepoint sequence \u0393\u00e8\u00f9) would have shipped if a
    # swarm agent followed the corrupted vbrief verbatim. This pre-PR
    # fix-up trail is documented in the CHANGELOG entry referencing
    # #796 / #800. The literal mojibake form is intentionally NOT written
    # here to keep this file clean against the #798 encoding gate.
    assert "\u0393\u00e8\u00f9" not in block, (
        f"{_SWARM_PATH}: Phase 6 Step 3 contains cp1252 mojibake "
        f"('\u0393\u00e8\u00f9') instead of canonical \u2297 (U+2297)"
    )


# ---------------------------------------------------------------------------
# 2. Phase 6 Step 3 carries the ! companion MAY/MUST-NOT rule (#800)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("token", _STEP3_COMPANION_MAY_TOKENS)
def test_swarm_phase6_step3_companion_may_rule_present(token: str) -> None:
    """Phase 6 Step 3 must carry the ! companion (merger-may-remove-own) rule (#800)."""
    block = _phase6_step3_block(_read_swarm())
    assert token in block, (
        f"{_SWARM_PATH}: Phase 6 Step 3 missing #800 ! companion rule token "
        f"{token!r} -- see issue #800 'Companion rule' block"
    )


def test_swarm_phase6_step3_companion_uses_must_marker() -> None:
    """The companion rule must be marked with ! (MUST), not ⊗ (MUST NOT)."""
    block = _phase6_step3_block(_read_swarm())
    # The line containing 'merger MAY remove' MUST start with the ! marker
    # (the rule grants permission + draws a boundary; it is not a prohibition).
    pattern = re.compile(r"^[\s\-]*!\s.*merger MAY remove", re.MULTILINE)
    assert pattern.search(block), (
        f"{_SWARM_PATH}: Phase 6 Step 3 companion rule must be marked with `!` "
        "(MUST), not a different RFC2119 marker (#800)"
    )


# ---------------------------------------------------------------------------
# 3. Anti-Patterns block bullet cites PR #797 + cross-references #727 (#800)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("token", _ANTI_PATTERN_TOKENS)
def test_swarm_anti_patterns_800_bullet_present(token: str) -> None:
    """Anti-Patterns must contain a #800 bullet citing PR #797 and #727."""
    text = _read_swarm()
    anti_start = text.find("## Anti-Patterns")
    assert anti_start != -1, (
        f"{_SWARM_PATH}: missing '## Anti-Patterns' section heading"
    )
    anti_block = text[anti_start:]
    assert token in anti_block, (
        f"{_SWARM_PATH}: Anti-Patterns missing #800 bullet token "
        f"{token!r} -- mirror the #727 Sub-Agent Role Separation "
        "anti-pattern bullet shape"
    )


def test_swarm_anti_patterns_800_bullet_is_prohibition() -> None:
    """The #800 anti-pattern bullet must use the ⊗ MUST NOT marker."""
    text = _read_swarm()
    anti_start = text.find("## Anti-Patterns")
    assert anti_start != -1, (
        f"{_SWARM_PATH}: missing '## Anti-Patterns' section heading"
    )
    anti_block = text[anti_start:]
    # Find the bullet whose content cites PR #797 and ensure it begins with ⊗.
    found = False
    for line in anti_block.splitlines():
        if "PR #797" in line and "git checkout" in line:
            assert "\u2297" in line, (
                f"{_SWARM_PATH}: #800 anti-pattern bullet must use \u2297 marker; "
                f"found: {line.strip()!r}"
            )
            found = True
            break
    assert found, (
        f"{_SWARM_PATH}: no Anti-Patterns bullet citing PR #797 + git checkout "
        "found -- the #800 anti-pattern is missing"
    )
