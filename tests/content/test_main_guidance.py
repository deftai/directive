"""Content tests for the Cancellation Attribution guidance (#1300).

Asserts that `main.md` carries an explicit Cancellation Attribution rule and
that `templates/agent-prompt-preamble.md` propagates the same rule so
dispatched sub-agents inherit the behavior.

The rule (issue #1300) requires:

1. A guidance section that names tool-reported `cancelled` / `aborted` /
   `killed` signals as NOT proof of user intent.
2. A MUST-retry-sequentially-before-attributing pattern.
3. A ban on phrases like "you cancelled" without direct user-side evidence.
4. Worker-prompt propagation so orchestrated sub-agents follow the same
   behavior.

Cross-references:
- ``main.md`` ``## Cancellation Attribution (#1300)``
- ``templates/agent-prompt-preamble.md`` ``## 13. Cancellation Attribution``
- GitHub issue: ``https://github.com/deftai/directive/issues/1300``
"""

from __future__ import annotations

import pathlib
import re

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
MAIN_MD = REPO_ROOT / "main.md"
PREAMBLE = REPO_ROOT / "templates" / "agent-prompt-preamble.md"

# Single source of truth for the Cancellation Attribution section slice in
# both files. ``\Z`` terminates the lookahead on end-of-file so the last
# section in a document still matches even when no trailing ``##`` heading
# is present (#1300 tests reviewer MINOR-3). The optional numeric prefix
# (``\d+\.\s+``) accepts both main.md's bare ``## Cancellation Attribution``
# heading and the preamble's numbered ``## 13. Cancellation Attribution``
# heading without false-matching unrelated ``##`` sections.
_SECTION_PATTERN = re.compile(
    r"^##\s+(?:\d+\.\s+)?Cancellation Attribution.*?(?=^##\s|\Z)",
    flags=re.MULTILINE | re.DOTALL,
)

# Canonical list of forbidden user-attribution phrases the rule MUST ban
# without direct user-side evidence (#1300 docs/contracts MINOR-3 + tests
# reviewer suggestion). Every phrase MUST appear under a ⊗ bullet in the
# Cancellation Attribution section of BOTH main.md and the preamble.
_BANNED_PHRASES = ("you cancelled", "you stopped", "you declined")


def _extract_section(text: str) -> str:
    """Return the Cancellation Attribution section slice or fail loudly.

    Whole-file substring assertions would pass even if the cited content
    lives in a neighbouring section, so every signal-enumeration and
    MUST-layer assertion in this file routes through this helper.
    """
    match = _SECTION_PATTERN.search(text)
    assert match is not None, (
        "Cancellation Attribution section heading not found -- expected a "
        "`## Cancellation Attribution` heading in the document"
    )
    return match.group(0)


@pytest.fixture(scope="module")
def main_text() -> str:
    return MAIN_MD.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def main_section(main_text: str) -> str:
    return _extract_section(main_text)


@pytest.fixture(scope="module")
def preamble_text() -> str:
    return PREAMBLE.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def preamble_section(preamble_text: str) -> str:
    return _extract_section(preamble_text)


# ---------------------------------------------------------------------------
# main.md: canonical rule body
# ---------------------------------------------------------------------------


def test_main_md_has_cancellation_attribution_section(main_text: str) -> None:
    """main.md MUST carry a heading naming the Cancellation Attribution rule."""
    assert re.search(
        r"^##\s+Cancellation Attribution\b", main_text, flags=re.MULTILINE
    ), "main.md must contain a `## Cancellation Attribution` section heading"


def test_main_md_section_references_issue_1300(main_section: str) -> None:
    """The Cancellation Attribution section must self-identify as #1300."""
    assert "#1300" in main_section, (
        "main.md Cancellation Attribution section must reference issue "
        "#1300 within the section body itself (not merely elsewhere in the file)"
    )


@pytest.mark.parametrize(
    "signal",
    ["cancelled", "aborted", "killed"],
)
def test_main_md_names_tool_runtime_signals(main_section: str, signal: str) -> None:
    """The rule must enumerate the tool-runtime signals it covers."""
    assert signal in main_section, (
        f"main.md Cancellation Attribution section must name `{signal}` as a "
        "tool-runtime signal that is not proof of user intent (the signal "
        "MUST appear inside the section slice, not elsewhere in main.md)"
    )


def test_main_md_names_runtime_failure_classes(main_section: str) -> None:
    """The rule must name at least one runtime-source failure class."""
    # The acceptance criterion in the vBRIEF asks for at least one runtime
    # source class (parallel batch, network glitch, timeout, server error).
    candidates = (
        "parallel-batch",
        "parallel batch",
        "network glitch",
        "timeout",
        "5xx",
        "server",
    )
    found = [c for c in candidates if c.lower() in main_section.lower()]
    assert found, (
        "main.md Cancellation Attribution section must cite at least one "
        f"runtime-source class within the section body; expected any of "
        f"{candidates!r}"
    )


def test_main_md_requires_sequential_retry(main_section: str) -> None:
    """The rule must require retry-sequentially before attribution."""
    # Be tolerant of casing / wording variation but require the pattern
    # inside the section slice -- a stray `retry sequentially` elsewhere
    # in main.md must NOT satisfy this assertion.
    assert re.search(
        r"retry.*sequential", main_section, flags=re.IGNORECASE | re.DOTALL
    ) or re.search(
        r"sequential.*retry", main_section, flags=re.IGNORECASE | re.DOTALL
    ), (
        "main.md Cancellation Attribution section must require retrying the "
        "affected operation sequentially before drawing a user-intent conclusion"
    )


@pytest.mark.parametrize("phrase", _BANNED_PHRASES)
def test_main_md_bans_you_cancelled_phrasing(main_section: str, phrase: str) -> None:
    """The rule must explicitly ban every canonical user-attribution phrase.

    The full prohibited list is ``you cancelled`` / ``you stopped`` /
    ``you declined`` (#1300 docs/contracts MINOR-3). Each phrase MUST
    appear inside the Cancellation Attribution section AND under a ``⊗``
    MUST NOT bullet so the rule is encoded at the strongest applicable
    layer per the ``## Rule Authority [AXIOM]`` section.
    """
    assert phrase in main_section, (
        "main.md Cancellation Attribution section must explicitly call out "
        f'the "{phrase}" phrasing as banned without direct user-side evidence'
    )
    # The ban must appear under a MUST NOT bullet (the project's `⊗` glyph)
    # WITHIN the section. The deft convention writes MUST NOT bullets as
    # either bare `⊗ ...` or list-form `- ⊗ ...`; accept both.
    must_not_lines = [
        line
        for line in main_section.splitlines()
        if re.match(r"^\s*(?:-\s+)?⊗\s", line)
    ]
    must_not_blob = "\n".join(must_not_lines)
    assert phrase in must_not_blob, (
        f"main.md must encode the `{phrase}` ban as a MUST NOT bullet "
        "(⊗) inside the Cancellation Attribution section, not a soft "
        "suggestion or a mention outside the section"
    )


def test_main_md_section_contains_must_layer(main_section: str) -> None:
    """The section MUST mix MUST and MUST NOT bullets, not just prose."""
    assert re.search(r"^-\s+!\s", main_section, flags=re.MULTILINE), (
        "Cancellation Attribution section must include at least one MUST (!) bullet"
    )
    assert re.search(r"^-\s+⊗\s", main_section, flags=re.MULTILINE), (
        "Cancellation Attribution section must include at least one MUST NOT (⊗) bullet"
    )


def test_main_md_section_references_preamble_propagation(main_section: str) -> None:
    """The canonical body MUST cross-reference the worker-prompt propagation."""
    assert "templates/agent-prompt-preamble.md" in main_section, (
        "main.md Cancellation Attribution section must reference the canonical "
        "orchestrator preamble so consumers can find the worker-side propagation"
    )


# ---------------------------------------------------------------------------
# templates/agent-prompt-preamble.md: worker-side propagation
# ---------------------------------------------------------------------------


def test_preamble_has_cancellation_attribution_section(preamble_text: str) -> None:
    """The canonical preamble must include a Cancellation Attribution section."""
    assert "Cancellation Attribution" in preamble_text, (
        "templates/agent-prompt-preamble.md must propagate the Cancellation "
        "Attribution rule so dispatched sub-agents inherit the behavior"
    )


def test_preamble_section_references_issue_1300(preamble_section: str) -> None:
    """The preamble section must self-identify as #1300."""
    assert "#1300" in preamble_section, (
        "preamble Cancellation Attribution section must reference issue "
        "#1300 inside the section body itself"
    )


@pytest.mark.parametrize(
    "signal",
    ["cancelled", "aborted", "killed"],
)
def test_preamble_names_tool_runtime_signals(
    preamble_section: str, signal: str
) -> None:
    """The propagated rule must enumerate the same tool-runtime signals."""
    assert signal in preamble_section, (
        f"preamble Cancellation Attribution section must name `{signal}` as a "
        "tool-runtime signal that is not proof of user intent (inside the "
        "section slice, not elsewhere in the preamble)"
    )


def test_preamble_requires_sequential_retry(preamble_section: str) -> None:
    """The propagated rule must require sequential retry before attribution."""
    assert re.search(
        r"retry.*sequential", preamble_section, flags=re.IGNORECASE | re.DOTALL
    ) or re.search(
        r"sequential.*retry", preamble_section, flags=re.IGNORECASE | re.DOTALL
    ), (
        "preamble Cancellation Attribution section must require retrying the "
        "affected operation sequentially before drawing a user-intent conclusion"
    )


@pytest.mark.parametrize("phrase", _BANNED_PHRASES)
def test_preamble_bans_you_cancelled_phrasing(
    preamble_section: str, phrase: str
) -> None:
    """The preamble must explicitly carry every canonical user-attribution ban.

    Mirrors the main.md parametrisation: every phrase in
    ``_BANNED_PHRASES`` MUST appear inside the preamble's Cancellation
    Attribution section. The preamble is the worker-side propagation
    document for the canonical rule body in ``main.md``; per the
    template's conventions it carries the prohibition as a ``Forbidden
    phrasing without direct user-side evidence:`` prose line rather than
    a ``⊗`` MUST NOT bullet. The canonical-body test
    ``test_main_md_bans_you_cancelled_phrasing`` retains the strict
    ``⊗``-bullet requirement so the strongest applicable layer is
    asserted at the rule body itself, while this propagation test only
    asserts the section contains an explicit, scoped prohibition signal
    (``forbidden`` / ``MUST NOT`` / ``⊗`` / the canonical-body cross-
    reference) co-located with each phrase.
    """
    assert phrase in preamble_section, (
        "preamble Cancellation Attribution section must explicitly call out "
        f'the "{phrase}" phrasing as banned without direct user-side evidence'
    )
    # Locate the lines naming the phrase and require one of them to also
    # carry a prohibition signal in the same line. Accepts the preamble's
    # ``Forbidden phrasing without direct user-side evidence:`` prose
    # form, an inline ``MUST NOT`` / ``must not``, or a ``⊗`` glyph.
    # Belt-and-suspenders against a future preamble revision that
    # mentions the phrase outside its prohibition context (e.g. a
    # paraphrasing example or a SHOULD-phrasing illustration).
    prohibition_signal = re.compile(
        r"(?:⊗|MUST NOT|must not|[Ff]orbidden)"
    )
    phrase_lines = [
        line for line in preamble_section.splitlines()
        if phrase in line
    ]
    assert phrase_lines, (
        f"preamble Cancellation Attribution section must mention `{phrase}` "
        "on at least one line (sanity check downstream of the section-slice "
        "assertion above)"
    )
    assert any(prohibition_signal.search(line) for line in phrase_lines), (
        f"preamble must co-locate the `{phrase}` mention with a prohibition "
        "signal (⊗ / MUST NOT / Forbidden) inside the Cancellation "
        "Attribution section, not as a paraphrasing example or unprefixed prose"
    )


def test_preamble_cross_references_main_md(preamble_section: str) -> None:
    """The preamble section must link back to the canonical main.md body."""
    assert "main.md" in preamble_section, (
        "preamble Cancellation Attribution section must cross-reference "
        "main.md (inside the section body) so the canonical rule body "
        "remains the single source of truth"
    )
