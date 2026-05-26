"""Tests for scripts/validate_strategy_output.py -- the #1166 s2 deterministic
v0.20 strategy output shape gate.

Covers the contract:
- Date-prefixed filenames required under all vbrief/ lifecycle dirs (catches bare
  names from pre-v0.20 interview etc.).
- PROJECT-DEFINITION.vbrief.json required at vbrief/ root.
- Legacy vbrief/specification.vbrief.json forbidden for generated user projects
  (tolerated only for the deft framework source tree itself via heuristic).
- Clear actionable errors that cite the v0-20 contract / #1166.
- CLI surface (exit codes, --project-root, --strict, --quiet).
- Integration with synthetic tmp trees (mirrors test_verify_encoding.py and
  test_preflight_*.py patterns).

New source + test per AGENTS.md requirement for scripts/*.py.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "validate_strategy_output.py"


def _load_module():
    """Load the validator as a module for direct function testing."""
    spec = importlib.util.spec_from_file_location("validate_strategy_output", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["validate_strategy_output"] = mod
    spec.loader.exec_module(mod)
    return mod


def test_module_loads_and_has_validate_function():
    mod = _load_module()
    assert hasattr(mod, "validate_strategy_output")
    assert hasattr(mod, "main")


def test_conformant_synthetic_tree_passes(tmp_path: Path):
    """A fully conformant synthetic v0.20 tree (dated + PROJECT-DEF) passes."""
    mod = _load_module()
    vbrief = tmp_path / "vbrief"
    vbrief.mkdir()
    (vbrief / "PROJECT-DEFINITION.vbrief.json").write_text("{}", encoding="utf-8")
    for d in ("proposed", "active"):
        (vbrief / d).mkdir()
    (vbrief / "proposed" / "2026-05-26-conformant-story.vbrief.json").write_text(
        "{}", encoding="utf-8"
    )
    (vbrief / "active" / "2026-05-20-some-active.vbrief.json").write_text(
        "{}", encoding="utf-8"
    )

    errors = mod.validate_strategy_output(tmp_path)
    assert errors == [], f"Synthetic conformant tree failed: {errors}"


def test_missing_project_definition_flags(tmp_path: Path):
    mod = _load_module()
    vbrief = tmp_path / "vbrief"
    vbrief.mkdir()
    (vbrief / "proposed").mkdir()
    # dated file
    (vbrief / "proposed" / "2026-05-26-foo-bar.vbrief.json").write_text("{}", encoding="utf-8")
    # deliberately no PROJECT-DEFINITION.vbrief.json

    errors = mod.validate_strategy_output(tmp_path)
    assert any("PROJECT-DEFINITION.vbrief.json" in e for e in errors)


def test_non_date_prefixed_flags(tmp_path: Path):
    mod = _load_module()
    vbrief = tmp_path / "vbrief"
    vbrief.mkdir()
    proposed = vbrief / "proposed"
    proposed.mkdir()
    (proposed / "scaffold.vbrief.json").write_text("{}", encoding="utf-8")  # bad
    (proposed / "2026-05-26-good-one.vbrief.json").write_text("{}", encoding="utf-8")
    (vbrief / "PROJECT-DEFINITION.vbrief.json").write_text("{}", encoding="utf-8")

    errors = mod.validate_strategy_output(tmp_path)
    assert any("scaffold.vbrief.json" in e and "Non-conformant filename" in e for e in errors)
    assert any("YYYY-MM-DD" in e for e in errors)


def test_legacy_spec_vbrief_forbidden_in_user_project(tmp_path: Path):
    mod = _load_module()
    vbrief = tmp_path / "vbrief"
    vbrief.mkdir()
    (vbrief / "specification.vbrief.json").write_text('{"old": true}', encoding="utf-8")
    (vbrief / "PROJECT-DEFINITION.vbrief.json").write_text("{}", encoding="utf-8")
    proposed = vbrief / "proposed"
    proposed.mkdir()
    (proposed / "2026-05-26-foo.vbrief.json").write_text("{}", encoding="utf-8")

    # Not a deft framework root (no AGENTS.md + Taskfile + strategies/)
    errors = mod.validate_strategy_output(tmp_path)
    assert any("specification.vbrief.json" in e and "Legacy artifact" in e for e in errors)


def test_legacy_spec_vbrief_tolerated_for_framework_heuristic(tmp_path: Path):
    mod = _load_module()
    vbrief = tmp_path / "vbrief"
    vbrief.mkdir()
    (vbrief / "specification.vbrief.json").write_text('{"old": true}', encoding="utf-8")
    (vbrief / "PROJECT-DEFINITION.vbrief.json").write_text("{}", encoding="utf-8")
    proposed = vbrief / "proposed"
    proposed.mkdir()
    (proposed / "2026-05-26-foo.vbrief.json").write_text("{}", encoding="utf-8")

    # Fake a framework root
    (tmp_path / "AGENTS.md").write_text("# Deft", encoding="utf-8")
    (tmp_path / "Taskfile.yml").write_text("version: '3'", encoding="utf-8")
    (tmp_path / "strategies").mkdir()

    errors = mod.validate_strategy_output(tmp_path)
    assert not any("specification.vbrief.json" in e for e in errors), (
        "Framework heuristic should have tolerated the legacy spec.vbrief.json"
    )


def test_cli_exit_codes_and_messages(tmp_path: Path, capsys):
    mod = _load_module()

    # Good tree
    vbrief = tmp_path / "vbrief"
    vbrief.mkdir()
    (vbrief / "PROJECT-DEFINITION.vbrief.json").write_text("{}", encoding="utf-8")
    proposed = vbrief / "proposed"
    proposed.mkdir()
    (proposed / "2026-05-26-good.vbrief.json").write_text("{}", encoding="utf-8")

    code = mod.main(["--project-root", str(tmp_path), "--quiet"])
    assert code == 0
    captured = capsys.readouterr()
    assert "✓" not in captured.out  # quiet

    # Bad tree
    bad_dir = tmp_path / "bad"
    bad_dir.mkdir()
    (bad_dir / "vbrief").mkdir()
    (bad_dir / "vbrief" / "specification.vbrief.json").write_text("{}", encoding="utf-8")

    code = mod.main(["--project-root", str(bad_dir)])
    assert code == 1
    captured = capsys.readouterr()
    assert "FAILED" in captured.err
    assert "1166" in captured.err or "v0-20-contract" in captured.err


def test_cli_invoked_via_subprocess(tmp_path: Path):
    """Smoke the actual script entry point (uv not required for test)."""
    vbrief = tmp_path / "vbrief"
    vbrief.mkdir()
    (vbrief / "PROJECT-DEFINITION.vbrief.json").write_text("{}", encoding="utf-8")
    proposed = vbrief / "proposed"
    proposed.mkdir()
    (proposed / "2026-05-26-subprocess-test.vbrief.json").write_text("{}", encoding="utf-8")

    proc = subprocess.run(
        [sys.executable, str(SCRIPT_PATH), "--project-root", str(tmp_path), "--quiet"],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0

    # Bad case (non-strict signals still error even under --strict)
    bad = tmp_path / "bad2"
    bad.mkdir()
    (bad / "vbrief").mkdir()  # vbrief/ exists but empty -> hits missing PROJECT-DEF etc.
    proc = subprocess.run(
        [sys.executable, str(SCRIPT_PATH), "--project-root", str(bad), "--strict"],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 1
    assert "vbrief/" in proc.stderr or "PROJECT-DEFINITION" in proc.stderr

    # Exercise the previously untested --strict branch for entirely missing vbrief/ dir
    # (per Greptile review on #1363; the strict error is only raised when vbrief/ does not exist at all)
    nob = tmp_path / "nob"
    nob.mkdir()
    # deliberately create no vbrief/ subdirectory
    proc = subprocess.run(
        [sys.executable, str(SCRIPT_PATH), "--project-root", str(nob), "--strict"],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 1
    assert "vbrief/ directory missing entirely" in proc.stderr
    assert "v0.20 strategies must emit at least" in proc.stderr
