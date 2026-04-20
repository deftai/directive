"""
test_roadmap_render.py -- Unit tests for scripts/roadmap_render.py.

Covers:
  - generate_roadmap_content: empty/missing pending dir -> valid empty ROADMAP
  - generate_roadmap_content: single vBRIEF file -> phase grouping
  - generate_roadmap_content: dependency ordering via edges
  - generate_roadmap_content: GitHub issue numbers from references
  - generate_roadmap_content: auto-generated banner present
  - generate_roadmap_content: deterministic output (same input -> same output)
  - generate_roadmap_content: multiple vBRIEF files processed in filename order
  - generate_roadmap_content: malformed JSON files skipped gracefully
  - render_roadmap: writes output file
  - check_drift: matches when up to date
  - check_drift: detects drift
  - check_drift: missing ROADMAP.md with no pending vBRIEFs -> OK
  - check_drift: missing ROADMAP.md with pending vBRIEFs -> drift
  - main(): default render mode
  - main(): --check flag

Part of #309 (RFC: vBRIEF-centric document model). Closes #311.
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Load script via importlib (avoids sys.path pollution at import time)
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_SCRIPTS_DIR = _REPO_ROOT / "scripts"
_RENDER_PY = _SCRIPTS_DIR / "roadmap_render.py"


@pytest.fixture(scope="session")
def roadmap_mod():
    """Load scripts/roadmap_render.py as a module once per session."""
    spec = importlib.util.spec_from_file_location("roadmap_render", _RENDER_PY)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


# ---------------------------------------------------------------------------
# Test fixture helpers
# ---------------------------------------------------------------------------

_MINIMAL_VBRIEF = {
    "vBRIEFInfo": {"version": "0.5"},
    "plan": {
        "title": "Test Plan",
        "status": "pending",
        "items": [
            {
                "id": "phase-1",
                "title": "Phase 1: Foundation",
                "status": "pending",
                "subItems": [
                    {"id": "task-a", "title": "Task A", "status": "pending"},
                    {"id": "task-b", "title": "Task B", "status": "pending"},
                ],
            }
        ],
    },
}

_VBRIEF_WITH_REFS = {
    "vBRIEFInfo": {"version": "0.5"},
    "plan": {
        "title": "Feature Work",
        "status": "pending",
        "references": [
            {
                "type": "github-issue",
                "url": "https://github.com/deftai/directive/issues/311",
                "id": "#311",
            },
            {
                "type": "github-issue",
                "url": "https://github.com/deftai/directive/issues/309",
                "id": "#309",
            },
        ],
        "items": [
            {
                "id": "tier-1",
                "title": "Tier 1 -- Foundation",
                "status": "pending",
                "subItems": [
                    {"id": "story-a", "title": "Story A: Update docs", "status": "pending"},
                ],
            }
        ],
    },
}

# Primary fixture -- schema-canonical {from, to} convention (see #458).
_VBRIEF_WITH_EDGES = {
    "vBRIEFInfo": {"version": "0.5"},
    "plan": {
        "title": "Dependency Test",
        "status": "pending",
        "edges": [
            {"from": "task-a", "to": "task-b", "type": "blocks"},
            {"from": "task-a", "to": "task-c", "type": "blocks"},
            {"from": "task-b", "to": "task-d", "type": "blocks"},
        ],
        "items": [
            {
                "id": "phase-1",
                "title": "Phase 1",
                "status": "pending",
                "subItems": [
                    {"id": "task-d", "title": "Task D", "status": "pending"},
                    {"id": "task-c", "title": "Task C", "status": "pending"},
                    {"id": "task-a", "title": "Task A", "status": "pending"},
                    {"id": "task-b", "title": "Task B", "status": "pending"},
                ],
            }
        ],
    },
}

# Legacy regression fixture -- pre-schema {source, target} convention.
_VBRIEF_WITH_LEGACY_EDGES = {
    "vBRIEFInfo": {"version": "0.5"},
    "plan": {
        "title": "Legacy Dependency Test",
        "status": "pending",
        "edges": [
            {"source": "task-a", "target": "task-b"},
            {"source": "task-a", "target": "task-c"},
            {"source": "task-b", "target": "task-d"},
        ],
        "items": [
            {
                "id": "phase-1",
                "title": "Phase 1",
                "status": "pending",
                "subItems": [
                    {"id": "task-d", "title": "Task D", "status": "pending"},
                    {"id": "task-c", "title": "Task C", "status": "pending"},
                    {"id": "task-a", "title": "Task A", "status": "pending"},
                    {"id": "task-b", "title": "Task B", "status": "pending"},
                ],
            }
        ],
    },
}

# Mixed convention -- both {from,to} and {source,target} edges in a single plan.
_VBRIEF_WITH_MIXED_EDGES = {
    "vBRIEFInfo": {"version": "0.5"},
    "plan": {
        "title": "Mixed Dependency Test",
        "status": "pending",
        "edges": [
            {"from": "task-a", "to": "task-b", "type": "blocks"},
            {"source": "task-b", "target": "task-d"},
            # Edge that specifies both -- canonical from/to must win.
            {
                "from": "task-a",
                "to": "task-c",
                "source": "ignored-source",
                "target": "ignored-target",
            },
        ],
        "items": [
            {
                "id": "phase-1",
                "title": "Phase 1",
                "status": "pending",
                "subItems": [
                    {"id": "task-d", "title": "Task D", "status": "pending"},
                    {"id": "task-c", "title": "Task C", "status": "pending"},
                    {"id": "task-a", "title": "Task A", "status": "pending"},
                    {"id": "task-b", "title": "Task B", "status": "pending"},
                ],
            }
        ],
    },
}

_VBRIEF_WITH_NARRATIVES = {
    "vBRIEFInfo": {"version": "0.5"},
    "plan": {
        "title": "Narrative Plan",
        "status": "pending",
        "narratives": {
            "Overview": "This plan covers the cutover.",
        },
        "items": [
            {
                "id": "phase-1",
                "title": "Phase 1",
                "status": "pending",
                "narrative": {"Description": "Foundation work."},
            }
        ],
    },
}


def _write_vbrief(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# generate_roadmap_content -- empty/missing directory
# ---------------------------------------------------------------------------


def test_empty_pending_dir_produces_valid_roadmap(roadmap_mod, tmp_path) -> None:
    """Empty pending/ must produce a valid ROADMAP.md with banner and empty message."""
    pending = tmp_path / "pending"
    pending.mkdir()
    content = roadmap_mod.generate_roadmap_content(pending)
    assert "AUTO-GENERATED" in content
    assert "DO NOT EDIT MANUALLY" in content
    assert "# Roadmap" in content
    assert "No pending work items." in content


def test_missing_pending_dir_produces_valid_roadmap(roadmap_mod, tmp_path) -> None:
    """Missing pending/ directory must produce a valid empty ROADMAP.md."""
    pending = tmp_path / "nonexistent"
    content = roadmap_mod.generate_roadmap_content(pending)
    assert "AUTO-GENERATED" in content
    assert "No pending work items." in content


# ---------------------------------------------------------------------------
# generate_roadmap_content -- single vBRIEF
# ---------------------------------------------------------------------------


def test_single_vbrief_renders_phases(roadmap_mod, tmp_path) -> None:
    """A single vBRIEF file should render its phases as H3 headings."""
    pending = tmp_path / "pending"
    _write_vbrief(pending / "2026-04-01-test.vbrief.json", _MINIMAL_VBRIEF)
    content = roadmap_mod.generate_roadmap_content(pending)
    assert "## Test Plan" in content
    assert "### phase-1: Phase 1: Foundation" in content
    assert "**task-a**" in content
    assert "**task-b**" in content


def test_banner_present(roadmap_mod, tmp_path) -> None:
    """Auto-generated banner must be at the top of rendered output."""
    pending = tmp_path / "pending"
    _write_vbrief(pending / "2026-04-01-test.vbrief.json", _MINIMAL_VBRIEF)
    content = roadmap_mod.generate_roadmap_content(pending)
    assert content.startswith("<!-- AUTO-GENERATED")
    assert "task roadmap:render" in content


# ---------------------------------------------------------------------------
# generate_roadmap_content -- issue references
# ---------------------------------------------------------------------------


def test_issue_refs_surfaced(roadmap_mod, tmp_path) -> None:
    """GitHub issue numbers from references must appear in the output."""
    pending = tmp_path / "pending"
    _write_vbrief(pending / "2026-04-01-feature.vbrief.json", _VBRIEF_WITH_REFS)
    content = roadmap_mod.generate_roadmap_content(pending)
    assert "#311" in content
    assert "#309" in content


def test_issue_refs_in_plan_heading(roadmap_mod, tmp_path) -> None:
    """Issue references should appear next to the plan title heading."""
    pending = tmp_path / "pending"
    _write_vbrief(pending / "2026-04-01-feature.vbrief.json", _VBRIEF_WITH_REFS)
    content = roadmap_mod.generate_roadmap_content(pending)
    # Should be in the H2 heading line
    for line in content.split("\n"):
        if line.startswith("## Feature Work"):
            assert "#311" in line
            assert "#309" in line
            break
    else:
        pytest.fail("H2 heading for Feature Work not found")


# ---------------------------------------------------------------------------
# generate_roadmap_content -- dependency ordering
# ---------------------------------------------------------------------------


def test_dependency_ordering(roadmap_mod, tmp_path) -> None:
    """Items should be ordered by dependency depth (items with no deps first)."""
    pending = tmp_path / "pending"
    _write_vbrief(pending / "2026-04-01-deps.vbrief.json", _VBRIEF_WITH_EDGES)
    content = roadmap_mod.generate_roadmap_content(pending)
    lines = content.split("\n")
    item_lines = [ln for ln in lines if ln.strip().startswith("- **task-")]
    # task-a has no deps (depth 0), task-b/task-c depend on task-a (depth 1),
    # task-d depends on task-b (depth 2)
    ids = []
    for ln in item_lines:
        for tid in ("task-a", "task-b", "task-c", "task-d"):
            if f"**{tid}**" in ln:
                ids.append(tid)
                break
    assert ids.index("task-a") < ids.index("task-b")
    assert ids.index("task-a") < ids.index("task-c")
    assert ids.index("task-b") < ids.index("task-d")


def test_dependency_annotation(roadmap_mod, tmp_path) -> None:
    """Items with dependencies should show 'depends on' annotation."""
    pending = tmp_path / "pending"
    _write_vbrief(pending / "2026-04-01-deps.vbrief.json", _VBRIEF_WITH_EDGES)
    content = roadmap_mod.generate_roadmap_content(pending)
    assert "(depends on: task-a)" in content


# ---------------------------------------------------------------------------
# Bilingual edge reader (#458) -- {from, to} vs {source, target}
# ---------------------------------------------------------------------------


def test_edge_map_from_to_keys(roadmap_mod) -> None:
    """Canonical {from, to} edges must populate the dep map (#458)."""
    dep_map = roadmap_mod._build_edge_map(_VBRIEF_WITH_EDGES)
    assert dep_map == {
        "task-b": ["task-a"],
        "task-c": ["task-a"],
        "task-d": ["task-b"],
    }


def test_edge_map_source_target_keys(roadmap_mod) -> None:
    """Legacy {source, target} edges must still populate the dep map (#458 regression)."""
    dep_map = roadmap_mod._build_edge_map(_VBRIEF_WITH_LEGACY_EDGES)
    assert dep_map == {
        "task-b": ["task-a"],
        "task-c": ["task-a"],
        "task-d": ["task-b"],
    }


def test_edge_map_mixed_keys_within_single_plan(roadmap_mod) -> None:
    """Mixed {from,to} and {source,target} edges must both be read; from/to wins (#458)."""
    dep_map = roadmap_mod._build_edge_map(_VBRIEF_WITH_MIXED_EDGES)
    # task-b depends on task-a (from/to)
    # task-d depends on task-b (legacy source/target)
    # task-c depends on task-a (from/to wins over ignored source/target)
    assert dep_map == {
        "task-b": ["task-a"],
        "task-d": ["task-b"],
        "task-c": ["task-a"],
    }
    # Explicitly confirm ignored-source did NOT leak into dependencies
    assert "ignored-target" not in dep_map
    assert all(
        "ignored-source" not in deps for deps in dep_map.values()
    ), "from/to must win over source/target when both are present"


def test_legacy_edges_produce_dependency_ordering(roadmap_mod, tmp_path) -> None:
    """Legacy {source, target} edges must still drive topological ordering (#458)."""
    pending = tmp_path / "pending"
    _write_vbrief(pending / "2026-04-01-legacy-deps.vbrief.json", _VBRIEF_WITH_LEGACY_EDGES)
    content = roadmap_mod.generate_roadmap_content(pending)
    lines = content.split("\n")
    item_lines = [ln for ln in lines if ln.strip().startswith("- **task-")]
    ids: list[str] = []
    for ln in item_lines:
        for tid in ("task-a", "task-b", "task-c", "task-d"):
            if f"**{tid}**" in ln:
                ids.append(tid)
                break
    assert ids.index("task-a") < ids.index("task-b")
    assert ids.index("task-a") < ids.index("task-c")
    assert ids.index("task-b") < ids.index("task-d")
    assert "(depends on: task-a)" in content


# ---------------------------------------------------------------------------
# generate_roadmap_content -- narratives
# ---------------------------------------------------------------------------


def test_plan_overview_rendered(roadmap_mod, tmp_path) -> None:
    """Plan-level Overview narrative should appear in the output."""
    pending = tmp_path / "pending"
    _write_vbrief(pending / "2026-04-01-narrative.vbrief.json", _VBRIEF_WITH_NARRATIVES)
    content = roadmap_mod.generate_roadmap_content(pending)
    assert "This plan covers the cutover." in content


def test_phase_narrative_rendered(roadmap_mod, tmp_path) -> None:
    """Phase-level narrative Description should appear in the output."""
    pending = tmp_path / "pending"
    _write_vbrief(pending / "2026-04-01-narrative.vbrief.json", _VBRIEF_WITH_NARRATIVES)
    content = roadmap_mod.generate_roadmap_content(pending)
    assert "Foundation work." in content


# ---------------------------------------------------------------------------
# generate_roadmap_content -- determinism
# ---------------------------------------------------------------------------


def test_deterministic_output(roadmap_mod, tmp_path) -> None:
    """Same input must always produce identical output."""
    pending = tmp_path / "pending"
    _write_vbrief(pending / "2026-04-01-test.vbrief.json", _MINIMAL_VBRIEF)
    content1 = roadmap_mod.generate_roadmap_content(pending)
    content2 = roadmap_mod.generate_roadmap_content(pending)
    assert content1 == content2


# ---------------------------------------------------------------------------
# generate_roadmap_content -- multiple vBRIEFs
# ---------------------------------------------------------------------------


def test_multiple_vbriefs_filename_order(roadmap_mod, tmp_path) -> None:
    """Multiple vBRIEF files should be processed in filename (sorted) order."""
    pending = tmp_path / "pending"
    vbrief_a = {
        "vBRIEFInfo": {"version": "0.5"},
        "plan": {"title": "Alpha Plan", "status": "pending", "items": []},
    }
    vbrief_b = {
        "vBRIEFInfo": {"version": "0.5"},
        "plan": {"title": "Beta Plan", "status": "pending", "items": []},
    }
    _write_vbrief(pending / "2026-01-01-alpha.vbrief.json", vbrief_a)
    _write_vbrief(pending / "2026-02-01-beta.vbrief.json", vbrief_b)
    content = roadmap_mod.generate_roadmap_content(pending)
    alpha_pos = content.index("Alpha Plan")
    beta_pos = content.index("Beta Plan")
    assert alpha_pos < beta_pos


# ---------------------------------------------------------------------------
# generate_roadmap_content -- malformed files
# ---------------------------------------------------------------------------


def test_malformed_json_skipped(roadmap_mod, tmp_path) -> None:
    """Malformed JSON files should be skipped without error."""
    pending = tmp_path / "pending"
    pending.mkdir(parents=True)
    (pending / "bad.vbrief.json").write_text("{not valid json", encoding="utf-8")
    _write_vbrief(pending / "good.vbrief.json", _MINIMAL_VBRIEF)
    content = roadmap_mod.generate_roadmap_content(pending)
    assert "Test Plan" in content


# ---------------------------------------------------------------------------
# generate_roadmap_content -- issue refs from URL only (no id field)
# ---------------------------------------------------------------------------


def test_issue_ref_from_url_only(roadmap_mod, tmp_path) -> None:
    """Issue numbers should be extracted from URL even without id field."""
    vbrief = {
        "vBRIEFInfo": {"version": "0.5"},
        "plan": {
            "title": "URL Ref Test",
            "status": "pending",
            "references": [
                {"type": "github-issue", "url": "https://github.com/deftai/directive/issues/42"},
            ],
            "items": [],
        },
    }
    pending = tmp_path / "pending"
    _write_vbrief(pending / "2026-04-01-url.vbrief.json", vbrief)
    content = roadmap_mod.generate_roadmap_content(pending)
    assert "#42" in content


# ---------------------------------------------------------------------------
# render_roadmap -- file writing
# ---------------------------------------------------------------------------


def test_render_writes_file(roadmap_mod, tmp_path) -> None:
    """render_roadmap() must create the output file."""
    pending = tmp_path / "pending"
    _write_vbrief(pending / "2026-04-01-test.vbrief.json", _MINIMAL_VBRIEF)
    out = tmp_path / "ROADMAP.md"
    ok, msg = roadmap_mod.render_roadmap(str(pending), str(out))
    assert ok is True
    assert out.exists()
    assert "✓" in msg


def test_render_empty_dir_writes_file(roadmap_mod, tmp_path) -> None:
    """render_roadmap() on empty dir must still create a valid output file."""
    pending = tmp_path / "pending"
    pending.mkdir()
    out = tmp_path / "ROADMAP.md"
    ok, msg = roadmap_mod.render_roadmap(str(pending), str(out))
    assert ok is True
    assert out.exists()
    content = out.read_text(encoding="utf-8")
    assert "No pending work items." in content


# ---------------------------------------------------------------------------
# check_drift
# ---------------------------------------------------------------------------


def test_drift_check_up_to_date(roadmap_mod, tmp_path) -> None:
    """check_drift() must return True when ROADMAP.md matches expected output."""
    pending = tmp_path / "pending"
    _write_vbrief(pending / "2026-04-01-test.vbrief.json", _MINIMAL_VBRIEF)
    out = tmp_path / "ROADMAP.md"
    roadmap_mod.render_roadmap(str(pending), str(out))
    ok, msg = roadmap_mod.check_drift(str(pending), str(out))
    assert ok is True
    assert "up to date" in msg


def test_drift_check_detects_drift(roadmap_mod, tmp_path) -> None:
    """check_drift() must return False when ROADMAP.md differs from expected."""
    pending = tmp_path / "pending"
    _write_vbrief(pending / "2026-04-01-test.vbrief.json", _MINIMAL_VBRIEF)
    out = tmp_path / "ROADMAP.md"
    out.write_text("stale content", encoding="utf-8")
    ok, msg = roadmap_mod.check_drift(str(pending), str(out))
    assert ok is False
    assert "drifted" in msg


def test_drift_check_missing_roadmap_no_vbriefs(roadmap_mod, tmp_path) -> None:
    """Missing ROADMAP.md with no pending vBRIEFs should be OK."""
    pending = tmp_path / "pending"
    pending.mkdir()
    out = tmp_path / "ROADMAP.md"
    ok, msg = roadmap_mod.check_drift(str(pending), str(out))
    assert ok is True


def test_drift_check_missing_roadmap_with_vbriefs(roadmap_mod, tmp_path) -> None:
    """Missing ROADMAP.md with pending vBRIEFs should be drift."""
    pending = tmp_path / "pending"
    _write_vbrief(pending / "2026-04-01-test.vbrief.json", _MINIMAL_VBRIEF)
    out = tmp_path / "ROADMAP.md"
    ok, msg = roadmap_mod.check_drift(str(pending), str(out))
    assert ok is False


# ---------------------------------------------------------------------------
# main() -- CLI
# ---------------------------------------------------------------------------


def test_main_render_mode(roadmap_mod, monkeypatch, tmp_path) -> None:
    """main() in render mode must create ROADMAP.md and return 0."""
    pending = tmp_path / "pending"
    _write_vbrief(pending / "2026-04-01-test.vbrief.json", _MINIMAL_VBRIEF)
    out = tmp_path / "ROADMAP.md"
    monkeypatch.setattr(sys, "argv", ["roadmap_render.py", str(pending), str(out)])
    result = roadmap_mod.main()
    assert result == 0
    assert out.exists()


def test_main_check_mode_up_to_date(roadmap_mod, monkeypatch, tmp_path) -> None:
    """main() with --check must return 0 when ROADMAP.md is current."""
    pending = tmp_path / "pending"
    _write_vbrief(pending / "2026-04-01-test.vbrief.json", _MINIMAL_VBRIEF)
    out = tmp_path / "ROADMAP.md"
    roadmap_mod.render_roadmap(str(pending), str(out))
    monkeypatch.setattr(sys, "argv", ["roadmap_render.py", str(pending), str(out), "--check"])
    result = roadmap_mod.main()
    assert result == 0


def test_main_check_mode_drift(roadmap_mod, monkeypatch, tmp_path) -> None:
    """main() with --check must return 1 when ROADMAP.md has drifted."""
    pending = tmp_path / "pending"
    _write_vbrief(pending / "2026-04-01-test.vbrief.json", _MINIMAL_VBRIEF)
    out = tmp_path / "ROADMAP.md"
    out.write_text("stale", encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["roadmap_render.py", str(pending), str(out), "--check"])
    result = roadmap_mod.main()
    assert result == 1


def test_main_empty_dir_returns_0(roadmap_mod, monkeypatch, tmp_path) -> None:
    """main() with empty pending dir must return 0 (valid empty ROADMAP.md)."""
    pending = tmp_path / "pending"
    pending.mkdir()
    out = tmp_path / "ROADMAP.md"
    monkeypatch.setattr(sys, "argv", ["roadmap_render.py", str(pending), str(out)])
    result = roadmap_mod.main()
    assert result == 0
    assert out.exists()


# ---------------------------------------------------------------------------
# Phase status rendering
# ---------------------------------------------------------------------------


def test_phase_status_rendered(roadmap_mod, tmp_path) -> None:
    """Phase status should appear in the heading as a code span."""
    pending = tmp_path / "pending"
    _write_vbrief(pending / "2026-04-01-test.vbrief.json", _MINIMAL_VBRIEF)
    content = roadmap_mod.generate_roadmap_content(pending)
    assert "`[pending]`" in content


# ---------------------------------------------------------------------------
# Edge case: vBRIEF with no plan key
# ---------------------------------------------------------------------------


def test_vbrief_without_plan_key(roadmap_mod, tmp_path) -> None:
    """A vBRIEF file missing the plan key should be handled gracefully."""
    vbrief = {"vBRIEFInfo": {"version": "0.5"}}
    pending = tmp_path / "pending"
    _write_vbrief(pending / "2026-04-01-noplan.vbrief.json", vbrief)
    content = roadmap_mod.generate_roadmap_content(pending)
    # Should not crash, should still have banner
    assert "AUTO-GENERATED" in content


# ---------------------------------------------------------------------------
# Cross-scope edges (P1 fix: max() on empty sequence)
# ---------------------------------------------------------------------------


def test_cross_scope_edges_no_crash(roadmap_mod, tmp_path) -> None:
    """Edges referencing items outside current scope must not crash."""
    vbrief = {
        "vBRIEFInfo": {"version": "0.5"},
        "plan": {
            "title": "Cross-scope Test",
            "status": "pending",
            "edges": [
                {"source": "external-item", "target": "task-a"},
            ],
            "items": [
                {
                    "id": "phase-1",
                    "title": "Phase 1",
                    "status": "pending",
                    "subItems": [
                        {"id": "task-a", "title": "Task A", "status": "pending"},
                    ],
                }
            ],
        },
    }
    pending = tmp_path / "pending"
    _write_vbrief(pending / "2026-04-01-cross.vbrief.json", vbrief)
    # Must not raise ValueError from max() on empty sequence
    content = roadmap_mod.generate_roadmap_content(pending)
    assert "Task A" in content


# ---------------------------------------------------------------------------
# render_roadmap error handling (P2 fix: OSError caught)
# ---------------------------------------------------------------------------


def test_render_to_invalid_path_returns_false(roadmap_mod, tmp_path) -> None:
    """render_roadmap() to an invalid path must return (False, error)."""
    pending = tmp_path / "pending"
    pending.mkdir()
    # Use a path that cannot be written (directory doesn't exist)
    out = str(tmp_path / "nonexistent" / "subdir" / "ROADMAP.md")
    ok, msg = roadmap_mod.render_roadmap(str(pending), out)
    assert ok is False
    assert "Failed" in msg


# ---------------------------------------------------------------------------
# --check flag position (P2 fix: flags before positionals)
# ---------------------------------------------------------------------------


def test_main_check_flag_before_positionals(
    roadmap_mod, monkeypatch, tmp_path
) -> None:
    """main() must work when --check appears before positional args."""
    pending = tmp_path / "pending"
    _write_vbrief(pending / "2026-04-01-test.vbrief.json", _MINIMAL_VBRIEF)
    out = tmp_path / "ROADMAP.md"
    roadmap_mod.render_roadmap(str(pending), str(out))
    monkeypatch.setattr(
        sys, "argv",
        ["roadmap_render.py", "--check", str(pending), str(out)],
    )
    result = roadmap_mod.main()
    assert result == 0


# ---------------------------------------------------------------------------
# Phase grouping from flat scope vBRIEFs (#383)
# ---------------------------------------------------------------------------

_SCOPE_VBRIEF_PHASE1 = {
    "vBRIEFInfo": {"version": "0.5"},
    "plan": {
        "title": "Add widget support",
        "status": "pending",
        "narratives": {
            "Description": "Add widget support",
            "Phase": "Phase 1 -- Foundation",
            "PhaseDescription": "Fix reported bugs blocking adoption.",
        },
        "references": [{"type": "github-issue", "id": "#100"}],
        "items": [],
    },
}

_SCOPE_VBRIEF_PHASE2 = {
    "vBRIEFInfo": {"version": "0.5"},
    "plan": {
        "title": "Dashboard redesign",
        "status": "pending",
        "narratives": {
            "Description": "Dashboard redesign",
            "Phase": "Phase 2 -- Features",
        },
        "references": [{"type": "github-issue", "id": "#200"}],
        "items": [],
    },
}

_SCOPE_VBRIEF_TIERED = {
    "vBRIEFInfo": {"version": "0.5"},
    "plan": {
        "title": "Core refactor",
        "status": "pending",
        "narratives": {
            "Description": "Core refactor",
            "Phase": "Phase 1 -- Foundation",
            "Tier": "Tier 1 -- Core",
        },
        "items": [],
    },
}

_COMPLETED_VBRIEF = {
    "vBRIEFInfo": {"version": "0.5"},
    "plan": {
        "title": "Initial setup",
        "status": "completed",
        "narratives": {
            "Description": "Initial setup",
            "Phase": "Completed",
        },
        "references": [{"type": "github-issue", "id": "#50"}],
        "items": [],
    },
}


def test_phase_grouping_from_scope_vbriefs(roadmap_mod, tmp_path) -> None:
    """Scope vBRIEFs must be grouped by Phase narrative key (#383)."""
    pending = tmp_path / "pending"
    completed = tmp_path / "completed"
    completed.mkdir(parents=True)
    _write_vbrief(pending / "2026-04-15-100-widget.vbrief.json", _SCOPE_VBRIEF_PHASE1)
    _write_vbrief(pending / "2026-04-15-200-dashboard.vbrief.json", _SCOPE_VBRIEF_PHASE2)
    content = roadmap_mod.generate_roadmap_content(pending, completed_dir=completed)
    assert "## Phase 1 -- Foundation" in content
    assert "## Phase 2 -- Features" in content
    # Phase 1 items should appear before Phase 2
    p1_pos = content.index("Phase 1")
    p2_pos = content.index("Phase 2")
    assert p1_pos < p2_pos


def test_phase_description_rendered(roadmap_mod, tmp_path) -> None:
    """Phase descriptions from PhaseDescription narrative must render (#383)."""
    pending = tmp_path / "pending"
    completed = tmp_path / "completed"
    completed.mkdir(parents=True)
    _write_vbrief(pending / "2026-04-15-100-widget.vbrief.json", _SCOPE_VBRIEF_PHASE1)
    content = roadmap_mod.generate_roadmap_content(pending, completed_dir=completed)
    assert "Fix reported bugs blocking adoption." in content


def test_completed_section_rendered(roadmap_mod, tmp_path) -> None:
    """Completed vBRIEFs must appear in a Completed section (#383)."""
    pending = tmp_path / "pending"
    pending.mkdir(parents=True)
    completed = tmp_path / "completed"
    _write_vbrief(completed / "2026-04-15-50-initial-setup.vbrief.json", _COMPLETED_VBRIEF)
    content = roadmap_mod.generate_roadmap_content(pending, completed_dir=completed)
    assert "## Completed" in content
    assert "Initial setup" in content
    assert "#50" in content


def test_tier_subgrouping_rendered(roadmap_mod, tmp_path) -> None:
    """Tier subgroupings within phases must render as ### headings (#383)."""
    pending = tmp_path / "pending"
    completed = tmp_path / "completed"
    completed.mkdir(parents=True)
    _write_vbrief(pending / "2026-04-15-100-widget.vbrief.json", _SCOPE_VBRIEF_PHASE1)
    _write_vbrief(pending / "2026-04-15-101-refactor.vbrief.json", _SCOPE_VBRIEF_TIERED)
    content = roadmap_mod.generate_roadmap_content(pending, completed_dir=completed)
    assert "### Tier 1 -- Core" in content


def test_no_completed_section_when_empty(roadmap_mod, tmp_path) -> None:
    """No Completed section when completed/ is empty (#383)."""
    pending = tmp_path / "pending"
    completed = tmp_path / "completed"
    completed.mkdir(parents=True)
    _write_vbrief(pending / "2026-04-15-100-widget.vbrief.json", _SCOPE_VBRIEF_PHASE1)
    content = roadmap_mod.generate_roadmap_content(pending, completed_dir=completed)
    assert "## Completed" not in content


def test_scope_items_render_issue_refs(roadmap_mod, tmp_path) -> None:
    """Scope vBRIEF items must show issue refs in the rendered list (#383)."""
    pending = tmp_path / "pending"
    completed = tmp_path / "completed"
    completed.mkdir(parents=True)
    _write_vbrief(pending / "2026-04-15-100-widget.vbrief.json", _SCOPE_VBRIEF_PHASE1)
    content = roadmap_mod.generate_roadmap_content(pending, completed_dir=completed)
    assert "**#100**" in content
    assert "Add widget support" in content


def test_drift_check_completed_only_detects_drift(roadmap_mod, tmp_path) -> None:
    """check_drift must detect drift when completed/ has items but ROADMAP.md missing."""
    vbrief_dir = tmp_path / "vbrief"
    pending = vbrief_dir / "pending"
    pending.mkdir(parents=True)
    completed = vbrief_dir / "completed"
    _write_vbrief(completed / "2026-04-15-50-done.vbrief.json", _COMPLETED_VBRIEF)
    out = tmp_path / "ROADMAP.md"
    ok, msg = roadmap_mod.check_drift(str(pending), str(out))
    assert ok is False
    assert "vBRIEFs found" in msg
