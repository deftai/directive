"""tests/content/test_upgrading_sections.py -- UPGRADING.md per-section header (#768).

Asserts every `## From <prev> -> <new>` section in `UPGRADING.md`
carries the four-field micro-format header (`Applies when` /
`Safe to auto-run` / `Restart required` / `Commands`). CI fails on
regression so future upgrade-section authors cannot land a section
without the canonical header.

Story: #768 (universal-upgrade-gate)
"""

from __future__ import annotations

import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_UPGRADING = _REPO_ROOT / "UPGRADING.md"

_REQUIRED_FIELDS = (
    "Applies when",
    "Safe to auto-run",
    "Restart required",
    "Commands",
)

# Match either ASCII `->` or Unicode arrow `→` so the heading style stays
# flexible while the four-field contract is enforced.
_SECTION_HEADING_RE = re.compile(
    r"^## From .+? (?:->|→) .+?$",
    re.MULTILINE,
)


def _split_sections(text: str) -> list[tuple[str, str]]:
    """Return [(heading, body)] for every `## From X -> Y` section."""
    matches = list(_SECTION_HEADING_RE.finditer(text))
    if not matches:
        return []
    sections: list[tuple[str, str]] = []
    for idx, m in enumerate(matches):
        heading = m.group(0)
        start = m.end()
        end = (
            matches[idx + 1].start()
            if idx + 1 < len(matches)
            else len(text)
        )
        body = text[start:end]
        sections.append((heading, body))
    return sections


def test_upgrading_file_exists() -> None:
    assert _UPGRADING.is_file(), f"Expected {_UPGRADING} (#768)"


def test_at_least_one_upgrade_section_present() -> None:
    text = _UPGRADING.read_text(encoding="utf-8")
    sections = _split_sections(text)
    assert sections, (
        "UPGRADING.md must contain at least one `## From <prev> -> <new>` section (#768)"
    )


def test_every_section_has_four_field_header() -> None:
    """Each section MUST carry all four fields somewhere in its body.

    The fields appear as bold list items (`- **Field:**`) in the canonical
    layout, but this test only requires the field name and the trailing
    colon to be present so authors can adjust styling without breaking
    the contract.
    """
    text = _UPGRADING.read_text(encoding="utf-8")
    sections = _split_sections(text)
    failures: list[str] = []
    for heading, body in sections:
        missing = [
            field
            for field in _REQUIRED_FIELDS
            if f"**{field}:**" not in body and f"{field}:" not in body
        ]
        if missing:
            failures.append(f"{heading.strip()} -> missing: {missing}")
    assert not failures, (
        "UPGRADING.md sections missing four-field micro-format header:\n"
        + "\n".join(failures)
        + "\n(#768)"
    )


def test_managed_section_legacy_migration_section_present() -> None:
    """UPGRADING.md MUST document the AGENTS.md managed-section legacy
    migration contract introduced in v0.20.0 (#768).

    The section documents the one-time append behavior for pre-#768
    `AGENTS.md` files (state=`missing`) and the long-term
    sentinel-only-rewrite contract for subsequent upgrades. Risk-averse
    consumers MUST be able to read the contract before running
    `deft/run agents:refresh`. Story: #794.
    """
    text = _UPGRADING.read_text(encoding="utf-8")
    sections = _split_sections(text)
    matching = [
        (heading, body)
        for heading, body in sections
        if "#768" in heading or "managed-section" in heading.lower()
    ]
    assert matching, (
        "UPGRADING.md must contain a `## From <pre-#768> -> <managed-section>` "
        "section documenting the AGENTS.md managed-section legacy migration "
        "contract (#794)."
    )
    # Pin the canonical contract surface area: detection rule, one-time
    # append, sentinel-only rewrite, and cross-references to the rendered
    # template + QUICK-START Case G. Each phrase / token is the minimum
    # contract the docs MUST surface so risk-averse consumers can decide
    # whether to run `deft/run agents:refresh` before doing so.
    required_tokens = (
        "<!-- deft:managed-section v1 -->",
        "agents-md=missing",
        "deft/run agents:refresh",
        "one-time",
        "sentinel-only",
        "templates/agents-entry.md",
        "QUICK-START.md",
        "Case G",
    )
    heading, body = matching[0]
    missing_tokens = [tok for tok in required_tokens if tok not in body]
    assert not missing_tokens, (
        f"UPGRADING.md section {heading.strip()!r} is missing required "
        f"contract tokens: {missing_tokens}. The section MUST cover the "
        f"detection rule (`<!-- deft:managed-section v1 -->` markers absent), "
        f"the one-time append behavior, the sentinel-only-rewrite contract, "
        f"and cross-link `templates/agents-entry.md` plus `QUICK-START.md` "
        f"Case G (#794)."
    )
