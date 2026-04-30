"""tests/content/test_main_md_preamble.py -- DEFT-PREAMBLE-V1 line-1 contract (#768).

Asserts the `<!-- DEFT-PREAMBLE-V1 -->` marker appears at line 1 of:
- `main.md`
- `SKILL.md`               (root)
- `skills/deft-setup/SKILL.md`   (legacy redirect stub)
- `skills/deft-build/SKILL.md`   (legacy redirect stub)

Together with the marker, the preamble body MUST instruct the agent to
run `python3 deft/run gate` before any other instruction in the file.

Story: #768 (universal-upgrade-gate)
"""

from __future__ import annotations

from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

_PREAMBLE_MARKER = "<!-- DEFT-PREAMBLE-V1 -->"
_GATE_INSTRUCTION = "python3 deft/run gate"
_UPGRADING_REFERENCE = "deft/UPGRADING.md"

_REQUIRED_FILES = (
    "main.md",
    "SKILL.md",
    "skills/deft-setup/SKILL.md",
    "skills/deft-build/SKILL.md",
)


@pytest.mark.parametrize("rel_path", _REQUIRED_FILES)
def test_file_exists(rel_path: str) -> None:
    """The required preamble carriers MUST exist."""
    full = _REPO_ROOT / rel_path
    assert full.is_file(), (
        f"Expected file {full} to carry the DEFT-PREAMBLE-V1 marker (#768)"
    )


@pytest.mark.parametrize("rel_path", _REQUIRED_FILES)
def test_preamble_marker_at_line_one(rel_path: str) -> None:
    """First line of every required file MUST be the DEFT-PREAMBLE-V1 marker."""
    full = _REPO_ROOT / rel_path
    first_line = full.read_text(encoding="utf-8").splitlines()[0]
    assert first_line.strip() == _PREAMBLE_MARKER, (
        f"{rel_path}: line 1 must be the literal `{_PREAMBLE_MARKER}` "
        f"(got: {first_line!r}) (#768)"
    )


@pytest.mark.parametrize("rel_path", _REQUIRED_FILES)
def test_preamble_includes_gate_instruction(rel_path: str) -> None:
    """The preamble body MUST instruct the agent to run `python3 deft/run gate`."""
    full = _REPO_ROOT / rel_path
    text = full.read_text(encoding="utf-8")
    # Limit to the first ~12 lines so we don't accidentally accept a later
    # mention of the gate command elsewhere in the file body.
    head = "\n".join(text.splitlines()[:12])
    assert _GATE_INSTRUCTION in head, (
        f"{rel_path}: preamble body must include `{_GATE_INSTRUCTION}` "
        "near line 1 (#768)"
    )


@pytest.mark.parametrize("rel_path", _REQUIRED_FILES)
def test_preamble_references_upgrading_doc(rel_path: str) -> None:
    """The preamble body MUST point at `deft/UPGRADING.md` for recovery."""
    full = _REPO_ROOT / rel_path
    text = full.read_text(encoding="utf-8")
    head = "\n".join(text.splitlines()[:12])
    assert _UPGRADING_REFERENCE in head, (
        f"{rel_path}: preamble body must reference `{_UPGRADING_REFERENCE}` "
        "for the recovery path (#768)"
    )
