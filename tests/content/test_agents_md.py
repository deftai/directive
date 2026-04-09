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


# ---------------------------------------------------------------------------
# 3. Deft alignment confirmation at session start (#134, t2.7.6)
# ---------------------------------------------------------------------------

def test_agents_md_deft_alignment_confirmation_rule() -> None:
    """AGENTS.md must require Deft alignment confirmation at session start (#134)."""
    text = _read_agents_md()
    assert "deft directive active" in text.lower(), (
        "AGENTS.md: must contain a rule requiring Deft alignment confirmation "
        "at session start (e.g. 'Deft Directive active') (#134)"
    )


def test_agents_md_deft_alignment_context_reset_recovery() -> None:
    """Alignment rule must cover context reset recovery (#134)."""
    text = _read_agents_md()
    assert "context window" in text.lower() or "re-confirm" in text.lower(), (
        "AGENTS.md: alignment confirmation rule must cover context reset recovery (#134)"
    )


def test_agents_md_deft_alignment_anti_pattern() -> None:
    """AGENTS.md must contain anti-pattern for missing alignment confirmation (#134)."""
    text = _read_agents_md()
    assert "\u2297" in text and "confirming deft alignment" in text.lower(), (
        "AGENTS.md: must contain \u2297 anti-pattern for starting session without "
        "confirming Deft alignment (#134)"
    )


# ---------------------------------------------------------------------------
# 4. Skill Completion Gate (#243, t1.11.5)
# ---------------------------------------------------------------------------

def test_agents_md_skill_completion_gate_rule() -> None:
    """AGENTS.md must require explicit skill exit confirmation (#243, t1.11.5)."""
    text = _read_agents_md()
    assert "skill completion gate" in text.lower(), (
        "AGENTS.md: must contain Skill Completion Gate rule (#243, t1.11.5)"
    )


def test_agents_md_skill_completion_gate_chaining() -> None:
    """AGENTS.md Skill Routing must include chaining annotations (#243, t1.11.5)."""
    text = _read_agents_md()
    assert "chains to" in text.lower(), (
        "AGENTS.md: Skill Routing table must include chaining annotations (#243, t1.11.5)"
    )
