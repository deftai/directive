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
        "vBRIEFInfo": {"version": "0.6"},
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


# ---------------------------------------------------------------------------
# #435 -- lifecycle-scope aggregator
# ---------------------------------------------------------------------------


def _scope(title: str, status: str, narratives: dict, items: list | None = None,
           plan_id: str | None = None, edges: list | None = None) -> dict:
    plan = {
        "title": title,
        "status": status,
        "narratives": narratives,
        "items": items or [],
    }
    if plan_id is not None:
        plan["id"] = plan_id
    if edges is not None:
        plan["edges"] = edges
    return {"vBRIEFInfo": {"version": "0.6"}, "plan": plan}


def test_aggregator_emits_implementation_plan_section(render_mod, tmp_path) -> None:
    """--include-scopes (default on) emits Implementation Plan with lifecycle buckets (#435)."""
    vbrief_dir = tmp_path / "vbrief"
    # Base spec
    spec_path = _write_spec(
        vbrief_dir,
        {"Overview": "Aggregator test spec."},
        title="Aggregator Spec",
    )
    # Pending scope
    _write_scope(
        vbrief_dir / "pending",
        "2026-04-18-pending-one.vbrief.json",
        _scope(
            "Pending scope one",
            "pending",
            {"Overview": "First pending scope summary."},
            items=[
                {"id": "p1-a", "title": "Pending item A", "status": "pending"},
                {"id": "p1-b", "title": "Pending item B", "status": "pending"},
            ],
        ),
    )
    # Active scope
    _write_scope(
        vbrief_dir / "active",
        "2026-04-19-active-one.vbrief.json",
        _scope(
            "Active scope one",
            "running",
            {"Overview": "Currently running scope summary."},
            items=[
                {"id": "a1-a", "title": "Active item A", "status": "running"},
            ],
        ),
    )
    # Completed scope (status pinned)
    _write_scope(
        vbrief_dir / "completed",
        "2026-04-10-completed-one.vbrief.json",
        _scope(
            "Completed scope one",
            "completed",
            {"Overview": "Already completed scope summary."},
            items=[
                {"id": "c1-a", "title": "Completed item A", "status": "completed"},
            ],
        ),
    )
    # Completed folder file with wrong status -- must be filtered out.
    _write_scope(
        vbrief_dir / "completed",
        "2026-04-10-misfiled-pending.vbrief.json",
        _scope(
            "Misfiled pending (should be skipped)",
            "pending",
            {"Overview": "This scope has status pending in completed/ and must be filtered."},
        ),
    )

    out = tmp_path / "SPECIFICATION.md"
    ok, _ = render_mod.render_spec(str(spec_path), str(out))
    assert ok
    content = out.read_text(encoding="utf-8")

    # Section heading
    assert "## Implementation Plan" in content
    # Lifecycle bucket sub-headings
    assert "### Pending" in content
    assert "### Active" in content
    assert "### Completed" in content
    # Each scope renders filename stem + title
    assert "### 2026-04-18-pending-one: Pending scope one" in content
    assert "### 2026-04-19-active-one: Active scope one" in content
    assert "### 2026-04-10-completed-one: Completed scope one" in content
    # Summary narrative rendered
    assert "First pending scope summary." in content
    assert "Currently running scope summary." in content
    assert "Already completed scope summary." in content
    # Acceptance items listed
    assert "**Acceptance**" in content
    assert "- Pending item A" in content
    assert "- Pending item B" in content
    assert "- Active item A" in content
    assert "- Completed item A" in content
    # Status pin: misfiled pending scope must NOT appear under Completed
    assert "Misfiled pending" not in content
    # Section order: Pending before Active before Completed
    pending_pos = content.index("### Pending")
    active_pos = content.index("### Active")
    completed_pos = content.index("### Completed")
    assert pending_pos < active_pos < completed_pos


def test_include_scopes_off_suppresses_aggregator(render_mod, tmp_path) -> None:
    """--include-scopes=off skips the aggregator and preserves pre-#435 output (#435 regression)."""
    vbrief_dir = tmp_path / "vbrief"
    spec_path = _write_spec(
        vbrief_dir,
        {"Overview": "Fallback regression spec."},
        title="Fallback Spec",
    )
    # Populate lifecycle folders -- aggregator would otherwise emit these.
    _write_scope(
        vbrief_dir / "pending",
        "2026-04-18-pending-one.vbrief.json",
        _scope(
            "Should be hidden",
            "pending",
            {"Overview": "This scope should NOT render when --include-scopes=off."},
        ),
    )

    out = tmp_path / "SPECIFICATION.md"
    ok, _ = render_mod.render_spec(str(spec_path), str(out), include_scopes=False)
    assert ok
    content = out.read_text(encoding="utf-8")

    # Base narrative still present
    assert "# Fallback Spec" in content
    assert "## Overview" in content
    assert "Fallback regression spec." in content
    # Aggregator section must be absent
    assert "## Implementation Plan" not in content
    assert "### Pending" not in content
    assert "Should be hidden" not in content


def test_include_scopes_cli_flag_off(render_mod, monkeypatch, tmp_path) -> None:
    """CLI ``--include-scopes=off`` suppresses the aggregator via main() (#435)."""
    vbrief_dir = tmp_path / "vbrief"
    spec_path = _write_spec(
        vbrief_dir,
        {"Overview": "CLI off test."},
        title="CLI Off Spec",
    )
    _write_scope(
        vbrief_dir / "pending",
        "2026-04-18-cli.vbrief.json",
        _scope("CLI pending", "pending", {"Overview": "Should not appear when off."}),
    )
    out = tmp_path / "SPECIFICATION.md"
    monkeypatch.setattr(
        sys,
        "argv",
        ["spec_render.py", str(spec_path), str(out), "--include-scopes=off"],
    )
    assert render_mod.main() == 0
    content = out.read_text(encoding="utf-8")
    assert "## Implementation Plan" not in content
    assert "CLI pending" not in content


def test_include_scopes_cli_flag_default_on(render_mod, monkeypatch, tmp_path) -> None:
    """CLI default (no flag) includes the aggregator (#435)."""
    vbrief_dir = tmp_path / "vbrief"
    spec_path = _write_spec(
        vbrief_dir,
        {"Overview": "Default on test."},
        title="Default On Spec",
    )
    _write_scope(
        vbrief_dir / "active",
        "2026-04-18-default.vbrief.json",
        _scope("Default active", "running", {"Overview": "Should appear by default."}),
    )
    out = tmp_path / "SPECIFICATION.md"
    monkeypatch.setattr(sys, "argv", ["spec_render.py", str(spec_path), str(out)])
    assert render_mod.main() == 0
    content = out.read_text(encoding="utf-8")
    assert "## Implementation Plan" in content
    assert "### Active" in content
    assert "Default active" in content


def test_aggregator_bilingual_edges_order_scopes(render_mod, tmp_path) -> None:
    """Cross-scope {from,to} and {source,target} edges both drive topo-sort order (#435/#458)."""
    vbrief_dir = tmp_path / "vbrief"
    spec_path = _write_spec(
        vbrief_dir, {"Overview": "Edge ordering."}, title="Edge Order Spec"
    )
    # Scope alpha is written first alphabetically but depends on gamma via from/to,
    # so gamma must render before alpha. beta depends on alpha via source/target.
    _write_scope(
        vbrief_dir / "pending",
        "2026-04-18-alpha.vbrief.json",
        _scope(
            "Alpha",
            "pending",
            {"Overview": "Depends on gamma."},
            plan_id="alpha",
            edges=[{"from": "gamma", "to": "alpha", "type": "blocks"}],
        ),
    )
    _write_scope(
        vbrief_dir / "pending",
        "2026-04-18-beta.vbrief.json",
        _scope(
            "Beta",
            "pending",
            {"Overview": "Depends on alpha via legacy keys."},
            plan_id="beta",
            edges=[{"source": "alpha", "target": "beta"}],
        ),
    )
    _write_scope(
        vbrief_dir / "pending",
        "2026-04-18-gamma.vbrief.json",
        _scope("Gamma", "pending", {"Overview": "Root scope with no deps."}, plan_id="gamma"),
    )

    out = tmp_path / "SPECIFICATION.md"
    render_mod.render_spec(str(spec_path), str(out))
    content = out.read_text(encoding="utf-8")
    gamma_pos = content.index("Gamma")
    alpha_pos = content.index("Alpha")
    beta_pos = content.index("Beta")
    assert gamma_pos < alpha_pos < beta_pos, (
        "cross-scope bilingual edges must order dependencies before dependents"
    )


def test_aggregator_graceful_when_no_lifecycle_folders(render_mod, tmp_path) -> None:
    """Missing lifecycle folders must not prevent rendering (#435 edge case)."""
    vbrief_dir = tmp_path / "vbrief"
    spec_path = _write_spec(
        vbrief_dir, {"Overview": "No folders."}, title="No Folders Spec"
    )
    out = tmp_path / "SPECIFICATION.md"
    ok, _ = render_mod.render_spec(str(spec_path), str(out))
    assert ok
    content = out.read_text(encoding="utf-8")
    assert "# No Folders Spec" in content
    # Aggregator silently skips when no scopes exist
    assert "## Implementation Plan" not in content
