"""
test_usermd_gate.py -- Tests for the USER.md presence gate at cmd_spec
and cmd_project entry points (#163).

Acceptance criteria from
vbrief/active/2026-04-23-163-enforce-user-md-gate-in-cli-path-parity-with-agentic.vbrief.json:

  Item A (usermd-gate-cmd-spec): cmd_spec exits with a helpful, actionable
    message when USER.md is absent; the message names the expected path
    and suggests `run bootstrap`.
  Item B (usermd-gate-cmd-project): cmd_project mirrors the same gate
    behavior identically.
  Item C (usermd-gate-tests): coverage for missing-USER.md early exit on
    both commands, present-USER.md happy path on both commands, and
    `$DEFT_USER_PATH` override on both.

The test surface uses tmp-path fixtures so the developer's real USER.md
at `~/.config/deft/USER.md` (or `%APPDATA%\\deft\\USER.md`) is never
touched -- every USER.md path goes through `$DEFT_USER_PATH` (set either
by the `isolated_env_no_user` fixture or directly via monkeypatch).

Author: Deft Directive agent (msadams) -- 2026-04-29
Refs: #163
"""

from pathlib import Path

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_minimal_user_md(path: Path) -> None:
    """Create a minimal but valid USER.md so the gate passes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "# User Preferences\n"
        "\n"
        "## Defaults (fallback)\n"
        "\n"
        "**Primary Languages**:\n"
        "- (None specified)\n",
        encoding="utf-8",
    )


def _spec_responses_light() -> list:
    """Standard cmd_spec response queue for the Light path.

    Mirrors the flow exercised by tests/cli/test_cmd_spec.py:
      1. Project name
      2. Brief description
      3. First feature
      4. (empty -- finish features)
      5. Sizing selection (1 = Light)
    """
    return [
        "GateApp",
        "A test app for the USER.md gate",
        "Feature A",
        "",
        "1",
    ]


def _project_responses(project_path: Path) -> list:
    """Standard cmd_project response queue (no USER.md defaults).

    Mirrors the flow exercised by tests/cli/test_project.py.
    """
    return [
        str(project_path),
        "GateProject",
        "1",      # CLI
        "1",      # first language
        "85",     # coverage
        "Flask",  # tech stack
        "1",      # strategy
        "1",      # branch-based
        False,    # don't chain to cmd_spec
    ]


# ---------------------------------------------------------------------------
# Resolver / helper unit tests
# ---------------------------------------------------------------------------


def test_resolve_user_md_path_honors_deft_user_path_override(
    deft_run_module, monkeypatch, tmp_path
):
    """`$DEFT_USER_PATH` overrides the platform default on any platform."""
    custom = tmp_path / "deeply" / "nested" / "USER.md"
    monkeypatch.setenv("DEFT_USER_PATH", str(custom))
    resolved = deft_run_module._resolve_user_md_path()
    assert resolved == custom.resolve()


def test_check_user_md_gate_returns_none_when_present(
    deft_run_module, monkeypatch, tmp_path
):
    """Gate passes (returns None) when USER.md exists at the resolved path."""
    user_md = tmp_path / "USER.md"
    _write_minimal_user_md(user_md)
    monkeypatch.setenv("DEFT_USER_PATH", str(user_md))
    assert deft_run_module._check_user_md_gate() is None


def test_check_user_md_gate_returns_one_when_missing(
    deft_run_module, monkeypatch, tmp_path, capsys
):
    """Gate returns 1 and emits a redirect when USER.md is missing."""
    user_md = tmp_path / "USER.md"
    monkeypatch.setenv("DEFT_USER_PATH", str(user_md))
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    assert deft_run_module._check_user_md_gate() == 1
    captured = capsys.readouterr()
    combined = captured.out + captured.err
    assert "USER.md" in combined
    assert str(user_md.resolve()) in combined
    assert "run bootstrap" in combined


# ---------------------------------------------------------------------------
# Item A: cmd_spec gate (missing USER.md)
# ---------------------------------------------------------------------------


def test_cmd_spec_blocks_when_user_md_missing(
    run_command, isolated_env_no_user, deft_run_module, monkeypatch
):
    """cmd_spec MUST exit non-zero with a redirect message before any work."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    user_md = isolated_env_no_user / "USER.md"
    assert not user_md.exists(), "Precondition: USER.md must NOT exist"
    proposed = isolated_env_no_user / "vbrief" / "proposed"

    # Intentionally queue zero responses -- the gate must fire BEFORE the
    # first prompt, otherwise mock_user_input would AssertionError on an
    # exhausted queue.
    result = run_command("cmd_spec", [])

    assert result.return_code == 1, (
        f"Expected non-zero exit at USER.md gate, got rc={result.return_code}\n"
        f"stdout={result.stdout}\nstderr={result.stderr}"
    )
    assert not list(proposed.glob("*.vbrief.json")) if proposed.exists() else True, (
        "scope vBRIEF must not be created when the gate fires"
    )
    combined = result.stdout + result.stderr
    assert "USER.md" in combined, "Gate message must mention USER.md"
    assert str(user_md.resolve()) in combined, (
        f"Gate message must include the resolved path {user_md}; got:\n{combined}"
    )
    assert "run bootstrap" in combined, (
        "Gate message must redirect to `run bootstrap`"
    )
    assert "DEFT_USER_PATH" in combined, (
        "Gate message must mention $DEFT_USER_PATH override hint"
    )


# ---------------------------------------------------------------------------
# Item B: cmd_project gate (missing USER.md)
# ---------------------------------------------------------------------------


def test_cmd_project_blocks_when_user_md_missing(
    run_command, isolated_env_no_user, deft_run_module, monkeypatch
):
    """cmd_project MUST mirror cmd_spec's gate identically."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    (isolated_env_no_user / "deft").mkdir(exist_ok=True)
    user_md = isolated_env_no_user / "USER.md"
    project_path = (
        isolated_env_no_user / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    )
    assert not user_md.exists(), "Precondition: USER.md must NOT exist"

    result = run_command("cmd_project", [])

    assert result.return_code == 1, (
        f"Expected non-zero exit at USER.md gate, got rc={result.return_code}\n"
        f"stdout={result.stdout}\nstderr={result.stderr}"
    )
    assert not project_path.exists(), (
        "PROJECT-DEFINITION.vbrief.json must not be created when the gate fires"
    )
    combined = result.stdout + result.stderr
    assert "USER.md" in combined
    assert str(user_md.resolve()) in combined
    assert "run bootstrap" in combined
    # Symmetric with `test_cmd_spec_blocks_when_user_md_missing` -- both
    # commands route through the same `_check_user_md_gate()`, so both
    # tests assert the override-hint surface explicitly. Without this,
    # the line could be silently stripped from the gate's output
    # without failing the cmd_project test (Greptile P2 on PR #753).
    assert "DEFT_USER_PATH" in combined, (
        "Gate message must mention $DEFT_USER_PATH override hint"
    )


# ---------------------------------------------------------------------------
# Item C: happy paths when USER.md is present
# ---------------------------------------------------------------------------


def test_cmd_spec_proceeds_when_user_md_present(
    run_command, mock_user_input, isolated_env_no_user, deft_run_module, monkeypatch
):
    """With USER.md present, cmd_spec proceeds to its normal behavior."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    user_md = isolated_env_no_user / "USER.md"
    _write_minimal_user_md(user_md)
    mock_user_input(_spec_responses_light())

    result = run_command("cmd_spec", [])

    assert result.return_code in (0, None), (
        f"Expected success when USER.md is present, got rc={result.return_code}\n"
        f"stderr={result.stderr}"
    )
    proposed = isolated_env_no_user / "vbrief" / "proposed"
    vbrief_files = list(proposed.glob("*.vbrief.json"))
    assert len(vbrief_files) == 1, (
        f"Expected 1 scope vBRIEF, found {len(vbrief_files)} in {proposed}"
    )


def test_cmd_project_proceeds_when_user_md_present(
    run_command, mock_user_input, isolated_env_no_user, deft_run_module, monkeypatch
):
    """With USER.md present, cmd_project proceeds to its normal behavior."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    (isolated_env_no_user / "deft").mkdir(exist_ok=True)
    user_md = isolated_env_no_user / "USER.md"
    _write_minimal_user_md(user_md)
    project_path = (
        isolated_env_no_user / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    )
    mock_user_input(_project_responses(project_path))

    result = run_command("cmd_project", [])

    assert result.return_code in (0, None), (
        f"Expected success when USER.md is present, got rc={result.return_code}\n"
        f"stderr={result.stderr}"
    )
    assert project_path.exists(), "PROJECT-DEFINITION.vbrief.json must be created"


# ---------------------------------------------------------------------------
# Item C: $DEFT_USER_PATH override on both commands
# ---------------------------------------------------------------------------


def test_cmd_spec_honors_deft_user_path_override(
    run_command, mock_user_input, deft_run_module, monkeypatch, tmp_path
):
    """A USER.md at a custom `$DEFT_USER_PATH` location lets cmd_spec proceed.

    Bypasses the standard `isolated_env*` fixtures and wires every env
    var directly on tmp_path so the override path is unmistakably under
    test (and the developer's real USER.md is untouched).
    """
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    custom_user = tmp_path / "deeply" / "nested" / "USER.md"
    _write_minimal_user_md(custom_user)
    project_json = tmp_path / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    proposed = tmp_path / "vbrief" / "proposed"
    monkeypatch.setenv("DEFT_USER_PATH", str(custom_user))
    monkeypatch.setenv("DEFT_PROJECT_PATH", str(project_json))
    monkeypatch.setenv("DEFT_VBRIEF_PROPOSED", str(proposed))
    monkeypatch.chdir(tmp_path)
    mock_user_input(_spec_responses_light())

    result = run_command("cmd_spec", [])

    assert result.return_code in (0, None), (
        f"Expected success with DEFT_USER_PATH override, "
        f"got rc={result.return_code}\nstderr={result.stderr}"
    )
    vbrief_files = list(proposed.glob("*.vbrief.json"))
    assert len(vbrief_files) == 1, (
        f"Expected scope vBRIEF via override path, found {len(vbrief_files)}"
    )


def test_cmd_project_honors_deft_user_path_override(
    run_command, mock_user_input, deft_run_module, monkeypatch, tmp_path
):
    """A USER.md at a custom `$DEFT_USER_PATH` lets cmd_project proceed."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    (tmp_path / "deft").mkdir(exist_ok=True)
    custom_user = tmp_path / "elsewhere" / "USER.md"
    _write_minimal_user_md(custom_user)
    project_json = tmp_path / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    proposed = tmp_path / "vbrief" / "proposed"
    monkeypatch.setenv("DEFT_USER_PATH", str(custom_user))
    monkeypatch.setenv("DEFT_PROJECT_PATH", str(project_json))
    monkeypatch.setenv("DEFT_VBRIEF_PROPOSED", str(proposed))
    monkeypatch.chdir(tmp_path)
    mock_user_input(_project_responses(project_json))

    result = run_command("cmd_project", [])

    assert result.return_code in (0, None), (
        f"Expected success with DEFT_USER_PATH override, "
        f"got rc={result.return_code}\nstderr={result.stderr}"
    )
    assert project_json.exists(), (
        "PROJECT-DEFINITION.vbrief.json must be created via override path"
    )
