"""
test_project.py — Tests for cmd_project.

Subphase 3.3 of the CLI regression suite (SPECIFICATION.md).

Tests:
  - Happy path: mocked inputs produce PROJECT.md at expected path
  - Content check: generated file contains ## Project Configuration
  - Strategy selection: selected strategy name appears in output file

Author: Scott Adams (msadams) — 2026-03-10
"""

from pathlib import Path


def _project_responses(project_path: Path, strategy_idx: str = "1") -> list:
    """Build the standard 8-response queue for cmd_project.

    Assumes ./deft/ directory exists (no install prompt).

    Prompt order (from run:cmd_project):
      1. Where to write PROJECT.md        (read_input)
      2. Project name                      (read_input)
      3. Project type selection            (read_input, e.g. "1" = CLI)
      4. Language selection                (read_input, e.g. "1")
      5. Coverage threshold                (read_input, default 85)
      6. Tech stack details                (read_input, optional)
      7. Strategy selection                (read_input, default "1")
      8. Run 'run spec' now?              (read_yn)
    """
    return [
        str(project_path),   # 1  output path
        "TestProject",        # 2  project name
        "1",                  # 3  CLI
        "1",                  # 4  first language
        "85",                 # 5  coverage
        "Flask",              # 6  tech stack
        strategy_idx,         # 7  strategy
        False,                # 8  don't chain to spec
    ]


def test_project_happy_path(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """cmd_project with mocked inputs produces PROJECT.md at expected path."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    (isolated_env / "deft").mkdir(exist_ok=True)
    project_path = isolated_env / "PROJECT.md"
    mock_user_input(_project_responses(project_path))

    result = run_command("cmd_project", [])

    assert project_path.exists(), f"PROJECT.md not created at {project_path}"
    assert result.return_code in (0, None)


def test_project_content_check(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """Generated PROJECT.md contains ## Project Configuration section."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    (isolated_env / "deft").mkdir(exist_ok=True)
    project_path = isolated_env / "PROJECT.md"
    mock_user_input(_project_responses(project_path))

    run_command("cmd_project", [])

    content = project_path.read_text(encoding="utf-8")
    assert "## Project Configuration" in content
    assert "## Strategy" in content


def test_project_strategy_selection(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """Selected strategy name appears in the generated PROJECT.md."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    (isolated_env / "deft").mkdir(exist_ok=True)
    project_path = isolated_env / "PROJECT.md"

    # Pick the last available strategy and verify its name lands in the file.
    strategies = deft_run_module.get_available_strategies()
    target_idx = len(strategies)
    _target_stem, target_display = strategies[-1]
    mock_user_input(_project_responses(project_path, strategy_idx=str(target_idx)))

    run_command("cmd_project", [])

    content = project_path.read_text(encoding="utf-8")
    assert target_display in content, (
        f"Expected strategy '{target_display}' in PROJECT.md"
    )
