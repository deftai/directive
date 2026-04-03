"""
test_loop_bugs.py — Tests for CLI loop bug fixes (#92 and #117).

#92:  Strategy selection infinite loop when strategies/ is empty.
#117: cmd_project re-runs questionnaire after cmd_install chains through.

Author: Scott Adams (msadams) — 2026-03-24
"""


# ---------------------------------------------------------------------------
# #92 — Strategy selection with empty strategies/ directory
# ---------------------------------------------------------------------------

def test_bootstrap_empty_strategies_defaults_to_interview(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """cmd_bootstrap completes without looping when strategies/ is empty."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    # Return an empty list from get_available_strategies
    monkeypatch.setattr(deft_run_module, "get_available_strategies", list)

    user_path = isolated_env / "USER.md"
    mock_user_input([
        str(user_path),   # 1  output path
        "TestUser",        # 2  name
        "85",              # 3  coverage
        "1",               # 4  first language
        # No strategy prompt — guard skips the loop
        False,             # 5  no custom rules
        False,             # 6  skip SOUL.md
        False,             # 7  skip morals.md
        False,             # 8  skip code-field.md
        False,             # 9  don't chain to project
    ])

    result = run_command("cmd_bootstrap", [])

    assert result.return_code in (0, None), (
        f"Expected success, got rc={result.return_code}\n{result.stderr}"
    )
    assert user_path.exists(), "USER.md not created"
    content = user_path.read_text(encoding="utf-8")
    # Fallback strategy should be Interview
    assert "Interview" in content
    assert "defaulting to Interview" in result.stdout


def test_project_empty_strategies_defaults_to_interview(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """cmd_project completes without looping when strategies/ is empty."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    monkeypatch.setattr(deft_run_module, "get_available_strategies", list)
    (isolated_env / "deft").mkdir(exist_ok=True)

    project_path = isolated_env / "PROJECT.md"
    mock_user_input([
        str(project_path),  # 1  output path
        "TestProject",       # 2  project name
        "1",                 # 3  CLI type
        "1",                 # 4  language
        "85",                # 5  coverage
        "Flask",             # 6  tech stack
        # No strategy prompt — guard skips the loop
        "1",                 # 7  branch-based (default)
        False,               # 8  don't chain to spec
    ])

    result = run_command("cmd_project", [])

    assert result.return_code in (0, None), (
        f"Expected success, got rc={result.return_code}\n{result.stderr}"
    )
    assert project_path.exists(), "PROJECT.md not created"
    content = project_path.read_text(encoding="utf-8")
    assert "Interview" in content
    assert "defaulting to Interview" in result.stdout


# ---------------------------------------------------------------------------
# #117 — cmd_project must not re-run after cmd_install chains through
# ---------------------------------------------------------------------------

def test_project_returns_after_install_chain(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """cmd_project returns cleanly after cmd_install chains through.

    When ./deft/ is missing, cmd_project asks to install, then cmd_install
    offers to chain into cmd_project → cmd_spec.  The original cmd_project
    must NOT fall through and re-run its questionnaire after the chain.
    We verify this by ensuring 'Project name' is only asked once.
    """
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    # No ./deft/ dir — triggers the install prompt

    call_count = {"cmd_install": 0}

    def tracking_install(args):
        """Track cmd_install calls and create ./deft/ to simulate install."""
        call_count["cmd_install"] += 1
        (isolated_env / "deft").mkdir(exist_ok=True)
        return 0  # Simulate: install succeeded, user declined chaining

    monkeypatch.setattr(deft_run_module, "cmd_install", tracking_install)

    project_path = isolated_env / "PROJECT.md"
    mock_user_input([
        True,               # 1  Install deft in current directory? → Yes
        # cmd_install runs and returns 0
        # Original cmd_project should return here — no more prompts
    ])

    result = run_command("cmd_project", [])

    assert result.return_code == 0, (
        f"Expected return 0 from cmd_install chain, "
        f"got rc={result.return_code}\n{result.stderr}"
    )
    assert call_count["cmd_install"] == 1, "cmd_install should be called exactly once"
    # PROJECT.md should NOT exist — the original cmd_project returned
    # after cmd_install, it didn't fall through to run the questionnaire
    assert not project_path.exists(), (
        "PROJECT.md should not exist — cmd_project should have returned "
        "after cmd_install, not fallen through to run the questionnaire again"
    )
