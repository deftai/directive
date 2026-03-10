"""
test_validate.py — Tests for cmd_validate.

Subphase 3.4 of the CLI regression suite (SPECIFICATION.md).

Tests:
  - Valid state: exits without error against a valid temp deft directory
  - Missing file: reports failure when a required file is absent

Author: Scott Adams (msadams) — 2026-03-10
"""

from pathlib import Path


def _create_valid_deft_dir(base: Path) -> None:
    """Populate *base* with the files cmd_validate checks for.

    Required files (from run:cmd_validate):
      - main.md
      - core/user.md
      - coding/coding.md
      - REFERENCES.md
      - languages/*.md  (at least one)
    """
    (base / "main.md").write_text("# Main\n")
    (base / "core").mkdir(exist_ok=True)
    (base / "core" / "user.md").write_text("# User\n")
    (base / "coding").mkdir(exist_ok=True)
    (base / "coding" / "coding.md").write_text("# Coding\n")
    (base / "REFERENCES.md").write_text("# References\n")
    (base / "languages").mkdir(exist_ok=True)
    (base / "languages" / "python.md").write_text("# Python\n")


def test_validate_valid_state(
    run_command, deft_run_module, monkeypatch, tmp_path
):
    """cmd_validate exits 0 when all required files are present."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    _create_valid_deft_dir(tmp_path)
    monkeypatch.setattr(deft_run_module, "get_script_dir", lambda: tmp_path)

    result = run_command("cmd_validate", [])

    assert result.return_code == 0, (
        f"Expected rc=0 but got {result.return_code}\n{result.stdout}"
    )


def test_validate_missing_file(
    run_command, deft_run_module, monkeypatch, tmp_path
):
    """cmd_validate reports failure when a required file is absent."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    _create_valid_deft_dir(tmp_path)
    # Remove a required file to trigger a validation error.
    (tmp_path / "main.md").unlink()
    monkeypatch.setattr(deft_run_module, "get_script_dir", lambda: tmp_path)

    result = run_command("cmd_validate", [])

    assert result.return_code == 1, (
        f"Expected rc=1 for missing file but got {result.return_code}"
    )
    assert "Missing" in result.stdout or "missing" in result.stdout.lower(), (
        "Expected 'Missing' in output for absent required file"
    )
