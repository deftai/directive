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
    """Build the standard 9-response queue for cmd_project.

    Assumes ./deft/ directory exists (no install prompt).

    Prompt order (from run:cmd_project):
      1. Where to write PROJECT.md        (read_input)
      2. Project name                      (read_input)
      3. Project type selection            (read_input, e.g. "1" = CLI)
      4. Language selection                (read_input, e.g. "1")
      5. Coverage threshold                (read_input, default 85)
      6. Tech stack details                (read_input, optional)
      7. Strategy selection                (read_input, default "1")
      8. Branching preference              (read_input, "1" = branch-based)
      9. Run 'run spec' now?              (read_yn)
    """
    return [
        str(project_path),   # 1  output path
        "TestProject",        # 2  project name
        "1",                  # 3  CLI
        "1",                  # 4  first language
        "85",                 # 5  coverage
        "Flask",              # 6  tech stack
        strategy_idx,         # 7  strategy
        "1",                  # 8  branch-based (default)
        False,                # 9  don't chain to spec
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


def test_project_trunk_based_emits_branching_section(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """Selecting trunk-based (option 2) emits Allow direct commits to master in PROJECT.md."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    (isolated_env / "deft").mkdir(exist_ok=True)
    project_path = isolated_env / "PROJECT.md"
    mock_user_input([
        str(project_path),   # 1  output path
        "TestProject",        # 2  project name
        "1",                  # 3  CLI
        "1",                  # 4  first language
        "85",                 # 5  coverage
        "Flask",              # 6  tech stack
        "1",                  # 7  strategy
        "2",                  # 8  trunk-based
        False,                # 9  don't chain to spec
    ])

    run_command("cmd_project", [])

    content = project_path.read_text(encoding="utf-8")
    assert "Allow direct commits to master: true" in content
    assert "## Branching" in content


def test_project_branch_based_does_not_emit_branching_section(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """Selecting branch-based (option 1 / default) must NOT emit Allow direct commits."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    (isolated_env / "deft").mkdir(exist_ok=True)
    project_path = isolated_env / "PROJECT.md"
    mock_user_input([
        str(project_path), "TestProject", "1", "1", "85", "Flask", "1",
        "1",   # branch-based (default)
        False,
    ])
    run_command("cmd_project", [])
    content = project_path.read_text(encoding="utf-8")
    assert "Allow direct commits to master" not in content


def test_project_rejects_duplicate_types(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """Duplicate type selections are rejected and the user is re-prompted."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    (isolated_env / "deft").mkdir(exist_ok=True)
    project_path = isolated_env / "PROJECT.md"
    mock_user_input([
        str(project_path),  # 1  output path
        "TestProject",       # 2  project name
        "1,1",               # 3  duplicate type — rejected
        "1",                 # 4  valid type — accepted
        "1",                 # 5  language
        "85",                # 6  coverage
        "Flask",             # 7  tech stack
        "1",                 # 8  strategy
        "1",                 # 9  branch-based (default)
        False,               # 10 don't chain to spec
    ])

    result = run_command("cmd_project", [])

    assert result.return_code in (0, None)
    assert "Duplicate" in result.stdout
