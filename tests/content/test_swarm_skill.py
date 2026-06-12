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


def test_swarm_deterministic_questions_are_host_portable() -> None:
    """Issue #1563 -- swarm gates must preserve visible numeric labels."""
    text = _read_swarm()
    assert "render the canonical numbered menu in chat" in text
    assert "numeric option labels" in text
    assert "exact displayed option text" in text
    assert "fallback chat replies MUST map only to the displayed number" in text


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


# ---------------------------------------------------------------------------
# 4. N2 / #1142 -- Phase 0 queue-driven cohort selection
# ---------------------------------------------------------------------------
#
# The N2 rewrite replaces the folder-scan Step 0 ("Work-Item Source") with a
# queue-driven Step 0 carrying four sub-phases (0a / 0b / 0c / 0d) and a D18
# #1136 fallback TODO marker pointing at the future
# `task scope:promote --from-issue=<N>` integration point. These tests pin the
# canonical content so a future edit silently dropping any of the load-bearing
# pieces fails CI.
#
# Stable substring matches (not full-text); failure messages cite the missing
# token so a contributor can locate the regression quickly.

_PHASE0_STEP0_HEADER = "### Step 0: Queue-driven cohort selection (#1142 / N2)"
_PHASE0_STEP0_5_HEADER = "### Step 0.5: Lifecycle Bridge"

# The four sub-phase headers, in canonical order.
_PHASE0_SUBPHASE_HEADERS = (
    "#### Phase 0a -- State overview via `task triage:summary` (D2 / #1122)",
    "#### Phase 0b -- Ranked candidates via `task triage:queue` (D11 / #1128)",
    "#### Phase 0c -- Promote-fill-cap loop",
    "#### Phase 0d -- Cohort dispatch",
)

# Canonical verb references that MUST be present inside the queue-driven
# Step 0 block. These are the per-sub-phase load-bearing references the
# scope of #1142 calls out explicitly.
_PHASE0_VERB_TOKENS = (
    # Phase 0a -- triage:summary verb cited verbatim
    "task triage:summary",
    # Phase 0b -- triage:queue verb cited verbatim with the --state=accept
    # filter and the --limit=20 cap from the issue body
    "task triage:queue --state=accept --limit=20",
    # Phase 0c -- canonical lifecycle verb (fallback shape until D18 ships)
    "task scope:promote",
    # WIP cap source
    "wipCap",
    # Cache-as-authoritative cross-reference to AGENTS.md #1149
    "Cache-as-authoritative work selection (#1149)",
)

# The exit-clean WIP-cap prose carries the literal language from the issue body.
_PHASE0_WIP_CAP_EXIT_TOKENS = (
    "WIP-cap exit-clean",
    "stops adding to the cohort and exits cleanly",
    "count of what was filled",
    "demote",
    "--force",
)

# The cohort-recovery prose carries the literal language from the issue body.
_PHASE0_COHORT_RECOVERY_TOKENS = (
    "Cohort recovery",
    "unpicked",
    "stay queued for the next session",
    "queue is the canonical record",
)

# D18 #1136 fallback tokens. The TODO marker MUST reference #1136 explicitly
# so a future grep for the integration point lands on this loop body.
_PHASE0_D18_FALLBACK_TOKENS = (
    "D18 #1136 fallback",
    "TODO(#1136)",
    "--from-issue=<N>",
    "OPEN but not",
)


def _phase0_step0_block(text: str) -> str:
    """Return the new queue-driven Step 0 block, bounded to Step 0.5."""
    start = text.find(_PHASE0_STEP0_HEADER)
    assert start != -1, (
        f"{_SWARM_PATH}: missing '{_PHASE0_STEP0_HEADER}' heading -- "
        "the N2 / #1142 queue-driven Phase 0 rewrite is missing"
    )
    end = text.find(_PHASE0_STEP0_5_HEADER, start)
    assert end != -1 and end > start, (
        f"{_SWARM_PATH}: '{_PHASE0_STEP0_5_HEADER}' heading not found after "
        "Step 0 -- cannot bound the Step 0 block for the #1142 assertions"
    )
    return text[start:end]


@pytest.mark.parametrize("header", _PHASE0_SUBPHASE_HEADERS)
def test_swarm_phase0_subphase_header_present(header: str) -> None:
    """Each of the four canonical sub-phase headers MUST be present."""
    block = _phase0_step0_block(_read_swarm())
    assert header in block, (
        f"{_SWARM_PATH}: Phase 0 Step 0 missing canonical sub-phase header "
        f"{header!r} -- see issue #1142 scope"
    )


def test_swarm_phase0_subphase_headers_in_canonical_order() -> None:
    """The four sub-phase headers MUST appear in canonical order 0a -> 0b -> 0c -> 0d."""
    block = _phase0_step0_block(_read_swarm())
    positions = [block.find(h) for h in _PHASE0_SUBPHASE_HEADERS]
    assert all(p != -1 for p in positions), (
        f"{_SWARM_PATH}: at least one Phase 0 sub-phase header is missing; "
        f"positions: {dict(zip(_PHASE0_SUBPHASE_HEADERS, positions, strict=True))}"
    )
    assert positions == sorted(positions), (
        f"{_SWARM_PATH}: Phase 0 sub-phase headers are not in canonical order "
        f"(0a -> 0b -> 0c -> 0d); positions: "
        f"{dict(zip(_PHASE0_SUBPHASE_HEADERS, positions, strict=True))}"
    )


@pytest.mark.parametrize("token", _PHASE0_VERB_TOKENS)
def test_swarm_phase0_verb_tokens_present(token: str) -> None:
    """Each canonical verb / cross-reference MUST appear inside Step 0."""
    block = _phase0_step0_block(_read_swarm())
    assert token in block, (
        f"{_SWARM_PATH}: Phase 0 Step 0 missing canonical verb / reference "
        f"{token!r} -- N2 / #1142 acceptance criteria"
    )


@pytest.mark.parametrize("token", _PHASE0_WIP_CAP_EXIT_TOKENS)
def test_swarm_phase0_wip_cap_exit_prose_present(token: str) -> None:
    """The WIP-cap exit-clean prose MUST carry the language from the issue body."""
    block = _phase0_step0_block(_read_swarm())
    assert token in block, (
        f"{_SWARM_PATH}: Phase 0 Step 0 missing WIP-cap exit-clean prose token "
        f"{token!r} -- N2 / #1142 acceptance criteria"
    )


@pytest.mark.parametrize("token", _PHASE0_COHORT_RECOVERY_TOKENS)
def test_swarm_phase0_cohort_recovery_prose_present(token: str) -> None:
    """The cohort-recovery prose MUST carry the language from the issue body."""
    block = _phase0_step0_block(_read_swarm())
    assert token in block, (
        f"{_SWARM_PATH}: Phase 0 Step 0 missing cohort-recovery prose token "
        f"{token!r} -- N2 / #1142 acceptance criteria"
    )


@pytest.mark.parametrize("token", _PHASE0_D18_FALLBACK_TOKENS)
def test_swarm_phase0_d18_1136_fallback_token_present(token: str) -> None:
    """The D18 #1136 fallback + TODO integration-point marker MUST be present."""
    block = _phase0_step0_block(_read_swarm())
    assert token in block, (
        f"{_SWARM_PATH}: Phase 0 Step 0 missing D18 / #1136 fallback token "
        f"{token!r} -- the integration-point TODO marker is mandatory per "
        "the orchestrator dispatch envelope's D18 #1136 fallback clause "
        "(N2 / #1142 owns the marker; D18 / #1136 owns the eventual "
        "--from-issue=<N> implementation)"
    )


# ---------------------------------------------------------------------------
# 5. #1487 -- Phase 6 cohort completion sweep (REQUIRED step)
# ---------------------------------------------------------------------------
#
# The #1487 work adds a REQUIRED Phase 6 step that sweeps a finished cohort's
# story vBRIEFs active/ -> completed/ and completes their decompose-created epic
# parents, covering BOTH the interactive and headless / multi-worker paths.
# These tests pin the load-bearing content so a future edit cannot silently
# drop the required step or its dual-path coverage.

_SWEEP_STEP_HEADER = "### Step 1.5: Cohort Completion Sweep (#1487)"
_SWEEP_STEP_END = "### Step 2: Close Issues and Update Origins"

# Load-bearing tokens that MUST appear inside the sweep step block.
_SWEEP_STEP_TOKENS = (
    # Canonical verb + companion script.
    "task swarm:complete-cohort",
    "scripts/swarm_complete_cohort.py",
    # The step is mandatory.
    "REQUIRED",
    # Both lifecycle stages are documented.
    "Stage 1",
    "Stage 2",
    # Both dispatch paths are covered (acceptance criterion #4).
    "Interactive path",
    "Headless / multi-worker path",
    # Validate-green reliance on the #1485 / #1487 reference maintenance.
    "task vbrief:validate",
    "#1485",
    "#1487",
)


def _sweep_step_block(text: str) -> str:
    """Return the #1487 Phase 6 sweep step block, bounded to Step 2."""
    start = text.find(_SWEEP_STEP_HEADER)
    assert start != -1, (
        f"{_SWARM_PATH}: missing '{_SWEEP_STEP_HEADER}' heading -- "
        "the #1487 REQUIRED Phase 6 cohort completion sweep step is missing"
    )
    end = text.find(_SWEEP_STEP_END, start)
    assert end != -1 and end > start, (
        f"{_SWARM_PATH}: '{_SWEEP_STEP_END}' heading not found after the sweep "
        "step -- cannot bound the #1487 block"
    )
    return text[start:end]


@pytest.mark.parametrize("token", _SWEEP_STEP_TOKENS)
def test_swarm_phase6_cohort_sweep_token_present(token: str) -> None:
    """The #1487 Phase 6 sweep step MUST carry each load-bearing token."""
    block = _sweep_step_block(_read_swarm())
    assert token in block, (
        f"{_SWARM_PATH}: Phase 6 cohort completion sweep step missing token "
        f"{token!r} -- see issue #1487 acceptance criteria"
    )


def test_swarm_phase6_cohort_sweep_is_required_rule() -> None:
    """The sweep step MUST open with a `!` MUST rule marking it REQUIRED."""
    block = _sweep_step_block(_read_swarm())
    pattern = re.compile(r"!\s+\*\*REQUIRED\.\*\*", re.MULTILINE)
    assert pattern.search(block), (
        f"{_SWARM_PATH}: the #1487 sweep step must be marked as a `!` MUST "
        "rule labelled REQUIRED"
    )


def test_swarm_anti_patterns_1487_bullet_present() -> None:
    """Anti-Patterns must carry a ⊗ bullet for skipping the cohort sweep (#1487)."""
    text = _read_swarm()
    anti_start = text.find("## Anti-Patterns")
    assert anti_start != -1, (
        f"{_SWARM_PATH}: missing '## Anti-Patterns' section heading"
    )
    anti_block = text[anti_start:]
    found = False
    for line in anti_block.splitlines():
        if "#1487" in line and "swarm:complete-cohort" in line:
            assert "\u2297" in line, (
                f"{_SWARM_PATH}: #1487 anti-pattern bullet must use the "
                f"\u2297 marker; found: {line.strip()!r}"
            )
            found = True
            break
    assert found, (
        f"{_SWARM_PATH}: no Anti-Patterns bullet citing #1487 + "
        "swarm:complete-cohort found -- the cohort-sweep anti-pattern is missing"
    )


# ---------------------------------------------------------------------------
# 6. #1531 -- provider-neutral sub-agent routing + preamble metadata
# ---------------------------------------------------------------------------
#
# Wave 3 pins the provider-neutral guidance landed by #1531b (swarm skill)
# and #1531c (agent preamble). Tests fail if either surface regresses to
# Grok Build-only wording or drops backend / role metadata for dispatched
# workers. Stable substring matches (not full-text).

_PREAMBLE_PATH = "templates/agent-prompt-preamble.md"

_STEP1B_HEADER = "### Step 1b: Provider-neutral sub-agent routing (#1531)"
_STEP1B_END = "### Step 2a: Orchestrated Launch (start_agent available)"

_PREAMBLE_SECTION_HEADER = "## 2.6 Provider-neutral worker metadata (#1531)"
_PREAMBLE_SECTION_END = "## 3. PowerShell 5.1 non-ASCII rule (#798)"

# Load-bearing tokens inside Phase 3 Step 1b (#1531b).
_PROVIDER_NEUTRAL_SWARM_TOKENS = (
    "provider-neutral",
    "Heterogeneous dispatch is provider-neutral",
    "Dispatch provider",
    "Worker role",
    "Model or agent selection",
    "Composer-class",
    "Grok Build",
    "Cursor/cloud",
    "future adapter",
    "not a Grok Build-only path",
)

# Anti-Patterns must retain the Grok Build-only regression guard (#1531).
_PROVIDER_NEUTRAL_SWARM_ANTI_PATTERN_TOKENS = (
    "Grok Build-only",
    "#1531",
    "Composer-class",
    "Cursor/cloud",
    "future adapter",
)

# Load-bearing tokens inside preamble §2.6 (#1531c).
_PROVIDER_NEUTRAL_PREAMBLE_TOKENS = (
    "provider-neutral",
    "Composer-class coding agents",
    "Grok Build (`spawn_subagent`)",
    "Cursor/cloud agents",
    "future adapters",
    "## Worker metadata",
    "dispatch_provider",
    "worker_role",
    "selected_backend",
    "routing_policy",
    "Role-boundary expectations (all providers)",
    "dispatch envelope",
)


def _read_preamble() -> str:
    return (_REPO_ROOT / _PREAMBLE_PATH).read_text(encoding="utf-8")


def _step1b_block(text: str) -> str:
    """Return Phase 3 Step 1b, bounded to Step 2a."""
    start = text.find(_STEP1B_HEADER)
    assert start != -1, (
        f"{_SWARM_PATH}: missing '{_STEP1B_HEADER}' heading -- "
        "the #1531 provider-neutral routing section is missing"
    )
    end = text.find(_STEP1B_END, start)
    assert end != -1 and end > start, (
        f"{_SWARM_PATH}: '{_STEP1B_END}' heading not found after Step 1b -- "
        "cannot bound the #1531 block"
    )
    return text[start:end]


def _preamble_section_26_block(text: str) -> str:
    """Return preamble §2.6, bounded to §3."""
    start = text.find(_PREAMBLE_SECTION_HEADER)
    assert start != -1, (
        f"{_PREAMBLE_PATH}: missing '{_PREAMBLE_SECTION_HEADER}' heading -- "
        "the #1531 worker-metadata section is missing"
    )
    end = text.find(_PREAMBLE_SECTION_END, start)
    assert end != -1 and end > start, (
        f"{_PREAMBLE_PATH}: '{_PREAMBLE_SECTION_END}' heading not found after "
        "§2.6 -- cannot bound the #1531 block"
    )
    return text[start:end]


@pytest.mark.parametrize("token", _PROVIDER_NEUTRAL_SWARM_TOKENS)
def test_provider_neutral_swarm_step1b_token_present(token: str) -> None:
    """Step 1b must pin provider-neutral backend choice and adapter examples (#1531)."""
    block = _step1b_block(_read_swarm())
    assert token in block, (
        f"{_SWARM_PATH}: Phase 3 Step 1b missing provider-neutral token "
        f"{token!r} -- see #1531b acceptance criteria"
    )


def test_provider_neutral_swarm_step1b_separates_three_concerns() -> None:
    """Step 1b must list dispatch provider, worker role, and model selection separately."""
    block = _step1b_block(_read_swarm())
    positions = [block.find(label) for label in (
        "Dispatch provider",
        "Worker role",
        "Model or agent selection",
    )]
    assert all(p != -1 for p in positions), (
        f"{_SWARM_PATH}: Phase 3 Step 1b must enumerate all three routing "
        f"concerns; positions: {positions}"
    )
    assert positions == sorted(positions), (
        f"{_SWARM_PATH}: Phase 3 Step 1b routing concerns are out of order; "
        f"positions: {positions}"
    )


@pytest.mark.parametrize("token", _PROVIDER_NEUTRAL_SWARM_ANTI_PATTERN_TOKENS)
def test_provider_neutral_swarm_anti_pattern_token_present(token: str) -> None:
    """Anti-Patterns must guard against Grok Build-only routing regressions (#1531)."""
    text = _read_swarm()
    anti_start = text.find("## Anti-Patterns")
    assert anti_start != -1, (
        f"{_SWARM_PATH}: missing '## Anti-Patterns' section heading"
    )
    anti_block = text[anti_start:]
    assert token in anti_block, (
        f"{_SWARM_PATH}: Anti-Patterns missing #1531 provider-neutral token "
        f"{token!r} -- must forbid Grok Build-only regressions"
    )


@pytest.mark.parametrize("token", _PROVIDER_NEUTRAL_PREAMBLE_TOKENS)
def test_provider_neutral_preamble_section_26_token_present(token: str) -> None:
    """Preamble §2.6 must carry provider-neutral backend and role metadata (#1531)."""
    block = _preamble_section_26_block(_read_preamble())
    assert token in block, (
        f"{_PREAMBLE_PATH}: §2.6 missing provider-neutral token "
        f"{token!r} -- see #1531c acceptance criteria"
    )


def test_provider_neutral_preamble_worker_metadata_is_required_rule() -> None:
    """§2.6 must mark intentional backend-routed dispatch with a ! MUST rule."""
    block = _preamble_section_26_block(_read_preamble())
    pattern = re.compile(
        r"!\s+Every intentional backend-routed dispatch MUST carry",
        re.MULTILINE,
    )
    assert pattern.search(block), (
        f"{_PREAMBLE_PATH}: §2.6 must open the Worker metadata requirement "
        "with a `!` MUST rule (#1531c)"
    )


# ---------------------------------------------------------------------------
# 7. #1557 -- worker runtime classification + GitHub auth remediation
# ---------------------------------------------------------------------------
#
# Wave 3 pins the sandbox credential remediation guidance landed by #1557d.
# Tests fail if the swarm skill drops runtime-mode classification, host-gh
# validation, cloud/headless injected-token failure, or sandbox remediation
# language. Stable substring matches (not full-text).

_STEP1A_HEADER = "### Step 1a: Worker Runtime and GitHub Auth Preflight (#1557)"
_STEP1A_END = "### Step 1b: Provider-neutral sub-agent routing (#1531)"

_SANDBOX_AUTH_TOKENS = (
    "scripts/platform_capabilities.py",
    "scripts/github_auth_modes.py",
    "local-unsandboxed",
    "cursor-native-sandbox",
    "cloud-headless",
    "sandbox_uid_remap",
    "sandbox-remapped-local-user",
    "sandbox view",
    "host-gh",
    "injected-token",
    "missing_injected_token",
    "gh auth status",
    "Full-access execution",
    "Trusted `gh` command allowlisting",
    "Injected-token handoff",
    "docs/subagent-heartbeat.md",
    "#1557",
)

_SANDBOX_AUTH_ANTI_PATTERN_TOKENS = (
    "parent-shell `gh auth status`",
    "sandbox UID 0",
    "#1557",
)


def _step1a_block(text: str) -> str:
    """Return Phase 3 Step 1a, bounded to Step 1b."""
    start = text.find(_STEP1A_HEADER)
    assert start != -1, (
        f"{_SWARM_PATH}: missing '{_STEP1A_HEADER}' heading -- "
        "the #1557 worker runtime/auth preflight step is missing"
    )
    end = text.find(_STEP1A_END, start)
    assert end != -1 and end > start, (
        f"{_SWARM_PATH}: '{_STEP1A_END}' heading not found after Step 1a -- "
        "cannot bound the #1557 block"
    )
    return text[start:end]


@pytest.mark.parametrize("token", _SANDBOX_AUTH_TOKENS)
def test_swarm_phase3_step1a_sandbox_auth_token_present(token: str) -> None:
    """Step 1a must pin runtime modes, auth validation, and remediation (#1557)."""
    block = _step1a_block(_read_swarm())
    assert token in block, (
        f"{_SWARM_PATH}: Phase 3 Step 1a missing #1557 token "
        f"{token!r} -- see 1557d acceptance criteria"
    )


def test_swarm_phase3_step1a_uid_remap_not_host_root() -> None:
    """Step 1a must forbid presenting sandbox root as host-root ownership."""
    block = _step1a_block(_read_swarm())
    assert "not real root" in block, (
        f"{_SWARM_PATH}: Phase 3 Step 1a must explain UID remap is not real root"
    )
    assert "host-root access" in block, (
        f"{_SWARM_PATH}: Phase 3 Step 1a must warn against host-root misread"
    )


@pytest.mark.parametrize("token", _SANDBOX_AUTH_ANTI_PATTERN_TOKENS)
def test_swarm_anti_patterns_1557_token_present(token: str) -> None:
    """Anti-Patterns must guard against parent-shell auth and sandbox-root regressions."""
    text = _read_swarm()
    anti_start = text.find("## Anti-Patterns")
    assert anti_start != -1, (
        f"{_SWARM_PATH}: missing '## Anti-Patterns' section heading"
    )
    anti_block = text[anti_start:]
    assert token in anti_block, (
        f"{_SWARM_PATH}: Anti-Patterns missing #1557 token "
        f"{token!r} -- must forbid sandbox auth regressions"
    )


# ---------------------------------------------------------------------------
# 8. #1568 -- interactive backend selection before launch
# ---------------------------------------------------------------------------

_PHASE0_BACKEND_HEADER = "#### Phase 0e -- Interactive sub-agent backend selection (#1568)"
_PHASE0_BACKEND_END = "#### Manual / GitHub-issue escape hatch"

_INTERACTIVE_BACKEND_TOKENS = (
    "task policy:subagent-backends",
    "plan.policy.swarmSubagentBackend",
    "before any `task swarm:launch`",
    "operator preference",
    "probe availability is supporting evidence only",
    "do NOT imply `cursor-cloud` is the default just because it is probe-available",
    "Local Composer/Cursor subagents (`composer`)",
    "Cursor cloud agents (`cursor-cloud`)",
    "Grok Build subagents (`grok-build`)",
    "task policy:subagent-backend -- <id>",
    "per-run launch-context choice",
    "unavailable or unknown",
    "rerun the probe in the target environment",
    "Autonomous/headless launch remains fail-closed",
    "scripts/swarm_launch.py",
)


def _phase0_backend_block(text: str) -> str:
    """Return the #1568 interactive backend-selection block."""
    start = text.find(_PHASE0_BACKEND_HEADER)
    assert start != -1, (
        f"{_SWARM_PATH}: missing '{_PHASE0_BACKEND_HEADER}' heading -- "
        "interactive swarms must ask for backend intent before launch"
    )
    end = text.find(_PHASE0_BACKEND_END, start)
    assert end != -1 and end > start, (
        f"{_SWARM_PATH}: '{_PHASE0_BACKEND_END}' heading not found after "
        "the #1568 backend-selection block"
    )
    return text[start:end]


@pytest.mark.parametrize("token", _INTERACTIVE_BACKEND_TOKENS)
def test_swarm_phase0_backend_selection_token_present(token: str) -> None:
    """The interactive path must ask for backend intent before headless launch."""
    block = _phase0_backend_block(_read_swarm())
    assert token in block, (
        f"{_SWARM_PATH}: Phase 0 backend-selection block missing token "
        f"{token!r} -- see issue #1568 acceptance criteria"
    )


def test_swarm_phase0d_routes_through_backend_selection_before_bridge() -> None:
    """Phase 0d must hand interactive swarms to Phase 0e before Step 0.5."""
    text = _read_swarm()
    phase0d = text.find("#### Phase 0d -- Cohort dispatch")
    phase0e = text.find(_PHASE0_BACKEND_HEADER)
    assert phase0d != -1 and phase0e != -1 and phase0d < phase0e, (
        f"{_SWARM_PATH}: Phase 0d must precede the #1568 backend-selection block"
    )
    block = text[phase0d:phase0e]
    assert "Phase 0e below captures the intended sub-agent backend" in block
    assert "before Step 0.5 hardens lifecycle state" in block


def test_swarm_phase0_backend_menu_uses_visible_numbered_options() -> None:
    """Backend menu must use visible numbering with Discuss and Back final."""
    block = _phase0_backend_block(_read_swarm())
    options = (
        "1. Local Composer/Cursor subagents (`composer`)",
        "2. Cursor cloud agents (`cursor-cloud`)",
        "3. Grok Build subagents (`grok-build`)",
        "4. Discuss",
        "5. Back",
    )
    positions = [block.find(option) for option in options]
    assert all(position != -1 for position in positions), (
        f"{_SWARM_PATH}: backend menu missing one or more visible numbered "
        f"options; positions={dict(zip(options, positions, strict=True))}"
    )
    assert positions == sorted(positions), (
        f"{_SWARM_PATH}: backend menu options must appear in canonical order; "
        f"positions={dict(zip(options, positions, strict=True))}"
    )


def test_swarm_phase0_backend_followup_menu_uses_visible_numbered_options() -> None:
    """Persistence follow-up menu must also render explicit numbered choices."""
    block = _phase0_backend_block(_read_swarm())
    options = (
        "1. Persist backend to project policy with `task policy:subagent-backend -- <id>`",
        "2. Record backend as a per-run launch-context choice for this swarm only",
        "3. Discuss",
        "4. Back",
    )
    positions = [block.find(option) for option in options]
    assert all(position != -1 for position in positions), (
        f"{_SWARM_PATH}: backend follow-up menu missing one or more visible "
        f"numbered options; positions={dict(zip(options, positions, strict=True))}"
    )
    assert positions == sorted(positions), (
        f"{_SWARM_PATH}: backend follow-up menu options must appear in "
        f"canonical order; positions={dict(zip(options, positions, strict=True))}"
    )


def test_swarm_phase0_backend_menu_keeps_discuss_back_final() -> None:
    """Discuss and Back must be the final two backend prompt choices."""
    block = _phase0_backend_block(_read_swarm())
    discuss = block.find("4. Discuss")
    back = block.find("5. Back")
    assert discuss != -1 and back != -1 and discuss < back, (
        f"{_SWARM_PATH}: backend-selection menu must end with Discuss then Back"
    )
    assert "6. " not in block[back:], (
        f"{_SWARM_PATH}: backend-selection menu must not add options after Back"
    )


# ---------------------------------------------------------------------------
# 9. #1053 -- greenfield and no-orchestration swarm launch surfaces
# ---------------------------------------------------------------------------

_GREENFIELD_BOOTSTRAP_HEADER = "#### Phase 0f -- Greenfield swarm-ready bootstrap (#1053)"
_GREENFIELD_BOOTSTRAP_END = "#### Manual / GitHub-issue escape hatch"

_GREENFIELD_BOOTSTRAP_TOKENS = (
    "greenfield swarm-ready bootstrap",
    "project infrastructure is separate from machine-tool availability",
    "git repository",
    "GitHub remote visibility",
    "Taskfile wiring",
    "install layout consistency",
    "scratch/worktree readiness",
    "task`, `uv`, `python`, `gh`, and `git`",
    "#1187",
    "exact remediation path",
    "explicit approval before creating or changing",
    "repo, remote, Taskfile, install layout, or gitignore state",
    "freshly setup-created candidates",
    "one explicit batch confirmation",
)

_INTERACTIVE_WORKTREE_TOKENS = (
    ".deft-scratch/worktrees/<story-id>",
    "launch manifest's resolved `worktree_path`",
    "deterministic ignored scratch paths",
    "sibling checkout directories",
    "%TEMP%",
    "OS temp",
    "explicit override",
    "throwaway CI or rehearsal runs",
)

_GENERIC_TERMINAL_TOKENS = (
    "generic-terminal",
    "Serial self-execution downgrade",
    "explicit operator consent",
    "one story at a time",
    "not true concurrent swarm execution",
    "manual terminal prompt-paste fallback remains available",
    "Do not describe this downgrade as a swarm",
)


def _greenfield_bootstrap_block(text: str) -> str:
    """Return the #1053 greenfield bootstrap block."""
    start = text.find(_GREENFIELD_BOOTSTRAP_HEADER)
    assert start != -1, (
        f"{_SWARM_PATH}: missing '{_GREENFIELD_BOOTSTRAP_HEADER}' heading -- "
        "greenfield swarms must surface project-infrastructure readiness"
    )
    end = text.find(_GREENFIELD_BOOTSTRAP_END, start)
    assert end != -1 and end > start, (
        f"{_SWARM_PATH}: '{_GREENFIELD_BOOTSTRAP_END}' heading not found after "
        "the greenfield bootstrap block"
    )
    return text[start:end]


def _phase2_mode_b_block(text: str) -> str:
    """Return Phase 2 Mode B monitor-created worktree guidance."""
    start = text.find("#### Mode B -- Monitor-created worktrees (interactive path)")
    assert start != -1, (
        f"{_SWARM_PATH}: missing Phase 2 Mode B monitor-created worktree heading"
    )
    end = text.find("### Step 2: Generate Prompt Files", start)
    assert end != -1 and end > start, (
        f"{_SWARM_PATH}: prompt-file step not found after Phase 2 Mode B"
    )
    return text[start:end]


def _runtime_detection_block(text: str) -> str:
    """Return Phase 3 runtime detection guidance through Step 1a."""
    start = text.find("### Step 1: Runtime Capability Detection")
    assert start != -1, (
        f"{_SWARM_PATH}: missing Phase 3 runtime capability detection heading"
    )
    end = text.find("### Step 1a: Worker Runtime and GitHub Auth Preflight", start)
    assert end != -1 and end > start, (
        f"{_SWARM_PATH}: Step 1a heading not found after runtime detection"
    )
    return text[start:end]


@pytest.mark.parametrize("token", _GREENFIELD_BOOTSTRAP_TOKENS)
def test_swarm_phase0_greenfield_bootstrap_token_present(token: str) -> None:
    """Phase 0 must distinguish greenfield project infrastructure from #1187 tools."""
    block = _greenfield_bootstrap_block(_read_swarm())
    assert token in block, (
        f"{_SWARM_PATH}: Phase 0 greenfield bootstrap block missing token "
        f"{token!r} -- see issue #1053 greenfield acceptance criteria"
    )


@pytest.mark.parametrize("token", _INTERACTIVE_WORKTREE_TOKENS)
def test_swarm_phase2_interactive_worktree_default_token_present(token: str) -> None:
    """Interactive worktrees must default to deterministic ignored scratch paths."""
    block = _phase2_mode_b_block(_read_swarm())
    assert token in block, (
        f"{_SWARM_PATH}: Phase 2 Mode B missing worktree-placement token "
        f"{token!r} -- see issue #1053 worktree placement criteria"
    )


def test_swarm_phase2_no_longer_defaults_to_sibling_example_paths() -> None:
    """Interactive worktree examples must not default to sibling checkout clutter."""
    block = _phase2_mode_b_block(_read_swarm())
    assert "E:\\Repos\\deft-agent1" not in block
    assert "E:\\Repos\\deft-agent2" not in block


@pytest.mark.parametrize("token", _GENERIC_TERMINAL_TOKENS)
def test_swarm_runtime_generic_terminal_serial_downgrade_token_present(token: str) -> None:
    """Generic-terminal mode must offer explicit serial self-execution fallback."""
    block = _runtime_detection_block(_read_swarm())
    assert token in block, (
        f"{_SWARM_PATH}: runtime detection missing generic-terminal token "
        f"{token!r} -- see issue #1053 generic-terminal fallback criteria"
    )
