"""Snapshot-style content tests for AGENTS.md #1152 umbrella current-shape convention.

Pins the N12 surface (`## Umbrella current-shape convention (#1152)` section header,
the five canonical RFC2119 rule lines verbatim, the canonical body-structure
enumeration, and the cross-references to the skills that consume the convention)
so a future edit that silently drops one of the convention's load-bearing rule
lines fails CI.

Per the Rule Authority [AXIOM] in main.md, content tests on rule prose are the
lightest enforceable layer below deterministic gates. Mirrors the shape of
`test_agents_md_session_start.py` from N9 / #1149.
"""

from __future__ import annotations

import pathlib
import re

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
AGENTS_MD = REPO_ROOT / "AGENTS.md"
GH_SLICE_SKILL = REPO_ROOT / "skills" / "deft-directive-gh-slice" / "SKILL.md"
REFINEMENT_SKILL = REPO_ROOT / "skills" / "deft-directive-refinement" / "SKILL.md"


@pytest.fixture(scope="module")
def agents_md_text() -> str:
    return AGENTS_MD.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def gh_slice_text() -> str:
    return GH_SLICE_SKILL.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def refinement_text() -> str:
    return REFINEMENT_SKILL.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _extract_section(text: str, heading_pattern: str) -> str:
    """Return the body (including heading) of the first `##` section whose heading matches.

    Section ends at the next `##` heading or EOF.
    """
    pattern = re.compile(
        r"^##\s+" + heading_pattern + r".*?(?=^##\s|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    match = pattern.search(text)
    return match.group(0) if match else ""


# ---------------------------------------------------------------------------
# 1. Section header (#1152)
# ---------------------------------------------------------------------------


def test_umbrella_current_shape_section_header_present(agents_md_text: str) -> None:
    """The '## Umbrella current-shape convention (#1152)' header must exist."""
    assert re.search(
        r"^##\s+Umbrella current-shape convention\s+\(#1152\)\s*$",
        agents_md_text,
        re.MULTILINE,
    ), "missing '## Umbrella current-shape convention (#1152)' header"


# ---------------------------------------------------------------------------
# 2. Five RFC2119 rule lines verbatim
# ---------------------------------------------------------------------------


REQUIRED_RULE_LINES = (
    "! Every umbrella issue MUST have a single canonical `## Current shape (as of pass-N)` comment, edited in place after each design pass.",  # noqa: E501
    "! The current-shape comment MUST list open children, closed children, wave order, and the child-count history.",  # noqa: E501
    "~ Pass-N skills SHOULD update the current-shape comment as their Phase 4 step.",
    "\u2297 Do NOT delete prior amendment comments when updating the current-shape comment \u2014 they remain the audit trail.",  # noqa: E501
    "\u2297 Do NOT replace the current-shape comment with a fresh comment \u2014 it must be edited in place so its permalink is stable.",  # noqa: E501
)


@pytest.mark.parametrize("rule_line", REQUIRED_RULE_LINES)
def test_required_rfc2119_rule_lines_present(
    agents_md_text: str, rule_line: str
) -> None:
    """Each of the 5 RFC2119 rule lines from the issue body MUST be present verbatim."""
    section = _extract_section(
        agents_md_text, r"Umbrella current-shape convention \(#1152\)"
    )
    assert section, "Umbrella current-shape convention section not isolatable"
    assert rule_line in section, (
        f"missing required RFC2119 rule line in '## Umbrella current-shape "
        f"convention (#1152)' section: {rule_line!r}"
    )


def test_section_uses_canonical_rfc2119_markers(agents_md_text: str) -> None:
    """Section MUST carry canonical ! / ~ / U+2297 markers (not long-form)."""
    section = _extract_section(
        agents_md_text, r"Umbrella current-shape convention \(#1152\)"
    )
    assert re.search(r"^-\s+!\s+Every umbrella issue MUST", section, re.MULTILINE), (
        "Umbrella current-shape convention MUST rule must use the canonical '! ' marker"
    )
    assert re.search(r"^-\s+~\s+Pass-N skills SHOULD", section, re.MULTILINE), (
        "Umbrella current-shape convention SHOULD rule must use the canonical '~ ' marker"
    )
    must_not_lines = re.findall(r"^-\s+\u2297\s+Do NOT", section, re.MULTILINE)
    assert len(must_not_lines) == 2, (
        f"expected 2 MUST-NOT rules with canonical '\u2297 ' marker; found {len(must_not_lines)}"
    )


# ---------------------------------------------------------------------------
# 3. Canonical body structure enumeration
# ---------------------------------------------------------------------------


CANONICAL_BODY_FIELDS = (
    "Last updated:",
    "Last pass type:",
    "Child count:",
    "Child-count history:",
    "### Open children",
    "### Closed children",
    "### Wave order",
    "### Open questions",
    "### Reading order for fresh contributors",
)


@pytest.mark.parametrize("field", CANONICAL_BODY_FIELDS)
def test_canonical_body_structure_field_present(
    agents_md_text: str, field: str
) -> None:
    """Every canonical body-structure field must be named in the section."""
    section = _extract_section(
        agents_md_text, r"Umbrella current-shape convention \(#1152\)"
    )
    assert field in section, (
        f"canonical body-structure field {field!r} must be named in the "
        f"'## Umbrella current-shape convention (#1152)' section"
    )


def test_body_structure_pass_type_enumerates_all_four(agents_md_text: str) -> None:
    """Pass-type field must enumerate the four canonical pass types."""
    section = _extract_section(
        agents_md_text, r"Umbrella current-shape convention \(#1152\)"
    )
    for pass_type in ("additive", "subtractive", "refactor", "verify"):
        assert pass_type in section, (
            f"canonical pass type {pass_type!r} must be named under 'Last pass type:'"
        )


# ---------------------------------------------------------------------------
# 4. Cross-references to the consuming skills + parent refs
# ---------------------------------------------------------------------------


def test_section_cross_references_consuming_skills(agents_md_text: str) -> None:
    """The section must cross-reference both consuming skills + the parent meta-umbrella."""
    section = _extract_section(
        agents_md_text, r"Umbrella current-shape convention \(#1152\)"
    )
    assert "skills/deft-directive-gh-slice/SKILL.md" in section, (
        "section must cross-reference skills/deft-directive-gh-slice/SKILL.md"
    )
    assert "skills/deft-directive-refinement/SKILL.md" in section, (
        "section must cross-reference skills/deft-directive-refinement/SKILL.md"
    )
    assert "#1140" in section, (
        "section must cite parent meta-umbrella #1140 (design-pass churn)"
    )
    assert "#1119" in section, (
        "section must cite companion umbrella #1119 (motivating pattern)"
    )


# ---------------------------------------------------------------------------
# 5. Skill cross-references back at the convention
# ---------------------------------------------------------------------------


def test_gh_slice_skill_cross_references_convention(gh_slice_text: str) -> None:
    """gh-slice SKILL.md must cross-reference the convention from its final phase."""
    assert "Umbrella current-shape convention" in gh_slice_text, (
        "skills/deft-directive-gh-slice/SKILL.md must cross-reference the "
        "'Umbrella current-shape convention' from AGENTS.md (#1152)"
    )
    assert "#1152" in gh_slice_text, (
        "skills/deft-directive-gh-slice/SKILL.md cross-reference must cite #1152"
    )


def test_refinement_skill_cross_references_convention(refinement_text: str) -> None:
    """refinement SKILL.md must cross-reference the convention from its final phase."""
    assert "Umbrella current-shape convention" in refinement_text, (
        "skills/deft-directive-refinement/SKILL.md must cross-reference the "
        "'Umbrella current-shape convention' from AGENTS.md (#1152)"
    )
    assert "#1152" in refinement_text, (
        "skills/deft-directive-refinement/SKILL.md cross-reference must cite #1152"
    )
