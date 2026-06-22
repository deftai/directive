"""Content tests for the ``## Allocation context`` schema (#1378 Story A).

Story A freezes the canonical ``## Allocation context`` dispatch-envelope
schema in ``templates/agent-prompt-preamble.md`` so downstream stories build
against a stable contract: Story B (skill recognition of the consent token)
and Story C (the deterministic Story Start Gate) both read the five fields and
the recognition contract pinned here. These tests are the frozen-schema guard
-- a future edit that renames a field, drops the recognition contract, or
deletes the worked example MUST fail CI.

The sibling ``test_agent_prompt_preamble_template.py`` pins the rest of the
preamble; this file owns only the #1378 allocation-context section.
"""

from __future__ import annotations

import pathlib
import re

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
TEMPLATE = REPO_ROOT / "content/templates/agent-prompt-preamble.md"

# The five canonical fields, in their frozen order. Story B / Story C read
# these names verbatim; renaming one here is a breaking change to the cohort.
FROZEN_FIELDS = (
    "dispatch_kind",
    "allocation_plan_id",
    "batching_rationale",
    "cohort_vbriefs",
    "operator_approval_evidence",
)


@pytest.fixture(scope="module")
def template_text() -> str:
    return TEMPLATE.read_text(encoding="utf-8")


def _allocation_section(text: str) -> str:
    """Return only the body of the ``## Allocation context`` section.

    Scopes position-sensitive probes to the text between the
    ``## ... Allocation context`` heading and the next top-level ``## ``
    heading, so field-name positions are not skewed by an earlier preamble
    section that happens to mention a field name.
    """
    match = re.search(r"^##\s+.*Allocation context.*$", text, re.MULTILINE)
    assert match, "allocation-context section heading not found"
    start = match.end()
    nxt = re.search(r"^##\s+", text[start:], re.MULTILINE)
    end = start + nxt.start() if nxt else len(text)
    return text[start:end]


def test_template_exists() -> None:
    assert TEMPLATE.is_file(), (
        f"templates/agent-prompt-preamble.md must exist at {TEMPLATE}"
    )


def test_allocation_context_heading_present(template_text: str) -> None:
    """A markdown heading naming the allocation-context section must exist."""
    assert re.search(r"^##\s+.*Allocation context", template_text, re.MULTILINE), (
        "preamble must carry a `## ... Allocation context` section heading"
    )


def test_section_references_1378(template_text: str) -> None:
    """The section self-identifies as #1378 scope for traceability."""
    assert "#1378" in template_text


@pytest.mark.parametrize("field", FROZEN_FIELDS)
def test_all_five_fields_documented(template_text: str, field: str) -> None:
    """Each of the five frozen field names must appear in the template."""
    assert field in template_text, (
        f"allocation-context schema missing required field: {field!r}"
    )


def test_fields_documented_in_frozen_order(template_text: str) -> None:
    """The five fields must be documented in the frozen contract order.

    Story B / Story C depend on this ordering being stable; a reorder is a
    breaking schema change and must fail CI. The search is scoped to the
    allocation-context section so a field name appearing in an earlier
    preamble section cannot skew the recorded positions.
    """
    section = _allocation_section(template_text)
    positions = [section.index(field) for field in FROZEN_FIELDS]
    assert positions == sorted(positions), (
        "allocation-context fields must be documented in the frozen order: "
        f"{FROZEN_FIELDS}"
    )


def test_dispatch_kind_enumerates_both_values(template_text: str) -> None:
    """dispatch_kind documents both the solo and swarm-cohort values."""
    assert "solo" in template_text
    assert "swarm-cohort" in template_text


def test_recognition_contract_sentence_present(template_text: str) -> None:
    """The recognition-contract sentence pins the consent-token semantics.

    A ``swarm-cohort`` dispatch with a NON-NULL allocation_plan_id AND a
    NON-NULL batching_rationale satisfies the Story Start Gate consent token
    (the #1371 carve-out). This is the exact sentence Story C's gate keys off.
    """
    assert "Recognition contract" in template_text
    assert "NON-NULL" in template_text
    assert "#1371" in template_text
    assert re.search(
        r"dispatch_kind:\s*swarm-cohort.*NON-NULL.*allocation_plan_id.*"
        r"batching_rationale",
        template_text,
        re.IGNORECASE | re.DOTALL,
    ), "recognition-contract sentence must tie swarm-cohort + non-null fields to the consent token"
    assert "consent-token" in template_text or "consent token" in template_text


def test_absent_section_falls_back_to_1371_prose(template_text: str) -> None:
    """When the section is ABSENT, fall back to the #1371 prose carve-out."""
    assert "ABSENT" in template_text
    assert re.search(
        r"ABSENT.*fall back to the #1371 prose carve-out",
        template_text,
        re.IGNORECASE | re.DOTALL,
    ), "absent-section fallback to the #1371 prose carve-out must be documented"


def test_worked_example_present(template_text: str) -> None:
    """A populated swarm-cohort worked example must be present.

    The example shows every field populated with realistic values so an
    orchestrator copying the section into a dispatch envelope has a template.
    """
    assert "Worked example" in template_text
    # The example block embeds a literal `## Allocation context` data block.
    assert "## Allocation context" in template_text
    assert "dispatch_kind: swarm-cohort" in template_text
    # Every field appears in the worked example as a populated bullet.
    assert "- allocation_plan_id: orchestrator-run-" in template_text
    assert "- batching_rationale: " in template_text
    assert "- cohort_vbriefs: [" in template_text
    assert "- operator_approval_evidence: " in template_text


def test_worked_example_lists_full_cohort(template_text: str) -> None:
    """The swarm-cohort example lists more than one vBRIEF in cohort_vbriefs."""
    match = re.search(r"- cohort_vbriefs: \[(.+?)\]", template_text, re.DOTALL)
    assert match, "worked example must include a cohort_vbriefs list"
    entries = [e for e in match.group(1).split(",") if ".vbrief.json" in e]
    assert len(entries) >= 2, (
        "a swarm-cohort worked example must list the full cohort (>= 2 vBRIEFs)"
    )
