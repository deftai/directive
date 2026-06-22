"""Content tests for the headless / low-ceremony swarm launch prose contract (#1387).

#1387 documents a headless launch path in the swarm skill so an operator with a
pre-approved cohort can launch with a SINGLE consent (the #1378 allocation-context
token) instead of the per-phase interactive gates. The prose lands in two surfaces
that MUST agree:

  * ``skills/deft-directive-swarm/SKILL.md`` -- Phase 0 headless cohort fast-path
    (routes through the C1 ``task swarm:launch`` CLI, skips the promote-fill loop),
    Phase 2 Step 1 Mode A (accepts a pre-created C3 worktree map), and Phase 3
    Step 0.5 (consumes the C2 launch-manifest as dispatch prep; the spawn stays
    agent-driven via Step 2a / 2d).
  * ``AGENTS.md`` -- a concise gate-stack mirror so both surfaces stay in lockstep.

These tests pin the load-bearing tokens (the C1 / C2 / C3 contract names,
``swarm:launch``, the pre-created worktree map, and launch-manifest consumption)
so a future copy-edit that silently drops the headless contract fails CI. Stable
substring matches (not full-text); failure messages cite the file path + the
missing token. Mirrors the block-bounded pattern in
``tests/content/test_swarm_skill.py`` and
``tests/content/test_allocation_context_skills.py``.

The ``\u2297`` (U+2297) MUST NOT glyph is written via its escape sequence to keep
this test file clean against the #798 encoding gate.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_SWARM_PATH = "content/skills/deft-directive-swarm/SKILL.md"
_AGENTS_PATH = "AGENTS.md"


def _read(rel_path: str) -> str:
    return (_REPO_ROOT / rel_path).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Block helpers -- each headless section is bounded by ASCII anchors so a
# future heading rename surfaces a clear failure rather than a silent pass.
# ---------------------------------------------------------------------------

_PHASE0_HEADLESS_HEADER = (
    "### Headless cohort fast-path: low-ceremony launch (C1 / #1387)"
)
_PHASE2_STEP1_HEADER = "### Step 1: Create Worktrees"
_PHASE3_STEP05_HEADER = (
    "### Step 0.5: Consume the launch-manifest before dispatch "
    "(headless path, C2 / #1387)"
)
_AGENTS_HEADER = "## Headless swarm launch gate-stack (#1387)"


def _bounded_block(text: str, start_marker: str, end_marker: str, path: str) -> str:
    start = text.find(start_marker)
    assert start != -1, (
        f"{path}: missing {start_marker!r} heading -- the #1387 headless "
        "launch prose is missing"
    )
    end = text.find(end_marker, start + len(start_marker))
    assert end != -1 and end > start, (
        f"{path}: {end_marker!r} not found after {start_marker!r} -- cannot "
        "bound the #1387 block"
    )
    return text[start:end]


def _phase0_headless_block(text: str) -> str:
    return _bounded_block(
        text,
        _PHASE0_HEADLESS_HEADER,
        "### Step 0: Queue-driven cohort selection (#1142 / N2)",
        _SWARM_PATH,
    )


def _phase2_step1_block(text: str) -> str:
    return _bounded_block(
        text,
        _PHASE2_STEP1_HEADER,
        "### Step 2: Generate Prompt Files",
        _SWARM_PATH,
    )


def _phase3_step05_block(text: str) -> str:
    return _bounded_block(
        text,
        _PHASE3_STEP05_HEADER,
        "### Step 1: Runtime Capability Detection",
        _SWARM_PATH,
    )


def _agents_block(text: str) -> str:
    start = text.find(_AGENTS_HEADER)
    assert start != -1, (
        f"{_AGENTS_PATH}: missing {_AGENTS_HEADER!r} heading -- the #1387 "
        "gate-stack mirror is missing"
    )
    # Slice to the next top-level (## ) heading after the section header.
    nxt = re.search(r"\n## ", text[start + len(_AGENTS_HEADER):])
    end = (start + len(_AGENTS_HEADER) + nxt.start()) if nxt else len(text)
    return text[start:end]


# ---------------------------------------------------------------------------
# 1. Phase 0 headless cohort fast-path (C1 / #1387)
# ---------------------------------------------------------------------------

_PHASE0_TOKENS = (
    "task swarm:launch",
    "--stories",
    "--group",
    "--worktree-map",
    "--base-branch",
    "--autonomous",
    "C1",
    "## Allocation context",
    "#1378",
    "#1387",
    "dispatch_kind: swarm-cohort",
    "promote-fill loop",
    "pre-approved cohort",
    "SINGLE consent",
)


@pytest.mark.parametrize("token", _PHASE0_TOKENS)
def test_swarm_phase0_headless_token_present(token: str) -> None:
    """Phase 0 headless fast-path must carry the #1387 C1 tokens."""
    block = _phase0_headless_block(_read(_SWARM_PATH))
    assert token in block, (
        f"{_SWARM_PATH}: Phase 0 headless fast-path missing #1387 token "
        f"{token!r} -- see #1387 acceptance criteria (Phase 0 entry)"
    )


def test_swarm_phase0_headless_reprompt_prohibition() -> None:
    """A MUST NOT bullet must forbid re-prompting per-phase under the C1 path."""
    block = _phase0_headless_block(_read(_SWARM_PATH))
    found = False
    for line in block.splitlines():
        if "Re-prompt the operator for per-phase batching approval" in line:
            assert "\u2297" in line, (
                f"{_SWARM_PATH}: the re-prompt prohibition must use the "
                f"\\u2297 MUST NOT marker; found: {line.strip()!r}"
            )
            found = True
            break
    assert found, (
        f"{_SWARM_PATH}: Phase 0 headless fast-path missing the \\u2297 "
        "prohibition against re-prompting per-phase approval under the "
        "pre-approved-cohort path (#1387)"
    )


# ---------------------------------------------------------------------------
# 2. Phase 2 Step 1 Mode A -- pre-created worktree map (C3 / #1387)
# ---------------------------------------------------------------------------

_PHASE2_TOKENS = (
    "pre-created worktree map",
    "C3",
    "--worktree-map",
    "resolve_worktree_map",
    "scripts/swarm_worktrees.py",
    # The full C3 record schema -- story_id is the join key tying each C3
    # worktree-map record to its C2 launch-manifest entry, so pin it too.
    "story_id",
    "worktree_path",
    "base_branch",
    "same-path collisions",
    # Mode B (the interactive fallback) must remain documented.
    "git worktree add",
)


@pytest.mark.parametrize("token", _PHASE2_TOKENS)
def test_swarm_phase2_worktree_map_token_present(token: str) -> None:
    """Phase 2 Step 1 must document the C3 pre-created worktree map (#1387)."""
    block = _phase2_step1_block(_read(_SWARM_PATH))
    assert token in block, (
        f"{_SWARM_PATH}: Phase 2 Step 1 missing #1387 C3 token {token!r} "
        "-- see #1387 acceptance criteria (Phase 2 pre-created worktrees)"
    )


def test_swarm_phase2_has_both_modes() -> None:
    """Step 1 must keep BOTH the pre-created (Mode A) and create (Mode B) paths."""
    block = _phase2_step1_block(_read(_SWARM_PATH))
    assert "Mode A" in block and "Mode B" in block, (
        f"{_SWARM_PATH}: Phase 2 Step 1 must document Mode A (pre-created "
        "worktree map) AND Mode B (monitor-created worktrees) (#1387)"
    )


# ---------------------------------------------------------------------------
# 3. Phase 3 Step 0.5 -- launch-manifest consumption (C2 / #1387)
# ---------------------------------------------------------------------------

_PHASE3_TOKENS = (
    "launch-manifest",
    "C2",
    "task swarm:launch",
    "story_id",
    "vbrief_path",
    "worktree_path",
    "allocation_context",
    # The spawn-stays-agent-driven contract.
    "PREP ONLY",
    "start_agent",
    "spawn_subagent",
    "does NOT spawn agents",
)


@pytest.mark.parametrize("token", _PHASE3_TOKENS)
def test_swarm_phase3_manifest_token_present(token: str) -> None:
    """Phase 3 Step 0.5 must document consuming the C2 launch-manifest (#1387)."""
    block = _phase3_step05_block(_read(_SWARM_PATH))
    assert token in block, (
        f"{_SWARM_PATH}: Phase 3 Step 0.5 missing #1387 C2 token {token!r} "
        "-- see #1387 acceptance criteria (Phase 3 manifest consumption)"
    )


def test_swarm_phase3_manifest_is_prep_not_spawn() -> None:
    """A MUST NOT bullet must forbid treating the manifest as the spawn itself."""
    block = _phase3_step05_block(_read(_SWARM_PATH))
    found = False
    for line in block.splitlines():
        if "Treat the C2 launch-manifest as the spawn itself" in line:
            assert "\u2297" in line, (
                f"{_SWARM_PATH}: the manifest-is-not-spawn prohibition must "
                f"use the \\u2297 MUST NOT marker; found: {line.strip()!r}"
            )
            found = True
            break
    assert found, (
        f"{_SWARM_PATH}: Phase 3 Step 0.5 missing the \\u2297 prohibition "
        "against treating the launch-manifest as the spawn primitive (#1387)"
    )


# ---------------------------------------------------------------------------
# 4. AGENTS.md gate-stack mirror (#1387)
# ---------------------------------------------------------------------------

_AGENTS_TOKENS = (
    "task swarm:launch",
    "--stories",
    "--worktree-map",
    "pre-created worktree map",
    "launch-manifest",
    "resolve_worktree_map",
    "scripts/swarm_worktrees.py",
    "C1",
    "C2",
    "C3",
    "#1378",
    "#1387",
    # The consent-token discriminator that separates swarm-cohort from solo.
    "dispatch_kind: swarm-cohort",
    # The spawn-stays-agent-driven contract is mirrored too.
    "agent-driven",
    "does NOT spawn agents",
)


@pytest.mark.parametrize("token", _AGENTS_TOKENS)
def test_agents_headless_mirror_token_present(token: str) -> None:
    """AGENTS.md gate-stack mirror must carry the #1387 tokens."""
    block = _agents_block(_read(_AGENTS_PATH))
    assert token in block, (
        f"{_AGENTS_PATH}: headless gate-stack mirror missing #1387 token "
        f"{token!r} -- the SKILL and AGENTS surfaces MUST agree"
    )


def test_agents_headless_mirror_reprompt_prohibition() -> None:
    """The AGENTS.md mirror must carry the \\u2297 re-prompt prohibition."""
    block = _agents_block(_read(_AGENTS_PATH))
    found = False
    for line in block.splitlines():
        if "Re-prompt the operator for per-phase batching approval" in line:
            assert "\u2297" in line, (
                f"{_AGENTS_PATH}: the re-prompt prohibition must use the "
                f"\\u2297 MUST NOT marker; found: {line.strip()!r}"
            )
            found = True
            break
    assert found, (
        f"{_AGENTS_PATH}: headless gate-stack mirror missing the \\u2297 "
        "re-prompt prohibition (#1387)"
    )


# ---------------------------------------------------------------------------
# 5. Cross-surface agreement -- the three load-bearing phrases the #1387
#    acceptance criteria name explicitly MUST appear in BOTH surfaces.
# ---------------------------------------------------------------------------

_CROSS_SURFACE_TOKENS = (
    "swarm:launch",
    "pre-created worktree map",
    "launch-manifest",
)


@pytest.mark.parametrize("token", _CROSS_SURFACE_TOKENS)
def test_headless_contract_present_in_both_surfaces(token: str) -> None:
    """The headless contract phrases MUST appear in BOTH the skill and AGENTS.md."""
    swarm = _read(_SWARM_PATH)
    agents = _read(_AGENTS_PATH)
    assert token in swarm, (
        f"{_SWARM_PATH}: missing cross-surface #1387 token {token!r}"
    )
    assert token in agents, (
        f"{_AGENTS_PATH}: missing cross-surface #1387 token {token!r}"
    )
