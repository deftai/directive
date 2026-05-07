"""
test_spec_sizing.py -- Tests for cmd_spec sizing gate and _read_project_process.

Tests the Issue #36 fix: interview strategy sizing gate (Light vs Full paths).
Updated for vBRIEF-centric model (#320).

Covers _read_project_process:
  - No PROJECT-DEFINITION.vbrief.json -> None
  - Process narrative: Light -> 'Light'
  - Process narrative: Full -> 'Full'
  - Process narrative: empty -> None
  - Process narrative: Invalid -> None
  - Case-insensitive -> correct capitalisation
  - Legacy PROJECT.md fallback still works

Covers cmd_spec sizing gate:
  - Light path: creates scope vBRIEF in vbrief/proposed/
  - Full path: creates scope vBRIEF with rich narratives
  - Strategy metadata appears in scope vBRIEF
  - PROJECT-DEFINITION Process override: skips sizing question
  - Existing output file without --force returns 1
  - Feature list appears as items in scope vBRIEF

Author: Scott Adams (msadams) -- 2026-03-13
Updated: 2026-04-13 -- vBRIEF-centric model (#320)
"""

import json
import os
from pathlib import Path

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_project_definition(project_path, process_value="", strategy_value=""):
    """Write a minimal PROJECT-DEFINITION.vbrief.json with optional Process/Strategy."""
    project_path.parent.mkdir(parents=True, exist_ok=True)
    narratives = {}
    if process_value:
        narratives["Process"] = process_value
    if strategy_value:
        narratives["Strategy"] = strategy_value
    data = {
        "vBRIEFInfo": {"version": "0.5"},
        "plan": {
            "title": "TestProject Project Definition",
            "status": "running",
            "narratives": narratives,
            "items": [],
        },
    }
    project_path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _write_legacy_project_md(project_path, process_value=""):
    """Write a legacy PROJECT.md with the given **Process** value."""
    process_line = f"**Process**: {process_value}" if process_value else "**Process**:"
    project_path.parent.mkdir(parents=True, exist_ok=True)
    project_path.write_text(
        f"# TestProject Project Guidelines\n\n"
        f"## Strategy\n\n"
        f"{process_line}\n",
        encoding="utf-8",
    )


def _spec_responses_no_project(features=None, sizing_choice="1"):
    """Build response queue for cmd_spec when NO PROJECT-DEFINITION exists.

    Prompt order (vBRIEF model):
      1. Project name                      (read_input)
      2. Brief description                 (read_input)
      3..N. Feature entries + empty stop   (read_input x len+1)
      N+1. Sizing selection                (read_input)
    """
    if features is None:
        features = ["Feature A", "Feature B"]
    responses = [
        "TestProject",
        "A test project.",
    ]
    for f in features:
        responses.append(f)
    responses.append("")              # empty -> stop feature loop
    responses.append(sizing_choice)   # sizing selection
    return responses


def _spec_responses_with_project(features=None, has_override=False, sizing_choice="1"):
    """Build response queue for cmd_spec when PROJECT-DEFINITION has a title.

    Prompt order:
      1. Use this name? (read_yn)          -> True
      2. Brief description (read_input)
      3..N. Feature entries + empty stop
      N+1. [only if no override] Sizing selection
    """
    if features is None:
        features = ["Feature A", "Feature B"]
    responses = [
        True,                  # use project name from PROJECT-DEFINITION
        "A test project.",
    ]
    for f in features:
        responses.append(f)
    responses.append("")       # empty -> stop feature loop
    if not has_override:
        responses.append(sizing_choice)
    return responses


def _get_scope_vbrief(isolated_env):
    """Read the first scope vBRIEF from vbrief/proposed/."""
    proposed = isolated_env / "vbrief" / "proposed"
    files = list(proposed.glob("*.vbrief.json"))
    assert len(files) >= 1, f"No vBRIEF files in {proposed}"
    return json.loads(files[0].read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# _read_project_process
# ---------------------------------------------------------------------------


class TestReadProjectProcess:
    """Tests for _read_project_process helper."""

    def test_returns_none_when_no_project(self, deft_run_module, isolated_env):
        """Returns None when PROJECT-DEFINITION does not exist."""
        defaults = deft_run_module.get_default_paths()
        assert deft_run_module._read_project_process(defaults) is None

    def test_returns_light(self, deft_run_module, isolated_env):
        """Returns 'Light' when Process narrative is Light."""
        _write_project_definition(Path(os.environ["DEFT_PROJECT_PATH"]), "Light")
        defaults = deft_run_module.get_default_paths()
        assert deft_run_module._read_project_process(defaults) == "Light"

    def test_returns_full(self, deft_run_module, isolated_env):
        """Returns 'Full' when Process narrative is Full."""
        _write_project_definition(Path(os.environ["DEFT_PROJECT_PATH"]), "Full")
        defaults = deft_run_module.get_default_paths()
        assert deft_run_module._read_project_process(defaults) == "Full"

    def test_returns_none_for_empty(self, deft_run_module, isolated_env):
        """Returns None when Process narrative is blank."""
        _write_project_definition(Path(os.environ["DEFT_PROJECT_PATH"]))
        defaults = deft_run_module.get_default_paths()
        assert deft_run_module._read_project_process(defaults) is None

    def test_returns_none_for_invalid(self, deft_run_module, isolated_env):
        """Returns None for unrecognised values like 'Medium'."""
        _write_project_definition(Path(os.environ["DEFT_PROJECT_PATH"]), "Medium")
        defaults = deft_run_module.get_default_paths()
        assert deft_run_module._read_project_process(defaults) is None

    def test_case_insensitive_light(self, deft_run_module, isolated_env):
        """Normalises 'light' -> 'Light'."""
        _write_project_definition(Path(os.environ["DEFT_PROJECT_PATH"]), "light")
        defaults = deft_run_module.get_default_paths()
        assert deft_run_module._read_project_process(defaults) == "Light"

    def test_case_insensitive_full(self, deft_run_module, isolated_env):
        """Normalises 'FULL' -> 'Full'."""
        _write_project_definition(Path(os.environ["DEFT_PROJECT_PATH"]), "FULL")
        defaults = deft_run_module.get_default_paths()
        assert deft_run_module._read_project_process(defaults) == "Full"



# ---------------------------------------------------------------------------
# cmd_spec -- Light path (vBRIEF output)
# ---------------------------------------------------------------------------


class TestCmdSpecLight:
    """cmd_spec with Light sizing selection -- scope vBRIEF output."""

    def test_creates_scope_vbrief(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """Light path creates a scope vBRIEF in vbrief/proposed/."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        mock_user_input(_spec_responses_no_project(sizing_choice="1"))

        result = run_command("cmd_spec", [])

        proposed = isolated_env / "vbrief" / "proposed"
        assert list(proposed.glob("*.vbrief.json")), "No scope vBRIEF created"
        assert result.return_code in (0, None)

    def test_light_sizing_in_metadata(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """Light output has sizing: Light in metadata."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        mock_user_input(_spec_responses_no_project(sizing_choice="1"))

        run_command("cmd_spec", [])

        data = _get_scope_vbrief(isolated_env)
        assert data["plan"]["metadata"]["sizing"] == "Light"

    def test_strategy_in_metadata(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """Light output has strategy in metadata."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        mock_user_input(_spec_responses_no_project(sizing_choice="1"))

        run_command("cmd_spec", [])

        data = _get_scope_vbrief(isolated_env)
        assert data["plan"]["metadata"]["strategy"] == "interview"

    def test_title_is_project_name(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """Scope vBRIEF title is the project name."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        mock_user_input(_spec_responses_no_project(sizing_choice="1"))

        run_command("cmd_spec", [])

        data = _get_scope_vbrief(isolated_env)
        assert data["plan"]["title"] == "TestProject"


# ---------------------------------------------------------------------------
# cmd_spec -- Full path (vBRIEF output)
# ---------------------------------------------------------------------------


class TestCmdSpecFull:
    """cmd_spec with Full sizing selection -- scope vBRIEF output."""

    def test_creates_scope_vbrief(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """Full path creates a scope vBRIEF in vbrief/proposed/."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        mock_user_input(_spec_responses_no_project(sizing_choice="2"))

        result = run_command("cmd_spec", [])

        proposed = isolated_env / "vbrief" / "proposed"
        assert list(proposed.glob("*.vbrief.json")), "No scope vBRIEF created"
        assert result.return_code in (0, None)

    def test_full_sizing_in_metadata(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """Full output has sizing: Full in metadata."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        mock_user_input(_spec_responses_no_project(sizing_choice="2"))

        run_command("cmd_spec", [])

        data = _get_scope_vbrief(isolated_env)
        assert data["plan"]["metadata"]["sizing"] == "Full"

    def test_full_has_rich_narratives(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """Full path includes rich narrative placeholders."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        mock_user_input(_spec_responses_no_project(sizing_choice="2"))

        run_command("cmd_spec", [])

        data = _get_scope_vbrief(isolated_env)
        narratives = data["plan"]["narratives"]
        for key in ("ProblemStatement", "Goals", "UserStories", "Requirements", "SuccessMetrics"):
            assert key in narratives, f"Missing narrative key: {key}"

    def test_title_is_project_name(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """Scope vBRIEF title is the project name."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        mock_user_input(_spec_responses_no_project(sizing_choice="2"))

        run_command("cmd_spec", [])

        data = _get_scope_vbrief(isolated_env)
        assert data["plan"]["title"] == "TestProject"


# ---------------------------------------------------------------------------
# cmd_spec -- Process override
# ---------------------------------------------------------------------------


class TestCmdSpecProcessOverride:
    """cmd_spec with PROJECT-DEFINITION Process override."""

    def test_override_light_skips_sizing(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """Process: Light skips sizing prompt and produces Light output."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        _write_project_definition(Path(os.environ["DEFT_PROJECT_PATH"]), "Light")
        mock_user_input(_spec_responses_with_project(has_override=True))

        result = run_command("cmd_spec", [])

        data = _get_scope_vbrief(isolated_env)
        assert data["plan"]["metadata"]["sizing"] == "Light"
        assert result.return_code in (0, None)

    def test_override_full_skips_sizing(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """Process: Full skips sizing prompt and produces Full output."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        _write_project_definition(Path(os.environ["DEFT_PROJECT_PATH"]), "Full")
        mock_user_input(_spec_responses_with_project(has_override=True))

        result = run_command("cmd_spec", [])

        data = _get_scope_vbrief(isolated_env)
        assert data["plan"]["metadata"]["sizing"] == "Full"
        assert result.return_code in (0, None)


# ---------------------------------------------------------------------------
# cmd_spec -- Edge cases
# ---------------------------------------------------------------------------


class TestCmdSpecEdgeCases:
    """Edge-case tests for cmd_spec."""

    def test_existing_file_without_force_returns_1(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """Returns 1 if scope vBRIEF already exists and --force not passed."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        # First run to create the file
        mock_user_input(_spec_responses_no_project(sizing_choice="1"))
        run_command("cmd_spec", [])

        # Second run without --force should fail
        mock_user_input(_spec_responses_no_project(sizing_choice="1"))
        result = run_command("cmd_spec", [])
        assert result.return_code == 1

    def test_features_in_items(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """Feature list appears as items in the scope vBRIEF."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        features = ["Login system", "Dashboard", "API endpoints"]
        mock_user_input(_spec_responses_no_project(features=features, sizing_choice="1"))

        run_command("cmd_spec", [])

        data = _get_scope_vbrief(isolated_env)
        item_titles = [item["title"] for item in data["plan"]["items"]]
        for feat in features:
            assert feat in item_titles, f"Feature '{feat}' not found in items"


# ---------------------------------------------------------------------------
# _read_project_strategy
# ---------------------------------------------------------------------------


class TestReadProjectStrategy:
    """Tests for _read_project_strategy helper."""

    def test_returns_none_when_no_project(self, deft_run_module, isolated_env):
        """Returns None when PROJECT-DEFINITION does not exist."""
        defaults = deft_run_module.get_default_paths()
        assert deft_run_module._read_project_strategy(defaults) is None

    def test_returns_interview_from_vbrief(
        self, deft_run_module, isolated_env
    ):
        """Returns 'interview' from vBRIEF Strategy narrative."""
        _write_project_definition(
            Path(os.environ["DEFT_PROJECT_PATH"]),
            strategy_value="Interview (strategies/interview.md)",
        )
        defaults = deft_run_module.get_default_paths()
        assert deft_run_module._read_project_strategy(defaults) == "interview"

    def test_returns_discuss_from_vbrief(
        self, deft_run_module, isolated_env
    ):
        """Returns 'discuss' from vBRIEF Strategy narrative."""
        _write_project_definition(
            Path(os.environ["DEFT_PROJECT_PATH"]),
            strategy_value="Discuss (strategies/discuss.md)",
        )
        defaults = deft_run_module.get_default_paths()
        assert deft_run_module._read_project_strategy(defaults) == "discuss"

    def test_returns_none_without_strategy(
        self, deft_run_module, isolated_env
    ):
        """Returns None when narratives have no Strategy."""
        _write_project_definition(Path(os.environ["DEFT_PROJECT_PATH"]))
        defaults = deft_run_module.get_default_paths()
        assert deft_run_module._read_project_strategy(defaults) is None


# ---------------------------------------------------------------------------
# cmd_spec -- strategy-aware output
# ---------------------------------------------------------------------------


class TestCmdSpecStrategyAware:
    """cmd_spec output uses the correct strategy from PROJECT-DEFINITION."""

    def test_discuss_strategy_in_metadata(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """When PROJECT-DEFINITION declares discuss, metadata records it."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        _write_project_definition(
            Path(os.environ["DEFT_PROJECT_PATH"]),
            strategy_value="Discuss (strategies/discuss.md)",
        )
        mock_user_input(_spec_responses_with_project(has_override=False, sizing_choice="1"))

        run_command("cmd_spec", [])

        data = _get_scope_vbrief(isolated_env)
        assert data["plan"]["metadata"]["strategy"] == "discuss"

    def test_default_strategy_is_interview(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """Without PROJECT-DEFINITION, strategy defaults to interview."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        mock_user_input(_spec_responses_no_project(sizing_choice="1"))

        run_command("cmd_spec", [])

        data = _get_scope_vbrief(isolated_env)
        assert data["plan"]["metadata"]["strategy"] == "interview"
        assert "interview" in data["plan"]["narratives"]["Strategy"]
