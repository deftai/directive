"""
test_project.py -- Tests for cmd_project vBRIEF output.

Verifies cmd_project generates PROJECT-DEFINITION.vbrief.json with correct
vBRIEF v0.5 schema: narratives for project identity, items as scope registry.

Author: Scott Adams (msadams) -- 2026-03-10
Updated: 2026-04-13 -- vBRIEF-centric model (#320)
"""

import json
from pathlib import Path


def _project_responses(project_path: Path, strategy_idx: str = "1") -> list:
    """Build the standard 9-response queue for cmd_project.

    Assumes ./deft/ directory exists (no install prompt).

    Prompt order (from run:cmd_project):
      1. Where to write PROJECT-DEFINITION.vbrief.json  (read_input)
      2. Project name                                    (read_input)
      3. Project type selection                          (read_input, e.g. "1" = CLI)
      4. Language selection                              (read_input, e.g. "1")
      5. Coverage threshold                              (read_input, default 85)
      6. Tech stack details                              (read_input, optional)
      7. Strategy selection                              (read_input, default "1")
      8. Branching preference                            (read_input, "1" = branch-based)
      9. Run 'run spec' now?                            (read_yn)
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
    """cmd_project with mocked inputs produces PROJECT-DEFINITION.vbrief.json."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    (isolated_env / "deft").mkdir(exist_ok=True)
    project_path = isolated_env / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    mock_user_input(_project_responses(project_path))

    result = run_command("cmd_project", [])

    assert project_path.exists(), f"PROJECT-DEFINITION.vbrief.json not created at {project_path}"
    assert result.return_code in (0, None)


def test_project_valid_json(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """Generated file must be valid JSON."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    (isolated_env / "deft").mkdir(exist_ok=True)
    project_path = isolated_env / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    mock_user_input(_project_responses(project_path))

    run_command("cmd_project", [])

    data = json.loads(project_path.read_text(encoding="utf-8"))
    assert isinstance(data, dict)


def test_project_vbrief_schema(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """Generated file must have vBRIEFInfo and plan with correct structure."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    (isolated_env / "deft").mkdir(exist_ok=True)
    project_path = isolated_env / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    mock_user_input(_project_responses(project_path))

    run_command("cmd_project", [])

    data = json.loads(project_path.read_text(encoding="utf-8"))
    assert data["vBRIEFInfo"]["version"] == "0.5"
    assert "plan" in data
    assert "title" in data["plan"]
    assert "status" in data["plan"]
    assert "narratives" in data["plan"]
    assert "items" in data["plan"]


def test_project_narratives_contain_project_identity(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """Narratives must contain project identity: Overview, TechStack, Strategy."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    (isolated_env / "deft").mkdir(exist_ok=True)
    project_path = isolated_env / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    mock_user_input(_project_responses(project_path))

    run_command("cmd_project", [])

    data = json.loads(project_path.read_text(encoding="utf-8"))
    narratives = data["plan"]["narratives"]
    assert "Overview" in narratives
    assert "TechStack" in narratives
    assert "Strategy" in narratives
    assert "Coverage" in narratives
    assert "TestProject" in narratives["Overview"]


def test_project_strategy_in_narratives(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """Selected strategy name appears in narratives."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    (isolated_env / "deft").mkdir(exist_ok=True)
    project_path = isolated_env / "vbrief" / "PROJECT-DEFINITION.vbrief.json"

    strategies = deft_run_module.get_available_strategies()
    target_idx = len(strategies)
    _target_stem, target_display = strategies[-1]
    mock_user_input(_project_responses(project_path, strategy_idx=str(target_idx)))

    run_command("cmd_project", [])

    data = json.loads(project_path.read_text(encoding="utf-8"))
    assert target_display in data["plan"]["narratives"]["Strategy"], (
        f"Expected strategy '{target_display}' in narratives"
    )


def test_project_trunk_based_emits_branching_narrative(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """Selecting trunk-based (option 2) emits Branching narrative."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    (isolated_env / "deft").mkdir(exist_ok=True)
    project_path = isolated_env / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
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

    data = json.loads(project_path.read_text(encoding="utf-8"))
    assert "Branching" in data["plan"]["narratives"]
    assert "direct commits to master" in data["plan"]["narratives"]["Branching"].lower()


def test_project_branch_based_no_branching_narrative(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """Branch-based (option 1) must NOT emit Branching narrative."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    (isolated_env / "deft").mkdir(exist_ok=True)
    project_path = isolated_env / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    mock_user_input([
        str(project_path), "TestProject", "1", "1", "85", "Flask", "1",
        "1",   # branch-based (default)
        False,
    ])
    run_command("cmd_project", [])
    data = json.loads(project_path.read_text(encoding="utf-8"))
    assert "Branching" not in data["plan"]["narratives"]


def test_project_rejects_duplicate_types(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """Duplicate type selections are rejected and the user is re-prompted."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    (isolated_env / "deft").mkdir(exist_ok=True)
    project_path = isolated_env / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    mock_user_input([
        str(project_path),  # 1  output path
        "TestProject",       # 2  project name
        "1,1",               # 3  duplicate type -- rejected
        "1",                 # 4  valid type -- accepted
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


def test_project_items_is_empty_list(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """items must be an empty list (scope registry, populated later)."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    (isolated_env / "deft").mkdir(exist_ok=True)
    project_path = isolated_env / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    mock_user_input(_project_responses(project_path))

    run_command("cmd_project", [])

    data = json.loads(project_path.read_text(encoding="utf-8"))
    assert data["plan"]["items"] == []


def test_project_status_is_running(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """plan.status must be 'running' for a new project definition."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    (isolated_env / "deft").mkdir(exist_ok=True)
    project_path = isolated_env / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    mock_user_input(_project_responses(project_path))

    run_command("cmd_project", [])

    data = json.loads(project_path.read_text(encoding="utf-8"))
    assert data["plan"]["status"] == "running"
