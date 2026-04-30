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
