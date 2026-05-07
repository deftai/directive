"""Content tests for AGENTS.md #954 additions.

Pins the four new MUST rules, the meta-rule, and the ghx-write-fallback
correction so a future edit that silently drops one of them fails CI.

Per the Rule Authority [AXIOM] in main.md, content tests on rule prose are
the lightest enforceable layer below deterministic gates. The full preamble
content lives in templates/agent-prompt-preamble.md (covered by the sibling
test_agent_prompt_preamble_template.py); this file only asserts the AGENTS.md
summary surface.
"""

from __future__ import annotations

import pathlib
import re

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
AGENTS_MD = REPO_ROOT / "AGENTS.md"


@pytest.fixture(scope="module")
def agents_md_text() -> str:
    return AGENTS_MD.read_text(encoding="utf-8")


def test_agents_md_exists() -> None:
    assert AGENTS_MD.is_file(), f"AGENTS.md must exist at {AGENTS_MD}"


def test_954_section_heading_present(agents_md_text: str) -> None:
    """The #954 additions land under their own heading; do not bury under #884."""
    assert re.search(
        r"^##\s+Multi-agent orchestration discipline\s+\(#954\)\s*$",
        agents_md_text,
        re.MULTILINE,
    ), "missing '## Multi-agent orchestration discipline (#954)' heading"


def test_rest_by_default_rule_present(agents_md_text: str) -> None:
    """REST-by-default for read-only gh is a MUST rule citing the forbidden surfaces."""
    assert "prefer REST surfaces over GraphQL" in agents_md_text
    for forbidden in (
        "gh issue view --json",
        "gh pr view --json",
        "gh pr ready",
        "gh pr update-branch",
    ):
        assert forbidden in agents_md_text, f"#954 rule must cite forbidden surface: {forbidden}"


def test_no_draft_retoggle_rule_present(agents_md_text: str) -> None:
    """At most one Draft<->Ready toggle per review cycle."""
    assert re.search(
        r"toggle PR Draft.*Ready state at most once",
        agents_md_text,
    ), "#954 must include the no-Draft-retoggle MUST rule"


def test_rate_limit_throttle_rule_present(agents_md_text: str) -> None:
    """Probe ghx api rate_limit; switch to REST when graphql.remaining < 500."""
    assert "ghx api rate_limit" in agents_md_text or "gh api rate_limit" in agents_md_text
    assert "graphql.remaining" in agents_md_text or "graphql_remaining" in agents_md_text


def test_dispatcher_lifecycle_hygiene_rule_present(agents_md_text: str) -> None:
    """Workers are all-or-nothing on dispatch envelope.

    Mid-scope approval gates must split into two dispatches.
    """
    assert "Dispatcher-level lifecycle hygiene" in agents_md_text
    assert "all-or-nothing" in agents_md_text
    assert (
        "two separate dispatches" in agents_md_text
        or "two-dispatch" in agents_md_text
    )


def test_meta_rule_points_at_template(agents_md_text: str) -> None:
    """Orchestrators MUST include the canonical preamble.

    Rule must reference templates/agent-prompt-preamble.md.
    """
    assert "templates/agent-prompt-preamble.md" in agents_md_text
    assert re.search(
        r"Orchestrators dispatching implementation sub-agents MUST include the canonical preamble",
        agents_md_text,
    ), "#954 must include the meta-rule referencing the canonical preamble template"


def test_ghx_writes_correction_present(agents_md_text: str) -> None:
    """ghx is a cached read-only GET proxy; writes must fall through to gh."""
    assert "cached read-only GET proxy" in agents_md_text
    assert (
        "single positional" in agents_md_text
        or "single arg" in agents_md_text
        or "accepts 1 arg" in agents_md_text
    )
    assert re.search(
        r"[Ww]rites?\s+\(POST/PATCH/PUT/DELETE.*\)?\s+(MUST|must)\s+fall through to\s+`?gh`?",
        agents_md_text,
    ), "#954 must include the ghx-write-fallback correction"


def test_rules_use_required_must_marker(agents_md_text: str) -> None:
    """Each new rule line in the #954 section uses the canonical `! ` MUST marker."""
    section_match = re.search(
        r"^##\s+Multi-agent orchestration discipline\s+\(#954\).*?(?=^##\s|\Z)",
        agents_md_text,
        re.MULTILINE | re.DOTALL,
    )
    assert section_match, "#954 section not isolatable"
    section_text = section_match.group(0)
    must_lines = re.findall(r"^- !\s+", section_text, re.MULTILINE)
    assert len(must_lines) >= 5, (
        f"#954 section must contain at least 5 MUST rules (REST-default, "
        f"no-Draft-retoggle, rate-limit-throttle, dispatcher-lifecycle-hygiene, meta-rule); "
        f"found {len(must_lines)}"
    )
