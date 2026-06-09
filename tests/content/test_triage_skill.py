"""Deterministic content tests for the canonical deft-directive-triage skill (D6 / #1130).

These tests pin the structure of the real skill body landed under #1130 so a
future edit that silently drops a phase, the EXIT block, the reversibility
verb, or the refinement cross-reference fails CI immediately.

Mirrors the existing test_skills.py patterns (RFC2119 legend, frontmatter,
EXIT block, pointer-file presence) but lives in its own file because the
parent test_skills.py is already 1.9k lines and the AGENTS.md
file-size convention asks for new files to be added when the parent is
approaching the cap.

Refs:
  - #1130 (D6 -- this skill)
  - #1119 (umbrella)
  - #1149 (N9 stub being replaced)
"""

from __future__ import annotations

from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

_TRIAGE_PATH = "skills/deft-directive-triage/SKILL.md"
_TRIAGE_POINTER_PATH = ".agents/skills/deft-directive-triage/SKILL.md"
_REFINEMENT_PATH = "skills/deft-directive-refinement/SKILL.md"

_MAX_SKILL_LINES = 150  # deft-directive-write-skill convention

_REQUIRED_TRIGGERS = (
    "triage",
    "triage hygiene",
    "work the cache",
    "what's next",
    "whats next",
    "what should I work on",
    "queue",
    "build a cohort",
    "build cohort",
)

# Each phase MUST be named with its canonical task verb so a future edit
# that decouples the playbook from the underlying surface fails the test.
_REQUIRED_PHASES = (
    ("## Phase 0 -- Sync", "task verify:cache-fresh"),
    ("## Phase 1 -- Classify", "task triage:classify"),
    ("## Phase 2 -- Present", "task triage:queue"),
    ("## Phase 3 -- Decide", "task triage:accept"),
    ("## Phase 4 -- Audit", "task triage:audit"),
)


def _read(rel_path: str) -> str:
    return (_REPO_ROOT / rel_path).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# 1. File exists, size cap, frontmatter, legend
# ---------------------------------------------------------------------------


def test_triage_skill_exists() -> None:
    """The canonical skill body MUST exist at the conventional path (#1130)."""
    assert (_REPO_ROOT / _TRIAGE_PATH).is_file(), (
        f"Skill file missing: {_TRIAGE_PATH} (#1130)"
    )


def test_triage_skill_size_cap() -> None:
    """Skill MUST be at-or-under the 150-line write-skill convention (#1130)."""
    line_count = len(_read(_TRIAGE_PATH).splitlines())
    assert line_count <= _MAX_SKILL_LINES, (
        f"{_TRIAGE_PATH}: {line_count} lines exceeds the "
        f"{_MAX_SKILL_LINES}-line deft-directive-write-skill convention "
        f"(#1130) -- split into REFERENCE.md or trim"
    )


def test_triage_skill_frontmatter_name() -> None:
    """Frontmatter MUST carry the canonical skill name."""
    text = _read(_TRIAGE_PATH)
    assert text.startswith("---"), (
        f"{_TRIAGE_PATH}: must start with YAML frontmatter"
    )
    assert "name: deft-directive-triage" in text, (
        f"{_TRIAGE_PATH}: frontmatter must declare name: deft-directive-triage"
    )


def test_triage_skill_rfc2119_legend() -> None:
    """Skill MUST carry the RFC2119 legend line used by every directive skill."""
    text = _read(_TRIAGE_PATH)
    assert "!=MUST, ~=SHOULD" in text, (
        f"{_TRIAGE_PATH}: missing RFC2119 legend "
        f"('!=MUST, ~=SHOULD, ...') -- conventional across deft-directive-* skills"
    )


# ---------------------------------------------------------------------------
# 2. Trigger keywords -- frontmatter and AGENTS.md surface
# ---------------------------------------------------------------------------


def test_triage_skill_triggers_present() -> None:
    """All canonical triggers from the #1130 issue body MUST be in the skill's frontmatter."""
    text = _read(_TRIAGE_PATH)
    # Extract the frontmatter block (between the first two `---` lines).
    parts = text.split("---", 2)
    assert len(parts) >= 3, f"{_TRIAGE_PATH}: malformed frontmatter"
    frontmatter = parts[1]
    missing = [t for t in _REQUIRED_TRIGGERS if t not in frontmatter]
    assert not missing, (
        f"{_TRIAGE_PATH}: frontmatter is missing required triggers: {missing!r} "
        f"(#1130) -- the routing rule expects every entry in the canonical list"
    )


# ---------------------------------------------------------------------------
# 3. Each of the 5 phases is named with its canonical task verb
# ---------------------------------------------------------------------------


def test_triage_skill_all_phases_present() -> None:
    """Each of the 5 phases MUST be a heading AND name its canonical verb (#1130)."""
    text = _read(_TRIAGE_PATH)
    for heading, verb in _REQUIRED_PHASES:
        assert heading in text, (
            f"{_TRIAGE_PATH}: missing phase heading {heading!r} (#1130)"
        )
        assert verb in text, (
            f"{_TRIAGE_PATH}: phase {heading!r} must name canonical verb "
            f"{verb!r} (#1130)"
        )


# ---------------------------------------------------------------------------
# 4. EXIT block + Skill Completion Gate compliance
# ---------------------------------------------------------------------------


def test_triage_skill_exit_block_present() -> None:
    """Skill MUST carry an EXIT section with the canonical exit phrasing."""
    text = _read(_TRIAGE_PATH)
    assert "## EXIT" in text, (
        f"{_TRIAGE_PATH}: missing '## EXIT' heading -- the Skill Completion "
        f"Gate (#1149) requires explicit skill-exit confirmation"
    )
    assert "exiting skill" in text.lower(), (
        f"{_TRIAGE_PATH}: EXIT block must contain canonical 'exiting skill' "
        f"confirmation phrasing"
    )
    assert "deft-directive-refinement" in text and "deft-directive-swarm" in text, (
        f"{_TRIAGE_PATH}: EXIT block must surface chaining instructions for "
        f"refinement and swarm sibling skills (#1130)"
    )


# ---------------------------------------------------------------------------
# 5. Reversibility -- Layer 5 verb named explicitly
# ---------------------------------------------------------------------------


def test_triage_skill_reversibility_layer5_verb() -> None:
    """Skill MUST name `task triage:reset <N>` as the canonical Layer 5 verb."""
    text = _read(_TRIAGE_PATH)
    assert "task triage:reset" in text, (
        f"{_TRIAGE_PATH}: must name `task triage:reset <N>` as the Layer 5 "
        f"reversibility verb (resolves the V3 audit from 2026-05-13)"
    )
    assert "## Reversibility" in text, (
        f"{_TRIAGE_PATH}: must carry an explicit '## Reversibility' section "
        f"per the #1130 issue body"
    )


def test_triage_action_menu_is_host_portable_numbered_contract() -> None:
    """Issue #1563 -- action menu replies map only to visible numbered choices."""
    text = _read(_TRIAGE_PATH)
    assert "1. Accept" in text
    assert "5. Mark duplicate" in text
    assert "6. Discuss" in text
    assert "7. Back" in text
    assert "displayed number (`1`-`7`) or exact displayed option text" in text
    assert "bare letters such as `d` / `b`" in text


# ---------------------------------------------------------------------------
# 6. Thin pointer file -- mirrors test_deft_sync_pointer_exists pattern
# ---------------------------------------------------------------------------


def test_triage_skill_pointer_exists() -> None:
    """.agents thin pointer for deft-directive-triage MUST exist (mirrors sync pointer test)."""
    assert (_REPO_ROOT / _TRIAGE_POINTER_PATH).is_file(), (
        f"Thin pointer missing: {_TRIAGE_POINTER_PATH}"
    )


def test_triage_skill_pointer_routes_to_real_skill() -> None:
    """Pointer body MUST direct readers at the real skill file."""
    text = _read(_TRIAGE_POINTER_PATH)
    assert _TRIAGE_PATH in text, (
        f"{_TRIAGE_POINTER_PATH}: must reference the real skill path "
        f"{_TRIAGE_PATH!r}"
    )


# ---------------------------------------------------------------------------
# 7. Refinement skill cross-reference
# ---------------------------------------------------------------------------


def test_refinement_skill_cross_references_triage() -> None:
    """Refinement intro MUST cross-reference the triage skill (#1130)."""
    text = _read(_REFINEMENT_PATH)
    # Locate the intro region (before the first ## heading after the title).
    title_idx = text.find("# Deft Directive Refinement")
    assert title_idx != -1, (
        f"{_REFINEMENT_PATH}: missing '# Deft Directive Refinement' title"
    )
    first_h2_idx = text.find("## ", title_idx + len("# Deft Directive Refinement"))
    intro = text[title_idx:first_h2_idx] if first_h2_idx != -1 else text[title_idx:]
    assert "deft-directive-triage" in intro, (
        f"{_REFINEMENT_PATH}: intro must cross-reference "
        f"`skills/deft-directive-triage/SKILL.md` (D6 / #1130) -- refinement "
        f"begins with a triage pass before continuing into the refinement flow"
    )
