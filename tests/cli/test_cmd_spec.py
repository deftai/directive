"""
test_cmd_spec.py -- Tests for cmd_spec vBRIEF scope output.

Verifies cmd_spec generates scope vBRIEFs in vbrief/proposed/ with correct
YYYY-MM-DD-descriptive-slug.vbrief.json filename convention and vBRIEF v0.5 schema.

Author: Scott Adams (msadams) -- 2026-04-13
Story: #320 (Phase 2 vBRIEF Architecture Cutover)
"""

import json
import re


def _spec_responses_light(*, name: str = "MyApp") -> list:
    """Build response queue for cmd_spec (Light path).

    Prompt order (from run:cmd_spec):
      1. Project name         (read_input, or read_yn to accept from PROJECT-DEFINITION)
      2. Brief description    (read_input)
      3. Features             (read_input per feature, then empty to stop)
      4. Sizing selection     (read_input, "1" = Light)
    """
    return [
        name,                           # 1  project name
        "A test application",            # 2  description
        "Feature A",                     # 3  first feature
        "Feature B",                     # 4  second feature
        "",                              # 5  empty = done with features
        "1",                             # 6  Light path
    ]


def _spec_responses_full(*, name: str = "MyApp") -> list:
    """Build response queue for cmd_spec (Full path)."""
    return [
        name,                           # 1  project name
        "A test application",            # 2  description
        "Feature A",                     # 3  first feature
        "",                              # 4  done with features
        "2",                             # 5  Full path
    ]


def test_spec_creates_vbrief_in_proposed(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """cmd_spec must create a .vbrief.json file in vbrief/proposed/."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    mock_user_input(_spec_responses_light())

    result = run_command("cmd_spec", [])

    proposed = isolated_env / "vbrief" / "proposed"
    assert proposed.exists(), "vbrief/proposed/ directory not created"
    vbrief_files = list(proposed.glob("*.vbrief.json"))
    assert len(vbrief_files) == 1, f"Expected 1 vBRIEF file, found {len(vbrief_files)}"
    assert result.return_code in (0, None)


def test_spec_filename_convention(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """Output filename must match YYYY-MM-DD-descriptive-slug.vbrief.json."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    mock_user_input(_spec_responses_light(name="My Cool App"))

    run_command("cmd_spec", [])

    proposed = isolated_env / "vbrief" / "proposed"
    vbrief_files = list(proposed.glob("*.vbrief.json"))
    assert len(vbrief_files) == 1
    filename = vbrief_files[0].name
    # Must match YYYY-MM-DD-slug.vbrief.json
    assert re.match(r"\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.vbrief\.json$", filename), (
        f"Filename '{filename}' does not match YYYY-MM-DD-descriptive-slug.vbrief.json"
    )
    assert "my-cool-app" in filename


def test_spec_valid_json(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """Generated scope vBRIEF must be valid JSON."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    mock_user_input(_spec_responses_light())

    run_command("cmd_spec", [])

    proposed = isolated_env / "vbrief" / "proposed"
    vbrief_file = list(proposed.glob("*.vbrief.json"))[0]
    data = json.loads(vbrief_file.read_text(encoding="utf-8"))
    assert isinstance(data, dict)


def test_spec_vbrief_schema(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """Scope vBRIEF must have vBRIEFInfo v0.5 and plan with required fields."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    mock_user_input(_spec_responses_light())

    run_command("cmd_spec", [])

    proposed = isolated_env / "vbrief" / "proposed"
    vbrief_file = list(proposed.glob("*.vbrief.json"))[0]
    data = json.loads(vbrief_file.read_text(encoding="utf-8"))
    assert data["vBRIEFInfo"]["version"] == "0.5"
    assert "plan" in data
    assert data["plan"]["status"] == "proposed"
    assert "title" in data["plan"]
    assert "narratives" in data["plan"]
    assert "items" in data["plan"]


def test_spec_items_from_features(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """Features entered by user must appear as items in the scope vBRIEF."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    mock_user_input(_spec_responses_light())

    run_command("cmd_spec", [])

    proposed = isolated_env / "vbrief" / "proposed"
    vbrief_file = list(proposed.glob("*.vbrief.json"))[0]
    data = json.loads(vbrief_file.read_text(encoding="utf-8"))
    items = data["plan"]["items"]
    assert len(items) == 2
    assert items[0]["title"] == "Feature A"
    assert items[1]["title"] == "Feature B"
    assert items[0]["status"] == "proposed"


def test_spec_narratives_contain_overview(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """Narratives must include Overview with the description."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    mock_user_input(_spec_responses_light())

    run_command("cmd_spec", [])

    proposed = isolated_env / "vbrief" / "proposed"
    vbrief_file = list(proposed.glob("*.vbrief.json"))[0]
    data = json.loads(vbrief_file.read_text(encoding="utf-8"))
    assert "Overview" in data["plan"]["narratives"]
    assert "A test application" in data["plan"]["narratives"]["Overview"]


def test_spec_full_path_has_rich_narratives(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """Full path must include rich narrative placeholders for AI to fill."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    mock_user_input(_spec_responses_full())

    run_command("cmd_spec", [])

    proposed = isolated_env / "vbrief" / "proposed"
    vbrief_file = list(proposed.glob("*.vbrief.json"))[0]
    data = json.loads(vbrief_file.read_text(encoding="utf-8"))
    narratives = data["plan"]["narratives"]
    # Full path should have placeholder narrative keys
    for key in ("ProblemStatement", "Goals", "UserStories", "Requirements", "SuccessMetrics"):
        assert key in narratives, f"Full path missing narrative key: {key}"


def test_spec_metadata_contains_strategy_and_sizing(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """Metadata must contain strategy and sizing information."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    mock_user_input(_spec_responses_light())

    run_command("cmd_spec", [])

    proposed = isolated_env / "vbrief" / "proposed"
    vbrief_file = list(proposed.glob("*.vbrief.json"))[0]
    data = json.loads(vbrief_file.read_text(encoding="utf-8"))
    metadata = data["plan"]["metadata"]
    assert "strategy" in metadata
    assert "sizing" in metadata
    assert metadata["sizing"] == "Light"


def test_spec_force_overwrites_existing(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """--force flag must allow overwriting an existing scope vBRIEF."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)

    # First run
    mock_user_input(_spec_responses_light())
    run_command("cmd_spec", [])

    # Second run without --force should fail
    mock_user_input(_spec_responses_light())
    result = run_command("cmd_spec", [])
    assert result.return_code == 1

    # Third run with --force should succeed
    mock_user_input(_spec_responses_light())
    result = run_command("cmd_spec", ["--force"])
    assert result.return_code in (0, None)


def test_slugify_basic(deft_run_module):
    """_slugify must convert names to URL-friendly slugs."""
    assert deft_run_module._slugify("My Cool App") == "my-cool-app"
    assert deft_run_module._slugify("Hello World!") == "hello-world"
    assert deft_run_module._slugify("test__multiple   spaces") == "test-multiple-spaces"
    assert deft_run_module._slugify("") == ""
