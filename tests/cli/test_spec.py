"""
test_spec.py — Unit tests for scripts/spec_validate.py and scripts/spec_render.py.

Implementation: IMPLEMENTATION.md Phase 5.3

Covers spec_validate:
  - validate_spec: file missing → False
  - validate_spec: invalid JSON → False
  - validate_spec: valid JSON → True
  - main(): no args → exit code 2
  - main(): missing file → exit code 1
  - main(): valid file → exit code 0

Covers spec_render:
  - render_spec: file missing → False (delegates to validate)
  - render_spec: invalid JSON → False (delegates to validate)
  - render_spec: valid JSON, status != 'approved' → False
  - render_spec: valid JSON, status == 'approved' → True, writes SPECIFICATION.md
  - render_spec: renders title, overview, tasks correctly
  - render_spec: tasks with list fields rendered as bullet points
  - main(): no args → exit code 2
  - main(): not-approved file → exit code 1
  - main(): approved file → exit code 0, output file created

Author: Scott Adams (msadams) — 2026-03-12
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Load scripts via importlib (avoids sys.path pollution at import time)
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_SCRIPTS_DIR = _REPO_ROOT / "scripts"
_VALIDATE_PY = _SCRIPTS_DIR / "spec_validate.py"
_RENDER_PY = _SCRIPTS_DIR / "spec_render.py"


@pytest.fixture(scope="session")
def validate_mod():
    """Load scripts/spec_validate.py as a module once per session."""
    spec = importlib.util.spec_from_file_location("spec_validate", _VALIDATE_PY)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


@pytest.fixture(scope="session")
def render_mod():
    """Load scripts/spec_render.py as a module once per session."""
    # Ensure scripts/ is on path before loading so the internal import works
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

_MINIMAL_APPROVED = {
    "vBRIEFInfo": {"version": "0.5"},
    "plan": {
        "title": "Test Spec",
        "status": "approved",
        "items": [],
    },
}

_MINIMAL_DRAFT = {
    "vBRIEFInfo": {"version": "0.5"},
    "plan": {
        "title": "Test Spec",
        "status": "draft",
        "items": [],
    },
}

_FULL_APPROVED = {
    "vBRIEFInfo": {"version": "0.5"},
    "plan": {
        "title": "Full Spec",
        "status": "approved",
        "narratives": {
            "Overview": "A complete specification.",
        },
        "items": [
            {
                "id": "T1",
                "title": "Build the thing",
                "status": "pending",
                "narrative": {
                    "Description": "This is the narrative.",
                    "Acceptance": "Criterion A; Criterion B",
                },
            },
            {
                "id": "T2",
                "title": "Fallback title key",
                "status": "completed",
                "narrative": {
                    "Description": "Because it matters.",
                },
            },
        ],
    },
}


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


# ---------------------------------------------------------------------------
# spec_validate — validate_spec()
# ---------------------------------------------------------------------------


def test_validate_missing_file_returns_false(validate_mod, tmp_path) -> None:
    """validate_spec() must return False when the file does not exist."""
    missing = str(tmp_path / "nonexistent.json")
    ok, msg = validate_mod.validate_spec(missing)
    assert ok is False
    assert "not found" in msg


def test_validate_missing_file_message_contains_path(validate_mod, tmp_path) -> None:
    """Error message must include the requested path."""
    missing = str(tmp_path / "nonexistent.json")
    _, msg = validate_mod.validate_spec(missing)
    assert "nonexistent.json" in msg


def test_validate_invalid_json_returns_false(validate_mod, tmp_path) -> None:
    """validate_spec() must return False for a file that is not valid JSON."""
    bad = tmp_path / "bad.json"
    bad.write_text("{not valid json", encoding="utf-8")
    ok, msg = validate_mod.validate_spec(str(bad))
    assert ok is False
    assert "not valid JSON" in msg


def test_validate_valid_json_returns_true(validate_mod, tmp_path) -> None:
    """validate_spec() must return True for a well-formed JSON file."""
    good = tmp_path / "good.json"
    _write_json(good, _MINIMAL_APPROVED)
    ok, msg = validate_mod.validate_spec(str(good))
    assert ok is True
    assert "✓" in msg


def test_validate_success_message_contains_filename(validate_mod, tmp_path) -> None:
    """Success message must include the filename."""
    good = tmp_path / "specification.vbrief.json"
    _write_json(good, _MINIMAL_APPROVED)
    _, msg = validate_mod.validate_spec(str(good))
    assert "specification.vbrief.json" in msg


# ---------------------------------------------------------------------------
# spec_validate — main()
# ---------------------------------------------------------------------------


def test_validate_main_no_args_returns_2(validate_mod, monkeypatch) -> None:
    """main() must return exit code 2 when called with no arguments."""
    monkeypatch.setattr(sys, "argv", ["spec_validate.py"])
    result = validate_mod.main()
    assert result == 2


def test_validate_main_missing_file_returns_1(validate_mod, monkeypatch, tmp_path) -> None:
    """main() must return exit code 1 for a missing file."""
    missing = str(tmp_path / "missing.json")
    monkeypatch.setattr(sys, "argv", ["spec_validate.py", missing])
    result = validate_mod.main()
    assert result == 1


def test_validate_main_valid_file_returns_0(validate_mod, monkeypatch, tmp_path) -> None:
    """main() must return exit code 0 for a valid file."""
    good = tmp_path / "spec.json"
    _write_json(good, _MINIMAL_APPROVED)
    monkeypatch.setattr(sys, "argv", ["spec_validate.py", str(good)])
    result = validate_mod.main()
    assert result == 0


# ---------------------------------------------------------------------------
# spec_render — render_spec()
# ---------------------------------------------------------------------------


def test_render_missing_file_returns_false(render_mod, tmp_path) -> None:
    """render_spec() must return False when the spec file does not exist."""
    ok, msg = render_mod.render_spec(
        str(tmp_path / "missing.json"),
        str(tmp_path / "SPECIFICATION.md"),
    )
    assert ok is False
    assert "not found" in msg


def test_render_invalid_json_returns_false(render_mod, tmp_path) -> None:
    """render_spec() must return False for invalid JSON."""
    bad = tmp_path / "bad.json"
    bad.write_text("{garbage", encoding="utf-8")
    ok, msg = render_mod.render_spec(str(bad), str(tmp_path / "SPECIFICATION.md"))
    assert ok is False
    assert "not valid JSON" in msg


def test_render_not_approved_returns_false(render_mod, tmp_path) -> None:
    """render_spec() must return False when status is not 'approved'."""
    spec_file = tmp_path / "spec.json"
    _write_json(spec_file, _MINIMAL_DRAFT)
    ok, msg = render_mod.render_spec(str(spec_file), str(tmp_path / "SPECIFICATION.md"))
    assert ok is False
    assert "draft" in msg
    assert "approved" in msg


def test_render_not_approved_does_not_write_file(render_mod, tmp_path) -> None:
    """render_spec() must not create the output file when status is not approved."""
    spec_file = tmp_path / "spec.json"
    out_file = tmp_path / "SPECIFICATION.md"
    _write_json(spec_file, _MINIMAL_DRAFT)
    render_mod.render_spec(str(spec_file), str(out_file))
    assert not out_file.exists()


def test_render_approved_returns_true(render_mod, tmp_path) -> None:
    """render_spec() must return True for an approved spec."""
    spec_file = tmp_path / "spec.json"
    out_file = tmp_path / "SPECIFICATION.md"
    _write_json(spec_file, _MINIMAL_APPROVED)
    ok, msg = render_mod.render_spec(str(spec_file), str(out_file))
    assert ok is True
    assert "✓" in msg


def test_render_creates_output_file(render_mod, tmp_path) -> None:
    """render_spec() must create the output SPECIFICATION.md file."""
    spec_file = tmp_path / "spec.json"
    out_file = tmp_path / "SPECIFICATION.md"
    _write_json(spec_file, _MINIMAL_APPROVED)
    render_mod.render_spec(str(spec_file), str(out_file))
    assert out_file.exists()


def test_render_output_contains_title(render_mod, tmp_path) -> None:
    """Rendered markdown must contain the spec title as an H1."""
    spec_file = tmp_path / "spec.json"
    out_file = tmp_path / "SPECIFICATION.md"
    _write_json(spec_file, _MINIMAL_APPROVED)
    render_mod.render_spec(str(spec_file), str(out_file))
    content = out_file.read_text(encoding="utf-8")
    assert "# Test Spec" in content


def test_render_output_contains_overview(render_mod, tmp_path) -> None:
    """Rendered markdown must contain the overview text."""
    spec_file = tmp_path / "spec.json"
    out_file = tmp_path / "SPECIFICATION.md"
    _write_json(spec_file, _FULL_APPROVED)
    render_mod.render_spec(str(spec_file), str(out_file))
    content = out_file.read_text(encoding="utf-8")
    assert "A complete specification." in content


def test_render_output_contains_task_heading(render_mod, tmp_path) -> None:
    """Rendered markdown must contain item headings as H2s."""
    spec_file = tmp_path / "spec.json"
    out_file = tmp_path / "SPECIFICATION.md"
    _write_json(spec_file, _FULL_APPROVED)
    render_mod.render_spec(str(spec_file), str(out_file))
    content = out_file.read_text(encoding="utf-8")
    assert "## T1: Build the thing" in content


def test_render_output_acceptance_as_bullets(render_mod, tmp_path) -> None:
    """Acceptance criteria in narrative must be rendered as markdown bullet points."""
    spec_file = tmp_path / "spec.json"
    out_file = tmp_path / "SPECIFICATION.md"
    _write_json(spec_file, _FULL_APPROVED)
    render_mod.render_spec(str(spec_file), str(out_file))
    content = out_file.read_text(encoding="utf-8")
    assert "- Criterion A" in content
    assert "- Criterion B" in content


def test_render_output_item_title(render_mod, tmp_path) -> None:
    """Items using 'title' field must render correctly."""
    spec_file = tmp_path / "spec.json"
    out_file = tmp_path / "SPECIFICATION.md"
    _write_json(spec_file, _FULL_APPROVED)
    render_mod.render_spec(str(spec_file), str(out_file))
    content = out_file.read_text(encoding="utf-8")
    assert "## T2: Fallback title key" in content


def test_render_output_plan_title_as_h1(render_mod, tmp_path) -> None:
    """plan.title must render as the H1 heading."""
    spec = {
        "vBRIEFInfo": {"version": "0.5"},
        "plan": {"title": "Plan Title", "status": "approved", "items": []},
    }
    spec_file = tmp_path / "spec.json"
    out_file = tmp_path / "SPECIFICATION.md"
    _write_json(spec_file, spec)
    render_mod.render_spec(str(spec_file), str(out_file))
    content = out_file.read_text(encoding="utf-8")
    assert "# Plan Title" in content


# ---------------------------------------------------------------------------
# spec_render — main()
# ---------------------------------------------------------------------------


def test_render_main_no_args_returns_2(render_mod, monkeypatch) -> None:
    """main() must return exit code 2 when called with no arguments."""
    monkeypatch.setattr(sys, "argv", ["spec_render.py"])
    result = render_mod.main()
    assert result == 2


def test_render_main_not_approved_returns_1(render_mod, monkeypatch, tmp_path) -> None:
    """main() must return exit code 1 for a draft spec."""
    spec_file = tmp_path / "spec.json"
    out_file = tmp_path / "SPECIFICATION.md"
    _write_json(spec_file, _MINIMAL_DRAFT)
    monkeypatch.setattr(sys, "argv", ["spec_render.py", str(spec_file), str(out_file)])
    result = render_mod.main()
    assert result == 1


def test_render_main_approved_returns_0(render_mod, monkeypatch, tmp_path) -> None:
    """main() must return exit code 0 for an approved spec."""
    spec_file = tmp_path / "spec.json"
    out_file = tmp_path / "SPECIFICATION.md"
    _write_json(spec_file, _MINIMAL_APPROVED)
    monkeypatch.setattr(sys, "argv", ["spec_render.py", str(spec_file), str(out_file)])
    result = render_mod.main()
    assert result == 0
    assert out_file.exists()


def test_render_main_default_output_path(render_mod, monkeypatch, tmp_path) -> None:
    """main() must derive output path from spec_file grandparent when no out_file given."""
    vbrief_dir = tmp_path / "vbrief"
    vbrief_dir.mkdir()
    spec_file = vbrief_dir / "specification.vbrief.json"
    _write_json(spec_file, _MINIMAL_APPROVED)
    monkeypatch.setattr(sys, "argv", ["spec_render.py", str(spec_file)])
    result = render_mod.main()
    assert result == 0
    assert (tmp_path / "SPECIFICATION.md").exists()


# ---------------------------------------------------------------------------
# spec_validate — schema edge cases
# ---------------------------------------------------------------------------


def test_validate_missing_vbriefinfo(validate_mod, tmp_path) -> None:
    """validate_spec must fail when vBRIEFInfo is missing."""
    spec_file = tmp_path / "spec.json"
    _write_json(spec_file, {"plan": {"title": "T", "status": "approved", "items": []}})
    ok, msg = validate_mod.validate_spec(str(spec_file))
    assert ok is False
    assert "vBRIEFInfo" in msg


def test_validate_missing_plan(validate_mod, tmp_path) -> None:
    """validate_spec must fail when plan is missing."""
    spec_file = tmp_path / "spec.json"
    _write_json(spec_file, {"vBRIEFInfo": {"version": "0.5"}})
    ok, msg = validate_mod.validate_spec(str(spec_file))
    assert ok is False
    assert "plan" in msg


def test_validate_plan_missing_required_fields(validate_mod, tmp_path) -> None:
    """validate_spec must fail when plan is missing title/status/items."""
    spec_file = tmp_path / "spec.json"
    _write_json(spec_file, {"vBRIEFInfo": {"version": "0.5"}, "plan": {}})
    ok, msg = validate_mod.validate_spec(str(spec_file))
    assert ok is False
    assert "title" in msg


def test_validate_legacy_flat_format(validate_mod, tmp_path) -> None:
    """validate_spec must detect legacy flat-format keys."""
    spec_file = tmp_path / "spec.json"
    _write_json(spec_file, {
        "vBRIEFInfo": {"version": "0.5"},
        "plan": {"title": "T", "status": "approved", "items": []},
        "tasks": [],
    })
    ok, msg = validate_mod.validate_spec(str(spec_file))
    assert ok is False
    assert "legacy" in msg


def test_validate_plan_items_not_array(validate_mod, tmp_path) -> None:
    """validate_spec must fail when plan.items is not an array."""
    spec_file = tmp_path / "spec.json"
    _write_json(spec_file, {
        "vBRIEFInfo": {"version": "0.5"},
        "plan": {"title": "T", "status": "approved", "items": "bad"},
    })
    ok, msg = validate_mod.validate_spec(str(spec_file))
    assert ok is False
    assert "array" in msg


def test_validate_plan_item_missing_title(validate_mod, tmp_path) -> None:
    """validate_spec must fail when a plan item is missing title."""
    spec_file = tmp_path / "spec.json"
    _write_json(spec_file, {
        "vBRIEFInfo": {"version": "0.5"},
        "plan": {
            "title": "T", "status": "approved",
            "items": [{"id": "x", "status": "pending"}],
        },
    })
    ok, msg = validate_mod.validate_spec(str(spec_file))
    assert ok is False
    assert "title" in msg


# ---------------------------------------------------------------------------
# spec_render — edge cases
# ---------------------------------------------------------------------------


def test_render_item_with_metadata_dependencies(render_mod, tmp_path) -> None:
    """render_spec must render dependencies from item.metadata.dependencies."""
    spec = {
        "vBRIEFInfo": {"version": "0.5"},
        "plan": {
            "title": "Deps Test", "status": "approved",
            "items": [{
                "id": "T1", "title": "Task", "status": "pending",
                "metadata": {"dependencies": ["T0"]},
            }],
        },
    }
    spec_file = tmp_path / "spec.json"
    out_file = tmp_path / "SPECIFICATION.md"
    _write_json(spec_file, spec)
    render_mod.render_spec(str(spec_file), str(out_file))
    content = out_file.read_text(encoding="utf-8")
    assert "**Depends on**: T0" in content


def test_render_item_with_traces(render_mod, tmp_path) -> None:
    """render_spec must render Traces from item narrative."""
    spec = {
        "vBRIEFInfo": {"version": "0.5"},
        "plan": {
            "title": "Traces Test", "status": "approved",
            "items": [{
                "id": "T1", "title": "Task", "status": "pending",
                "narrative": {"Traces": "FR-1, FR-2"},
            }],
        },
    }
    spec_file = tmp_path / "spec.json"
    out_file = tmp_path / "SPECIFICATION.md"
    _write_json(spec_file, spec)
    render_mod.render_spec(str(spec_file), str(out_file))
    content = out_file.read_text(encoding="utf-8")
    assert "**Traces**: FR-1, FR-2" in content

