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


@pytest.fixture(scope="module")
def main_text() -> str:
    return MAIN_MD.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def preamble_text() -> str:
    return PREAMBLE.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# main.md: canonical rule body
# ---------------------------------------------------------------------------


def test_main_md_has_cancellation_attribution_section(main_text: str) -> None:
    """main.md MUST carry a heading naming the Cancellation Attribution rule."""
    assert re.search(
        r"^##\s+Cancellation Attribution\b", main_text, flags=re.MULTILINE
    ), "main.md must contain a `## Cancellation Attribution` section heading"


def test_main_md_section_references_issue_1300(main_text: str) -> None:
    """The Cancellation Attribution section must self-identify as #1300."""
    assert "#1300" in main_text, (
        "main.md Cancellation Attribution section must reference issue #1300"
    )


@pytest.mark.parametrize(
    "signal",
    ["cancelled", "aborted", "killed"],
)
def test_main_md_names_tool_runtime_signals(main_text: str, signal: str) -> None:
    """The rule must enumerate the tool-runtime signals it covers."""
    assert signal in main_text, (
        f"main.md Cancellation Attribution rule must name `{signal}` as a "
        "tool-runtime signal that is not proof of user intent"
    )


def test_main_md_names_runtime_failure_classes(main_text: str) -> None:
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
    found = [c for c in candidates if c.lower() in main_text.lower()]
    assert found, (
        "main.md Cancellation Attribution rule must cite at least one "
        f"runtime-source class; expected any of {candidates!r}"
    )


def test_main_md_requires_sequential_retry(main_text: str) -> None:
    """The rule must require retry-sequentially before attribution."""
    # Be tolerant of casing / wording variation but require the pattern.
    assert re.search(
        r"retry.*sequential", main_text, flags=re.IGNORECASE | re.DOTALL
    ) or re.search(
        r"sequential.*retry", main_text, flags=re.IGNORECASE | re.DOTALL
    ), (
        "main.md Cancellation Attribution rule must require retrying the "
        "affected operation sequentially before drawing a user-intent conclusion"
    )


def test_main_md_bans_you_cancelled_phrasing(main_text: str) -> None:
    """The rule must explicitly ban `you cancelled` without user evidence."""
    assert "you cancelled" in main_text, (
        "main.md Cancellation Attribution rule must explicitly call out the "
        '"you cancelled" phrasing as banned without direct user-side evidence'
    )
    # The ban must appear under a MUST NOT bullet (the project's `⊗` glyph)
    # so the rule is encoded at the strongest applicable layer per the
    # ## Rule Authority [AXIOM] section. The deft convention writes MUST NOT
    # bullets as either bare `⊗ ...` or list-form `- ⊗ ...`; accept both.
    must_not_lines = [
        line
        for line in main_text.splitlines()
        if re.match(r"^\s*(?:-\s+)?⊗\s", line)
    ]
    must_not_blob = "\n".join(must_not_lines)
    assert "you cancelled" in must_not_blob, (
        "main.md must encode the `you cancelled` ban as a MUST NOT bullet "
        "(⊗), not a soft suggestion"
    )


def test_main_md_section_contains_must_layer(main_text: str) -> None:
    """The section MUST mix MUST and MUST NOT bullets, not just prose."""
    # Pull just the Cancellation Attribution section so we don't accidentally
    # accept MUST bullets from neighbouring sections.
    match = re.search(
        r"^##\s+Cancellation Attribution.*?(?=^##\s)",
        main_text,
        flags=re.MULTILINE | re.DOTALL,
    )
    assert match is not None, "Cancellation Attribution section not found in main.md"
    section = match.group(0)
    assert re.search(r"^-\s+!\s", section, flags=re.MULTILINE), (
        "Cancellation Attribution section must include at least one MUST (!) bullet"
    )
    assert re.search(r"^-\s+⊗\s", section, flags=re.MULTILINE), (
        "Cancellation Attribution section must include at least one MUST NOT (⊗) bullet"
    )


def test_main_md_section_references_preamble_propagation(main_text: str) -> None:
    """The canonical body MUST cross-reference the worker-prompt propagation."""
    match = re.search(
        r"^##\s+Cancellation Attribution.*?(?=^##\s)",
        main_text,
        flags=re.MULTILINE | re.DOTALL,
    )
    assert match is not None
    section = match.group(0)
    assert "templates/agent-prompt-preamble.md" in section, (
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


def test_preamble_section_references_issue_1300(preamble_text: str) -> None:
    """The preamble section must self-identify as #1300."""
    assert "#1300" in preamble_text, (
        "preamble Cancellation Attribution section must reference issue #1300"
    )


@pytest.mark.parametrize(
    "signal",
    ["cancelled", "aborted", "killed"],
)
def test_preamble_names_tool_runtime_signals(
    preamble_text: str, signal: str
) -> None:
    """The propagated rule must enumerate the same tool-runtime signals."""
    assert signal in preamble_text, (
        f"preamble Cancellation Attribution section must name `{signal}` as a "
        "tool-runtime signal that is not proof of user intent"
    )


def test_preamble_requires_sequential_retry(preamble_text: str) -> None:
    """The propagated rule must require sequential retry before attribution."""
    assert re.search(
        r"retry.*sequential", preamble_text, flags=re.IGNORECASE | re.DOTALL
    ) or re.search(
        r"sequential.*retry", preamble_text, flags=re.IGNORECASE | re.DOTALL
    ), (
        "preamble Cancellation Attribution section must require retrying the "
        "affected operation sequentially before drawing a user-intent conclusion"
    )


def test_preamble_bans_you_cancelled_phrasing(preamble_text: str) -> None:
    """The preamble must explicitly carry the `you cancelled` ban."""
    assert "you cancelled" in preamble_text, (
        "preamble Cancellation Attribution section must explicitly call out "
        'the "you cancelled" phrasing as banned without direct user-side evidence'
    )


def test_preamble_cross_references_main_md(preamble_text: str) -> None:
    """The preamble section must link back to the canonical main.md body."""
    assert "main.md" in preamble_text, (
        "preamble Cancellation Attribution section must cross-reference "
        "main.md so the canonical rule body remains the single source of truth"
    )
