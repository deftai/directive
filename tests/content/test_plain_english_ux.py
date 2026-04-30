"""Content tests for the plain-English UX pass (#740, refs #767).

Covers:

1. ``references/plain-english-ux.md`` exists and codifies the rules
2. Acronym-on-first-use rule named in interview / strategy surfaces
3. Approval-menu presence after PRD review and SPEC review
4. Diff-view preface presence on PRD / SPEC review
5. The #767 framework rule (Discuss + Back as final two numbered options)
   is asserted in every approval menu defined in the interview SKILL and
   the interview strategy
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_INTERVIEW_SKILL = _REPO_ROOT / "skills" / "deft-directive-interview" / "SKILL.md"
_INTERVIEW_STRATEGY = _REPO_ROOT / "strategies" / "interview.md"
_UX_DOC = _REPO_ROOT / "references" / "plain-english-ux.md"


@pytest.fixture(scope="module")
def interview_skill_text() -> str:
    return _INTERVIEW_SKILL.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def interview_strategy_text() -> str:
    return _INTERVIEW_STRATEGY.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def ux_doc_text() -> str:
    return _UX_DOC.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# 1. references/plain-english-ux.md exists and codifies the rules
# ---------------------------------------------------------------------------


class TestUXReferenceDoc:
    def test_file_exists(self) -> None:
        assert _UX_DOC.is_file(), "references/plain-english-ux.md must exist (#740)"

    def test_has_acronym_rule(self, ux_doc_text: str) -> None:
        assert "Acronyms" in ux_doc_text or "acronym" in ux_doc_text.lower()
        assert "first use" in ux_doc_text.lower(), (
            "UX doc must codify the acronym-defined-on-first-use rule (#740)"
        )

    def test_has_approval_menu_rule(self, ux_doc_text: str) -> None:
        lower = ux_doc_text.lower()
        assert "approval menu" in lower

    def test_has_diff_preface_rule(self, ux_doc_text: str) -> None:
        lower = ux_doc_text.lower()
        assert "diff" in lower
        assert "preface" in lower

    def test_discuss_back_final_two_rule(self, ux_doc_text: str) -> None:
        lower = ux_doc_text.lower()
        assert "discuss" in lower and "back" in lower
        assert "final two" in lower or "last two" in lower or "final two numbered" in lower
        assert "#767" in ux_doc_text, (
            "UX doc must cross-reference #767 framework rule"
        )

    def test_jargon_rule_present(self, ux_doc_text: str) -> None:
        lower = ux_doc_text.lower()
        assert "context note" in lower or "plain-english context" in lower
        assert "jargon" in lower

    def test_framework_justification_rule_present(self, ux_doc_text: str) -> None:
        lower = ux_doc_text.lower()
        assert "industry-standard" in lower or "modern" in lower
        # Anti-pattern should call out empty-jargon justifications.
        assert "framework" in lower


# ---------------------------------------------------------------------------
# 2. Acronym-on-first-use rule named in interview surfaces
# ---------------------------------------------------------------------------


class TestAcronymOnFirstUseRule:
    def test_interview_skill_links_to_ux_doc(self, interview_skill_text: str) -> None:
        assert "references/plain-english-ux.md" in interview_skill_text, (
            "interview skill must link to references/plain-english-ux.md (#740)"
        )

    def test_interview_skill_calls_out_acronym_rule(self, interview_skill_text: str) -> None:
        lower = interview_skill_text.lower()
        # Must mention acronym + first use.
        assert "acronym" in lower
        assert "first use" in lower

    def test_interview_skill_inlines_prd_expansion(self, interview_skill_text: str) -> None:
        # Must show the canonical expansion at least once.
        assert "Product Requirements Document" in interview_skill_text, (
            "interview skill must define PRD inline at least once (#740)"
        )


# ---------------------------------------------------------------------------
# 3. Approval-menu presence (PRD + SPEC review)
# ---------------------------------------------------------------------------


class TestApprovalMenuPresence:
    def test_skill_has_prd_approval_menu(self, interview_skill_text: str) -> None:
        # Section heading naming the PRD approval menu.
        assert "PRD" in interview_skill_text and "Approval Menu" in interview_skill_text

    def test_skill_has_spec_approval_menu(self, interview_skill_text: str) -> None:
        assert "SPECIFICATION" in interview_skill_text and "Approval Menu" in interview_skill_text

    def test_strategy_has_prd_approval_menu(self, interview_strategy_text: str) -> None:
        assert "PRD Approval Menu" in interview_strategy_text

    def test_strategy_has_spec_approval_menu(self, interview_strategy_text: str) -> None:
        assert "SPECIFICATION Approval Menu" in interview_strategy_text

    def test_menu_has_approve_continue(self, interview_skill_text: str) -> None:
        assert "Approve and continue" in interview_skill_text

    def test_menu_has_suggest_changes(self, interview_skill_text: str) -> None:
        assert "Suggest changes" in interview_skill_text

    def test_menu_has_edit_yourself(self, interview_skill_text: str) -> None:
        assert "Edit yourself" in interview_skill_text


# ---------------------------------------------------------------------------
# 4. Diff-view preface presence
# ---------------------------------------------------------------------------


class TestDiffPrefacePresence:
    _CANONICAL_PREFACE_TOKENS = (
        "Red lines",
        "green lines",
    )

    def test_skill_has_diff_preface_section(self, interview_skill_text: str) -> None:
        lower = interview_skill_text.lower()
        assert "Diff-View Preface" in interview_skill_text or "diff-view preface" in lower

    def test_skill_canonical_preface(self, interview_skill_text: str) -> None:
        for token in self._CANONICAL_PREFACE_TOKENS:
            assert token in interview_skill_text, (
                f"interview skill diff preface must include {token!r} (#740)"
            )

    def test_strategy_prd_diff_preface(self, interview_strategy_text: str) -> None:
        # PRD review section must include a non-alarming preface.
        prd_section = interview_strategy_text.split("### PRD Approval Menu")[1].split(
            "### SPECIFICATION Structure"
        )[0]
        for token in self._CANONICAL_PREFACE_TOKENS:
            assert token in prd_section, (
                f"strategies/interview.md PRD review must include diff preface {token!r} (#740)"
            )

    def test_strategy_spec_diff_preface(self, interview_strategy_text: str) -> None:
        spec_section = interview_strategy_text.split("### SPECIFICATION Approval Menu")[1].split(
            "### Rejected Spec Archival"
        )[0]
        for token in self._CANONICAL_PREFACE_TOKENS:
            assert token in spec_section, (
                f"strategies/interview.md SPEC review must include diff preface "
                f"{token!r} (#740)"
            )

    def test_skill_states_not_an_error(self, interview_skill_text: str) -> None:
        # The non-alarming preface must explicitly state that the diff is not
        # an error report.
        lower = interview_skill_text.lower()
        assert "nothing here is broken" in lower or "not errors" in lower


# ---------------------------------------------------------------------------
# 5. #767 framework rule -- Discuss + Back as final two numbered options
# ---------------------------------------------------------------------------

# Regex extracting numbered menu blocks: lines like "  1. Approve..." through
# "  N. Back". We capture the entire block as a contiguous chunk of numbered
# lines, allowing leading whitespace.
_MENU_BLOCK_RE = re.compile(
    r"((?:^[ \t]*\d+\.[^\n]*\n){3,})",
    re.MULTILINE,
)


def _extract_numbered_menus(text: str) -> list[list[str]]:
    """Return each numbered-menu block as a list of `(num, label)` tuples."""
    menus: list[list[str]] = []
    for match in _MENU_BLOCK_RE.finditer(text):
        block = match.group(1)
        lines = [ln.strip() for ln in block.splitlines() if ln.strip()]
        # Filter to lines starting with `<digit>.`
        numbered = [ln for ln in lines if re.match(r"^\d+\.", ln)]
        if len(numbered) >= 3:
            menus.append(numbered)
    return menus


class TestDiscussBackFinalTwoOptions:
    """Every numbered approval menu added by this PR MUST end with `Discuss`
    then `Back` as the final two numbered options (#767 framework rule)."""

    def _approval_menus_from(self, text: str) -> list[list[str]]:
        """Extract numbered menus that look like approval menus (mention
        ``Approve and continue`` so we don't accidentally lint other numbered
        lists like the chaining gate's preparatory-strategy enumeration)."""
        approval = []
        for menu in _extract_numbered_menus(text):
            joined = " ".join(menu)
            if "Approve and continue" in joined:
                approval.append(menu)
        return approval

    def test_skill_approval_menus_end_with_discuss_back(
        self, interview_skill_text: str
    ) -> None:
        menus = self._approval_menus_from(interview_skill_text)
        assert menus, (
            "interview skill must contain at least one approval menu with "
            "`Approve and continue` (#740)"
        )
        for menu in menus:
            assert len(menu) >= 5, (
                f"approval menu must have at least 5 numbered options "
                f"(includes Discuss + Back); got {len(menu)}: {menu!r}"
            )
            penultimate = menu[-2]
            last = menu[-1]
            assert "Discuss" in penultimate, (
                f"approval menu penultimate option must be `Discuss` "
                f"(#767 framework rule); got {penultimate!r}"
            )
            assert "Back" in last, (
                f"approval menu last option must be `Back` "
                f"(#767 framework rule); got {last!r}"
            )

    def test_strategy_approval_menus_end_with_discuss_back(
        self, interview_strategy_text: str
    ) -> None:
        menus = self._approval_menus_from(interview_strategy_text)
        assert menus, (
            "strategies/interview.md must contain at least one approval menu "
            "with `Approve and continue` (#740)"
        )
        for menu in menus:
            assert len(menu) >= 5
            assert "Discuss" in menu[-2], (
                f"approval menu penultimate option must be `Discuss` (#767); "
                f"got {menu[-2]!r}"
            )
            assert "Back" in menu[-1], (
                f"approval menu last option must be `Back` (#767); "
                f"got {menu[-1]!r}"
            )

    def test_skill_cross_references_767(self, interview_skill_text: str) -> None:
        assert "#767" in interview_skill_text, (
            "interview skill must cross-reference #767 framework rule (#740)"
        )

    def test_strategy_cross_references_767(self, interview_strategy_text: str) -> None:
        assert "#767" in interview_strategy_text, (
            "strategies/interview.md must cross-reference #767 framework rule (#740)"
        )

    def test_ux_doc_canonical_menus_end_with_discuss_back(
        self, ux_doc_text: str
    ) -> None:
        # The reference doc itself ships with two canonical menus (PRD + SPEC).
        menus = []
        for menu in _extract_numbered_menus(ux_doc_text):
            if any("Approve and continue" in line for line in menu):
                menus.append(menu)
        assert len(menus) >= 2, (
            "references/plain-english-ux.md must include at least 2 canonical "
            "approval menus (PRD + SPEC)"
        )
        for menu in menus:
            assert "Discuss" in menu[-2]
            assert "Back" in menu[-1]
