"""Content tests for templates/agent-prompt-preamble.md (#954).

Asserts the canonical orchestrator preamble template exists, is non-empty,
and contains all named sections. The AGENTS.md summary is covered by the
sibling test_agents_md_preamble.py; this file pins the heavy template content.
"""

from __future__ import annotations

import pathlib
import re

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
TEMPLATE = REPO_ROOT / "templates" / "agent-prompt-preamble.md"

REQUIRED_SECTION_HEADINGS = (
    "Read AGENTS.md before any other tool call",
    "#810 vBRIEF Implementation Intent Gate",
    "PowerShell 5.1 non-ASCII rule",
    "pre-pr and review-cycle skills",
    "REST-by-default for read-only gh calls",
    "No Draft re-toggling within a single review cycle",
    "Rate-limit-aware throttle",
    "Sub-agent spawn rules",
    "Dispatcher lifecycle hygiene",
    "Mandatory DONE message even on early exit",
)


@pytest.fixture(scope="module")
def template_text() -> str:
    return TEMPLATE.read_text(encoding="utf-8")


def test_template_exists() -> None:
    assert TEMPLATE.is_file(), f"templates/agent-prompt-preamble.md must exist at {TEMPLATE}"


def test_template_non_empty(template_text: str) -> None:
    """A future refactor that empties the template (e.g. silent rename) MUST fail CI."""
    assert len(template_text) > 0
    assert len(template_text.splitlines()) >= 100, (
        f"template should be >= 100 lines; got {len(template_text.splitlines())}"
    )


@pytest.mark.parametrize("heading_fragment", REQUIRED_SECTION_HEADINGS)
def test_template_contains_section(template_text: str, heading_fragment: str) -> None:
    """Each named section heading must appear at least once in the template."""
    assert heading_fragment in template_text, (
        f"templates/agent-prompt-preamble.md missing required section: {heading_fragment!r}"
    )


def test_template_references_954(template_text: str) -> None:
    """The template self-identifies as #954 scope so future readers can trace ownership."""
    assert "#954" in template_text


def test_template_cross_references_810_gate(template_text: str) -> None:
    """The vBRIEF gate section references the canonical task surface."""
    assert "task vbrief:preflight" in template_text
    assert "task vbrief:activate" in template_text
    assert "task scope:promote" in template_text


def test_template_cross_references_798_encoding_rule(template_text: str) -> None:
    """The PowerShell 5.1 section references the recurrence record."""
    assert "#798" in template_text or "#236" in template_text
    assert re.search(r"pathlib", template_text), "must reference pathlib as the safe-edit primitive"


def test_template_cross_references_727_subagent_rule(template_text: str) -> None:
    """The sub-agent section references the canonical role-separation issue."""
    assert "#727" in template_text


def test_template_lists_forbidden_graphql_surfaces(template_text: str) -> None:
    """The REST-by-default section enumerates the forbidden GraphQL paths.

    The template uses placeholder argument forms (e.g. `gh issue view <N> --json ...`)
    so the assertions match the command + flag pair via regex tolerant of
    interspersed argument placeholders.
    """
    forbidden_patterns = (
        (r"gh\s+issue\s+view\b.*--json", "gh issue view ... --json"),
        (r"gh\s+pr\s+view\b.*--json", "gh pr view ... --json"),
        (r"gh\s+pr\s+ready\b", "gh pr ready"),
        (r"gh\s+pr\s+update-branch\b", "gh pr update-branch"),
    )
    for pattern, label in forbidden_patterns:
        assert re.search(pattern, template_text), (
            f"template must cite forbidden GraphQL surface: {label}"
        )


def test_template_dispatcher_hygiene_includes_anti_pattern_and_correct(template_text: str) -> None:
    """The lifecycle-hygiene section walks both the wrong and the correct pattern."""
    assert "WRONG" in template_text
    assert "CORRECT" in template_text
    assert "succeeded" in template_text  # must mention the terminal lifecycle state
    assert "agent_id" in template_text  # must mention reachability surface


def test_template_done_message_protocol_present(template_text: str) -> None:
    """The DONE-message section enumerates the four canonical exit shapes."""
    for exit_marker in ("DONE:", "BLOCKED:", "FAILED:", "STOOD-DOWN:"):
        assert exit_marker in template_text, (
            f"DONE-message protocol must include exit marker: {exit_marker}"
        )


def test_template_rate_limit_probe_uses_gh_not_ghx_with_q_flag(template_text: str) -> None:
    """Section 7's rate-limit probe MUST use `gh api ... -q` not `ghx api ... -q`.

    AGENTS.md `## Multi-agent orchestration discipline (#954)` ghx surface
    clarification documents that `ghx api` accepts a single positional path
    arg only and multi-arg forms (e.g. `-q` + jq expression) fail with
    `accepts 1 arg(s), received N`. The probe example in this template MUST
    therefore use `gh api` so a worker copying the preamble verbatim into a
    dispatch envelope and executing the probe gets structured JSON, not a
    runtime error that bypasses the rate-limit guard. Greptile review on
    PR #966 (P1).
    """
    assert re.search(r"gh\s+api\s+rate_limit\s+-q\s+'", template_text), (
        "template Section 7 must use `gh api rate_limit -q '...'` (not `ghx api`)"
    )
    assert not re.search(r"ghx\s+api\s+rate_limit\s+-q\b", template_text), (
        "template MUST NOT use `ghx api rate_limit -q` -- ghx accepts only a "
        "single positional path arg per AGENTS.md ghx surface clarification"
    )


def test_template_section_5_qualifies_mutation_graphql_freedom(template_text: str) -> None:
    """Section 5 mutation claim must qualify to REST endpoints, not blanket.

    `gh api -X POST /graphql ...` IS still a GraphQL mutation and consumes
    GraphQL budget; the prior phrasing "Mutations are inherently GraphQL-free"
    overstated and could mislead a worker into bypassing the throttle.
    Greptile review on PR #966 (P2 with concrete suggestion).
    """
    assert "Mutations to REST endpoints" in template_text
    assert "do not consume GraphQL budget" in template_text
    assert "`/graphql` endpoint" in template_text or "/graphql" in template_text
    # Negative: the unqualified blanket form must not survive
    assert "are inherently GraphQL-free" not in template_text, (
        "unqualified blanket claim about mutation GraphQL-freedom must be "
        "qualified to REST endpoints (Greptile PR #966 review)"
    )


def test_template_footer_concrete_vbrief_path(template_text: str) -> None:
    """Footer must cite the concrete vbrief/active/ path, not a glob wildcard.

    Greptile review on PR #966 flagged the prior `vbrief/.../954-...` form
    as a broken-reference-after-lifecycle-move hazard. The replacement
    cites the concrete active/ path and notes the move-to-completed/ on
    merge so a future reader can find the file at either lifecycle stage.
    """
    assert (
        "vbrief/active/2026-05-07-954-orchestrator-agents-md-preamble-template.vbrief.json"
        in template_text
    )
    assert "vbrief/completed/" in template_text
    # Negative: the glob form must not survive
    assert "vbrief/.../954-orchestrator-agents-md-preamble-template" not in template_text
