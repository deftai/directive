"""Content tests for the ``## Allocation context`` consent-token recognition +
population prose (#1378 Story B).

Story A (``templates/agent-prompt-preamble.md``) freezes the canonical
``## Allocation context`` schema. Story B teaches the two skills that flank a
swarm dispatch to use it:

  * ``skills/deft-directive-build/SKILL.md`` Step 0 recognizes the structured
    section as the canonical consent-token path (swarm-cohort + non-null
    ``allocation_plan_id`` + ``batching_rationale``), while EXPLICITLY keeping
    the #1371 prose carve-out as the fallback when the section is absent.
  * ``skills/deft-directive-swarm/SKILL.md`` Phase 3 (Launch) requires the
    dispatcher to populate the section in EVERY dispatched prompt (cohort AND
    solo), per the Story A schema.

These tests pin the load-bearing tokens so a future copy-edit that silently
drops the recognition prose or the population step fails CI. Stable substring
matches (not full-text); failure messages cite the file path + the missing
token. Mirrors the block-bounded pattern in
``tests/content/test_swarm_skill.py`` and ``tests/content/test_story_start_gate.py``.

The ``\u2297`` (U+2297) MUST NOT glyph is written via its escape sequence to
keep this test file clean against the #798 encoding gate.
"""

from __future__ import annotations

from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_BUILD_PATH = "skills/deft-directive-build/SKILL.md"
_SWARM_PATH = "skills/deft-directive-swarm/SKILL.md"


def _read(rel_path: str) -> str:
    return (_REPO_ROOT / rel_path).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Build skill Step 0 block helper
# ---------------------------------------------------------------------------


def _build_step0_block(text: str) -> str:
    """Return the build-skill Step 0 (Implementation Preflight) block."""
    start = text.find("## Step 0 -- Implementation Preflight (#810)")
    assert start != -1, (
        f"{_BUILD_PATH}: missing '## Step 0 -- Implementation Preflight (#810)' "
        "heading -- the #1378 recognition bullet anchors on Step 0"
    )
    end = text.find("## Platform Detection", start)
    assert end != -1 and end > start, (
        f"{_BUILD_PATH}: '## Platform Detection' heading not found after Step 0 "
        "-- cannot bound the Step 0 block for the #1378 assertions"
    )
    return text[start:end]


# ---------------------------------------------------------------------------
# Swarm skill Phase 3 Step 0 block helper
# ---------------------------------------------------------------------------

_SWARM_STEP0_HEADER = (
    "### Step 0: Populate the allocation-context consent token (#1378)"
)


def _swarm_phase3_step0_block(text: str) -> str:
    """Return the swarm-skill Phase 3 Step 0 (population) block."""
    start = text.find(_SWARM_STEP0_HEADER)
    assert start != -1, (
        f"{_SWARM_PATH}: missing '{_SWARM_STEP0_HEADER}' heading -- the #1378 "
        "Phase 3 population step is missing"
    )
    end = text.find("### Step 1: Runtime Capability Detection", start)
    assert end != -1 and end > start, (
        f"{_SWARM_PATH}: '### Step 1: Runtime Capability Detection' heading not "
        "found after Step 0 -- cannot bound the Phase 3 Step 0 block"
    )
    return text[start:end]


# ---------------------------------------------------------------------------
# 1. Build skill Step 0 recognizes the structured consent token (#1378)
# ---------------------------------------------------------------------------

# Tokens drawn from the frozen schema contract + the recognition bullet. Stable
# substrings so minor copy-edits don't break the contract while preserving the
# rule's intent.
_BUILD_RECOGNITION_TOKENS = (
    # The new bullet's distinctive header.
    "Structured consent-token recognition (#1378)",
    # The canonical section name.
    "## Allocation context",
    # The cross-reference to Story A (schema owner) -- must NOT be edited there.
    "templates/agent-prompt-preamble.md",
    # The three recognition predicates (frozen schema contract).
    "dispatch_kind: swarm-cohort",
    "allocation_plan_id",
    "batching_rationale",
    # The cohort list field the worker reads as its file boundary.
    "cohort_vbriefs",
    # The mechanical-satisfaction claim.
    "consent token is satisfied mechanically",
)


@pytest.mark.parametrize("token", _BUILD_RECOGNITION_TOKENS)
def test_build_step0_recognition_token_present(token: str) -> None:
    """Build skill Step 0 must carry the #1378 structured-recognition tokens."""
    block = _build_step0_block(_read(_BUILD_PATH))
    assert token in block, (
        f"{_BUILD_PATH}: Step 0 missing #1378 recognition token {token!r} "
        "-- see #1378 Story B build-skill acceptance criteria"
    )


def test_build_step0_recognition_is_must_bullet() -> None:
    """The recognition rule must be a `!` (MUST) bullet, not a softer marker."""
    block = _build_step0_block(_read(_BUILD_PATH))
    found = False
    for line in block.splitlines():
        if "Structured consent-token recognition (#1378)" in line:
            stripped = line.lstrip(" -")
            assert stripped.startswith("! "), (
                f"{_BUILD_PATH}: #1378 recognition bullet must be a `!` MUST "
                f"rule; found: {line.strip()!r}"
            )
            found = True
            break
    assert found, (
        f"{_BUILD_PATH}: no Step 0 line carrying the #1378 recognition header "
        "found"
    )


def test_build_step0_keeps_1371_prose_fallback() -> None:
    """Step 0 must EXPLICITLY keep the #1371 prose carve-out as the fallback."""
    block = _build_step0_block(_read(_BUILD_PATH))
    # The new bullet names the absent-section fallback...
    assert "ABSENT" in block, (
        f"{_BUILD_PATH}: Step 0 #1378 bullet must name the ABSENT-section "
        "fallback path"
    )
    assert "#1371 prose carve-out" in block, (
        f"{_BUILD_PATH}: Step 0 #1378 bullet must point at the #1371 prose "
        "carve-out as the fallback when the section is absent"
    )
    # ...and the original #1371 carve-out bullet itself must still be present
    # (we must NOT reword or remove it).
    assert "Swarm-cohort dispatch carve-out" in block, (
        f"{_BUILD_PATH}: the original #1371 'Swarm-cohort dispatch carve-out' "
        "bullet must remain in Step 0 as the prose fallback (do not remove it)"
    )
    assert "(#954)" in block, (
        f"{_BUILD_PATH}: the #1371 carve-out's all-or-nothing (#954) reference "
        "must remain intact"
    )


# ---------------------------------------------------------------------------
# 2. Swarm skill Phase 3 populates the section on every dispatch (#1378)
# ---------------------------------------------------------------------------

# Tokens drawn from the Phase 3 Step 0 population step. The five schema fields
# must all be named so the dispatcher populates the full Story A shape.
_SWARM_POPULATION_TOKENS = (
    # The canonical section name.
    "## Allocation context",
    # Cross-reference to the Story A schema owner.
    "templates/agent-prompt-preamble.md",
    # The cohort-AND-solo requirement (the step applies to every dispatch).
    "swarm cohort OR solo",
    # All five frozen-schema fields.
    "dispatch_kind",
    "allocation_plan_id",
    "batching_rationale",
    "cohort_vbriefs",
    "operator_approval_evidence",
    # The downstream recognition cross-reference to the Story B build skill.
    "build-skill Step 0 recognizes mechanically (#1378 Story B)",
)


@pytest.mark.parametrize("token", _SWARM_POPULATION_TOKENS)
def test_swarm_phase3_population_token_present(token: str) -> None:
    """Swarm Phase 3 Step 0 must carry the #1378 population-step tokens."""
    block = _swarm_phase3_step0_block(_read(_SWARM_PATH))
    assert token in block, (
        f"{_SWARM_PATH}: Phase 3 Step 0 missing #1378 population token "
        f"{token!r} -- see #1378 Story B swarm-skill acceptance criteria"
    )


def test_swarm_phase3_population_is_must_step() -> None:
    """The population step must be a `!` (MUST) requirement."""
    block = _swarm_phase3_step0_block(_read(_SWARM_PATH))
    assert "! Before dispatching ANY worker prompt" in block, (
        f"{_SWARM_PATH}: Phase 3 Step 0 must carry the `!` MUST population "
        "requirement covering every dispatched prompt"
    )
    assert "MUST populate a `## Allocation context` section" in block, (
        f"{_SWARM_PATH}: Phase 3 Step 0 must explicitly MUST-populate the "
        "`## Allocation context` section"
    )


def test_swarm_phase3_population_has_absent_section_prohibition() -> None:
    """A MUST NOT bullet must forbid dispatching without the section."""
    block = _swarm_phase3_step0_block(_read(_SWARM_PATH))
    found = False
    for line in block.splitlines():
        if (
            "without a populated `## Allocation context` section" in line
            and "#1378" in line
        ):
            assert "\u2297" in line, (
                f"{_SWARM_PATH}: the dispatch-without-section prohibition must "
                f"use the \u2297 MUST NOT marker; found: {line.strip()!r}"
            )
            found = True
            break
    assert found, (
        f"{_SWARM_PATH}: Phase 3 Step 0 missing the \u2297 prohibition against "
        "dispatching a worker prompt without a populated ## Allocation context "
        "section (#1378)"
    )


# ---------------------------------------------------------------------------
# 3. Swarm skill Phase 3 Step 1a documents sandbox auth remediation (#1557)
# ---------------------------------------------------------------------------

_STEP1A_HEADER = "### Step 1a: Worker Runtime and GitHub Auth Preflight (#1557)"
_STEP1A_END = "### Step 1b: Provider-neutral sub-agent routing (#1531)"

_SWARM_SANDBOX_AUTH_TOKENS = (
    "scripts/platform_capabilities.py",
    "scripts/github_auth_modes.py",
    "sandbox_uid_remap",
    "host-gh",
    "injected-token",
    "missing_injected_token",
    "cloud-headless",
    "Full-access execution",
    "Trusted `gh` command allowlisting",
    "Injected-token handoff",
)


def _swarm_phase3_step1a_block(text: str) -> str:
    """Return the swarm-skill Phase 3 Step 1a (sandbox auth) block."""
    start = text.find(_STEP1A_HEADER)
    assert start != -1, (
        f"{_SWARM_PATH}: missing '{_STEP1A_HEADER}' heading -- the #1557 "
        "Phase 3 runtime/auth preflight step is missing"
    )
    end = text.find(_STEP1A_END, start)
    assert end != -1 and end > start, (
        f"{_SWARM_PATH}: '{_STEP1A_END}' heading not found after Step 1a -- "
        "cannot bound the #1557 block"
    )
    return text[start:end]


@pytest.mark.parametrize("token", _SWARM_SANDBOX_AUTH_TOKENS)
def test_swarm_phase3_step1a_sandbox_auth_token_present(token: str) -> None:
    """Swarm Phase 3 Step 1a must carry #1557 sandbox/auth guidance tokens."""
    block = _swarm_phase3_step1a_block(_read(_SWARM_PATH))
    assert token in block, (
        f"{_SWARM_PATH}: Phase 3 Step 1a missing #1557 token "
        f"{token!r} -- see 1557d acceptance criteria"
    )


def test_swarm_phase3_step1a_is_must_step() -> None:
    """The sandbox auth preflight step must be a `!` (MUST) requirement."""
    block = _swarm_phase3_step1a_block(_read(_SWARM_PATH))
    assert "! Before dispatching workers that will call `gh`" in block, (
        f"{_SWARM_PATH}: Phase 3 Step 1a must carry the `!` MUST preflight "
        "requirement for worker GitHub auth (#1557)"
    )
