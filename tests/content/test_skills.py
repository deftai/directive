"""
test_skills.py — Structural and content checks for deft skill files.

Implementation: IMPLEMENTATION.md Phase 1.3

Verifies:
  - SKILL.md files exist at expected paths
  - Both skill files contain the RFC2119 legend
  - Both skill files contain a Platform Detection section
  - deft-build SKILL.md contains a USER.md Gate section

Author: Scott Adams (msadams) — 2026-03-12
"""

from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Repo root
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SKILL_PATHS = [
    "skills/deft-setup/SKILL.md",
    "skills/deft-build/SKILL.md",
]

RFC2119_LEGEND = "!=MUST, ~=SHOULD"
PLATFORM_DETECTION_HEADING = "## Platform Detection"
USER_MD_GATE_HEADING = "## USER.md Gate"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read_skill(rel_path: str) -> str:
    return (_REPO_ROOT / rel_path).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# 1. Skill files exist
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("rel_path", SKILL_PATHS)
def test_skill_file_exists(rel_path: str) -> None:
    """Each skill SKILL.md must exist at its expected path."""
    assert (_REPO_ROOT / rel_path).is_file(), (
        f"Skill file missing: {rel_path}"
    )


# ---------------------------------------------------------------------------
# 2. RFC2119 legend present in both skill files
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("rel_path", SKILL_PATHS)
def test_skill_rfc2119_legend_present(rel_path: str) -> None:
    """Each skill file must contain the RFC2119 legend line."""
    text = _read_skill(rel_path)
    assert RFC2119_LEGEND in text, (
        f"{rel_path}: missing RFC2119 legend '{RFC2119_LEGEND}' — "
        "add the Legend line near the top of the file"
    )


# ---------------------------------------------------------------------------
# 3. Platform Detection section present in both skill files
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("rel_path", SKILL_PATHS)
def test_skill_platform_detection_section(rel_path: str) -> None:
    """Each skill file must contain a Platform Detection section."""
    text = _read_skill(rel_path)
    assert PLATFORM_DETECTION_HEADING in text, (
        f"{rel_path}: missing '{PLATFORM_DETECTION_HEADING}' section — "
        "skills must instruct agents to detect OS and resolve USER.md path"
    )


# ---------------------------------------------------------------------------
# 4. Platform Detection covers both Windows and Unix paths
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("rel_path", SKILL_PATHS)
def test_skill_platform_detection_covers_windows(rel_path: str) -> None:
    """Platform Detection must reference the Windows APPDATA path."""
    text = _read_skill(rel_path)
    assert "%APPDATA%" in text, (
        f"{rel_path}: Platform Detection must include Windows path "
        r"(%APPDATA%\deft\USER.md)"
    )


@pytest.mark.parametrize("rel_path", SKILL_PATHS)
def test_skill_platform_detection_covers_unix(rel_path: str) -> None:
    """Platform Detection must reference the Unix ~/.config path."""
    text = _read_skill(rel_path)
    assert "~/.config/deft/USER.md" in text, (
        f"{rel_path}: Platform Detection must include Unix path "
        "(~/.config/deft/USER.md)"
    )


@pytest.mark.parametrize("rel_path", SKILL_PATHS)
def test_skill_platform_detection_env_override(rel_path: str) -> None:
    """Platform Detection must mention $DEFT_USER_PATH as an override."""
    text = _read_skill(rel_path)
    assert "$DEFT_USER_PATH" in text, (
        f"{rel_path}: Platform Detection must mention $DEFT_USER_PATH "
        "as the override for platform-default paths"
    )


# ---------------------------------------------------------------------------
# 5. USER.md Gate present in deft-build
# ---------------------------------------------------------------------------

def test_deft_build_user_md_gate() -> None:
    """deft-build must contain a USER.md Gate section."""
    rel_path = "skills/deft-build/SKILL.md"
    text = _read_skill(rel_path)
    assert USER_MD_GATE_HEADING in text, (
        f"{rel_path}: missing '{USER_MD_GATE_HEADING}' section — "
        "deft-build must redirect to deft-setup if USER.md is not found"
    )


def test_deft_build_user_md_gate_redirects_to_deft_setup() -> None:
    """deft-build USER.md Gate must reference deft-setup as the redirect target."""
    rel_path = "skills/deft-build/SKILL.md"
    text = _read_skill(rel_path)
    assert "deft-setup" in text, (
        f"{rel_path}: USER.md Gate must reference deft-setup as the "
        "redirect target when USER.md is not found"
    )


# ---------------------------------------------------------------------------
# 6. deft-setup does NOT have a USER.md Gate (belongs only in deft-build)
# ---------------------------------------------------------------------------

def test_deft_setup_has_no_user_md_gate() -> None:
    """deft-setup must not have a USER.md Gate section (that belongs in deft-build)."""
    rel_path = "skills/deft-setup/SKILL.md"
    text = _read_skill(rel_path)
    assert USER_MD_GATE_HEADING not in text, (
        f"{rel_path}: should not contain '{USER_MD_GATE_HEADING}' — "
        "deft-setup creates USER.md, it doesn't gate on it"
    )


# ---------------------------------------------------------------------------
# 7. task check and task test:coverage referenced in deft-build
# ---------------------------------------------------------------------------

def test_deft_build_references_task_check() -> None:
    """deft-build must reference 'task check' as a quality gate."""
    rel_path = "skills/deft-build/SKILL.md"
    text = _read_skill(rel_path)
    assert "task check" in text, (
        f"{rel_path}: must reference 'task check' — Taskfile is a hard dependency"
    )


def test_deft_build_references_task_test_coverage() -> None:
    """deft-build must reference 'task test:coverage'."""
    rel_path = "skills/deft-build/SKILL.md"
    text = _read_skill(rel_path)
    assert "task test:coverage" in text, (
        f"{rel_path}: must reference 'task test:coverage' — Taskfile is a hard dependency"
    )
