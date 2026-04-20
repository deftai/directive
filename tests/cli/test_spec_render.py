"""
test_spec_render.py -- Unit tests for scripts/spec_render.py narrative-centric
rendering and lifecycle-scope aggregation.

Covers:
  - #434: declared narrative key ordering (speckit + interview/light)
  - #434: remaining narrative keys rendered alphabetically
  - #434: legacy interview-shaped spec (Overview + items) still renders
  - #435: --include-scopes aggregator walks vbrief/{pending,active,completed}
  - #435: --include-scopes=off fallback regression
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_SCRIPTS_DIR = _REPO_ROOT / "scripts"
_RENDER_PY = _SCRIPTS_DIR / "spec_render.py"


@pytest.fixture(scope="session")
def render_mod():
    """Load scripts/spec_render.py once per session."""
    scripts_str = str(_SCRIPTS_DIR)
    if scripts_str not in sys.path:
        sys.path.insert(0, scripts_str)
    spec = importlib.util.spec_from_file_location("spec_render", _RENDER_PY)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_spec(
    vbrief_dir: Path,
    narratives: dict,
    items: list | None = None,
    title: str = "Test Spec",
    status: str = "approved",
) -> Path:
    """Write a specification.vbrief.json at ``vbrief_dir/specification.vbrief.json``."""
    vbrief_dir.mkdir(parents=True, exist_ok=True)
    spec = {
        "vBRIEFInfo": {"version": "0.5"},
        "plan": {
            "title": title,
            "status": status,
            "narratives": narratives,
            "items": items or [],
        },
    }
    spec_path = vbrief_dir / "specification.vbrief.json"
    spec_path.write_text(json.dumps(spec, indent=2), encoding="utf-8")
    return spec_path


def _write_scope(folder: Path, filename: str, vbrief: dict) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / filename
    path.write_text(json.dumps(vbrief, indent=2), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# #434 -- speckit-shaped narratives render in declared order
# ---------------------------------------------------------------------------


_SPECKIT_NARRATIVES = {
    "Overview": "Deft framework build CLI.",
    "ProblemStatement": "Users struggle to bootstrap Deft projects reliably.",
    "Goals": "Deliver a deterministic spec-to-scaffold flow.",
    "UserStories": "As a developer, I want to run task spec:render and see my scopes.",
    "Requirements": "FR-1: Spec renders narratives.\nFR-2: Scopes render per lifecycle.",
    "SuccessMetrics": "90% of speckit projects render without manual intervention.",
    "EdgeCases": "Empty narratives, missing lifecycle folders, mixed conventions.",
    "Architecture": "Python scripts + vBRIEF v0.5 JSON + Taskfile wrappers.",
    "TechDecisions": "Python 3.12, uv for packaging, importlib-based test loading.",
    "ImplementationPhases": "Phase 1 narrative ordering; Phase 2 aggregator.",
    "PreImplementationGates": "Simplicity gate, test-first gate, coverage >=85%.",
}


def test_speckit_narratives_render_as_headings(render_mod, tmp_path) -> None:
    """All 11 speckit narrative keys render as H2 headings with non-empty body (#434)."""
    spec_path = _write_spec(
        tmp_path / "vbrief", _SPECKIT_NARRATIVES, title="Speckit Spec"
    )
    out = tmp_path / "SPECIFICATION.md"
    ok, msg = render_mod.render_spec(str(spec_path), str(out))
    assert ok, f"render_spec failed: {msg}"
    content = out.read_text(encoding="utf-8")

    # Required top-level heading
    assert "# Speckit Spec" in content

    # Every speckit narrative key must appear as ## heading with body
    for key, body in _SPECKIT_NARRATIVES.items():
        assert f"## {key}" in content, f"missing heading: {key}"
        assert body in content, f"missing body for: {key}"


def test_speckit_required_headings_non_empty(render_mod, tmp_path) -> None:
    """Three required assertions per the vBRIEF: ## ProblemStatement/Goals/Requirements (#434)."""
    spec_path = _write_spec(tmp_path / "vbrief", _SPECKIT_NARRATIVES)
    out = tmp_path / "SPECIFICATION.md"
    render_mod.render_spec(str(spec_path), str(out))
    content = out.read_text(encoding="utf-8")

    assert "## ProblemStatement" in content
    assert "## Goals" in content
    assert "## Requirements" in content

    # Non-empty body content -- not just the heading
    for heading in ("## ProblemStatement", "## Goals", "## Requirements"):
        pos = content.index(heading)
        after = content[pos + len(heading):].strip()
        assert after, f"body after {heading} should be non-empty"


def test_narrative_declared_order_preserved(render_mod, tmp_path) -> None:
    """Render in SPECIFICATION_NARRATIVE_KEY_ORDER regardless of JSON insertion order (#434)."""
    # Write narratives in reverse order -- output must still be declared order.
    reversed_order = dict(reversed(list(_SPECKIT_NARRATIVES.items())))
    spec_path = _write_spec(tmp_path / "vbrief", reversed_order)
    out = tmp_path / "SPECIFICATION.md"
    render_mod.render_spec(str(spec_path), str(out))
    content = out.read_text(encoding="utf-8")

    positions = [
        content.index(f"## {key}")
        for key in render_mod.SPECIFICATION_NARRATIVE_KEY_ORDER
    ]
    assert positions == sorted(positions), (
        "narratives must render in SPECIFICATION_NARRATIVE_KEY_ORDER regardless of "
        "input insertion order"
    )


def test_extra_narrative_keys_render_alphabetically(render_mod, tmp_path) -> None:
    """Narratives outside the declared order must render alphabetically after it (#434)."""
    narratives = {
        "Overview": "Short overview",
        "Architecture": "Monolith",
        "ZExtra": "Alpha z-extra",
        "AaBonus": "Alpha aa-bonus",
    }
    spec_path = _write_spec(tmp_path / "vbrief", narratives)
    out = tmp_path / "SPECIFICATION.md"
    render_mod.render_spec(str(spec_path), str(out))
    content = out.read_text(encoding="utf-8")

    # Declared keys come first, in declared order
    overview_pos = content.index("## Overview")
    arch_pos = content.index("## Architecture")
    assert overview_pos < arch_pos

    # Extra keys come after declared keys, alphabetically
    aa_pos = content.index("## AaBonus")
    z_pos = content.index("## ZExtra")
    assert arch_pos < aa_pos < z_pos, (
        "extra narrative keys must render after declared keys in alphabetical order"
    )


# ---------------------------------------------------------------------------
# #434 -- legacy interview-shaped spec still renders
# ---------------------------------------------------------------------------


def test_legacy_interview_shape_renders_overview_and_items(render_mod, tmp_path) -> None:
    """Legacy interview-shaped spec (Overview + items) still renders post-#434."""
    narratives = {"Overview": "A legacy interview-style spec."}
    items = [
        {
            "id": "T1",
            "title": "Do the thing",
            "status": "pending",
            "narrative": {"Description": "Get it done.", "Acceptance": "A; B"},
        },
        {
            "id": "T2",
            "title": "Follow up",
            "status": "pending",
            "narrative": {"Description": "Part two."},
        },
    ]
    spec_path = _write_spec(
        tmp_path / "vbrief", narratives, items=items, title="Legacy Spec"
    )
    out = tmp_path / "SPECIFICATION.md"
    ok, _ = render_mod.render_spec(str(spec_path), str(out))
    assert ok

    content = out.read_text(encoding="utf-8")
    assert "# Legacy Spec" in content
    assert "## Overview" in content
    assert "A legacy interview-style spec." in content
    # Items still render as H2 with id: title
    assert "## T1: Do the thing" in content
    assert "## T2: Follow up" in content
    # Acceptance rendered as bullets (pre-existing behavior preserved)
    assert "- A" in content
    assert "- B" in content
