"""
test_agents_md.py — Content checks for AGENTS.md.

Verifies:
  - AGENTS.md First Session section contains headless/cloud agent bypass (#142, t1.1.5)

Author: Scott Adams (msadams) — 2026-04-02
"""

from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def _read_agents_md() -> str:
    return (_REPO_ROOT / "AGENTS.md").read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# 1. Headless agent bypass exists in First Session (#142, t1.1.5)
# ---------------------------------------------------------------------------

def test_agents_md_headless_bypass_present() -> None:
    """AGENTS.md must contain a headless bypass for cloud/CI agents."""
    text = _read_agents_md()
    assert "headless bypass" in text.lower(), (
        "AGENTS.md: missing headless bypass instruction in First Session — "
        "cloud/CI agents need to skip onboarding when dispatched with a task (#142)"
    )


def test_agents_md_headless_bypass_before_user_md_check() -> None:
    """Headless bypass must appear before the USER.md missing check."""
    text = _read_agents_md()
    bypass_pos = text.lower().find("headless bypass")
    user_md_pos = text.find("USER.md missing")
    assert bypass_pos != -1 and user_md_pos != -1 and bypass_pos < user_md_pos, (
        "AGENTS.md: headless bypass must appear before the USER.md missing check"
    )


def test_agents_md_headless_bypass_mentions_cloud_agent() -> None:
    """Headless bypass must mention cloud agents as a use case."""
    text = _read_agents_md()
    assert "cloud agent" in text.lower(), (
        "AGENTS.md: headless bypass must mention cloud agents as a use case"
    )


# ---------------------------------------------------------------------------
# 2. Pre-implementation checklist enforcement markers (#186, t1.9.2)
# ---------------------------------------------------------------------------

def test_agents_md_before_code_changes_must_markers() -> None:
    """'Before code changes' items must carry ! (MUST) markers (#186, t1.9.2)."""
    text = _read_agents_md()
    assert "! Read SPECIFICATION.md" in text, (
        "AGENTS.md: 'Before code changes' items must carry ! (MUST) markers (#186)"
    )


def test_agents_md_pre_implementation_anti_pattern() -> None:
    """AGENTS.md must contain anti-pattern for editing before spec check (#186, t1.9.2)."""
    text = _read_agents_md()
    assert "\u2297" in text and "editing files before" in text.lower(), (
        "AGENTS.md: must contain \u2297 anti-pattern for editing before spec/branch check (#186)"
    )
