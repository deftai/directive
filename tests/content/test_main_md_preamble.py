"""tests/content/test_main_md_preamble.py -- DEFT-PREAMBLE-V1 line-1 contract (#768).

Asserts the `<!-- DEFT-PREAMBLE-V1 -->` marker appears at line 1 of:
- `main.md`
- `SKILL.md`               (root)
- `skills/deft-setup/SKILL.md`   (legacy redirect stub)
- `skills/deft-build/SKILL.md`   (legacy redirect stub)

Together with the marker, the preamble body MUST instruct the agent to
run `python3 <run-path> gate` before any other instruction in the file.
The canonical `<run-path>` was flipped from `deft/run` to `.deft/core/run`
in v0.27 (#992 PR1) for `main.md` + `SKILL.md` (root); the two legacy
redirect-stub carriers (`skills/deft-setup/SKILL.md`,
`skills/deft-build/SKILL.md`) intentionally retain the pre-v0.27
`deft/run` form so v0.19 -> v0.20 stale-AGENTS.md references still resolve
through the `<!-- deft:deprecated-skill-redirect -->` contract (#411).

Story: #768 (universal-upgrade-gate); marker bump #992 PR1.
"""

from __future__ import annotations

from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

_PREAMBLE_MARKER = "<!-- DEFT-PREAMBLE-V1 -->"
# Per #992 PR1: canonical install-layout flip deft/ -> .deft/core/ across
# the documented contract surfaces. The two legacy v0.19 -> v0.20 redirect
# stubs (`skills/deft-setup/SKILL.md`, `skills/deft-build/SKILL.md`) keep
# the pre-flip token so stale `AGENTS.md` references continue to resolve
# into the redirect contract documented in
# `tests/content/test_deprecated_skill_redirects.py`.
_GATE_INSTRUCTION_CANONICAL = "python3 .deft/core/run gate"
_GATE_INSTRUCTION_LEGACY = "python3 deft/run gate"
_UPGRADING_REFERENCE = "deft/UPGRADING.md"

_REDIRECT_STUB_PATHS = (
    "skills/deft-setup/SKILL.md",
    "skills/deft-build/SKILL.md",
)
_CANONICAL_PATHS = (
    "main.md",
    "SKILL.md",
)
_REQUIRED_FILES = _CANONICAL_PATHS + _REDIRECT_STUB_PATHS


def _expected_gate_instruction(rel_path: str) -> str:
    """Return the canonical or legacy gate instruction expected for ``rel_path``."""
    if rel_path in _REDIRECT_STUB_PATHS:
        return _GATE_INSTRUCTION_LEGACY
    return _GATE_INSTRUCTION_CANONICAL


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
    """The preamble body MUST instruct the agent to run the gate command.

    Canonical carriers (`main.md`, `SKILL.md`) MUST use the v0.27
    `.deft/core/run` form; legacy redirect stubs MUST retain the pre-v0.27
    `deft/run` form per the #411 redirect contract.
    """
    full = _REPO_ROOT / rel_path
    text = full.read_text(encoding="utf-8")
    # Limit to the first ~12 lines so we don't accidentally accept a later
    # mention of the gate command elsewhere in the file body.
    head = "\n".join(text.splitlines()[:12])
    expected = _expected_gate_instruction(rel_path)
    assert expected in head, (
        f"{rel_path}: preamble body must include `{expected}` "
        "near line 1 (#768; #992 PR1 for the canonical-vs-legacy split)"
    )


@pytest.mark.parametrize("rel_path", _REQUIRED_FILES)
def test_preamble_references_upgrading_doc(rel_path: str) -> None:
    """The preamble body MUST point at `deft/UPGRADING.md` for recovery.

    The `deft/UPGRADING.md` install-layout reference is intentionally NOT
    flipped in PR1 -- the AC scope is the `deft/run` -> `.deft/core/run`
    substring only. Other `deft/<X>` install-layout references stay on the
    pre-flip path until a future cycle decides.
    """
    full = _REPO_ROOT / rel_path
    text = full.read_text(encoding="utf-8")
    head = "\n".join(text.splitlines()[:12])
    assert _UPGRADING_REFERENCE in head, (
        f"{rel_path}: preamble body must reference `{_UPGRADING_REFERENCE}` "
        "for the recovery path (#768)"
    )
