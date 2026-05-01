"""tests/content/test_skills_preflight_call.py -- skills cite the preflight (#810).

Asserts that:

- ``skills/deft-directive-build/SKILL.md`` contains a `!` line that
  references ``scripts/preflight_implementation.py`` AND a line that
  references ``task vbrief:activate``.
- ``skills/deft-directive-swarm/SKILL.md`` contains the same two lines.

Failure messages name the file and the missing pattern so that future
copy-edits surface what they're missing without needing to re-read the
test.

Pinning the regex (not exact wording) lets both skills evolve their
prose without breaking the contract.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_BUILD_SKILL = _REPO_ROOT / "skills" / "deft-directive-build" / "SKILL.md"
_SWARM_SKILL = _REPO_ROOT / "skills" / "deft-directive-swarm" / "SKILL.md"

# A line carrying the `!` (RFC2119 MUST) marker that references the
# helper. Matches "- ! ..." (Anti-Patterns / Step bullets) AND "! ..."
# (top-level prose) variants.
_PREFLIGHT_HELPER_RE = re.compile(
    r"!.*scripts/preflight_implementation\.py"
)

# Any line referencing ``task vbrief:activate`` -- the actionable
# redirect that goes hand-in-hand with the helper.
_ACTIVATE_TASK_RE = re.compile(r"task\s+vbrief:activate")


@pytest.mark.parametrize(
    "skill_path",
    [_BUILD_SKILL, _SWARM_SKILL],
    ids=["deft-directive-build", "deft-directive-swarm"],
)
def test_skill_references_preflight_helper_with_must_marker(skill_path: Path) -> None:
    """Skill MUST contain a `!` line citing scripts/preflight_implementation.py."""
    assert skill_path.is_file(), (
        f"Skill file missing at {skill_path} -- cannot run #810 contract test."
    )
    text = skill_path.read_text(encoding="utf-8")
    matches = [line for line in text.splitlines() if _PREFLIGHT_HELPER_RE.search(line)]
    assert matches, (
        f"{skill_path.relative_to(_REPO_ROOT)}: missing `!` line referencing "
        f"`scripts/preflight_implementation.py` (#810). The skill MUST cite the "
        f"helper as a MUST rule before any code-writing tool call."
    )


@pytest.mark.parametrize(
    "skill_path",
    [_BUILD_SKILL, _SWARM_SKILL],
    ids=["deft-directive-build", "deft-directive-swarm"],
)
def test_skill_references_activate_task(skill_path: Path) -> None:
    """Skill MUST cite ``task vbrief:activate`` as the actionable redirect."""
    assert skill_path.is_file(), (
        f"Skill file missing at {skill_path} -- cannot run #810 contract test."
    )
    text = skill_path.read_text(encoding="utf-8")
    assert _ACTIVATE_TASK_RE.search(text), (
        f"{skill_path.relative_to(_REPO_ROOT)}: missing reference to "
        f"`task vbrief:activate` (#810). The skill MUST surface the "
        f"actionable redirect operators see on a non-zero preflight exit."
    )
