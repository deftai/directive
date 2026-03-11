"""
test_vbrief_schema.py — vBRIEF schema consistency checks.

Ensures the Status enum defined in vbrief-core.schema.json stays in sync
with the documented values in vbrief/vbrief.md. This guards against the
kind of drift that Issue #28 fixed (deft using non-conforming status values).

Author: Scott Adams (msadams) — 2026-03-11
"""

import json
import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_SCHEMA_PATH = _REPO_ROOT / "vbrief/schemas/vbrief-core.schema.json"
_VBRIEF_MD_PATH = _REPO_ROOT / "vbrief/vbrief.md"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _schema_status_enum() -> set[str]:
    """Extract the Status enum values from vbrief-core.schema.json."""
    schema = json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))
    return set(schema["$defs"]["Status"]["enum"])


def _documented_status_enum() -> set[str]:
    """Extract the Status enum values from the code-fenced line in vbrief.md.

    Looks for the pipe-delimited list inside the first ``` block under
    '### Status Enum', e.g.:
        draft | proposed | approved | pending | running | completed | blocked | cancelled
    """
    text = _VBRIEF_MD_PATH.read_text(encoding="utf-8")
    in_status_section = False
    in_code_block = False
    for line in text.splitlines():
        if line.strip().startswith("### Status Enum"):
            in_status_section = True
            continue
        if in_status_section and line.strip().startswith("```") and not in_code_block:
            in_code_block = True
            continue
        if in_code_block and line.strip().startswith("```"):
            break
        if in_code_block:
            # Parse "draft | proposed | approved | ..."
            values = {v.strip() for v in line.split("|") if v.strip()}
            if values:
                return values
    return set()


def _status_values_used_in_prose() -> set[str]:
    """Collect status values used in lifecycle lines and tool-mapping rows.

    Scans for backtick-quoted words that match the schema enum, ensuring
    no non-conforming values like `todo`, `doing`, `done`, `skip`, or
    `deferred` have crept back in.
    """
    text = _VBRIEF_MD_PATH.read_text(encoding="utf-8")
    schema_values = _schema_status_enum()
    # Old non-conforming values that must NOT appear as status references
    non_conforming = {"todo", "doing", "done", "skip", "deferred"}
    # Find all backtick-quoted words in status-relevant lines
    found: set[str] = set()
    status_line_re = re.compile(r"status.lifecycle|status.*→|`status`", re.IGNORECASE)
    backtick_re = re.compile(r"`(\w+)`")
    for line in text.splitlines():
        if not status_line_re.search(line):
            continue
        for match in backtick_re.finditer(line):
            word = match.group(1)
            if word in schema_values or word in non_conforming:
                found.add(word)
    return found


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_schema_file_is_valid_json() -> None:
    """vbrief-core.schema.json must be parseable JSON."""
    data = json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))
    assert "$defs" in data, "Schema missing $defs — not a valid vBRIEF core schema"


def test_documented_status_matches_schema() -> None:
    """The Status enum in vbrief.md must exactly match the schema."""
    schema_values = _schema_status_enum()
    doc_values = _documented_status_enum()
    assert doc_values, "Could not parse Status enum from vbrief.md"
    assert doc_values == schema_values, (
        f"Status enum mismatch:\n"
        f"  schema:     {sorted(schema_values)}\n"
        f"  vbrief.md:  {sorted(doc_values)}"
    )


def test_no_non_conforming_status_in_prose() -> None:
    """Status lifecycle lines must not contain old non-conforming values."""
    non_conforming = {"todo", "doing", "done", "skip", "deferred"}
    prose_values = _status_values_used_in_prose()
    violations = prose_values & non_conforming
    assert not violations, (
        f"Non-conforming status values found in vbrief.md lifecycle prose: {sorted(violations)}\n"
        f"Use spec-conforming values: pending, running, completed, blocked, cancelled"
    )
