#!/usr/bin/env python3
"""ip_risk.py -- Permissive heuristic for detecting third-party intellectual
property (IP) references in interview / research text (#738).

The detector is intentionally permissive: it errs on the side of false
positives so that downstream interview steps can ask the user the
monetization-intent question rather than silently letting an IP-adjacent
project sail through PRD / SPECIFICATION generation without legal-risk
flagging.

Usage::

    from ip_risk import detect_ip_terms, ip_risk_scope_items, plain_risk_summary

    hits = detect_ip_terms("A Magic: The Gathering deck-builder app")
    if hits:
        items = ip_risk_scope_items(monetization_intent="commercial")
        summary = plain_risk_summary(hits, monetization_intent="commercial")

The full guidance (heuristic categories, question script, minimum-protection
checklist) lives in ``references/ip-risk.md``. Keep the term lists in this
module synchronised with that document.

Exit codes (CLI mode):

    0 -- no IP terms detected
    1 -- IP terms detected (one term per line on stdout)
    2 -- usage error (no input provided)

This module is *advisory*. It does NOT provide legal advice and MUST NOT be
used as a substitute for lawyer consultation when the project is commercial
and IP-adjacent.
"""

from __future__ import annotations

import re
import sys
from collections.abc import Iterable
from dataclasses import dataclass

# ---------------------------------------------------------------------------
# Heuristic term lists (#738)
# ---------------------------------------------------------------------------
# Curated permissive set keyed by category. All matching is case-insensitive
# and word-boundary based -- substring matches inside a longer word
# ("magicwand", "starcraft") do NOT trigger.
#
# The lists are intentionally short and well-known. The heuristic is meant to
# catch the *most common* IP-adjacent project ideas that come up in interview
# sessions (the #151 playtester case was a Magic: The Gathering deck builder),
# not to be a comprehensive trademark database.

_BRANDED_GAMES_AND_UNIVERSES: tuple[str, ...] = (
    # Tabletop / collectable card games
    "Magic: The Gathering",
    "Magic the Gathering",
    "MTG",
    "Yu-Gi-Oh",
    "Yugioh",
    "Pokemon",
    "Pokémon",
    "Dungeons and Dragons",
    "Dungeons & Dragons",
    "D&D",
    "Warhammer",
    # Video game franchises
    "Mario",
    "Zelda",
    "Final Fantasy",
    "Halo",
    "Call of Duty",
    "Fortnite",
    "Minecraft",
    "Roblox",
    "League of Legends",
    "World of Warcraft",
    "WoW",
    "Overwatch",
    "Counter-Strike",
    "Valorant",
    "Apex Legends",
    # Fictional universes
    "Star Wars",
    "Star Trek",
    "Marvel",
    "DC Comics",
    "Harry Potter",
    "Lord of the Rings",
    "Middle-earth",
    "Game of Thrones",
    "Westeros",
    "Disney",
    "Pixar",
)

_BRANDED_CHARACTERS: tuple[str, ...] = (
    "Mickey Mouse",
    "Spider-Man",
    "Spiderman",
    "Batman",
    "Superman",
    "Wonder Woman",
    "Iron Man",
    "Hulk",
    "Captain America",
    "Pikachu",
    "Sonic the Hedgehog",
    "Luigi",
    "Princess Peach",
    "Kirby",
    "Master Chief",
    "Lara Croft",
    "Indiana Jones",
    "James Bond",
)

_SPORTS_LEAGUES: tuple[str, ...] = (
    "NFL",
    "NBA",
    "MLB",
    "NHL",
    "MLS",
    "FIFA",
    "UEFA",
    "Premier League",
    "La Liga",
    "Bundesliga",
    "Olympics",
    "Olympic Games",
    "Super Bowl",
    "World Cup",
)

_BRANDED_PRODUCTS: tuple[str, ...] = (
    "iPhone",
    "iPad",
    "MacBook",
    "AirPods",
    "PlayStation",
    "Xbox",
    "Nintendo Switch",
    "Coca-Cola",
    "Pepsi",
    "Starbucks",
    "McDonald's",
    "Lego",
    "Barbie",
    "Hot Wheels",
)

_MUSIC_AND_FILM: tuple[str, ...] = (
    "Taylor Swift",
    "Beyonce",
    "Beyoncé",
    # NOTE: "BTS" and "Drake" were removed (Greptile P2 #775) -- both
    # false-positive heavily on common technical / proper-noun uses
    # (BTS = Build-Test-Ship / Behind-The-Scenes / bug-tracking;
    # Drake = the duck, the surname, Drake University, Sir Francis Drake,
    # the Drake equation). Re-add only with a music-specific surrounding
    # context check.
    "Spotify",
    "Netflix",
    "Hulu",
    "HBO",
)

# Generic fictional-universe terms that often signal IP-adjacency even
# without a specific brand name. Conservative list -- single common nouns
# like "wizard" are NOT included to avoid pathological false positives.
_FICTIONAL_UNIVERSE_TERMS: tuple[str, ...] = (
    "Hogwarts",
    "Jedi",
    "Sith",
    "Death Star",
    "Hobbit",
    "Vulcan",
    "Klingon",
    "Mandalorian",
    "Force-sensitive",
    "Muggle",
    "Quidditch",
    "Tatooine",
)

_CATEGORIES: dict[str, tuple[str, ...]] = {
    "branded-game-or-universe": _BRANDED_GAMES_AND_UNIVERSES,
    "branded-character": _BRANDED_CHARACTERS,
    "sports-league": _SPORTS_LEAGUES,
    "branded-product": _BRANDED_PRODUCTS,
    "music-or-film": _MUSIC_AND_FILM,
    "fictional-universe-term": _FICTIONAL_UNIVERSE_TERMS,
}


@dataclass(frozen=True)
class IPHit:
    """A single IP-term detection hit."""

    term: str
    category: str

    def __str__(self) -> str:  # pragma: no cover - trivial
        return f"{self.term} ({self.category})"


# Pre-compile a regex per category for fast scanning. Each term is escaped
# and wrapped in word boundaries so substring matches inside a longer word
# do not trigger ("magicwand" should NOT match "Magic").
def _compile_category(terms: Iterable[str]) -> re.Pattern[str]:
    # Use a non-word-char lookaround that also tolerates leading/trailing
    # punctuation common in titles (e.g. "Magic: The Gathering" appearing
    # mid-sentence). Word boundaries (\b) work for ASCII; we accept the
    # ASCII-only behavior for the heuristic.
    escaped = [re.escape(term) for term in terms]
    pattern = r"(?i)(?<!\w)(?:" + "|".join(escaped) + r")(?!\w)"
    return re.compile(pattern)


_CATEGORY_PATTERNS: dict[str, re.Pattern[str]] = {
    category: _compile_category(terms) for category, terms in _CATEGORIES.items()
}


def detect_ip_terms(text: str) -> list[IPHit]:
    """Scan *text* for known IP terms; return a deduplicated list of hits.

    The scan is permissive (case-insensitive, word-boundary based) and
    intentionally err on the side of false positives. An empty list means
    "no known IP terms detected" -- it does NOT mean "this project is
    free of IP risk", since the heuristic only knows about the curated
    term lists above.

    Hits are deduplicated by ``(term, category)`` pair preserving first
    appearance order. The original surface form from *text* is preserved
    (e.g. ``"magic the gathering"`` keeps its lowercase form even though
    the canonical term is ``"Magic the Gathering"``).
    """
    if not text:
        return []
    seen: set[tuple[str, str]] = set()
    hits: list[IPHit] = []
    for category, pattern in _CATEGORY_PATTERNS.items():
        for match in pattern.finditer(text):
            term = match.group(0)
            key = (term.lower(), category)
            if key in seen:
                continue
            seen.add(key)
            hits.append(IPHit(term=term, category=category))
    return hits


def is_ip_adjacent(text: str) -> bool:
    """Return True iff *text* contains at least one detected IP term."""
    return bool(detect_ip_terms(text))


# ---------------------------------------------------------------------------
# Monetization-intent branching + scope-item generation (#738)
# ---------------------------------------------------------------------------

_VALID_INTENTS: frozenset[str] = frozenset({"personal", "commercial", "unknown"})


def _validate_intent(intent: str) -> str:
    """Normalise and validate a monetization-intent value.

    Accepts ``"personal"``, ``"commercial"``, or ``"unknown"`` (case-
    insensitive). Anything else raises ``ValueError`` -- the interview
    flow MUST capture an explicit answer when IP is detected, so an
    unrecognised intent here indicates a programming error in the caller.
    """
    if not isinstance(intent, str):
        raise ValueError(f"monetization_intent must be a string, got {type(intent)!r}")
    normalized = intent.strip().lower()
    if normalized not in _VALID_INTENTS:
        raise ValueError(
            f"monetization_intent {intent!r} not in {sorted(_VALID_INTENTS)}"
        )
    return normalized


def ip_risk_scope_items(monetization_intent: str) -> list[dict[str, str]]:
    """Return the canonical IP-risk protection scope items for SPECIFICATION
    injection.

    The minimum-protection checklist (see ``references/ip-risk.md``) lands
    three scope items in the spec:

    - **Disclaimer stub** -- a "not affiliated with / not endorsed by"
      front-of-app notice the implementation phase fills in once the
      specific IP holder is named.
    - **API-only-asset-access policy** -- never bundle assets (images,
      audio, video, text) from the third-party IP; access only via
      official APIs that grant a license to use them, and gate that
      access behind the user's own credentials.
    - **Hosting policy** -- self-hosted private use only, OR commercial
      hosting only after legal review confirms the licensing terms allow
      it.

    All three items are emitted regardless of monetization intent because
    even personal IP-adjacent projects can leak into commercial use over
    time. The ``Acceptance`` narrative on each item is tightened to the
    commercial-level checklist (lawyer-confirmed terms, written license,
    etc.) for **any intent other than ``"personal"``** -- the
    wrong-side-of-safe policy means that ``"unknown"`` (interview hasn't
    captured an explicit answer yet) inherits the stricter commercial
    checklist. Only the explicit ``"personal"`` answer relaxes the
    acceptance language.

    The returned items are plain dicts compatible with
    ``vBRIEF v0.6 PlanItem`` shape (``title``, ``status``, ``narrative``).
    Callers append them to ``plan.items`` on the
    ``specification.vbrief.json`` draft so they flow naturally into the
    rendered SPECIFICATION.md via the existing ``scripts/spec_render.py``
    pipeline -- no spec_render.py modification is required.
    """
    intent = _validate_intent(monetization_intent)
    # Wrong-side-of-safe policy (Greptile P1 #775): treat anything other than
    # the explicit `personal` answer as commercial-level. `unknown` (the
    # interview is still asking the question) MUST inherit the stricter
    # checklist so the spec carries lawyer-confirmed acceptance criteria
    # by default. The interview MUST still resolve `unknown` -> `personal` /
    # `commercial` before the confirmation gate; this is just the safe
    # fallback for the scope-item shape if the call lands first.
    commercial = intent != "personal"

    base_acceptance = (
        "Lawyer-confirmed wording before public release"
        if commercial
        else "Reviewed by the project owner before any public release"
    )
    asset_acceptance = (
        "All third-party assets reach the app via official APIs only with a "
        "license that explicitly permits the planned use; no assets bundled "
        "in the repository or build artifacts; lawyer-confirmed before public "
        "release"
        if commercial
        else "All third-party assets reach the app via official APIs only; "
        "no assets bundled in the repository or build artifacts"
    )
    hosting_acceptance = (
        "Hosting plan reviewed by counsel; written license terms cover the "
        "deployment region and audience; revenue model documented"
        if commercial
        else "Self-hosted private use only; do not deploy publicly until a "
        "monetization decision is made and re-reviewed against this rule"
    )

    return [
        {
            "title": "IP-risk: disclaimer stub on the app's front surface",
            "status": "pending",
            "narrative": {
                "Description": (
                    "Add a 'not affiliated with / not endorsed by' notice on "
                    "the app's first user-visible surface (splash screen, "
                    "landing page, or CLI banner)."
                ),
                "Acceptance": base_acceptance,
                "Traces": "IP-1",
            },
        },
        {
            "title": "IP-risk: API-only third-party asset access policy",
            "status": "pending",
            "narrative": {
                "Description": (
                    "Never bundle third-party IP assets (images, audio, "
                    "video, text, card data, character likenesses) in the "
                    "repository or build artifacts. Access only via official "
                    "APIs that grant a license."
                ),
                "Acceptance": asset_acceptance,
                "Traces": "IP-2",
            },
        },
        {
            "title": "IP-risk: hosting policy gated on monetization intent",
            "status": "pending",
            "narrative": {
                "Description": (
                    "Document the hosting plan and gate it on the captured "
                    "monetization intent. Self-hosted private use is the "
                    "default; commercial hosting requires lawyer review."
                ),
                "Acceptance": hosting_acceptance,
                "Traces": "IP-3",
            },
        },
    ]


def plain_risk_summary(
    hits: list[IPHit],
    monetization_intent: str,
) -> str:
    """Build a plain-English risk summary suitable for interview output.

    The summary is intentionally non-alarming and non-legal-advice: it
    states what was detected, what the implication is at a high level,
    and (for commercial intent) it carries a non-optional recommendation
    to consult a lawyer. The summary is meant to be copied verbatim into
    the interview output and into the ``IPRisk`` narrative on the
    specification vBRIEF.

    Returns an empty string when *hits* is empty (no IP detected); the
    caller MUST NOT inject the summary in that case.

    .. warning::

        ``monetization_intent="unknown"`` produces a **transitional**
        re-ask prompt -- a status message saying "the interview MUST
        capture an explicit answer". It is NOT a terminal output and
        does NOT carry the lawyer recommendation that
        :func:`ip_risk_scope_items` injects under the wrong-side-of-safe
        policy. Callers MUST loop back to the monetization-intent
        question and re-call this function with ``personal`` or
        ``commercial`` before treating the summary as final output --
        otherwise the interview surface (no lawyer rec) and the
        injected spec items (commercial-level acceptance language)
        will mismatch (#775 P2).
    """
    if not hits:
        return ""
    intent = _validate_intent(monetization_intent)

    grouped: dict[str, list[str]] = {}
    for hit in hits:
        grouped.setdefault(hit.category, []).append(hit.term)

    bullets: list[str] = []
    for category, terms in grouped.items():
        unique_terms = sorted(set(terms), key=str.lower)
        bullets.append(f"- {category}: {', '.join(unique_terms)}")

    header = (
        "Heads up: your project description references third-party "
        "intellectual property (IP). This is a plain-English summary -- "
        "not legal advice."
    )
    detection_block = "Detected IP-adjacent terms:\n" + "\n".join(bullets)

    if intent == "commercial":
        intent_block = (
            "You said you intend to use this commercially (sell access, "
            "earn revenue, distribute to paying users, or run ads). "
            "Commercial use of someone else's IP without a written license "
            "is the high-risk case. You MUST consult a lawyer before "
            "shipping to paying users -- this is not optional output from "
            "this interview."
        )
    elif intent == "personal":
        intent_block = (
            "You said this is a personal project (no monetization, private "
            "use, learning). Personal use is lower risk but not zero risk: "
            "if your project ever goes public, becomes monetized, or is "
            "shared widely, the risk profile changes and a lawyer review "
            "becomes worthwhile."
        )
    else:  # unknown
        intent_block = (
            "You did not choose between personal and commercial use. The "
            "interview MUST capture an explicit answer before generating "
            "the SPECIFICATION -- the legal-risk profile depends on the "
            "answer."
        )

    next_steps = (
        "Suggested next steps: (1) confirm whether your use is personal "
        "or commercial; (2) keep the disclaimer / API-only-asset / "
        "hosting scope items the SPECIFICATION will include; "
        "(3) for commercial intent, consult a lawyer before public "
        "release."
    )

    return "\n\n".join([header, detection_block, intent_block, next_steps])


# ---------------------------------------------------------------------------
# CLI entry point (for ad-hoc use; the canonical caller is the interview
# skill which invokes the helpers directly).
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if not args:
        print(
            "Usage: ip_risk.py <text-to-scan> [--intent personal|commercial|unknown]",
            file=sys.stderr,
        )
        return 2

    intent = "unknown"
    text_parts: list[str] = []
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--intent" and i + 1 < len(args):
            intent = args[i + 1]
            i += 2
            continue
        text_parts.append(arg)
        i += 1
    text = " ".join(text_parts)
    if not text:
        print("Usage: ip_risk.py <text-to-scan>", file=sys.stderr)
        return 2

    hits = detect_ip_terms(text)
    if not hits:
        print("No IP terms detected.")
        return 0

    print("Detected IP terms:")
    for hit in hits:
        print(f"  - {hit}")
    try:
        summary = plain_risk_summary(hits, intent)
    except ValueError as exc:
        print(f"Invalid --intent value: {exc}", file=sys.stderr)
        return 2
    print()
    print(summary)
    return 1


if __name__ == "__main__":  # pragma: no cover - CLI entry
    sys.exit(main())
