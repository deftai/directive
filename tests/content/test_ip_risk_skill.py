"""Content tests for the IP risk surface (#738).

Covers:

1. ``skills/deft-directive-interview/SKILL.md`` carries an IP Risk Probe section
2. ``strategies/research.md`` carries an IPRisk narrative section
3. ``references/ip-risk.md`` exists and references the canonical helpers
4. The minimum-protection checklist (disclaimer / API-only-asset / hosting)
   is named in both the skill and the reference doc
"""

from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_INTERVIEW_SKILL = _REPO_ROOT / "skills" / "deft-directive-interview" / "SKILL.md"
_RESEARCH_STRATEGY = _REPO_ROOT / "strategies" / "research.md"
_IP_RISK_DOC = _REPO_ROOT / "references" / "ip-risk.md"


@pytest.fixture(scope="module")
def interview_text() -> str:
    return _INTERVIEW_SKILL.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def research_text() -> str:
    return _RESEARCH_STRATEGY.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def ip_risk_text() -> str:
    return _IP_RISK_DOC.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# 1. Interview skill IP Risk Probe section
# ---------------------------------------------------------------------------


class TestInterviewSkillIPRisk:
    def test_ip_risk_probe_section_present(self, interview_text: str) -> None:
        assert "IP Risk Probe" in interview_text or "IP risk probe" in interview_text.lower(), (
            "skills/deft-directive-interview/SKILL.md must carry an IP Risk Probe section (#738)"
        )

    def test_references_ip_risk_doc(self, interview_text: str) -> None:
        assert "references/ip-risk.md" in interview_text, (
            "interview skill must link to references/ip-risk.md (#738)"
        )

    def test_references_detect_ip_terms(self, interview_text: str) -> None:
        assert "detect_ip_terms" in interview_text, (
            "interview skill must reference scripts/ip_risk.py:detect_ip_terms (#738)"
        )

    def test_monetization_intent_question_called_out(self, interview_text: str) -> None:
        lower = interview_text.lower()
        assert "monetization-intent" in lower or "monetization intent" in lower, (
            "interview skill must call out the monetization-intent question (#738)"
        )

    def test_personal_vs_commercial_branching(self, interview_text: str) -> None:
        lower = interview_text.lower()
        assert "personal" in lower and "commercial" in lower, (
            "interview skill must reference both personal and commercial branches (#738)"
        )

    def test_lawyer_consultation_non_optional(self, interview_text: str) -> None:
        lower = interview_text.lower()
        assert "lawyer" in lower, (
            "interview skill must surface the lawyer-consultation recommendation (#738)"
        )
        assert "non-optional" in lower or "not optional" in lower, (
            "interview skill must state lawyer recommendation is non-optional for "
            "commercial intent (#738)"
        )

    def test_scope_items_referenced(self, interview_text: str) -> None:
        assert "ip_risk_scope_items" in interview_text, (
            "interview skill must reference scripts/ip_risk.py:ip_risk_scope_items (#738)"
        )

    def test_minimum_protection_checklist_named(self, interview_text: str) -> None:
        lower = interview_text.lower()
        # All three protection items must be named.
        assert "disclaimer" in lower
        assert ("api" in lower) and ("asset" in lower)
        assert "hosting" in lower


# ---------------------------------------------------------------------------
# 2. Research strategy IPRisk narrative
# ---------------------------------------------------------------------------


class TestResearchStrategyIPRisk:
    def test_iprisk_narrative_section_present(self, research_text: str) -> None:
        assert "IPRisk" in research_text, (
            "strategies/research.md must include an IPRisk narrative section (#738)"
        )

    def test_references_ip_risk_doc(self, research_text: str) -> None:
        assert "references/ip-risk.md" in research_text, (
            "strategies/research.md must link to references/ip-risk.md (#738)"
        )

    def test_references_detect_ip_terms(self, research_text: str) -> None:
        assert "detect_ip_terms" in research_text, (
            "strategies/research.md must reference scripts/ip_risk.py:detect_ip_terms (#738)"
        )

    def test_monetization_intent_question_called_out(self, research_text: str) -> None:
        lower = research_text.lower()
        assert "monetization-intent" in lower or "monetization intent" in lower, (
            "strategies/research.md must call out the monetization-intent question (#738)"
        )

    def test_lawyer_consultation_non_optional_for_commercial(self, research_text: str) -> None:
        lower = research_text.lower()
        assert "lawyer" in lower
        assert "non-optional" in lower or "not optional" in lower


# ---------------------------------------------------------------------------
# 3. references/ip-risk.md exists and is well-formed
# ---------------------------------------------------------------------------


class TestIPRiskReferenceDoc:
    def test_file_exists(self) -> None:
        assert _IP_RISK_DOC.is_file(), "references/ip-risk.md must exist (#738)"

    def test_has_heuristic_section(self, ip_risk_text: str) -> None:
        assert "Heuristic" in ip_risk_text or "heuristic" in ip_risk_text

    def test_has_question_script_section(self, ip_risk_text: str) -> None:
        assert "Question Script" in ip_risk_text or "question script" in ip_risk_text.lower()

    def test_has_minimum_protection_checklist_section(self, ip_risk_text: str) -> None:
        assert "Minimum-Protection" in ip_risk_text or "minimum-protection" in ip_risk_text.lower()

    def test_lists_three_protection_items(self, ip_risk_text: str) -> None:
        # The disclaimer / API-only-asset / hosting trio MUST be named.
        lower = ip_risk_text.lower()
        assert "disclaimer" in lower
        assert "api-only" in lower or ("api" in lower and "asset" in lower)
        assert "hosting" in lower

    def test_references_canonical_helpers(self, ip_risk_text: str) -> None:
        assert "detect_ip_terms" in ip_risk_text
        assert "ip_risk_scope_items" in ip_risk_text
        assert "plain_risk_summary" in ip_risk_text

    def test_explicitly_disclaims_legal_advice(self, ip_risk_text: str) -> None:
        lower = ip_risk_text.lower()
        assert "not legal advice" in lower or "not a law firm" in lower
