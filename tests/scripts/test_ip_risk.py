"""Unit tests for ``scripts/ip_risk.py`` (#738).

Covers:

1. Detection (positive + negative)
2. Commercial vs personal vs unknown branching
3. Scope-item insertion shape (vBRIEF v0.6 PlanItem)
4. Plain-English risk summary content
5. CLI entry-point exit codes
"""

from __future__ import annotations

import io
import sys
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from ip_risk import (  # noqa: E402  # isort: skip
    IPHit,
    detect_ip_terms,
    ip_risk_scope_items,
    is_ip_adjacent,
    main,
    plain_risk_summary,
)


# ---------------------------------------------------------------------------
# 1. Detection -- positive cases (#738)
# ---------------------------------------------------------------------------


class TestDetectIPTermsPositive:
    """Recognised IP names MUST trigger a detection hit."""

    def test_magic_the_gathering_full_name(self):
        # The #151 playtester case: a Magic: The Gathering deck-builder.
        hits = detect_ip_terms("A Magic: The Gathering deck-builder app")
        assert hits, "Magic: The Gathering must be detected"
        assert any("Magic" in h.term for h in hits)
        assert any(h.category == "branded-game-or-universe" for h in hits)

    def test_pokemon_lowercase(self):
        hits = detect_ip_terms("a pokemon battle simulator")
        assert any(h.term.lower() == "pokemon" for h in hits)

    def test_branded_character(self):
        hits = detect_ip_terms("A site featuring Mickey Mouse and Spider-Man")
        terms = {h.term for h in hits}
        assert any(t.lower() == "mickey mouse" for t in terms)
        assert any(t.lower() in ("spider-man", "spiderman") for t in terms)

    def test_sports_league(self):
        hits = detect_ip_terms("an NFL fantasy app with NBA stats")
        cats = {h.category for h in hits}
        assert "sports-league" in cats

    def test_branded_product(self):
        hits = detect_ip_terms("companion app for the iPhone and Xbox")
        cats = {h.category for h in hits}
        assert "branded-product" in cats

    def test_fictional_universe_term_only(self):
        # No brand name, just a fictional-universe term.
        hits = detect_ip_terms("simulator set on Tatooine with Jedi training")
        cats = {h.category for h in hits}
        assert "fictional-universe-term" in cats

    def test_case_insensitive_match(self):
        hits = detect_ip_terms("WORLD OF WARCRAFT clone")
        assert hits
        assert any(h.term.lower() == "world of warcraft" for h in hits)

    def test_dedupes_repeated_term(self):
        hits = detect_ip_terms("Pokemon Pokemon Pokemon")
        # Only one hit despite three occurrences.
        terms = [h.term.lower() for h in hits if h.category == "branded-game-or-universe"]
        assert terms.count("pokemon") == 1

    def test_returns_iphit_dataclass(self):
        hits = detect_ip_terms("Mario kart clone")
        assert hits
        assert isinstance(hits[0], IPHit)
        assert hits[0].term
        assert hits[0].category in (
            "branded-game-or-universe",
            "branded-character",
            "sports-league",
            "branded-product",
            "music-or-film",
            "fictional-universe-term",
        )


# ---------------------------------------------------------------------------
# 2. Detection -- negative cases (#738)
# ---------------------------------------------------------------------------


class TestDetectIPTermsNegative:
    """Generic / non-IP project descriptions MUST NOT trigger hits."""

    def test_empty_string_safe(self):
        # Empty input must not crash. The type annotation on detect_ip_terms
        # is `text: str`, so callers MUST NOT pass `None`; the empty-string
        # path is the falsy case the helper guards against.
        assert detect_ip_terms("") == []

    def test_generic_todo_app(self):
        assert detect_ip_terms("a generic todo list app") == []

    def test_generic_card_game_no_brand(self):
        # Generic "card game" without a branded universe name.
        assert detect_ip_terms("a deck-building card game with original art") == []

    def test_substring_in_unrelated_word_does_not_match(self):
        # 'magicwand' contains 'magic' but the heuristic uses word boundaries.
        # 'starcraft' contains 'star' but 'Star Wars'/'Star Trek' require the
        # full multi-word phrase, so neither triggers.
        assert detect_ip_terms("a magicwand crafting game called starcraft") == []

    def test_is_ip_adjacent_false_for_generic(self):
        assert is_ip_adjacent("a generic project") is False

    def test_is_ip_adjacent_true_for_branded(self):
        assert is_ip_adjacent("a Star Wars trivia game") is True


# ---------------------------------------------------------------------------
# 3. Commercial vs personal vs unknown branching (#738)
# ---------------------------------------------------------------------------


class TestScopeItemsBranching:
    """ip_risk_scope_items must produce three items shaped for vBRIEF v0.6
    and tighten Acceptance language for commercial intent."""

    def test_returns_three_items(self):
        items = ip_risk_scope_items("personal")
        assert len(items) == 3

    def test_items_have_planitem_shape(self):
        items = ip_risk_scope_items("personal")
        for item in items:
            assert "title" in item
            assert "status" in item
            assert "narrative" in item
            assert isinstance(item["narrative"], dict)
            assert item["status"] == "pending"
            # Every IP item carries traces (IP-1, IP-2, IP-3).
            assert "Traces" in item["narrative"]

    def test_traces_are_ip_numbered(self):
        items = ip_risk_scope_items("personal")
        traces = sorted(item["narrative"]["Traces"] for item in items)
        assert traces == ["IP-1", "IP-2", "IP-3"]

    def test_disclaimer_item_present(self):
        items = ip_risk_scope_items("personal")
        titles = [item["title"].lower() for item in items]
        assert any("disclaimer" in t for t in titles)

    def test_api_only_item_present(self):
        items = ip_risk_scope_items("personal")
        titles = [item["title"].lower() for item in items]
        assert any("api-only" in t and "asset" in t for t in titles)

    def test_hosting_item_present(self):
        items = ip_risk_scope_items("personal")
        titles = [item["title"].lower() for item in items]
        assert any("hosting" in t for t in titles)

    def test_commercial_acceptance_mentions_lawyer(self):
        items = ip_risk_scope_items("commercial")
        joined = " ".join(item["narrative"]["Acceptance"] for item in items)
        assert "lawyer" in joined.lower() or "counsel" in joined.lower(), (
            "commercial-intent acceptance criteria must reference legal review"
        )

    def test_personal_acceptance_does_not_mandate_lawyer(self):
        items = ip_risk_scope_items("personal")
        # Personal intent acceptance must NOT make lawyer review mandatory
        # on the disclaimer item (would over-apply a commercial-only rule).
        joined = " ".join(item["narrative"]["Acceptance"] for item in items)
        assert "lawyer-confirmed wording" not in joined.lower()

    def test_personal_hosting_is_self_hosted(self):
        items = ip_risk_scope_items("personal")
        hosting_item = next(
            item for item in items if "hosting" in item["title"].lower()
        )
        assert "self-hosted" in hosting_item["narrative"]["Acceptance"].lower()

    def test_commercial_hosting_requires_counsel(self):
        items = ip_risk_scope_items("commercial")
        hosting_item = next(
            item for item in items if "hosting" in item["title"].lower()
        )
        assert "counsel" in hosting_item["narrative"]["Acceptance"].lower()

    def test_unknown_intent_emits_items(self):
        # Even with unknown intent we emit the protection items so the spec
        # carries the minimum-protection checklist; the interview will
        # follow up to capture the explicit answer.
        items = ip_risk_scope_items("unknown")
        assert len(items) == 3

    def test_unknown_intent_uses_commercial_level_criteria(self):
        # Wrong-side-of-safe policy (Greptile P1 #775): when intent is
        # ``unknown`` (interview hasn't resolved it yet), the protection
        # scope items MUST carry the stricter commercial-level acceptance
        # criteria so that an unresolved-intent path never produces a spec
        # weaker than the policy mandates.
        items = ip_risk_scope_items("unknown")
        joined = " ".join(item["narrative"]["Acceptance"] for item in items)
        lower = joined.lower()
        # Lawyer / counsel review must appear at least once -- the
        # personal-only acceptance language ("reviewed by the project owner",
        # "self-hosted private use only") is forbidden under unknown intent.
        assert "lawyer" in lower or "counsel" in lower, (
            "unknown-intent acceptance criteria must inherit commercial-level "
            "language (lawyer-confirmed / counsel-reviewed)"
        )
        # Personal-only hosting language must NOT be the only path.
        hosting_item = next(
            item for item in items if "hosting" in item["title"].lower()
        )
        assert "counsel" in hosting_item["narrative"]["Acceptance"].lower(), (
            "unknown-intent hosting acceptance must require counsel review "
            "(commercial-level), not self-hosted-private-use-only"
        )

    def test_invalid_intent_raises(self):
        with pytest.raises(ValueError):
            ip_risk_scope_items("monetized-of-course")


# ---------------------------------------------------------------------------
# 4. Plain-English risk summary (#738)
# ---------------------------------------------------------------------------


class TestPlainRiskSummary:
    def test_empty_hits_returns_empty_string(self):
        assert plain_risk_summary([], "personal") == ""

    def test_summary_is_plain_english_no_legalese(self):
        hits = detect_ip_terms("Magic: The Gathering deck-builder")
        text = plain_risk_summary(hits, "personal")
        assert text
        # Should not contain courtroom-style legalese tokens.
        for forbidden in ("hereby", "tortious", "in perpetuity"):
            assert forbidden not in text.lower(), (
                f"plain summary must not include legalese token {forbidden!r}"
            )

    def test_summary_calls_out_not_legal_advice(self):
        hits = detect_ip_terms("Pokemon companion app")
        text = plain_risk_summary(hits, "personal")
        assert "not legal advice" in text.lower()

    def test_commercial_summary_recommends_lawyer_non_optional(self):
        hits = detect_ip_terms("Pokemon companion app")
        text = plain_risk_summary(hits, "commercial")
        # "MUST consult a lawyer" wording surfaces the non-optional output.
        lower = text.lower()
        assert "lawyer" in lower
        assert "must" in lower
        assert "not optional" in lower

    def test_personal_summary_warns_on_drift(self):
        hits = detect_ip_terms("Pokemon companion app")
        text = plain_risk_summary(hits, "personal")
        lower = text.lower()
        # Personal use is lower risk but not zero -- summary must mention
        # the drift case (going public, monetized, shared widely).
        assert "lower risk" in lower or "not zero" in lower or "lawyer" in lower

    def test_summary_lists_detected_terms(self):
        hits = detect_ip_terms("a Star Wars trivia bot using Pokemon images")
        text = plain_risk_summary(hits, "commercial")
        # Both detected term universes should appear.
        assert "Star Wars" in text or "star wars" in text.lower()
        assert "pokemon" in text.lower()


# ---------------------------------------------------------------------------
# 5. CLI entry point (#738)
# ---------------------------------------------------------------------------


class TestCLI:
    def test_no_args_returns_2(self):
        buf = io.StringIO()
        with redirect_stderr(buf):
            rc = main([])
        assert rc == 2
        assert "Usage" in buf.getvalue()

    def test_no_ip_returns_0(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = main(["a generic todo app"])
        assert rc == 0
        assert "No IP terms detected" in buf.getvalue()

    def test_ip_returns_1(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = main(["a Pokemon companion app", "--intent", "personal"])
        assert rc == 1
        out = buf.getvalue()
        assert "Detected IP terms" in out
        assert "pokemon" in out.lower()

    def test_invalid_intent_returns_2(self):
        out_buf = io.StringIO()
        err_buf = io.StringIO()
        with redirect_stdout(out_buf), redirect_stderr(err_buf):
            rc = main(["a Pokemon app", "--intent", "bogus"])
        assert rc == 2


# ---------------------------------------------------------------------------
# 6. Reference doc cross-checks (#738)
# ---------------------------------------------------------------------------


class TestReferenceDocCrossCheck:
    """The references/ip-risk.md document must exist and reference the
    canonical helpers exposed by this module so the heuristic and the
    written checklist do not drift apart."""

    _IP_RISK_DOC = REPO_ROOT / "references" / "ip-risk.md"

    def test_reference_doc_exists(self):
        assert self._IP_RISK_DOC.is_file(), (
            "references/ip-risk.md must exist (#738)"
        )

    def test_reference_doc_mentions_detect_helper(self):
        text = self._IP_RISK_DOC.read_text(encoding="utf-8")
        assert "detect_ip_terms" in text, (
            "references/ip-risk.md must reference scripts/ip_risk.py:detect_ip_terms"
        )

    def test_reference_doc_lists_minimum_protection_checklist(self):
        text = self._IP_RISK_DOC.read_text(encoding="utf-8")
        lower = text.lower()
        # All three minimum-protection categories must appear.
        assert "disclaimer" in lower
        assert "api" in lower and "asset" in lower
        assert "hosting" in lower
