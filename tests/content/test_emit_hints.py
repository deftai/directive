"""
test_emit_hints.py — Content tests for the shared issue-emit hint (#1274 Change 1).

Verifies that:
  - strategies/emit-hints.md exists and names all three GitHub-issue tracking
    patterns (none / --umbrella / --per-vbrief) plus the canonical
    `task deft:issue:emit` invocations.
  - Every vBRIEF-producing strategy references emit-hints.md at/near its
    emission step (the same shared-reference shape used for artifact-guards.md).
  - speckit references the hint in BOTH Phase 4 and Phase 4.5.

This story documents the emit invocations only; the `task deft:issue:emit` tool
itself is built by the sibling story 1274a.

Refs #1274 #1284
"""

from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Module-level constants
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HELPER_REL = "content/strategies/emit-hints.md"

# Every vBRIEF-producing strategy that must link the hint at its emission step.
_STRATEGY_FILES = [
    "content/strategies/bdd.md",
    "content/strategies/discuss.md",
    "content/strategies/research.md",
    "content/strategies/map.md",
    "content/strategies/probe.md",
    "content/strategies/interview.md",
    "content/strategies/yolo.md",
    "content/strategies/rapid.md",
    "content/strategies/enterprise.md",
    "content/strategies/speckit.md",
]

# Markdown link form strategies use to reference the shared helper.
_HELPER_LINK = "](./emit-hints.md"


def _read(relpath: str) -> str:
    return (_REPO_ROOT / relpath).read_text(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# emit-hints.md — the shared helper
# ---------------------------------------------------------------------------

class TestEmitHintsHelper:
    """strategies/emit-hints.md must name the three patterns and canonical invocation."""

    def test_helper_exists(self) -> None:
        assert (_REPO_ROOT / _HELPER_REL).exists(), (
            f"{_HELPER_REL} must exist as the shared issue-emit hint helper"
        )

    def test_names_canonical_issue_emit_command(self) -> None:
        text = _read(_HELPER_REL)
        # Consumer-installed surface form (strategies render to consumers).
        assert "task deft:issue:emit" in text, (
            f"{_HELPER_REL} must name the canonical `task deft:issue:emit` invocation"
        )

    def test_names_umbrella_pattern(self) -> None:
        text = _read(_HELPER_REL)
        assert "--umbrella" in text, f"{_HELPER_REL} must name the --umbrella pattern"
        assert "task deft:issue:emit --umbrella" in text, (
            f"{_HELPER_REL} must show the canonical --umbrella invocation"
        )

    def test_names_per_vbrief_pattern(self) -> None:
        text = _read(_HELPER_REL)
        assert "--per-vbrief" in text, f"{_HELPER_REL} must name the --per-vbrief pattern"
        assert "task deft:issue:emit --per-vbrief" in text, (
            f"{_HELPER_REL} must show the canonical --per-vbrief invocation"
        )

    def test_names_default_no_issue_pattern(self) -> None:
        text = _read(_HELPER_REL)
        lowered = text.lower()
        # The default (vBRIEF-only / no issue, no further action) must be named.
        assert "default" in lowered and "no further action" in lowered, (
            f"{_HELPER_REL} must name the default (vBRIEF-only) pattern requiring no action"
        )

    def test_default_is_unchanged_no_auto_file(self) -> None:
        text = _read(_HELPER_REL)
        # The hint is informational; no strategy files an issue automatically.
        assert "⊗" in text and "automatic" in text.lower(), (
            f"{_HELPER_REL} must state that no issue is filed automatically (default unchanged)"
        )


# ---------------------------------------------------------------------------
# Each vBRIEF-producing strategy references the hint at its emission step
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("strategy_rel", _STRATEGY_FILES)
def test_strategy_references_emit_hints(strategy_rel: str) -> None:
    """Every listed strategy doc must link the shared emit-hints helper."""
    text = _read(strategy_rel)
    assert _HELPER_LINK in text, (
        f"{strategy_rel} must reference the shared hint via [emit-hints.md](./emit-hints.md) "
        "at its emission step (the same shape used for artifact-guards.md)"
    )


@pytest.mark.parametrize("strategy_rel", _STRATEGY_FILES)
def test_reference_is_near_emission_step(strategy_rel: str) -> None:
    """The emit-hints reference must co-locate with an emission marker.

    Robust heuristic: the strategy mentions writing scope vBRIEFs (proposed/ or
    pending/) and links the helper; the helper link is positioned at/after the
    first emission marker rather than only in the front-matter See-also list.
    """
    text = _read(strategy_rel)
    emission_markers = ["vbrief/proposed/", "vbrief/pending/", "proposed/", "pending/"]
    first_emission = min(
        (text.find(m) for m in emission_markers if text.find(m) != -1),
        default=-1,
    )
    assert first_emission != -1, (
        f"{strategy_rel} should mention an emission target (proposed/ or pending/)"
    )
    link_idx = text.find(_HELPER_LINK)
    assert link_idx != -1, f"{strategy_rel} must link emit-hints.md"
    assert link_idx > first_emission, (
        f"{strategy_rel} must reference emit-hints.md at/near its emission step, "
        "not only in the front-matter See-also list"
    )


# ---------------------------------------------------------------------------
# speckit references the hint in BOTH Phase 4 and Phase 4.5
# ---------------------------------------------------------------------------

class TestSpeckitBothEmissionPhases:
    """speckit emits at Phase 4 AND Phase 4.5 — both must surface the hint."""

    _text = _read("content/strategies/speckit.md")

    def _section(self, start_header: str, end_header: str) -> str:
        assert start_header in self._text, f"speckit.md missing section {start_header!r}"
        body = self._text.split(start_header, 1)[1]
        if end_header in body:
            body = body.split(end_header, 1)[0]
        return body

    def test_phase4_references_emit_hints(self) -> None:
        section = self._section(
            "## Phase 4: Implementation Phase", "## Phase 4.5:"
        )
        assert _HELPER_LINK in section, (
            "speckit.md Phase 4 emission step must reference emit-hints.md"
        )

    def test_phase4_5_references_emit_hints(self) -> None:
        section = self._section("## Phase 4.5:", "## Phase 5:")
        assert _HELPER_LINK in section, (
            "speckit.md Phase 4.5 emission step must reference emit-hints.md"
        )
