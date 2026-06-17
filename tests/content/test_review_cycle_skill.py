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


def _informal_clean_section() -> str:
    """Return the #1543 informal-clean guidance section from the skill."""
    text = _read_skill()
    start = text.find("### Informal-clean missing canonical fields (#1543)")
    assert start != -1, (
        f"{_REVIEW_CYCLE_PATH}: must document informal-clean missing "
        "canonical fields (#1543)"
    )
    # Section runs until the next top-level Phase heading or Submitting block.
    end_markers = [
        text.find("## Submitting GitHub Reviews", start),
        text.find("## Anti-Patterns", start),
    ]
    end = min(i for i in end_markers if i != -1)
    return text[start:end]


def test_greptile_informal_clean_section_present() -> None:
    """Review-cycle skill must document informal-clean missing canonical fields (#1543)."""
    section = _informal_clean_section()
    assert "informal-clean missing-canonical-fields" in section


def test_greptile_informal_clean_recovery_path_tokens() -> None:
    """Informal-clean guidance must route to retrigger, canonical evidence, or override."""
    section = _informal_clean_section()
    assert "@greptileai review" in section
    assert "documented override" in section or "operator override" in section
    assert "Do NOT keep polling" in section or "do not keep polling" in section.lower()


def test_greptile_informal_clean_must_not_accept_prose_alone() -> None:
    """Informal-clean guidance must forbid treating prose alone as merge-ready."""
    section = _informal_clean_section()
    pattern = re.compile(
        r"^\u2297 Treat informal clean Greptile prose",
        re.MULTILINE,
    )
    assert pattern.search(section), (
        f"{_REVIEW_CYCLE_PATH}: informal-clean section must contain a "
        "`\u2297 Treat informal clean Greptile prose...` MUST NOT rule (#1543)"
    )


def test_greptile_informal_clean_references_poller_template() -> None:
    """Informal-clean guidance must cross-reference the poller template terminal exit."""
    section = _informal_clean_section()
    assert "templates/swarm-greptile-poller-prompt.md" in section
    assert "(6) INFORMAL-CLEAN" in section


# ---------------------------------------------------------------------------
# 6. Fail-closed Step 6 exit predicate (#1259)
#
# The Step 6 exit predicate could previously evaluate true against a PARTIAL or
# STALE Greptile review (confidence number alone, or a reviewed SHA lagging
# HEAD), letting an agent exit clean -- and merge -- while a P0/P1 finding was
# still in flight. The fix rewrites Step 6 as a fail-closed `ReviewerStatus`
# all-of: terminal check-run + HEAD-SHA pinned at read time + HEAD-matching
# completion marker + confidence > 3 + no P0/P1, with any missing/ambiguous
# field resolving to `unknown` (NOT a pass). These tests pin the predicate's
# presence and the named anti-patterns so a future copy-edit cannot silently
# weaken it back to the confidence-only form.
# ---------------------------------------------------------------------------


def _step6_section() -> str:
    """Return the SKILL.md substring spanning the Step 6 exit-condition block.

    Runs from the `### Step 6:` anchor to the next `## ` top-level heading
    (the Pre-Merge Re-Poll Gate section), so token checks are scoped to the
    rewritten exit predicate and don't false-positive on the loop body above.
    """
    text = _read_skill()
    start = text.find("### Step 6:")
    assert start != -1, (
        f"{_REVIEW_CYCLE_PATH}: Step 6 exit-condition anchor missing (#1259)"
    )
    end = text.find("\n## ", start)
    assert end != -1 and end > start, (
        f"{_REVIEW_CYCLE_PATH}: Step 6 section must be followed by a `## ` "
        f"heading (the Pre-Merge Re-Poll Gate); current state malformed (#1259)"
    )
    return text[start:end]


def test_step6_is_fail_closed_all_of() -> None:
    """Step 6 MUST be a fail-closed all-of where missing/ambiguous => unknown
    (NOT a pass) (#1259)."""
    section = _step6_section()
    assert "fail-closed" in section, (
        f"{_REVIEW_CYCLE_PATH}: Step 6 must describe a fail-closed predicate "
        "(#1259)"
    )
    assert "ReviewerStatus" in section, (
        f"{_REVIEW_CYCLE_PATH}: Step 6 must name the ReviewerStatus all-of "
        "(#1259)"
    )
    assert "unknown" in section, (
        f"{_REVIEW_CYCLE_PATH}: Step 6 must resolve missing/ambiguous fields to "
        "`unknown` (#1259)"
    )
    assert "#1259" in section


def test_step6_requires_terminal_check_run() -> None:
    """Step 6 MUST require a terminal check-run (completed + success/neutral)
    and explicitly reject the non-terminal conclusions (#1259)."""
    section = _step6_section()
    assert 'status == "completed"' in section, (
        f"{_REVIEW_CYCLE_PATH}: Step 6 must require check_run.status == "
        '"completed" (#1259)'
    )
    assert "success" in section and "neutral" in section, (
        f"{_REVIEW_CYCLE_PATH}: Step 6 must accept only success/neutral "
        "conclusions (#1259)"
    )
    # The non-terminal conclusions that MUST NOT count as clean.
    for bad in ("cancelled", "timed_out", "stale", "action_required", "failure"):
        assert bad in section, (
            f"{_REVIEW_CYCLE_PATH}: Step 6 must explicitly exclude the "
            f"`{bad}` conclusion from terminal-clean (#1259)"
        )


def test_step6_requires_sha_pinned_completion_marker() -> None:
    """Step 6 MUST require the HEAD-SHA pinned at read time AND a HEAD-matching
    `Last reviewed commit:` completion marker (#1259)."""
    section = _step6_section()
    assert "Last reviewed commit:" in section, (
        f"{_REVIEW_CYCLE_PATH}: Step 6 must require the `Last reviewed commit:` "
        "completion marker (#1259)"
    )
    # SHA-pinned at read time (the load-bearing freshness guard).
    assert "AT READ TIME" in section or "head_sha_reviewed == current HEAD" in section, (
        f"{_REVIEW_CYCLE_PATH}: Step 6 must pin head_sha_reviewed to the "
        "current HEAD read at exit-evaluation time (#1259)"
    )
    # The non-greedy SHA regex (#1326) shared with the poller template.
    assert r"Last reviewed commit:\s*\[.*?\]\(" in section, (
        f"{_REVIEW_CYCLE_PATH}: Step 6 must carry the non-greedy SHA-extraction "
        "regex (#1326)"
    )


def test_step6_requires_confidence_and_no_p0_p1() -> None:
    """Step 6 MUST require confidence > 3 and no P0/P1 findings (#1259)."""
    section = _step6_section()
    assert "Confidence" in section and ("> 3" in section or "greater than 3" in section), (
        f"{_REVIEW_CYCLE_PATH}: Step 6 must require confidence strictly greater "
        "than 3 (#1259)"
    )
    assert "P0" in section and "P1" in section, (
        f"{_REVIEW_CYCLE_PATH}: Step 6 must require zero P0/P1 findings (#1259)"
    )


def test_step6_confidence_alone_anti_pattern_present() -> None:
    """Step 6 MUST forbid exiting on a confidence number alone while the check
    run is non-terminal (#1259)."""
    section = _step6_section()
    pattern = re.compile(
        r"^\u2297 Exit the loop on a confidence number alone",
        re.MULTILINE,
    )
    assert pattern.search(section), (
        f"{_REVIEW_CYCLE_PATH}: Step 6 must contain a `\u2297 Exit the loop on "
        "a confidence number alone...` MUST NOT rule (#1259)"
    )


def test_pre_merge_re_poll_gate_present() -> None:
    """SKILL.md MUST contain a mandatory pre-merge re-poll gate that re-fetches
    reviewer state immediately before `gh pr merge` (#1259)."""
    text = _read_skill()
    assert "## Pre-Merge Re-Poll Gate (#1259)" in text, (
        f"{_REVIEW_CYCLE_PATH}: must contain a Pre-Merge Re-Poll Gate section "
        "(#1259)"
    )
    start = text.find("## Pre-Merge Re-Poll Gate (#1259)")
    end = text.find("\n## ", start + 1)
    section = text[start:end if end != -1 else len(text)]
    assert "gh pr merge" in section and "re-fetch" in section, (
        f"{_REVIEW_CYCLE_PATH}: pre-merge gate must mandate a re-fetch of "
        "reviewer state before `gh pr merge` (#1259)"
    )
    pattern = re.compile(
        r"^\u2297 Call `gh pr merge` on the strength of a review verdict",
        re.MULTILINE,
    )
    assert pattern.search(section), (
        f"{_REVIEW_CYCLE_PATH}: pre-merge gate must forbid merging on cached "
        "review state (#1259)"
    )


def test_incomplete_but_rated_stall_signature_present() -> None:
    """Stall Detection Rubric MUST carry the INCOMPLETE_BUT_RATED signature
    (confidence present but no terminal check-run / completion marker) (#1259)."""
    text = _read_skill()
    assert "INCOMPLETE_BUT_RATED" in text, (
        f"{_REVIEW_CYCLE_PATH}: Stall Detection Rubric must name the "
        "`INCOMPLETE_BUT_RATED` signature (#1259)"
    )


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
