"""
test_strategy_chaining.py — Content tests for the strategy chaining feature.

Spec: specs/strategy-chaining/SPECIFICATION.md Phase 6 (Task 6.2)

Checks:
  1. interview.md contains ## Chaining Gate and ## Acceptance Gate sections
  2. strategies/README.md Type column exists with valid values
  3. Category consistency: preparatory strategies reference chaining gate,
     spec-generating strategies do not have a "Then: Chaining Gate" section
  4. vbrief/vbrief.md documents completedStrategies and artifacts fields

Author: Scott Adams (msadams) — 2026-03-15
"""

import re
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Module-level constants
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_STRATEGIES = _REPO_ROOT / "strategies"
_VALID_TYPES = {"preparatory", "spec-generating"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read(relpath: str) -> str:
    return (_REPO_ROOT / relpath).read_text(encoding="utf-8", errors="replace")


def _parse_readme_table() -> list[dict[str, str]]:
    """Parse the strategy table from README.md into a list of dicts."""
    text = _read("strategies/README.md")
    rows = []
    in_table = False
    headers: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|"):
            if in_table:
                break
            continue
        cells = [c.strip() for c in stripped.strip("|").split("|")]
        if not in_table:
            headers = [h.lower() for h in cells]
            in_table = True
            continue
        # Skip separator row
        if all(set(c) <= {"-", " ", ":"} for c in cells):
            continue
        row = dict(zip(headers, cells, strict=False))
        rows.append(row)
    return rows


# ---------------------------------------------------------------------------
# 1. interview.md must contain Chaining Gate and Acceptance Gate sections
# ---------------------------------------------------------------------------

class TestInterviewGateSections:
    """interview.md must have both gate sections (FR-1, FR-8)."""

    _text = _read("strategies/interview.md")

    def test_chaining_gate_section_exists(self) -> None:
        assert "## Chaining Gate" in self._text, (
            "strategies/interview.md is missing '## Chaining Gate' section"
        )

    def test_acceptance_gate_section_exists(self) -> None:
        assert "## Acceptance Gate" in self._text, (
            "strategies/interview.md is missing '## Acceptance Gate' section"
        )

    def test_chaining_gate_before_sizing_gate(self) -> None:
        """Chaining Gate must appear before Sizing Gate (FR-1)."""
        chaining_pos = self._text.find("## Chaining Gate")
        sizing_pos = self._text.find("## Sizing Gate")
        assert chaining_pos < sizing_pos, (
            "## Chaining Gate must appear before ## Sizing Gate in interview.md"
        )

    def test_acceptance_gate_after_transition_criteria(self) -> None:
        """Acceptance Gate must appear after spec Transition Criteria."""
        # Find the last occurrence of "### Transition Criteria"
        transition_pos = self._text.rfind("### Transition Criteria")
        acceptance_pos = self._text.find("## Acceptance Gate")
        assert transition_pos < acceptance_pos, (
            "## Acceptance Gate must appear after ### Transition Criteria in interview.md"
        )


# ---------------------------------------------------------------------------
# 2. strategies/README.md Type column with valid values
# ---------------------------------------------------------------------------

class TestReadmeTypeColumn:
    """README.md strategy table must have a Type column (FR-4, NFR-3)."""

    _rows = _parse_readme_table()

    def test_type_column_exists(self) -> None:
        assert self._rows, "No rows parsed from strategies/README.md table"
        assert "type" in self._rows[0], (
            "strategies/README.md table is missing 'Type' column"
        )

    def test_all_rows_have_valid_type(self) -> None:
        for row in self._rows:
            strategy = row.get("strategy", "unknown")
            stype = row.get("type", "")
            assert stype in _VALID_TYPES, (
                f"strategies/README.md: {strategy} has invalid Type '{stype}', "
                f"expected one of {_VALID_TYPES}"
            )

    def test_known_preparatory_strategies(self) -> None:
        """Known preparatory strategies must be typed correctly."""
        expected_prep = {"map.md", "discuss.md", "research.md"}
        for row in self._rows:
            # Extract filename from markdown link if present
            strategy_cell = row.get("strategy", "")
            match = re.search(r"\[([^\]]+)\]", strategy_cell)
            name = match.group(1) if match else strategy_cell
            if name in expected_prep:
                assert row.get("type") == "preparatory", (
                    f"{name} should be typed 'preparatory' but is '{row.get('type')}'"
                )

    def test_known_spec_generating_strategies(self) -> None:
        """Known spec-generating strategies must be typed correctly."""
        expected_gen = {"interview.md", "yolo.md", "speckit.md"}
        for row in self._rows:
            strategy_cell = row.get("strategy", "")
            match = re.search(r"\[([^\]]+)\]", strategy_cell)
            name = match.group(1) if match else strategy_cell
            if name in expected_gen:
                assert row.get("type") == "spec-generating", (
                    f"{name} should be typed 'spec-generating' but is '{row.get('type')}'"
                )


# ---------------------------------------------------------------------------
# 3. Category consistency: preparatory strategies reference chaining gate
# ---------------------------------------------------------------------------

_PREPARATORY_FILES = ["map.md", "research.md", "discuss.md"]
_SPEC_GENERATING_FILES = ["interview.md", "yolo.md", "speckit.md"]


@pytest.mark.parametrize("filename", _PREPARATORY_FILES)
def test_preparatory_strategy_references_chaining_gate(filename: str) -> None:
    """Preparatory strategies must have a 'Then: Chaining Gate' section (FR-15)."""
    text = _read(f"strategies/{filename}")
    assert "## Then: Chaining Gate" in text, (
        f"strategies/{filename} is missing '## Then: Chaining Gate' section — "
        "preparatory strategies must return to the chaining gate"
    )


@pytest.mark.parametrize("filename", _SPEC_GENERATING_FILES)
def test_spec_generating_strategy_no_then_chaining_gate(filename: str) -> None:
    """Spec-generating strategies must NOT have a 'Then: Chaining Gate' section."""
    text = _read(f"strategies/{filename}")
    assert "## Then: Chaining Gate" not in text, (
        f"strategies/{filename} should not have '## Then: Chaining Gate' — "
        "spec-generating strategies produce specs, they don't chain back"
    )


# ---------------------------------------------------------------------------
# 4. vbrief/vbrief.md documents strategy chaining fields
# ---------------------------------------------------------------------------

class TestVbriefSchemaDocumentation:
    """vbrief.md must document the strategy chaining fields (FR-11, FR-12)."""

    _text = _read("vbrief/vbrief.md")

    def test_completed_strategies_documented(self) -> None:
        assert "completedStrategies" in self._text, (
            "vbrief/vbrief.md does not document 'completedStrategies' field"
        )

    def test_artifacts_field_documented(self) -> None:
        # Check for the artifacts field in the strategy chaining context
        # (not just any mention of "artifacts")
        assert "Strategy Chaining Fields" in self._text, (
            "vbrief/vbrief.md is missing '### Strategy Chaining Fields' section"
        )

    def test_run_count_documented(self) -> None:
        assert "runCount" in self._text, (
            "vbrief/vbrief.md does not document 'runCount' field"
        )
