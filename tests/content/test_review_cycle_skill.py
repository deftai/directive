"""
test_review_cycle_skill.py -- Content checks for the deft-directive-review-cycle SKILL.

Verifies the Phase 2 Step 1 late-arriving-bot-review re-check rules added per #796.

The Phase 2 Step 1 dual-source-fetch contract correctly catches the
`Comments Outside Diff` case but does not cover the cold-start path where the
agent's first fetch lands BEFORE the bot reviewer (Greptile) has posted -- both
sources return zero findings and Step 6 false-positively declares the PR
review-clean. The fix is a `~` SHOULD rule mandating a re-fetch after a ~60s
delay before evaluating the Step 6 exit condition, plus a `\u2297` MUST NOT
rule against declaring exit on a single empty fetch.

These tests pin the rule presence and the canonical phrasing tokens
(`re-fetch`, `60s`, `before evaluating`) so a future copy-edit cannot silently
drop the rule. Mirrors the pattern in tests/content/test_skills.py.

Closes #796 (regression coverage).
"""

import re
from pathlib import Path

# ---------------------------------------------------------------------------
# Repo root + skill path
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_REVIEW_CYCLE_PATH = "skills/deft-directive-review-cycle/SKILL.md"


def _read_skill() -> str:
    return (_REPO_ROOT / _REVIEW_CYCLE_PATH).read_text(encoding="utf-8")


def _phase2_step1_section() -> str:
    """Return the substring of SKILL.md spanning Phase 2 Step 1 only.

    The rules under test are scoped to Step 1 (Fetch ALL bot comments). Tests
    extract the Step 1 region so a stray match elsewhere in the file (e.g. in
    the Anti-Patterns block at the bottom) doesn't false-positive the rule
    presence checks.
    """
    text = _read_skill()
    step1_start = text.find("### Step 1: Fetch ALL bot comments")
    step2_start = text.find("### Step 2: Analyze ALL findings before changing anything")
    assert step1_start != -1 and step2_start != -1 and step1_start < step2_start, (
        f"{_REVIEW_CYCLE_PATH}: Phase 2 Step 1/Step 2 anchors must be present "
        f"and in order; current state is malformed (#796)"
    )
    return text[step1_start:step2_start]


# ---------------------------------------------------------------------------
# 1. ~ SHOULD rule -- late-arriving bot review re-check (#796)
# ---------------------------------------------------------------------------


def test_phase2_step1_late_arriving_bot_review_should_rule_present() -> None:
    """Phase 2 Step 1 must contain a `~` SHOULD rule for the late-arriving
    bot review re-check (#796)."""
    section = _phase2_step1_section()
    assert "Late-arriving bot review re-check" in section, (
        f"{_REVIEW_CYCLE_PATH}: Phase 2 Step 1 must contain a "
        "`~ **Late-arriving bot review re-check:**` SHOULD rule covering the "
        "cold-start case where the first fetch lands before the bot has "
        "posted (#796)"
    )
    # Token must be tagged as a SHOULD (`~`) rule, not MUST/MUST NOT/MAY.
    pattern = re.compile(
        r"^~ \*\*Late-arriving bot review re-check:\*\*",
        re.MULTILINE,
    )
    assert pattern.search(section), (
        f"{_REVIEW_CYCLE_PATH}: late-arriving-bot-review rule must be "
        "rendered as a `~` SHOULD rule (RFC2119 strength), not as a `!` MUST "
        "or `?` MAY (#796)"
    )


# ---------------------------------------------------------------------------
# 2. Canonical phrasing tokens (#796)
# ---------------------------------------------------------------------------


def test_phase2_step1_late_arriving_re_fetch_token() -> None:
    """The re-check rule must use the canonical token `re-fetch` so the rule
    is searchable by intent (#796)."""
    section = _phase2_step1_section()
    assert "re-fetch" in section, (
        f"{_REVIEW_CYCLE_PATH}: Phase 2 Step 1 late-arriving-bot-review rule "
        "must include the canonical token `re-fetch` (#796)"
    )


def test_phase2_step1_late_arriving_60s_token() -> None:
    """The re-check rule must specify the ~60s delay verbatim (#796)."""
    section = _phase2_step1_section()
    assert "60s" in section, (
        f"{_REVIEW_CYCLE_PATH}: Phase 2 Step 1 late-arriving-bot-review rule "
        "must specify the `~60s` delay token verbatim (#796)"
    )


def test_phase2_step1_late_arriving_before_evaluating_token() -> None:
    """The re-check rule must clarify the rule fires BEFORE the Step 6 exit
    condition is evaluated, not after (#796)."""
    section = _phase2_step1_section()
    assert "before evaluating" in section, (
        f"{_REVIEW_CYCLE_PATH}: Phase 2 Step 1 late-arriving-bot-review rule "
        "must contain the canonical phrase `before evaluating` to anchor the "
        "rule against the Step 6 exit condition (#796)"
    )


# ---------------------------------------------------------------------------
# 3. \u2297 MUST NOT rule -- no single-fetch exit (#796)
# ---------------------------------------------------------------------------


def test_phase2_step1_no_single_fetch_exit_must_not_rule_present() -> None:
    """Phase 2 Step 1 must contain a `\u2297` MUST NOT rule against declaring
    the exit condition met on a single empty fetch (#796)."""
    section = _phase2_step1_section()
    # The rule must be tagged with the U+2297 MUST NOT marker, not the cp1252
    # mojibake `\xCE\x93\xC3\xA8\xC3\xB9` (which the same cohort just fixed in
    # PR #844 review-cycle on the briefs themselves).
    pattern = re.compile(
        r"^\u2297 Declare the exit condition met based on a single fetch",
        re.MULTILINE,
    )
    assert pattern.search(section), (
        f"{_REVIEW_CYCLE_PATH}: Phase 2 Step 1 must contain a `\u2297 Declare "
        "the exit condition met based on a single fetch...` MUST NOT rule "
        "(#796)"
    )


def test_phase2_step1_no_single_fetch_exit_re_fetch_recovery_token() -> None:
    """The MUST NOT rule must include the recovery instruction (`re-fetch at
    least once`) so the prohibition is paired with the corrective action
    (#796)."""
    section = _phase2_step1_section()
    assert "re-fetch at least once" in section, (
        f"{_REVIEW_CYCLE_PATH}: Phase 2 Step 1 `\u2297` no-single-fetch-exit "
        "rule must specify the recovery action (`re-fetch at least once after "
        "a ~60s delay`) so the prohibition is actionable (#796)"
    )


# ---------------------------------------------------------------------------
# 4. Cross-reference -- poller template handles the same case in its loop body
# ---------------------------------------------------------------------------


def test_phase2_step1_late_arriving_references_poller_template() -> None:
    """Phase 2 Step 1 must cross-reference the poller template that already
    handles this case for push-driven cycles, so future readers see the
    relationship between the cold-start one-shot path and the loop-body
    poller (#796)."""
    section = _phase2_step1_section()
    assert "templates/swarm-greptile-poller-prompt.md" in section, (
        f"{_REVIEW_CYCLE_PATH}: Phase 2 Step 1 late-arriving-bot-review rule "
        "must cross-reference templates/swarm-greptile-poller-prompt.md "
        "(which already handles this case for push-driven cycles in its loop "
        "body) so the rule's scope (cold-start one-shot entry path) is "
        "discoverable (#796)"
    )


# ---------------------------------------------------------------------------
# 5. Defense in depth -- canonical \u2297 marker is intact, not mojibake
# ---------------------------------------------------------------------------


def test_phase2_step1_no_cp1252_mojibake() -> None:
    """The newly-added rules MUST NOT contain the cp1252 mojibake form of
    \u2297 (e.g. `\u0393\u00E8\u00F9` -- the Windows-1252 round-trip
    corruption that hit the same cohort's pending vBRIEFs and was fixed in
    PR #844). This test guards against regressing into the same bug we are
    documenting the fix for (#796, #844)."""
    section = _phase2_step1_section()
    # The exact byte triple from the PR #844 incident.
    assert "\u0393\u00E8\u00F9" not in section, (
        f"{_REVIEW_CYCLE_PATH}: Phase 2 Step 1 contains the cp1252 mojibake "
        "form `\u0393\u00E8\u00F9` -- the canonical U+2297 character was "
        "corrupted on a PowerShell 5.1 round-trip. Re-write the rule via "
        "create_file / edit_files (UTF-8-safe) and restore the canonical "
        "`\u2297` glyph (#796, #844)."
    )
