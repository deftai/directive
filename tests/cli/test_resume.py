"""
test_resume.py — Tests for Ctrl+C resume protection (issue #8).

Tests:
  - Helper function roundtrip (_save_progress, _load_progress, _clear_progress)
  - Corrupt/missing progress file handling
  - _atomic_write crash safety
  - _progress_path naming convention
  - Bootstrap resume: progress file detected, answers restored
  - Bootstrap discard: progress file detected, user declines, fresh start
  - Ctrl+C simulation: KeyboardInterrupt mid-questionnaire leaves progress on disk

Author: Scott Adams (msadams) — 2026-03-16
"""

import contextlib
from pathlib import Path

# ── Helper function tests ──────────────────────────────────────────


def test_progress_path_convention(deft_run_module):
    """_progress_path returns .{name}.progress in the same directory."""
    p = deft_run_module._progress_path(Path("/tmp/deft/USER.md"))
    assert p == Path("/tmp/deft/.USER.md.progress")


def test_save_load_roundtrip(deft_run_module, tmp_path):
    """_save_progress + _load_progress preserves data."""
    prog = tmp_path / ".TEST.progress"
    data = {"user_name": "Alice", "coverage": "90", "use_soul": True}
    deft_run_module._save_progress(prog, data)
    assert prog.exists()
    loaded = deft_run_module._load_progress(prog)
    assert loaded == data


def test_load_missing_returns_empty(deft_run_module, tmp_path):
    """_load_progress returns {} when file does not exist."""
    prog = tmp_path / ".MISSING.progress"
    assert deft_run_module._load_progress(prog) == {}


def test_load_corrupt_returns_empty(deft_run_module, tmp_path):
    """_load_progress returns {} on corrupt JSON."""
    prog = tmp_path / ".BAD.progress"
    prog.write_text("NOT JSON {{", encoding="utf-8")
    assert deft_run_module._load_progress(prog) == {}


def test_clear_progress_deletes_file(deft_run_module, tmp_path):
    """_clear_progress removes the progress file."""
    prog = tmp_path / ".DEL.progress"
    prog.write_text("{}", encoding="utf-8")
    deft_run_module._clear_progress(prog)
    assert not prog.exists()


def test_clear_progress_noop_when_missing(deft_run_module, tmp_path):
    """_clear_progress is a no-op when file doesn't exist."""
    prog = tmp_path / ".NOPE.progress"
    deft_run_module._clear_progress(prog)  # should not raise


def test_atomic_write_creates_file(deft_run_module, tmp_path):
    """_atomic_write creates the target file with correct content."""
    target = tmp_path / "OUTPUT.md"
    deft_run_module._atomic_write(target, "hello world")
    assert target.exists()
    assert target.read_text(encoding="utf-8") == "hello world"


def test_atomic_write_no_leftover_tmp(deft_run_module, tmp_path):
    """_atomic_write leaves no .tmp file behind after success."""
    target = tmp_path / "OUTPUT.md"
    deft_run_module._atomic_write(target, "content")
    tmp_file = tmp_path / ".OUTPUT.md.tmp"
    assert not tmp_file.exists()


def test_atomic_write_creates_parent_dirs(deft_run_module, tmp_path):
    """_atomic_write creates parent directories if needed."""
    target = tmp_path / "sub" / "dir" / "FILE.md"
    deft_run_module._atomic_write(target, "nested")
    assert target.read_text(encoding="utf-8") == "nested"


# ── Bootstrap resume tests ─────────────────────────────────────────


def _bootstrap_responses(user_path: Path) -> list:
    """Standard 10-response queue for cmd_bootstrap (no progress file)."""
    return [
        str(user_path),  # output path
        "TestUser",       # name
        "85",             # coverage
        "1",              # first language
        "1",              # first strategy
        False,            # no custom rules (read_yn gate)
        False,            # skip SOUL.md
        False,            # skip morals.md
        False,            # skip code-field.md
        False,            # don't chain to project
    ]


def test_bootstrap_resume_skips_answered(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """When a progress file exists and user resumes, answered questions are skipped."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    user_path = isolated_env / "USER.md"

    # Simulate partial progress (first 3 questions answered)
    prog_file = deft_run_module._progress_path(user_path)
    deft_run_module._save_progress(prog_file, {
        "output_path": str(user_path),
        "user_name": "ResumedUser",
        "coverage": "90",
    })

    # Queue: resume=Yes, then remaining 7 questions, then chain=No
    mock_user_input([
        True,   # Resume where you left off?
        "1",    # lang_selection
        "1",    # strat_selection
        False,  # has_custom_rules (read_yn gate)
        False,  # use_soul
        False,  # use_morals
        False,  # use_code_field
        False,  # chain to project
    ])

    result = run_command("cmd_bootstrap", [])

    assert result.return_code in (0, None)
    assert user_path.exists()
    content = user_path.read_text(encoding="utf-8")
    assert "ResumedUser" in content  # resumed value used
    assert "90" in content or "coverage" in content.lower()
    # Progress file should be cleaned up after success
    assert not prog_file.exists()


def test_bootstrap_discard_starts_fresh(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """When user declines resume, progress is deleted and full questionnaire runs."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    user_path = isolated_env / "USER.md"

    # Simulate partial progress
    prog_file = deft_run_module._progress_path(user_path)
    deft_run_module._save_progress(prog_file, {
        "output_path": str(user_path),
        "user_name": "OldUser",
    })

    # Queue: resume=No, then full 10-question flow
    mock_user_input([
        False,  # Resume where you left off? -> No
        *_bootstrap_responses(user_path),
    ])

    result = run_command("cmd_bootstrap", [])

    assert result.return_code in (0, None)
    assert user_path.exists()
    content = user_path.read_text(encoding="utf-8")
    assert "TestUser" in content  # fresh answer, not "OldUser"
    assert not prog_file.exists()


def test_bootstrap_no_progress_unchanged(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """Without a progress file, bootstrap works exactly as before (no extra prompts)."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    user_path = isolated_env / "USER.md"
    mock_user_input(_bootstrap_responses(user_path))

    result = run_command("cmd_bootstrap", [])

    assert result.return_code in (0, None)
    assert user_path.exists()


def test_bootstrap_progress_cleared_on_success(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """Progress file is removed after successful bootstrap completion."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    user_path = isolated_env / "USER.md"
    mock_user_input(_bootstrap_responses(user_path))

    result = run_command("cmd_bootstrap", [])
    assert result.return_code in (0, None)

    prog_file = deft_run_module._progress_path(user_path)
    assert not prog_file.exists()


# ── Ctrl+C simulation ──────────────────────────────────────────────


def test_ctrlc_preserves_progress(
    isolated_env, deft_run_module, monkeypatch
):
    """KeyboardInterrupt mid-questionnaire leaves progress file on disk."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    user_path = isolated_env / "USER.md"

    call_count = 0

    def _interrupt_after_two(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return str(user_path)   # output path
        if call_count == 2:
            return "PartialUser"    # user name
        raise KeyboardInterrupt()

    monkeypatch.setattr(deft_run_module, "ask_input", _interrupt_after_two)
    monkeypatch.setattr(deft_run_module, "read_input", _interrupt_after_two)
    monkeypatch.setattr(deft_run_module, "ask_confirm", lambda *a, **kw: False)
    monkeypatch.setattr(deft_run_module, "read_yn", lambda *a, **kw: False)

    with contextlib.suppress(KeyboardInterrupt):
        deft_run_module.cmd_bootstrap([])

    # Progress file should exist with the answers given before interruption
    prog_file = deft_run_module._progress_path(user_path)
    assert prog_file.exists(), "Progress file should survive Ctrl+C"
    saved = deft_run_module._load_progress(prog_file)
    assert saved.get("output_path") == str(user_path)
    assert saved.get("user_name") == "PartialUser"
    # USER.md should NOT have been written (interrupted before completion)
    assert not user_path.exists()
