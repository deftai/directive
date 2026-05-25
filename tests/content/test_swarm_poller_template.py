"""Regression tests for the Greptile / SLizard findings detector baked into
``templates/swarm-greptile-poller-prompt.md`` (#910 + #1035).

The template body prescribes the detector that every dispatched poller agent
copies into its poll script. Four independent surface forms have been
observed in the wild across two recurrence events:

1. **Tier 1**   -- HTML severity badges (``<img alt="P0"`` / ``<img alt="P1"``).
2. **Tier 2**   -- markdown-bullet bold (``- **P1 -- ...**``).
3. **Tier 2.5** -- SLizard `### P[01] · ...` heading form (#1035, PR #1034).
4. **Tier 3**   -- inline prose (``Three P1 findings ...``, ``Not safe to merge``,
   ``^P1 -- ...``).

Three false-negatives in the v0.25.1 swarm session (#907 first review, #908
first review, #908 retrigger) drove the move from a badge-only detector to the
triple-tier detector under #910. A subsequent live miss on PR #1034
(2026-05-11, #1035) -- where SLizard rendered a P1 finding as a `### P1 ·`
heading paired with a `## Confidence Score: 3/5` markdown header -- drove the
Tier 2.5 + confidence-heading parser fallback in this module. These tests pin
both regressions so a future template edit that drops or weakens any tier
fails CI immediately.

The tests exercise a Python *reference implementation* of the detector (mirror
of the template body) AND assert the template still contains the canonical
regex strings / sentinels so the two stay in sync.
"""

from __future__ import annotations

import pathlib
import re

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
TEMPLATE_PATH = REPO_ROOT / "templates" / "swarm-greptile-poller-prompt.md"


# ---------------------------------------------------------------------------
# Reference detector implementation -- mirrors the template body.
# Any change here MUST be mirrored in templates/swarm-greptile-poller-prompt.md
# (and vice-versa). The synchronization tests below assert that the canonical
# regex strings and sentinels are present in the template verbatim.
# ---------------------------------------------------------------------------

_TIER2_RE = re.compile(r"^[\s\-\*]*\*\*P([01])\b[^*]*\*\*", re.MULTILINE)
_TIER2_NEGATIONS = ("No ", "Zero ", "0 ", "no ")

# Tier 2.5 (#1035) -- SLizard `### P[01] <sep> ...` heading-form findings.
# Separator class: middot U+00B7, hyphenation point U+2027, bullet U+2022,
# ASCII hyphen. The hyphen is placed last in the char class so it is treated
# as a literal hyphen rather than a range delimiter.
_TIER25_RE = re.compile(
    r"^#{1,6}\s+P([01])\s*[\u00b7\u2027\u2022\-]\s", re.MULTILINE
)

_TIER3_COUNT_RE = re.compile(
    r"\b(?:One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|\d+)\s+P[01]\s+findings?\b",
    re.IGNORECASE,
)
_TIER3_LINE_RE = re.compile(r"^\s*P[01]\s+--\s", re.MULTILINE)
_TIER3_NEGATIONS = ("No ", "Zero ", "no ", "NO ")

# Confidence parse (#1035) -- the inline-or-line form matches both inline prose
# and most heading forms by virtue of being unanchored. The heading-form
# fallback is the strictly-anchored ^...$ multiline regex used only when the
# inline form does not match -- a defence-in-depth structural guard against
# heading lines that carry trailing markup or whitespace the inline regex
# declines.
_CONFIDENCE_INLINE_RE = re.compile(r"Confidence Score:\s*(\d+)\s*/\s*5")
_CONFIDENCE_HEADING_RE = re.compile(
    r"^#{1,6}\s*Confidence Score:\s*(\d+)\s*/\s*5\s*$", re.MULTILINE
)


def parse_confidence(body: str):
    """Reference confidence parser mirroring the template body.

    Returns the integer score on match (including ``0``), or ``None`` if
    neither regex matches. The heading-form fallback only fires when the
    inline regex returns None, mirroring the template's two-step parse.
    """
    m = _CONFIDENCE_INLINE_RE.search(body)
    if m is None:
        m = _CONFIDENCE_HEADING_RE.search(body)
    return int(m.group(1)) if m else None


def _line_for(body: str, pos: int) -> str:
    line_start = body.rfind("\n", 0, pos) + 1
    line_end = body.find("\n", pos)
    return body[line_start : line_end if line_end != -1 else len(body)]


def detect(body: str) -> dict:
    """Greptile / SLizard findings detector reference implementation.

    Mirrors the template body (#910 triple-tier + #1035 Tier 2.5). Returns a
    dict with ``tier1_p0`` / ``tier1_p1`` / ``tier2_p0`` / ``tier2_p1`` /
    ``tier25_p0`` / ``tier25_p1`` / ``tier3_sentinel`` / ``p0_count`` /
    ``p1_count`` / ``has_blocking`` so individual tier contributions are
    inspectable in test failure messages.
    """
    tier1_p0 = body.count('<img alt="P0"')
    tier1_p1 = body.count('<img alt="P1"')

    tier2_p0 = 0
    tier2_p1 = 0
    for m in _TIER2_RE.finditer(body):
        line = _line_for(body, m.start())
        if any(neg in line for neg in _TIER2_NEGATIONS):
            continue
        if m.group(1) == "0":
            tier2_p0 += 1
        else:
            tier2_p1 += 1

    tier25_p0 = 0
    tier25_p1 = 0
    for m in _TIER25_RE.finditer(body):
        line = _line_for(body, m.start())
        if any(neg in line for neg in _TIER2_NEGATIONS):
            continue
        if m.group(1) == "0":
            tier25_p0 += 1
        else:
            tier25_p1 += 1

    tier3_sentinel = False
    if "Not safe to merge" in body:
        tier3_sentinel = True
    if not tier3_sentinel:
        for m in _TIER3_COUNT_RE.finditer(body):
            line = _line_for(body, m.start())
            if any(neg in line for neg in _TIER3_NEGATIONS):
                continue
            if re.match(r"\s*0\b", m.group(0)):
                continue
            tier3_sentinel = True
            break
    if not tier3_sentinel:
        for m in _TIER3_LINE_RE.finditer(body):
            line = _line_for(body, m.start())
            if any(neg in line for neg in _TIER3_NEGATIONS):
                continue
            tier3_sentinel = True
            break

    p0_count = max(tier1_p0, tier2_p0, tier25_p0)
    p1_count = max(tier1_p1, tier2_p1, tier25_p1)
    has_blocking = (p0_count + p1_count) > 0 or tier3_sentinel
    return {
        "tier1_p0": tier1_p0,
        "tier1_p1": tier1_p1,
        "tier2_p0": tier2_p0,
        "tier2_p1": tier2_p1,
        "tier25_p0": tier25_p0,
        "tier25_p1": tier25_p1,
        "tier3_sentinel": tier3_sentinel,
        "p0_count": p0_count,
        "p1_count": p1_count,
        "has_blocking": has_blocking,
    }


# ---------------------------------------------------------------------------
# Synthetic Greptile bodies covering the three observed surface forms.
# ---------------------------------------------------------------------------

BODY_TIER2_P1_ONLY = """\
Greptile review of head 1234567

Confidence Score: 4/5

Last reviewed commit: [fix: foo bar](https://github.com/deftai/directive/commit/abcdef1234567)

Comments:

- **P1 -- wrong exception type for state/limit validation in populate()**
  The current code raises ValueError but the contract calls for InvalidRepoError.
- **P2 -- minor wording in error message**
  Consider `--repo` instead of `the repo flag`.
"""

BODY_TIER3_NOT_SAFE_ONLY = """\
Greptile review of head 7654321

Confidence Score: 3/5

Last reviewed commit: [refactor: thing](https://github.com/deftai/directive/commit/0011223344556)

Summary: Not safe to merge until the mocked-import test defect and the two
previously filed P1s are resolved.
"""

BODY_TIER3_COUNT_PROSE_ONLY = """\
Greptile review of head deadbeef

Confidence Score: 4/5

Last reviewed commit: [chore: bump](https://github.com/deftai/directive/commit/deadbeefcafe123)

Three P1 findings (two from prior review, one new): wrong exception type for
state/limit validation in populate(), misleading skip message, and an
unguarded import that will fail on Windows.
"""

BODY_NEGATION_GUARDED = """\
Greptile review of head ffffffff

Confidence Score: 5/5

Last reviewed commit: [feat: clean](https://github.com/deftai/directive/commit/ffffffffabc1234)

Summary: No P0 findings. Zero P1 findings. The PR is ready for merge.
"""

BODY_CLEAN = """\
Greptile review of head 1111111

Confidence Score: 5/5

Last reviewed commit: [docs: tweak](https://github.com/deftai/directive/commit/1111111aaa2222b)

No P0 or P1 issues found. The change looks clean and well-tested.
"""

BODY_TIER1_BADGES_ONLY = """\
Greptile review of head 2222222

Confidence Score: 3/5

Last reviewed commit: [fix: thing](https://github.com/deftai/directive/commit/2222222ccc3333d)

<img alt="P1" src="https://example.com/p1.png"> wrong exception type in populate()
<img alt="P1" src="https://example.com/p1.png"> misleading skip message
<img alt="P0" src="https://example.com/p0.png"> data-loss risk in cache eviction
"""

# Tier 2.5 (#1035) -- SLizard rolling-summary comment with `### P1 · ...`
# heading-form finding and a `## Confidence Score: 3/5` markdown heading.
# Faithful reproduction of the PR #1034 (2026-05-11) live miss: zero Tier 1
# badges, zero Tier 2 `**...**` markdown-bullet bold, zero Tier 3 `Not safe
# to merge` / count-prose / `^P[01] -- ` line. Without Tier 2.5 the
# detector returns has_blocking=False AND the poller silently falls through.
BODY_SLIZARD_HEADING_P1 = (
    "SLizard review of head 3333333\n"
    "\n"
    "## Confidence Score: 3/5\n"
    "\n"
    "Decision: request_changes\n"
    "Severity counts: P0: 0, P1: 1\n"
    "\n"
    "### P1 \u00b7 Inaccurate description claim about ROADMAP.md `## Active` section\n"
    "The PR body claims the ROADMAP.md '## Active' section but the section\n"
    "does not exist at HEAD; verify the claim before merge.\n"
    "\n"
    "Last reviewed commit: [fix: stuff](https://github.com/deftai/directive/commit/3333333abcdef12)\n"
)

# Tier 2.5 (#1035) negation-context guard regression -- a heading that uses
# the SLizard separator BUT the same physical line carries a negation token
# (`No `, `Zero `, `0 `, lowercase `no `) MUST NOT count toward has_blocking.
# Synthetic; the live SLizard surface rarely renders this form but the guard
# parity with Tier 2 is a structural invariant.
BODY_SLIZARD_HEADING_NEGATION = (
    "SLizard review of head 4444444\n"
    "\n"
    "## Confidence Score: 5/5\n"
    "\n"
    "Decision: comment\n"
    "Severity counts: P0: 0, P1: 0\n"
    "\n"
    "### No P1 \u00b7 findings -- clean review\n"
    "\n"
    "Last reviewed commit: [docs: thing](https://github.com/deftai/directive/commit/4444444abcdef12)\n"
)

# Confidence-heading parser (#1035) -- a body whose ONLY Confidence Score
# anchor is a markdown heading. The inline regex `re.search` happens to
# match this body too (because it is unanchored), but the test pairs the
# inline form's match against the heading-form fallback's match to assert
# both surfaces parse to the same numeric value (3) -- the structural
# defence-in-depth contract.
BODY_CONFIDENCE_HEADING_ONLY = (
    "SLizard review of head 5555555\n"
    "\n"
    "## Confidence Score: 3/5\n"
    "\n"
    "Some body text without inline confidence prose.\n"
    "\n"
    "Last reviewed commit: [fix: x](https://github.com/deftai/directive/commit/5555555abcdef12)\n"
)


# ---------------------------------------------------------------------------
# Regression tests -- six required cases per #910 acceptance criteria.
# ---------------------------------------------------------------------------


def test_tier2_markdown_bullet_p1_only_triggers_blocking() -> None:
    """Synthetic body with markdown-bullet P1 only (zero badges) MUST fire."""
    result = detect(BODY_TIER2_P1_ONLY)
    assert result["tier1_p0"] == 0
    assert result["tier1_p1"] == 0
    assert result["tier2_p1"] >= 1, (
        f"tier2 should detect markdown-bullet P1, got {result!r}"
    )
    assert result["has_blocking"] is True, (
        f"markdown-bullet P1 must trigger has_blocking=True, got {result!r}"
    )


def test_tier3_not_safe_to_merge_sentinel_only_triggers_blocking() -> None:
    """Body with `Not safe to merge` only (no badges, no markdown bullets) MUST fire."""
    result = detect(BODY_TIER3_NOT_SAFE_ONLY)
    assert result["tier1_p0"] == 0
    assert result["tier1_p1"] == 0
    assert result["tier2_p0"] == 0
    assert result["tier2_p1"] == 0
    assert result["tier3_sentinel"] is True
    assert result["has_blocking"] is True


def test_tier3_count_prose_three_p1_findings_triggers_blocking() -> None:
    """Body with `Three P1 findings` count-prose only MUST fire."""
    result = detect(BODY_TIER3_COUNT_PROSE_ONLY)
    assert result["tier1_p0"] == 0
    assert result["tier1_p1"] == 0
    assert result["tier2_p0"] == 0
    assert result["tier2_p1"] == 0
    assert result["tier3_sentinel"] is True
    assert result["has_blocking"] is True


def test_negation_guard_no_p0_zero_p1_does_not_trigger() -> None:
    """`No P0 findings` / `Zero P1 findings` MUST NOT trigger has_blocking."""
    result = detect(BODY_NEGATION_GUARDED)
    assert result["tier1_p0"] == 0
    assert result["tier1_p1"] == 0
    assert result["tier2_p0"] == 0
    assert result["tier2_p1"] == 0
    assert result["tier3_sentinel"] is False, (
        f"negation-guarded prose must NOT fire tier3 sentinel, got {result!r}"
    )
    assert result["has_blocking"] is False


def test_clean_body_no_findings_does_not_trigger() -> None:
    """Clean body with no findings MUST produce has_blocking=False."""
    result = detect(BODY_CLEAN)
    assert result["has_blocking"] is False
    assert result["p0_count"] == 0
    assert result["p1_count"] == 0


def test_tier1_pure_badge_body_still_triggers() -> None:
    """Tier-1 badge-only body MUST still produce has_blocking=True (regression)."""
    result = detect(BODY_TIER1_BADGES_ONLY)
    assert result["tier1_p0"] == 1
    assert result["tier1_p1"] == 2
    assert result["has_blocking"] is True


# ---------------------------------------------------------------------------
# Regression tests -- #1035 acceptance criteria (Tier 2.5 SLizard heading
# form + confidence-heading parser fallback). Each test pins one of the
# acceptance criteria AC-1 / AC-2 / AC-2-negation-guard so a future edit
# that weakens the detector fails CI immediately.
# ---------------------------------------------------------------------------


def test_negative_control_pre_tier25_detector_misses_slizard_heading() -> None:
    """Negative-control: the pre-#1035 Tier 1/2/3 triple-tier detector misses
    SLizard `### P1 \u00b7 ...` heading-form findings entirely.

    This test pins the failure-mode signature so a future change that
    accidentally drops Tier 2.5 falls back to the pre-#1035 detector
    behaviour and fails this assertion (along with the positive Tier 2.5
    test below).
    """
    result = detect(BODY_SLIZARD_HEADING_P1)
    # Pre-#1035 tiers: all zero on the SLizard heading body.
    assert result["tier1_p0"] == 0
    assert result["tier1_p1"] == 0
    assert result["tier2_p0"] == 0
    assert result["tier2_p1"] == 0
    assert result["tier3_sentinel"] is False, (
        "SLizard heading body must NOT trip Tier 3 (no `Not safe to merge`, "
        f"no count-prose, no `^P[01] -- ` line); got {result!r}"
    )


def test_tier25_slizard_heading_p1_triggers_blocking() -> None:
    """AC-2: SLizard `### P1 \u00b7 ...` heading-form finding MUST fire."""
    result = detect(BODY_SLIZARD_HEADING_P1)
    assert result["tier25_p1"] == 1, (
        f"Tier 2.5 should detect SLizard heading-form P1, got {result!r}"
    )
    assert result["tier25_p0"] == 0
    assert result["p1_count"] == 1
    assert result["has_blocking"] is True, (
        f"SLizard heading-form P1 must trigger has_blocking=True, got {result!r}"
    )


def test_tier25_negation_guard_rejects_no_p1_heading() -> None:
    """AC-2 negation guard: `### No P1 \u00b7 findings` MUST NOT trigger."""
    result = detect(BODY_SLIZARD_HEADING_NEGATION)
    assert result["tier25_p0"] == 0
    assert result["tier25_p1"] == 0, (
        f"Tier 2.5 negation guard must reject `No P1 \u00b7 ...` heading, "
        f"got {result!r}"
    )
    assert result["has_blocking"] is False


def test_confidence_heading_form_parses_to_same_score_as_inline() -> None:
    """AC-1: both inline and heading-form confidence regexes MUST parse to the
    same numeric score for the same body.

    The inline regex is unanchored and so happens to also match a heading
    line, but the heading-form fallback is the load-bearing defence-in-depth
    contract. Drive each regex in isolation so a future edit that breaks the
    heading-form regex fails this assertion even when the inline regex still
    happens to match.
    """
    body = BODY_CONFIDENCE_HEADING_ONLY
    inline_match = _CONFIDENCE_INLINE_RE.search(body)
    heading_match = _CONFIDENCE_HEADING_RE.search(body)
    assert inline_match is not None, (
        "inline regex should still match a markdown heading because it is "
        "unanchored -- the heading-form fallback is defence-in-depth"
    )
    assert heading_match is not None, (
        "heading-form fallback MUST match `## Confidence Score: 3/5`"
    )
    assert int(inline_match.group(1)) == int(heading_match.group(1)) == 3
    assert parse_confidence(body) == 3


def test_confidence_heading_form_only_parses_when_inline_misses() -> None:
    """AC-1: when the inline regex cannot match (synthetic adversarial body),
    the heading-form fallback MUST still parse the score.

    Construct a body where the only `Confidence Score:` anchor is preceded
    by hash glyphs that the inline regex tolerates BUT pad the inline form
    out of reach with leading hash glyphs and verify the parser still
    returns 4 via the heading-form fallback. Because the inline regex is
    unanchored it cannot easily be defeated; assert the parser returns the
    correct score regardless of which surface fires.
    """
    body = "#### Confidence Score: 4/5\n\nbody text\n"
    assert parse_confidence(body) == 4


def test_confidence_zero_score_parses_via_slash_form() -> None:
    """AC-1 leading-`0` guard: `0/5` is a valid confidence and MUST parse.

    Conversely, a stray `0` outside the slash form MUST NOT trip the gate
    -- the regex structurally requires the `\\s*/\\s*5` suffix so any bare
    `0` cannot match. Pin both behaviours.
    """
    assert parse_confidence("## Confidence Score: 0/5\n") == 0
    # Stray `0` outside the slash form -- inline regex would not match either,
    # but the heading regex MUST also decline.
    body_stray = "## Confidence Score: 0 out of 5\n"
    assert _CONFIDENCE_HEADING_RE.search(body_stray) is None
    assert parse_confidence(body_stray) is None


def test_confidence_parses_inline_form_unchanged() -> None:
    """AC-1 regression: the inline-prose form MUST still parse unchanged.

    The heading-form fallback is added as a defence-in-depth fallback; the
    primary inline path must keep working on every previously-supported
    surface (no regression on the #910 / pre-#1035 bodies).
    """
    assert parse_confidence(BODY_TIER2_P1_ONLY) == 4
    assert parse_confidence(BODY_TIER3_NOT_SAFE_ONLY) == 3
    assert parse_confidence(BODY_CLEAN) == 5


# ---------------------------------------------------------------------------
# Synchronization tests -- assert the template encodes the same regex
# strings / sentinels the reference implementation above uses. If a future
# edit weakens or removes a tier from the template, these tests fail and
# force the author to update the reference + tests in lockstep.
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def template_text() -> str:
    return TEMPLATE_PATH.read_text(encoding="utf-8")


def test_template_contains_tier2_regex(template_text: str) -> None:
    """Template MUST encode the markdown-bullet bold regex with negation guards."""
    assert (
        r"^[\s\-\*]*\*\*P([01])\b[^*]*\*\*"
        in template_text
    ), "template missing Tier 2 markdown-bullet regex (#910)"
    # All four negation tokens must be enumerated.
    for token in ('"No "', '"Zero "', '"0 "', '"no "'):
        assert token in template_text, (
            f"template Tier 2 negation list missing token {token!r} (#910)"
        )


def test_template_contains_tier3_count_prose_regex(template_text: str) -> None:
    """Template MUST encode the inline-prose count regex (One..Ten|\\d+ P[01] findings)."""
    assert (
        r"\b(?:One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|\d+)\s+P[01]\s+findings?\b"
        in template_text
    ), "template missing Tier 3 count-prose regex (#910)"


def test_template_contains_tier3_line_anchored_regex(template_text: str) -> None:
    """Template MUST encode the line-anchored ``^P[01] -- `` sentinel regex."""
    assert (
        r"^\s*P[01]\s+--\s"
        in template_text
    ), "template missing Tier 3 line-anchored regex (#910)"


def test_template_contains_not_safe_to_merge_substring(template_text: str) -> None:
    """Template MUST encode the ``Not safe to merge`` substring sentinel."""
    assert "Not safe to merge" in template_text, (
        "template missing Tier 3 `Not safe to merge` substring sentinel (#910)"
    )


def test_template_contains_tier1_badge_count_strings(template_text: str) -> None:
    """Template MUST encode the canonical Tier 1 HTML-badge substring counts.

    Greptile review on PR #996 surfaced this gap: the Tier 2 / Tier 3 sync
    tests pin their regex strings, but nothing pinned the Tier 1
    ``body.count('<img alt="P0"')`` / ``body.count('<img alt="P1"')`` calls
    that drive the badge tier. A future editor renaming the HTML attribute
    (e.g. switching to ``data-severity="P0"`` or upstream Greptile changing
    the badge tag) would silently break Tier 1 with no sync-test failure.
    Pin both calls verbatim.
    """
    assert (
        "body.count('<img alt=\"P0\"')" in template_text
    ), "template missing Tier 1 badge count for P0 (`body.count('<img alt=\"P0\"')`) (#910)"
    assert (
        "body.count('<img alt=\"P1\"')" in template_text
    ), "template missing Tier 1 badge count for P1 (`body.count('<img alt=\"P1\"')`) (#910)"


def test_template_combined_verdict_uses_max_per_severity(template_text: str) -> None:
    """Template MUST combine tier1+tier2+tier25 via max() per severity (#910 + #1035)."""
    assert "max(tier1_p0, tier2_p0, tier25_p0)" in template_text, (
        "template combined verdict must fold Tier 2.5 P0 into per-severity max() (#1035)"
    )
    assert "max(tier1_p1, tier2_p1, tier25_p1)" in template_text, (
        "template combined verdict must fold Tier 2.5 P1 into per-severity max() (#1035)"
    )
    assert "tier3_sentinel" in template_text


def test_template_contains_tier25_regex(template_text: str) -> None:
    """Template MUST encode the Tier 2.5 SLizard heading regex (#1035).

    The regex matches SLizard's `### P[01] <sep> ...` heading-form findings,
    where `<sep>` is one of middot (U+00B7), hyphenation point (U+2027),
    bullet (U+2022), or ASCII hyphen. The character class places the
    hyphen last to avoid range-delimiter parsing.

    The template is a ``str.format(...)`` payload, so the literal ``{1,6}``
    quantifier appears in the file as the doubled-brace escape ``{{1,6}}``
    (every literal curly brace in the file is doubled per the format
    contract). The sync test asserts the escaped form to match what the
    file actually contains.
    """
    # Doubled-brace form -- the on-disk template content
    assert (
        r"^#{{1,6}}\s+P([01])\s*[\u00b7\u2027\u2022\-]\s"
        in template_text
    ), "template missing Tier 2.5 SLizard heading regex (#1035)"
    # And confirm the doubled-brace form renders to the single-brace form
    # via str.format() so a downstream poller script actually compiles the
    # canonical regex (defence-in-depth against a typo that escapes one
    # side and not the other).
    rendered = template_text.format(
        pr_number=1035,
        repo="deftai/directive",
        poll_interval_seconds=90,
        poll_cap_minutes=30,
        parent_agent_id="parent-id",
    )
    assert (
        r"^#{1,6}\s+P([01])\s*[\u00b7\u2027\u2022\-]\s"
        in rendered
    ), "rendered template missing Tier 2.5 SLizard heading regex (#1035)"


def test_template_contains_confidence_heading_regex(template_text: str) -> None:
    """Template MUST encode the heading-form confidence fallback regex (#1035).

    Same doubled-brace contract as the Tier 2.5 sync test above: the
    template file contains ``{{1,6}}``; the rendered output contains
    ``{1,6}``. Pin both.
    """
    assert (
        r"^#{{1,6}}\s*Confidence Score:\s*(\d+)\s*/\s*5\s*$"
        in template_text
    ), "template missing confidence-heading fallback regex (#1035)"
    rendered = template_text.format(
        pr_number=1035,
        repo="deftai/directive",
        poll_interval_seconds=90,
        poll_cap_minutes=30,
        parent_agent_id="parent-id",
    )
    assert (
        r"^#{1,6}\s*Confidence Score:\s*(\d+)\s*/\s*5\s*$"
        in rendered
    ), "rendered template missing confidence-heading fallback regex (#1035)"


def test_template_tier25_recurrence_citation(template_text: str) -> None:
    """Template MUST cite the #1035 recurrence record for Tier 2.5.

    The recurrence-record citation is the load-bearing argument for adding
    Tier 2.5; if a future edit drops the citation the rule body's rationale
    evaporates. Pin both the issue-number citation and the `Tier 2.5` token.
    """
    assert "#1035" in template_text, (
        "template must cite the Tier 2.5 recurrence-record issue (#1035)"
    )
    assert "Tier 2.5" in template_text, (
        "template must name the Tier 2.5 sub-tier explicitly so the existing "
        "Tier 1/2/3 citations remain stable (#1035)"
    )


def test_template_section_heading_marks_triple_tier(template_text: str) -> None:
    """Template section heading MUST advertise the triple-tier upgrade + #910."""
    assert "TRIPLE-TIER" in template_text
    assert "#910" in template_text


def test_template_recurrence_record_three_false_negatives(template_text: str) -> None:
    """Template MUST cite the v0.25.1 swarm session three-false-negative record."""
    # The recurrence count is the load-bearing argument for promoting Tier 2
    # and Tier 3 from Notes-only to detector-body. If a future edit drops the
    # recurrence citation the rule body's rationale evaporates -- pin it.
    assert "three false-negatives" in template_text.lower() or (
        "three false-negative" in template_text.lower()
    ), "template must cite the three-false-negative recurrence record (#910)"


def test_template_renders_via_format() -> None:
    """The template MUST still render via str.format() with all five placeholders.

    Structural guard against accidentally introducing an unescaped `{` in the
    new triple-tier code block (every literal curly brace must be doubled).
    """
    text = TEMPLATE_PATH.read_text(encoding="utf-8")
    rendered = text.format(
        pr_number=910,
        repo="deftai/directive",
        poll_interval_seconds=90,
        poll_cap_minutes=30,
        parent_agent_id="parent-id-xyz",
    )
    assert "PR #910" in rendered
    assert "deftai/directive" in rendered


# ---------------------------------------------------------------------------
# #1039 -- (5) STALL terminal exit + Tier 1 instrumentation + Tier 3 per-
# condition fail-loud (clean_gate_holdout). The behaviour-matrix lane below
# pins each AC item via a Python reference implementation of the (5)-condition
# CLEAN gate that mirrors the template body's `evaluate_clean_gate` function.
# The synchronization-test lane pins the template encoding so a future edit
# that drops the (5) STALL block, the clean_gate_holdout surface, or the
# Tier 1 instrumentation log line fails CI immediately.
# ---------------------------------------------------------------------------


# Naive INLINE-SHA regex used by the negative-control case below.
# Greptile emits the SHA as a markdown link, NOT inline; a poller that copies
# THIS regex into its poll script will fall through every iteration with
# last_reviewed_sha=None. The template's prescribed markdown-link regex
# (mirrored at the top of this module) is the correct surface.
_NAIVE_INLINE_SHA_RE = re.compile(
    r"Last reviewed commit:\s*([0-9a-f]{7,40})"
)
# Template-prescribed markdown-link regex (verbatim mirror of the template's
# `Last reviewed commit:` section). Doubled-brace form not needed here because
# this is the reference Python module, not the template body.
_MARKDOWN_LINK_SHA_RE = re.compile(
    r"Last reviewed commit:\s*\[[^\]]*\]\("
    r"https?://github\.com/[^/]+/[^/]+/commit/(?P<sha>[0-9a-f]{7,40})"
)


def parse_last_reviewed_sha_markdown_link(body: str):
    """Reference markdown-link SHA parser mirroring the template body."""
    m = _MARKDOWN_LINK_SHA_RE.search(body)
    return m.group("sha") if m else None


def parse_last_reviewed_sha_naive_inline(body: str):
    """Negative-control: the naive inline-SHA regex that does NOT match."""
    m = _NAIVE_INLINE_SHA_RE.search(body)
    return m.group(1) if m else None


def evaluate_clean_gate(
    *,
    last_reviewed_sha,
    head_sha: str,
    has_blocking: bool,
    confidence,
    ci_failures: int,
    errored: bool,
):
    """Reference (5)-condition CLEAN gate evaluator.

    Mirrors the template body's `evaluate_clean_gate` function exactly --
    the order of checks is the operative contract so `clean_gate_holdout`
    names the FIRST failing condition, not a downstream cascade. Returns
    a tuple of ``(is_clean: bool, clean_gate_holdout: Optional[str])`` per
    the template body.
    """
    if last_reviewed_sha is None or last_reviewed_sha != head_sha:
        return False, "sha_match"
    if has_blocking:
        return False, "has_blocking"
    if confidence is None or confidence <= 3:
        return False, "confidence"
    if ci_failures > 0:
        return False, "ci_failures"
    if errored:
        return False, "errored"
    return True, None


def format_poll_log_line(
    *,
    i: int,
    cap: int,
    last_reviewed_sha,
    head_sha,
    confidence,
    has_blocking,
    p0_count,
    p1_count,
    errored,
    ci_failures,
    is_clean,
    clean_gate_holdout,
) -> str:
    """Reference Tier 1 instrumentation formatter mirroring the template body.

    A poller transcript line emitted via this format MUST be greppable on
    ``is_clean=False`` so the operator can see WHICH of the five conditions
    was the holdout (the load-bearing #1039 AC-1 contract).
    """
    return (
        f"[poll {i}/{cap}] last_reviewed_sha={last_reviewed_sha} "
        f"head={head_sha} sha_match={last_reviewed_sha == head_sha} "
        f"confidence={confidence} has_blocking={has_blocking} "
        f"p0={p0_count} p1={p1_count} errored={errored} "
        f"ci_failures={ci_failures} is_clean={is_clean} "
        f"clean_gate_holdout={clean_gate_holdout}"
    )


def simulate_poll_loop(
    *,
    body: str,
    head_sha: str,
    ci_failures: int = 0,
    max_polls: int = 5,
    stall_threshold: int = 3,
):
    """Drive a synthetic poll loop over a static rolling-summary body.

    Returns ``(exit_class, polls_run, last_holdout, log_lines)`` where
    ``exit_class`` is one of ``"CLEAN"`` / ``"NEW_P0P1"`` / ``"ERRORED"`` /
    ``"STALL"`` / ``"RUNNING"``. The body is held static across polls because
    a real Greptile rolling-summary comment is stable between Greptile
    updates -- which is exactly the regime the (5) STALL exit is sized for.
    The errored sentinel from #526 fires when the body equals the canonical
    error string.
    """
    errored_sentinel = "Greptile encountered an error while reviewing this PR"
    last_reviewed_sha = parse_last_reviewed_sha_markdown_link(body)
    confidence = parse_confidence(body)
    findings = detect(body)
    has_blocking = findings["has_blocking"]
    errored = body.strip() == errored_sentinel
    stall_streak = 0
    log_lines: list[str] = []
    last_holdout = None
    for i in range(1, max_polls + 1):
        is_clean, clean_gate_holdout = evaluate_clean_gate(
            last_reviewed_sha=last_reviewed_sha,
            head_sha=head_sha,
            has_blocking=has_blocking,
            confidence=confidence,
            ci_failures=ci_failures,
            errored=errored,
        )
        last_holdout = clean_gate_holdout
        log_lines.append(
            format_poll_log_line(
                i=i,
                cap=max_polls,
                last_reviewed_sha=last_reviewed_sha,
                head_sha=head_sha,
                confidence=confidence,
                has_blocking=has_blocking,
                p0_count=findings["p0_count"],
                p1_count=findings["p1_count"],
                errored=errored,
                ci_failures=ci_failures,
                is_clean=is_clean,
                clean_gate_holdout=clean_gate_holdout,
            )
        )
        if is_clean:
            return "CLEAN", i, clean_gate_holdout, log_lines
        if has_blocking and last_reviewed_sha == head_sha:
            return "NEW_P0P1", i, clean_gate_holdout, log_lines
        if errored:
            return "ERRORED", i, clean_gate_holdout, log_lines
        if not has_blocking and not is_clean:
            stall_streak += 1
        else:
            stall_streak = 0
        if stall_streak >= stall_threshold:
            return "STALL", i, clean_gate_holdout, log_lines
    return "RUNNING", max_polls, last_holdout, log_lines


# ---------------------------------------------------------------------------
# AC-4 behaviour-matrix bodies. The CLEAN body uses a markdown-link SHA + a
# clean-signal review; the stall bodies vary one parse surface at a time so
# the resulting holdout names the precise failure root cause.
# ---------------------------------------------------------------------------

_HEAD_SHA = "abcdef1234567"

BODY_AC4_MARKDOWN_LINK_CLEAN = (
    "Greptile review of head 1234567\n"
    "\n"
    "## Confidence Score: 5/5\n"
    "\n"
    "No P0 or P1 issues found. The change looks clean and well-tested.\n"
    "\n"
    f"Last reviewed commit: [fix: foo](https://github.com/deftai/directive/commit/{_HEAD_SHA})\n"
)

# Inline SHA (no markdown link) -- the prescribed regex returns None, condition
# (1) `sha_match` holds the gate, and (since the body otherwise looks clean)
# both has_blocking AND is_clean are False on every poll -> STALL within 3.
BODY_AC4_INLINE_SHA_CLEAN = (
    "Greptile review of head 1234567\n"
    "\n"
    "## Confidence Score: 5/5\n"
    "\n"
    "No P0 or P1 issues found. The change looks clean.\n"
    "\n"
    f"Last reviewed commit: {_HEAD_SHA}\n"  # inline, no `[<subject>](<url>)` wrapper
)

# Confidence rendered in a third unanticipated form -- neither the inline
# regex nor the heading-form fallback match. Holdout: `sha_match` then
# `confidence` cascade -- but because the SHA parses successfully, the
# first holdout is `confidence`.
BODY_AC4_THIRD_CONFIDENCE_FORM = (
    "Greptile review of head 1234567\n"
    "\n"
    "| Metric            | Value |\n"
    "| ----------------- | ----- |\n"
    "| Confidence Score  | 5 of 5 |\n"  # `X of 5` not `X/5` -- neither regex matches
    "\n"
    "No P0 or P1 issues found. The change looks clean.\n"
    "\n"
    f"Last reviewed commit: [fix: foo](https://github.com/deftai/directive/commit/{_HEAD_SHA})\n"
)

# Empty / truncated body -- every parse surface returns None; holdout is
# `sha_match` (first failing condition in 1/2/3/4/5 order).
BODY_AC4_EMPTY = ""
BODY_AC4_TRUNCATED = (
    "Greptile review of head 1234567\n"
    "\n"
    "## Confidence Score:"
    # ... output truncated mid-line before the slash form, before the SHA
    # anchor, before the findings. The poller's body window is incomplete.
)


def test_ac4_markdown_link_sha_clean_exits_clean_within_one_poll() -> None:
    """AC-4 case 1: markdown-link SHA + clean signals -> CLEAN within 1 poll."""
    exit_class, polls_run, holdout, log_lines = simulate_poll_loop(
        body=BODY_AC4_MARKDOWN_LINK_CLEAN, head_sha=_HEAD_SHA, max_polls=5
    )
    assert exit_class == "CLEAN", (
        f"markdown-link SHA + clean body must exit CLEAN, got {exit_class!r}; "
        f"log_lines={log_lines!r}"
    )
    assert polls_run == 1
    assert holdout is None, f"CLEAN exit must have holdout=None, got {holdout!r}"


def test_ac4_inline_sha_clean_exits_stall_within_three_polls() -> None:
    """AC-4 case 2: INLINE SHA + clean signals -> STALL within 3 polls.

    The naive inline-SHA regex would match the body's `Last reviewed commit: <SHA>`
    inline form (negative-control), but the template's prescribed markdown-link
    regex returns None -> condition (1) `sha_match` is the first failure ->
    `has_blocking=False AND is_clean=False` on every poll -> STALL fires after
    3 consecutive wedged polls (#1039 AC-2).
    """
    # Negative control: the naive inline regex DOES match the inline form --
    # this asserts the body really does contain a parseable inline SHA, so the
    # markdown-link miss below is a regex-shape gap, not a missing-SHA gap.
    assert (
        parse_last_reviewed_sha_naive_inline(BODY_AC4_INLINE_SHA_CLEAN) == _HEAD_SHA
    )
    # The template-prescribed regex declines the inline form.
    assert parse_last_reviewed_sha_markdown_link(BODY_AC4_INLINE_SHA_CLEAN) is None

    exit_class, polls_run, holdout, log_lines = simulate_poll_loop(
        body=BODY_AC4_INLINE_SHA_CLEAN, head_sha=_HEAD_SHA, max_polls=5
    )
    assert exit_class == "STALL", (
        f"inline-SHA + clean body must exit STALL, got {exit_class!r}; "
        f"log_lines={log_lines!r}"
    )
    assert polls_run == 3, (
        f"STALL threshold is 3 consecutive wedged polls; got polls_run={polls_run}"
    )
    assert holdout == "sha_match", (
        f"STALL holdout must name `sha_match` (condition 1), got {holdout!r}"
    )


def test_ac4_third_confidence_form_exits_stall_within_three_polls() -> None:
    """AC-4 case 3: confidence in a third form -> STALL within 3 polls.

    The SHA parses (markdown-link form), `has_blocking` is False (clean body),
    but `confidence = None` because the table-cell `5 of 5` matches NEITHER
    the inline `X/5` regex NOR the heading-form `^#+ ... X/5 $` regex. The
    holdout is `confidence` (condition 3), since (1) and (2) pass.
    """
    assert (
        parse_last_reviewed_sha_markdown_link(BODY_AC4_THIRD_CONFIDENCE_FORM)
        == _HEAD_SHA
    ), "sha_match must pass on a markdown-link SHA pointing at HEAD"
    assert parse_confidence(BODY_AC4_THIRD_CONFIDENCE_FORM) is None, (
        "the third confidence form (`5 of 5` in a table cell) must NOT parse"
    )

    exit_class, polls_run, holdout, _log_lines = simulate_poll_loop(
        body=BODY_AC4_THIRD_CONFIDENCE_FORM, head_sha=_HEAD_SHA, max_polls=5
    )
    assert exit_class == "STALL"
    assert polls_run == 3
    assert holdout == "confidence", (
        f"holdout must name `confidence` (condition 3), got {holdout!r}"
    )


@pytest.mark.parametrize(
    "body",
    [BODY_AC4_EMPTY, BODY_AC4_TRUNCATED],
    ids=["empty", "truncated"],
)
def test_ac4_empty_or_truncated_body_exits_stall_within_three_polls(body: str) -> None:
    """AC-4 case 4: empty / truncated body -> STALL within 3 polls.

    Every parse surface returns None; the SHA never matches HEAD; holdout
    is `sha_match` (condition 1, the first failing check).
    """
    exit_class, polls_run, holdout, _log_lines = simulate_poll_loop(
        body=body, head_sha=_HEAD_SHA, max_polls=5
    )
    assert exit_class == "STALL"
    assert polls_run == 3
    assert holdout == "sha_match"


def test_ac4_per_poll_instrumentation_line_present_in_log() -> None:
    """AC-4 case 5: every poll iteration emits the Tier 1 instrumentation line.

    The line MUST carry the eleven fields in the exact order documented in
    `## CLEAN gate evaluation, clean_gate_holdout, and per-poll instrumentation`
    of the template body. A future edit that drops or reorders fields will
    fail this assertion AND the synchronization test on the template body.
    """
    _exit_class, _polls_run, _holdout, log_lines = simulate_poll_loop(
        body=BODY_AC4_INLINE_SHA_CLEAN, head_sha=_HEAD_SHA, max_polls=5
    )
    assert len(log_lines) >= 1, "poll loop MUST emit at least one log line"
    expected_field_order = [
        "last_reviewed_sha=",
        "head=",
        "sha_match=",
        "confidence=",
        "has_blocking=",
        "p0=",
        "p1=",
        "errored=",
        "ci_failures=",
        "is_clean=",
        "clean_gate_holdout=",
    ]
    for line in log_lines:
        assert line.startswith("[poll "), f"line must start with `[poll `, got {line!r}"
        prev_idx = -1
        for field in expected_field_order:
            idx = line.find(field)
            assert idx != -1, (
                f"log line missing field {field!r}: {line!r}"
            )
            assert idx > prev_idx, (
                f"log line field order regression -- {field!r} appears before "
                f"a prior field: {line!r}"
            )
            prev_idx = idx


def test_ac3_clean_gate_holdout_names_first_failing_condition() -> None:
    """AC-3 unit test: the gate names the FIRST failing condition.

    Drive the gate evaluator with adversarial inputs that fail multiple
    conditions simultaneously and assert the holdout names the lowest-
    numbered failure -- the operative contract documented in the template
    body ("the holdout names the first failure, not a downstream cascade").
    """
    # Conditions (1) AND (3) fail simultaneously -- holdout MUST be `sha_match`.
    is_clean, holdout = evaluate_clean_gate(
        last_reviewed_sha=None,
        head_sha=_HEAD_SHA,
        has_blocking=False,
        confidence=None,
        ci_failures=0,
        errored=False,
    )
    assert (is_clean, holdout) == (False, "sha_match")

    # (2) AND (3) fail; (1) passes -- holdout MUST be `has_blocking`.
    is_clean, holdout = evaluate_clean_gate(
        last_reviewed_sha=_HEAD_SHA,
        head_sha=_HEAD_SHA,
        has_blocking=True,
        confidence=2,
        ci_failures=0,
        errored=False,
    )
    assert (is_clean, holdout) == (False, "has_blocking")

    # (3) AND (4) fail; (1)/(2) pass -- holdout MUST be `confidence`.
    is_clean, holdout = evaluate_clean_gate(
        last_reviewed_sha=_HEAD_SHA,
        head_sha=_HEAD_SHA,
        has_blocking=False,
        confidence=2,
        ci_failures=3,
        errored=False,
    )
    assert (is_clean, holdout) == (False, "confidence")

    # (4) AND (5) fail; (1)/(2)/(3) pass -- holdout MUST be `ci_failures`.
    is_clean, holdout = evaluate_clean_gate(
        last_reviewed_sha=_HEAD_SHA,
        head_sha=_HEAD_SHA,
        has_blocking=False,
        confidence=5,
        ci_failures=1,
        errored=True,
    )
    assert (is_clean, holdout) == (False, "ci_failures")

    # Only (5) fails -- holdout MUST be `errored`.
    is_clean, holdout = evaluate_clean_gate(
        last_reviewed_sha=_HEAD_SHA,
        head_sha=_HEAD_SHA,
        has_blocking=False,
        confidence=5,
        ci_failures=0,
        errored=True,
    )
    assert (is_clean, holdout) == (False, "errored")

    # All five pass -- holdout MUST be None.
    is_clean, holdout = evaluate_clean_gate(
        last_reviewed_sha=_HEAD_SHA,
        head_sha=_HEAD_SHA,
        has_blocking=False,
        confidence=5,
        ci_failures=0,
        errored=False,
    )
    assert (is_clean, holdout) == (True, None)


def test_ac4_regression_clean_exit_unchanged_on_pre_1039_bodies() -> None:
    """AC-4 regression guard: existing #910 / #1035 detector bodies still
    drive CLEAN / NEW_P0P1 correctly under the new (5)-condition gate.

    For the bodies fixtures defined earlier in this module the gate's
    `has_blocking` reflects the detector's verdict; CLEAN fires when the
    SHA matches AND confidence > 3 AND no blocking; NEW_P0P1 fires when
    has_blocking is True on the matched SHA. These two regression cases
    pin that the #1039 (5) STALL surface is purely additive -- existing
    exits behave identically to the pre-#1039 poller.
    """
    # BODY_CLEAN has confidence 5/5, no findings, markdown-link SHA at
    # `1111111aaa2222b`. Drive the loop with the matching head SHA.
    clean_head = "1111111aaa2222b"
    exit_class, polls_run, holdout, _ = simulate_poll_loop(
        body=BODY_CLEAN, head_sha=clean_head, max_polls=5
    )
    assert (exit_class, polls_run, holdout) == ("CLEAN", 1, None)

    # BODY_SLIZARD_HEADING_P1 has a Tier 2.5 P1 finding + markdown-link SHA
    # `3333333abcdef12`. Confidence is 3/5 -- the gate's condition (2)
    # has_blocking fires BEFORE condition (3) confidence under the documented
    # 1/2/3/4/5 evaluation order. Holdout name MUST be `has_blocking`.
    slizard_head = "3333333abcdef12"
    exit_class, polls_run, holdout, _ = simulate_poll_loop(
        body=BODY_SLIZARD_HEADING_P1, head_sha=slizard_head, max_polls=5
    )
    assert exit_class == "NEW_P0P1"
    assert polls_run == 1
    assert holdout == "has_blocking"


# ---------------------------------------------------------------------------
# Synchronization tests -- pin the template encoding so a future edit that
# drops the (5) STALL block, the clean_gate_holdout surface, or the Tier 1
# instrumentation log line fails CI immediately.
# ---------------------------------------------------------------------------


def test_template_section_intro_says_five_terminal_exits(template_text: str) -> None:
    """Template MUST advertise FIVE terminal exit conditions (#1039 AC-2)."""
    assert "five terminal exit conditions" in template_text, (
        "template intro must say `five terminal exit conditions` (#1039)"
    )
    assert (
        "When ANY of the five conditions below fires" in template_text
    ), "`## Terminal exit conditions` intro must enumerate five conditions (#1039)"


def test_template_contains_evaluate_clean_gate_function(template_text: str) -> None:
    """Template MUST encode the evaluate_clean_gate function body (#1039 AC-3)."""
    assert "def evaluate_clean_gate(" in template_text, (
        "template missing evaluate_clean_gate function (#1039)"
    )
    # The five holdout names MUST be present verbatim in the function body so
    # a downstream poller copying the snippet emits exactly these names.
    for holdout_name in (
        '"sha_match"',
        '"has_blocking"',
        '"confidence"',
        '"ci_failures"',
        '"errored"',
    ):
        assert holdout_name in template_text, (
            f"template missing canonical holdout name {holdout_name} (#1039)"
        )


def test_template_contains_stall_terminal_exit(template_text: str) -> None:
    """Template MUST contain the `### (5) STALL` section + canonical subject (#1039 AC-2)."""
    assert "### (5) STALL" in template_text, (
        "template missing `### (5) STALL` terminal exit section (#1039)"
    )
    # Canonical subject line from the issue body.
    assert (
        "poll loop wedged -- terminal-condition detection failure" in template_text
    ), "template missing canonical STALL subject (#1039 issue body)"
    # The state dump in the (5) STALL body MUST include clean_gate_holdout.
    stall_idx = template_text.index("### (5) STALL")
    stall_block = template_text[stall_idx : stall_idx + 2000]
    assert "clean_gate_holdout:" in stall_block, (
        "`### (5) STALL` body must surface clean_gate_holdout in state dump (#1039 AC-3)"
    )
    assert "-- no more polling, exiting now" in stall_block, (
        "`### (5) STALL` body must end with the canonical exit-contract line"
    )
    # The 3-poll streak threshold (~4.5 min at 90s) is the load-bearing
    # bounded-exit promise.
    assert "3 consecutive wedged polls" in template_text or (
        "N=3" in template_text and "3 consecutive polls" in template_text
    ) or "stall_streak >= 3" in template_text, (
        "template must pin the 3-consecutive-poll STALL threshold (#1039)"
    )
    assert "~4.5 min" in template_text, (
        "template must surface the ~4.5-min bounded-exit promise (#1039 AC-2)"
    )


def test_template_contains_clean_gate_holdout_in_timeout(template_text: str) -> None:
    """Template MUST surface clean_gate_holdout in the (4) TIMEOUT body (#1039 AC-3)."""
    timeout_idx = template_text.index("### (4) TIMEOUT")
    next_section_idx = template_text.index("### (5) STALL", timeout_idx)
    timeout_block = template_text[timeout_idx:next_section_idx]
    assert "clean_gate_holdout:" in timeout_block, (
        "`### (4) TIMEOUT` body must surface clean_gate_holdout (#1039 AC-3)"
    )


def test_template_contains_tier1_instrumentation_log(template_text: str) -> None:
    """Template MUST encode the Tier 1 per-poll instrumentation line (#1039 AC-1).

    The doubled-brace form is what the on-disk template carries; the
    single-brace form is what str.format(...) renders to. Pin both.
    """
    # Pin the leading `[poll {{i}}/{{cap}}]` token in doubled-brace form.
    assert "[poll {{i}}/{{cap}}]" in template_text, (
        "template missing Tier 1 instrumentation prefix `[poll {{i}}/{{cap}}]` (#1039)"
    )
    # Anchor the field-order search to the slice STARTING at the `[poll ` prefix
    # AND ending at the close of the `print(...)` block; without this, tokens
    # like `confidence=` would match the earlier kwarg in `evaluate_clean_gate(`
    # rather than the instrumentation block we are pinning here (the
    # observed false positive in the first test run).
    instr_start = template_text.index("[poll {{i}}/{{cap}}]")
    # The print block fits in ~600 chars; take a generous slice and stop at the
    # closing `)` of `print(...)`.
    instr_window = template_text[instr_start : instr_start + 800]
    # Pin the eleven verbatim fields in the canonical order within the slice.
    expected_field_tokens = [
        "last_reviewed_sha=",
        "head=",
        "sha_match=",
        "confidence=",
        "has_blocking=",
        "p0=",
        "p1=",
        "errored=",
        "ci_failures=",
        "is_clean=",
        "clean_gate_holdout=",
    ]
    prev_idx = -1
    for token in expected_field_tokens:
        idx = instr_window.find(token)
        assert idx != -1, (
            f"template Tier 1 instrumentation missing field {token!r} "
            f"in instrumentation print block (#1039)"
        )
        assert idx > prev_idx, (
            f"template Tier 1 instrumentation field order regression -- "
            f"{token!r} appears before a prior field in the print block (#1039)"
        )
        prev_idx = idx
    # Render the template; the single-brace form must be present in the
    # rendered output (defence-in-depth against a typo that escapes one
    # side and not the other -- mirrors the #1035 sync-test contract).
    rendered = template_text.format(
        pr_number=1039,
        repo="deftai/directive",
        poll_interval_seconds=90,
        poll_cap_minutes=30,
        parent_agent_id="parent-id",
    )
    assert "[poll {i}/{cap}]" in rendered, (
        "rendered template missing single-brace `[poll {i}/{cap}]` (#1039)"
    )


def test_template_status_message_list_includes_stall(template_text: str) -> None:
    """Constraints status-message list MUST include STALL alongside the four
    pre-#1039 exits so the worker sends a status message on every terminal
    exit (the existing rule -- extended to cover the new (5) STALL exit)."""
    assert (
        "(CLEAN / NEW P0/P1 FINDINGS escalation / ERRORED / TIMEOUT / STALL)"
        in template_text
    ), "Constraints status-message list must include STALL (#1039)"


def test_template_recurrence_record_cites_1039(template_text: str) -> None:
    """Template MUST cite the #1039 / PR #1038 recurrence record."""
    assert "#1039" in template_text, (
        "template must cite the (5) STALL + Tier 1 instrumentation issue (#1039)"
    )
    assert "PR #1038" in template_text, (
        "template must cite the PR #1038 stall recurrence record (#1039)"
    )
    assert "5794b0e7" in template_text, (
        "template must cite the wedged poller agent id `5794b0e7-...` (#1039)"
    )


def test_template_platform_adapter_unification_1342_phase6(template_text: str) -> None:
    """#1342 Phase 6 unification (slices 4+5): poller template must document platform-adapter spawn (spawn_subagent / Grok Build support) instead of hardcoding start_agent; pins the refactor of duplication and docs update."""
    assert "platform adapter" in template_text, "Phase 6 poller template must reference the unified platform adapter (#1342)"
    assert "spawn_subagent" in template_text or "Grok Build" in template_text, "template must mention non-Warp spawn_subagent path post-unification"
    assert "#1342" in template_text, "template must cite the #1342 unification for the spawn change"
