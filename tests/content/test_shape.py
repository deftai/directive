"""
test_shape.py — Shape compliance checks for the Deft Directive framework.

Spec: SPECIFICATION.md Subphase 2.5 (Task 2.5.2)

Verifies that every file in each framework category contains the required
structural sections defined in tests/fixtures/shapes.py. Adding a new file
to languages/, strategies/, interfaces/, or tools/ without the required
sections will cause a test failure here.

Author: Scott Adams (msadams) — 2026-03-10
"""

import json
import sys
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Path setup — allow importing from tests/fixtures/
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_FIXTURES = _REPO_ROOT / "tests/fixtures"
if str(_FIXTURES) not in sys.path:
    sys.path.insert(0, str(_FIXTURES))

from shapes import (  # noqa: E402, I001
    INTERFACE_SHAPE,
    LANGUAGE_SHAPE,
    STRATEGY_SHAPE,
    TOOL_SHAPE,
    validate_shape,
)


# ---------------------------------------------------------------------------
# Known-failures helpers
# ---------------------------------------------------------------------------

def _load_entries() -> list[dict]:
    kf_path = _REPO_ROOT / "tests/content/snapshots/known_failures.json"
    return json.loads(kf_path.read_text(encoding="utf-8"))["known_failures"]


def _xfail_set(check: str) -> set[str]:
    return {e["file"] for e in _load_entries() if e.get("xfail") and e.get("check") == check}


def _exempt_set(check: str) -> set[str]:
    return {e["file"] for e in _load_entries() if e.get("exempt") and e.get("check") == check}


# ---------------------------------------------------------------------------
# Parametrize builder
# ---------------------------------------------------------------------------

def _params(dirname: str, check: str) -> list:
    xfail = _xfail_set(check)
    exempt = _exempt_set(check)
    params = []
    for path in sorted((_REPO_ROOT / dirname).glob("*.md")):
        rel = path.relative_to(_REPO_ROOT).as_posix()
        if rel in exempt:
            continue
        if rel in xfail:
            params.append(
                pytest.param(
                    rel,
                    marks=pytest.mark.xfail(
                        reason=f"{rel}: shape violations — see todo.md Phase 2",
                        strict=True,
                    ),
                )
            )
        else:
            params.append(rel)  # type: ignore[arg-type]
    return params


# ---------------------------------------------------------------------------
# Language files: must have ## Standards, ## Commands, ## Patterns
# ---------------------------------------------------------------------------

_LANG_CHECK = "test_shape.language_file_shape"


@pytest.mark.parametrize("rel_path", _params("languages", _LANG_CHECK))
def test_language_file_shape(rel_path: str) -> None:
    """Language files must contain ## Standards, ## Commands, and ## Patterns."""
    text = (_REPO_ROOT / rel_path).read_text(encoding="utf-8", errors="replace")
    violations = validate_shape(text, LANGUAGE_SHAPE)
    assert not violations, (
        f"{rel_path} fails language shape check:\n"
        + "\n".join(f"  • {v}" for v in violations)
    )


# ---------------------------------------------------------------------------
# Strategy files: must have ## When to Use, ## Workflow
# ---------------------------------------------------------------------------

_STRAT_CHECK = "test_shape.strategy_file_shape"


@pytest.mark.parametrize("rel_path", _params("strategies", _STRAT_CHECK))
def test_strategy_file_shape(rel_path: str) -> None:
    """Strategy files must contain ## When to Use and ## Workflow."""
    text = (_REPO_ROOT / rel_path).read_text(encoding="utf-8", errors="replace")
    violations = validate_shape(text, STRATEGY_SHAPE)
    assert not violations, (
        f"{rel_path} fails strategy shape check:\n"
        + "\n".join(f"  • {v}" for v in violations)
    )


# ---------------------------------------------------------------------------
# Interface files: must have ## Core Architecture OR ## Framework Selection
# ---------------------------------------------------------------------------

_IFACE_CHECK = "test_shape.interface_file_shape"


@pytest.mark.parametrize("rel_path", _params("interfaces", _IFACE_CHECK))
def test_interface_file_shape(rel_path: str) -> None:
    """Interface files must contain ## Core Architecture or ## Framework Selection."""
    text = (_REPO_ROOT / rel_path).read_text(encoding="utf-8", errors="replace")
    violations = validate_shape(text, INTERFACE_SHAPE)
    assert not violations, (
        f"{rel_path} fails interface shape check:\n"
        + "\n".join(f"  • {v}" for v in violations)
    )


# ---------------------------------------------------------------------------
# Tool files: must have at least one ## section
# ---------------------------------------------------------------------------

_TOOL_CHECK = "test_shape.tool_file_shape"


@pytest.mark.parametrize("rel_path", _params("tools", _TOOL_CHECK))
def test_tool_file_shape(rel_path: str) -> None:
    """Tool files must contain at least one ## section."""
    text = (_REPO_ROOT / rel_path).read_text(encoding="utf-8", errors="replace")
    violations = validate_shape(text, TOOL_SHAPE)
    assert not violations, (
        f"{rel_path} fails tool shape check:\n"
        + "\n".join(f"  • {v}" for v in violations)
    )
