"""
test_spec_sizing.py — Tests for cmd_spec sizing gate and _read_project_process.

Tests the Issue #36 fix: interview strategy sizing gate (Light vs Full paths).

Covers _read_project_process:
  - No PROJECT.md → None
  - **Process**: Light → 'Light'
  - **Process**: Full → 'Full'
  - **Process**: (empty) → None
  - **Process**: Invalid → None
  - Case-insensitive → correct capitalisation

Covers cmd_spec sizing gate:
  - Light path: creates INTERVIEW.md with correct heading & path marker
  - Full path: creates PRD.md with correct heading & path marker
  - Light output references strategies/interview.md Light path
  - Full output references strategies/interview.md Full path
  - PROJECT.md Process override: skips sizing question (fewer prompts)
  - Existing output file without --force returns 1
  - Feature list appears in generated output

Covers cmd_project:
  - Generated PROJECT.md includes **Process**: field

Author: Scott Adams (msadams) — 2026-03-13
"""

import os
from pathlib import Path

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_project_md(project_path, process_value=""):
    """Write a minimal PROJECT.md with the given **Process** value."""
    process_line = f"**Process**: {process_value}" if process_value else "**Process**:"
    project_path.write_text(
        f"# TestProject Project Guidelines\n\n"
        f"## Strategy\n\n"
        f"{process_line}\n",
        encoding="utf-8",
    )


def _spec_responses_no_project(
    output_path, spec_path, features=None, sizing_choice="1"
):
    """Build response queue for cmd_spec when NO PROJECT.md exists.

    Prompt order:
      1. Project name                      (read_input)
      2. Brief description                 (read_input)
      3..N. Feature entries + empty stop   (read_input × len+1)
      N+1. Sizing selection                (read_input)
      N+2. Output file path                (read_input)
      N+3. SPECIFICATION path              (read_input)
    """
    if features is None:
        features = ["Feature A", "Feature B"]
    responses = [
        "TestProject",
        "A test project.",
    ]
    for f in features:
        responses.append(f)
    responses.append("")              # empty → stop feature loop
    responses.append(sizing_choice)   # sizing selection
    responses.append(str(output_path))
    responses.append(str(spec_path))
    return responses


def _spec_responses_with_project(
    output_path, spec_path, features=None, has_override=False, sizing_choice="1"
):
    """Build response queue for cmd_spec when PROJECT.md has a project name.

    Prompt order:
      1. Use this name? (read_yn)          → True
      2. Brief description (read_input)
      3..N. Feature entries + empty stop
      N+1. [only if no override] Sizing selection
      N+2. Output file path
      N+3. SPECIFICATION path
    """
    if features is None:
        features = ["Feature A", "Feature B"]
    responses = [
        True,                  # use project name from PROJECT.md
        "A test project.",
    ]
    for f in features:
        responses.append(f)
    responses.append("")       # empty → stop feature loop
    if not has_override:
        responses.append(sizing_choice)
    responses.append(str(output_path))
    responses.append(str(spec_path))
    return responses


# ---------------------------------------------------------------------------
# _read_project_process
# ---------------------------------------------------------------------------


class TestReadProjectProcess:
    """Tests for _read_project_process helper."""

    def test_returns_none_when_no_project_md(self, deft_run_module, isolated_env):
        """Returns None when PROJECT.md does not exist."""
        defaults = deft_run_module.get_default_paths()
        assert deft_run_module._read_project_process(defaults) is None

    def test_returns_light(self, deft_run_module, isolated_env):
        """Returns 'Light' when **Process**: Light."""
        _write_project_md(Path(os.environ["DEFT_PROJECT_PATH"]), "Light")
        defaults = deft_run_module.get_default_paths()
        assert deft_run_module._read_project_process(defaults) == "Light"

    def test_returns_full(self, deft_run_module, isolated_env):
        """Returns 'Full' when **Process**: Full."""
        _write_project_md(Path(os.environ["DEFT_PROJECT_PATH"]), "Full")
        defaults = deft_run_module.get_default_paths()
        assert deft_run_module._read_project_process(defaults) == "Full"

    def test_returns_none_for_empty(self, deft_run_module, isolated_env):
        """Returns None when **Process**: is blank."""
        _write_project_md(Path(os.environ["DEFT_PROJECT_PATH"]))
        defaults = deft_run_module.get_default_paths()
        assert deft_run_module._read_project_process(defaults) is None

    def test_returns_none_for_invalid(self, deft_run_module, isolated_env):
        """Returns None for unrecognised values like 'Medium'."""
        _write_project_md(Path(os.environ["DEFT_PROJECT_PATH"]), "Medium")
        defaults = deft_run_module.get_default_paths()
        assert deft_run_module._read_project_process(defaults) is None

    def test_case_insensitive_light(self, deft_run_module, isolated_env):
        """Normalises 'light' → 'Light'."""
        _write_project_md(Path(os.environ["DEFT_PROJECT_PATH"]), "light")
        defaults = deft_run_module.get_default_paths()
        assert deft_run_module._read_project_process(defaults) == "Light"

    def test_case_insensitive_full(self, deft_run_module, isolated_env):
        """Normalises 'FULL' → 'Full'."""
        _write_project_md(Path(os.environ["DEFT_PROJECT_PATH"]), "FULL")
        defaults = deft_run_module.get_default_paths()
        assert deft_run_module._read_project_process(defaults) == "Full"


# ---------------------------------------------------------------------------
# cmd_spec — Light path
# ---------------------------------------------------------------------------


class TestCmdSpecLight:
    """cmd_spec with Light sizing selection."""

    def test_creates_interview_md(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """Light path creates INTERVIEW.md at specified location."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        output = isolated_env / "INTERVIEW.md"
        spec = isolated_env / "SPECIFICATION.md"
        mock_user_input(_spec_responses_no_project(output, spec, sizing_choice="1"))

        result = run_command("cmd_spec", [])

        assert output.exists(), f"INTERVIEW.md not created at {output}"
        assert result.return_code in (0, None)

    def test_has_path_marker(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """Light output contains **Path**: Light."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        output = isolated_env / "INTERVIEW.md"
        spec = isolated_env / "SPECIFICATION.md"
        mock_user_input(_spec_responses_no_project(output, spec, sizing_choice="1"))

        run_command("cmd_spec", [])

        content = output.read_text(encoding="utf-8")
        assert "**Path**: Light" in content

    def test_references_interview_strategy(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """Light output references strategies/interview.md Light path."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        output = isolated_env / "INTERVIEW.md"
        spec = isolated_env / "SPECIFICATION.md"
        mock_user_input(_spec_responses_no_project(output, spec, sizing_choice="1"))

        run_command("cmd_spec", [])

        content = output.read_text(encoding="utf-8")
        assert "strategies/interview.md" in content
        assert "Light path" in content

    def test_heading(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """Light output heading is '# Interview: <name>'."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        output = isolated_env / "INTERVIEW.md"
        spec = isolated_env / "SPECIFICATION.md"
        mock_user_input(_spec_responses_no_project(output, spec, sizing_choice="1"))

        run_command("cmd_spec", [])

        content = output.read_text(encoding="utf-8")
        assert content.startswith("# Interview: TestProject")


# ---------------------------------------------------------------------------
# cmd_spec — Full path
# ---------------------------------------------------------------------------


class TestCmdSpecFull:
    """cmd_spec with Full sizing selection."""

    def test_creates_prd_md(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """Full path creates PRD.md at specified location."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        output = isolated_env / "PRD.md"
        spec = isolated_env / "SPECIFICATION.md"
        mock_user_input(_spec_responses_no_project(output, spec, sizing_choice="2"))

        result = run_command("cmd_spec", [])

        assert output.exists(), f"PRD.md not created at {output}"
        assert result.return_code in (0, None)

    def test_has_path_marker(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """Full output contains **Path**: Full."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        output = isolated_env / "PRD.md"
        spec = isolated_env / "SPECIFICATION.md"
        mock_user_input(_spec_responses_no_project(output, spec, sizing_choice="2"))

        run_command("cmd_spec", [])

        content = output.read_text(encoding="utf-8")
        assert "**Path**: Full" in content

    def test_references_interview_strategy(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """Full output references strategies/interview.md Full path."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        output = isolated_env / "PRD.md"
        spec = isolated_env / "SPECIFICATION.md"
        mock_user_input(_spec_responses_no_project(output, spec, sizing_choice="2"))

        run_command("cmd_spec", [])

        content = output.read_text(encoding="utf-8")
        assert "strategies/interview.md" in content
        assert "Full path" in content

    def test_heading(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """Full output heading is '# Product Requirements Document: <name>'."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        output = isolated_env / "PRD.md"
        spec = isolated_env / "SPECIFICATION.md"
        mock_user_input(_spec_responses_no_project(output, spec, sizing_choice="2"))

        run_command("cmd_spec", [])

        content = output.read_text(encoding="utf-8")
        assert content.startswith("# Product Requirements Document: TestProject")


# ---------------------------------------------------------------------------
# cmd_spec — Process override
# ---------------------------------------------------------------------------


class TestCmdSpecProcessOverride:
    """cmd_spec with PROJECT.md **Process** override."""

    def test_override_light_skips_sizing(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """**Process**: Light skips sizing prompt and produces Light output."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        _write_project_md(Path(os.environ["DEFT_PROJECT_PATH"]), "Light")
        output = isolated_env / "INTERVIEW.md"
        spec = isolated_env / "SPECIFICATION.md"
        mock_user_input(
            _spec_responses_with_project(output, spec, has_override=True)
        )

        result = run_command("cmd_spec", [])

        assert output.exists()
        content = output.read_text(encoding="utf-8")
        assert "**Path**: Light" in content
        assert result.return_code in (0, None)

    def test_override_full_skips_sizing(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """**Process**: Full skips sizing prompt and produces Full output."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        _write_project_md(Path(os.environ["DEFT_PROJECT_PATH"]), "Full")
        output = isolated_env / "PRD.md"
        spec = isolated_env / "SPECIFICATION.md"
        mock_user_input(
            _spec_responses_with_project(output, spec, has_override=True)
        )

        result = run_command("cmd_spec", [])

        assert output.exists()
        content = output.read_text(encoding="utf-8")
        assert "**Path**: Full" in content
        assert result.return_code in (0, None)


# ---------------------------------------------------------------------------
# cmd_spec — Edge cases
# ---------------------------------------------------------------------------


class TestCmdSpecEdgeCases:
    """Edge-case tests for cmd_spec."""

    def test_existing_file_without_force_returns_1(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """Returns 1 if output file already exists and --force not passed."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        output = isolated_env / "INTERVIEW.md"
        spec = isolated_env / "SPECIFICATION.md"
        output.write_text("existing content", encoding="utf-8")
        mock_user_input(_spec_responses_no_project(output, spec, sizing_choice="1"))

        result = run_command("cmd_spec", [])

        assert result.return_code == 1

    def test_features_in_output(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """Feature list appears in the generated output file."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        output = isolated_env / "INTERVIEW.md"
        spec = isolated_env / "SPECIFICATION.md"
        features = ["Login system", "Dashboard", "API endpoints"]
        mock_user_input(
            _spec_responses_no_project(output, spec, features=features, sizing_choice="1")
        )

        run_command("cmd_spec", [])

        content = output.read_text(encoding="utf-8")
        for feat in features:
            assert feat in content, f"Feature '{feat}' not found in output"

    def test_spec_output_path_in_content(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """SPECIFICATION output path appears in generated file."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        output = isolated_env / "INTERVIEW.md"
        spec = isolated_env / "MY_SPEC.md"
        mock_user_input(_spec_responses_no_project(output, spec, sizing_choice="1"))

        run_command("cmd_spec", [])

        content = output.read_text(encoding="utf-8")
        assert "MY_SPEC.md" in content


# ---------------------------------------------------------------------------
# _read_project_strategy
# ---------------------------------------------------------------------------


class TestReadProjectStrategy:
    """Tests for _read_project_strategy helper."""

    def test_returns_none_when_no_project_md(self, deft_run_module, isolated_env):
        """Returns None when PROJECT.md does not exist."""
        defaults = deft_run_module.get_default_paths()
        assert deft_run_module._read_project_strategy(defaults) is None

    def test_returns_interview(self, deft_run_module, isolated_env):
        """Returns 'interview' when strategy link points to interview.md."""
        project_path = Path(os.environ["DEFT_PROJECT_PATH"])
        project_path.write_text(
            "# Test\n\n## Strategy\n\n"
            "Use [Interview](../strategies/interview.md) for this project.\n",
            encoding="utf-8",
        )
        defaults = deft_run_module.get_default_paths()
        assert deft_run_module._read_project_strategy(defaults) == "interview"

    def test_returns_discuss(self, deft_run_module, isolated_env):
        """Returns 'discuss' when strategy link points to discuss.md."""
        project_path = Path(os.environ["DEFT_PROJECT_PATH"])
        project_path.write_text(
            "# Test\n\n## Strategy\n\n"
            "Use [Discuss](deft/strategies/discuss.md) for this project.\n",
            encoding="utf-8",
        )
        defaults = deft_run_module.get_default_paths()
        assert deft_run_module._read_project_strategy(defaults) == "discuss"

    def test_returns_none_without_strategy_link(self, deft_run_module, isolated_env):
        """Returns None when PROJECT.md has no strategy link."""
        project_path = Path(os.environ["DEFT_PROJECT_PATH"])
        project_path.write_text(
            "# Test\n\n## Strategy\n\nNo link here.\n",
            encoding="utf-8",
        )
        defaults = deft_run_module.get_default_paths()
        assert deft_run_module._read_project_strategy(defaults) is None


# ---------------------------------------------------------------------------
# cmd_spec — strategy-aware output
# ---------------------------------------------------------------------------


class TestCmdSpecStrategyAware:
    """cmd_spec output references the correct strategy from PROJECT.md."""

    def test_discuss_strategy_in_light_output(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """When PROJECT.md declares discuss, Light output references discuss.md."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        project_path = Path(os.environ["DEFT_PROJECT_PATH"])
        project_path.write_text(
            "# TestProject Project Guidelines\n\n## Strategy\n\n"
            "Use [Discuss](../strategies/discuss.md) for this project.\n",
            encoding="utf-8",
        )
        output = isolated_env / "INTERVIEW.md"
        spec = isolated_env / "SPECIFICATION.md"
        mock_user_input(
            _spec_responses_with_project(output, spec, has_override=False, sizing_choice="1")
        )

        run_command("cmd_spec", [])

        content = output.read_text(encoding="utf-8")
        assert "strategies/discuss.md" in content
        assert "**Strategy**: discuss" in content

    def test_discuss_strategy_in_full_output(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """When PROJECT.md declares discuss, Full output references discuss.md."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        project_path = Path(os.environ["DEFT_PROJECT_PATH"])
        project_path.write_text(
            "# TestProject Project Guidelines\n\n## Strategy\n\n"
            "Use [Discuss](../strategies/discuss.md) for this project.\n",
            encoding="utf-8",
        )
        output = isolated_env / "PRD.md"
        spec = isolated_env / "SPECIFICATION.md"
        mock_user_input(
            _spec_responses_with_project(output, spec, has_override=False, sizing_choice="2")
        )

        run_command("cmd_spec", [])

        content = output.read_text(encoding="utf-8")
        assert "strategies/discuss.md" in content
        assert "**Strategy**: discuss" in content

    def test_default_strategy_is_interview(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """Without PROJECT.md, strategy defaults to interview."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        output = isolated_env / "INTERVIEW.md"
        spec = isolated_env / "SPECIFICATION.md"
        mock_user_input(_spec_responses_no_project(output, spec, sizing_choice="1"))

        run_command("cmd_spec", [])

        content = output.read_text(encoding="utf-8")
        assert "**Strategy**: interview" in content
        assert "strategies/interview.md" in content


# ---------------------------------------------------------------------------
# cmd_project — **Process** field present
# ---------------------------------------------------------------------------


class TestCmdProjectProcessField:
    """cmd_project output includes **Process**: field."""

    def test_project_contains_process_field(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """Generated PROJECT.md contains **Process**: marker."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        (isolated_env / "deft").mkdir(exist_ok=True)
        project_path = isolated_env / "PROJECT.md"
        mock_user_input([
            str(project_path),   # output path
            "TestProject",       # project name
            "1",                 # CLI type
            "1",                 # first language
            "85",                # coverage
            "Flask",             # tech stack
            "1",                 # strategy
            "1",                 # branch-based (default)
            False,               # don't chain to spec
        ])

        run_command("cmd_project", [])

        content = project_path.read_text(encoding="utf-8")
        assert "**Process**:" in content
