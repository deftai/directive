"""
test_doctor.py — Tests for cmd_doctor.

Subphase 3.5 of the CLI regression suite (SPECIFICATION.md).

Tests:
  - Runs without crash: cmd_doctor completes without exception
  - Output contains checks: stdout includes at least one check result (✓ or ⚠)

Author: Scott Adams (msadams) — 2026-03-10
"""


def test_doctor_no_crash(run_command, deft_run_module, monkeypatch):
    """cmd_doctor completes without exception."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)

    result = run_command("cmd_doctor", [])

    assert result.return_code in (0, None), (
        f"Expected success, got rc={result.return_code}\n{result.stderr}"
    )


def test_doctor_output_contains_checks(run_command, deft_run_module, monkeypatch):
    """cmd_doctor stdout includes at least one check result line (✓ or ⚠)."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)

    result = run_command("cmd_doctor", [])

    has_success = "\u2713" in result.stdout   # ✓
    has_warning = "\u26a0" in result.stdout   # ⚠
    has_error = "\u2717" in result.stdout     # ✗
    assert has_success or has_warning or has_error, (
        f"Expected at least one check symbol (✓/⚠/✗) in stdout:\n{result.stdout}"
    )
