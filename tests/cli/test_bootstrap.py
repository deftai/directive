"""
test_bootstrap.py — Tests for cmd_bootstrap.

Subphase 3.2 of the CLI regression suite (SPECIFICATION.md).

Tests:
  - Happy path: mocked inputs produce USER.md with expected sections
  - Output path: file written to get_default_paths()['user']
  - No crash: exits without exception given minimal valid inputs

Author: Scott Adams (msadams) — 2026-03-10
"""

from pathlib import Path


def _bootstrap_responses(user_path: Path) -> list:
    """Build the standard 10-response queue for cmd_bootstrap.

    Prompt order (from run:cmd_bootstrap):
      1. Where to write USER.md          (read_input)
      2. Your name                        (read_input)
      3. Coverage threshold               (read_input, default 85)
      4. Language selection                (read_input, e.g. "1")
      5. Strategy selection               (read_input, default "1")
      6. Do you have custom rules?        (read_yn)
      7. Use SOUL.md?                     (read_yn)
      8. Use morals.md?                   (read_yn)
      9. Use code-field.md?              (read_yn)
     10. Run 'run project' now?           (read_yn)
    """
    return [
        str(user_path),   # 1  output path
        "TestUser",        # 2  name
        "85",              # 3  coverage
        "1",               # 4  first language
        "1",               # 5  first strategy
        False,             # 6  no custom rules
        False,             # 7  skip SOUL.md
        False,             # 8  skip morals.md
        False,             # 9  skip code-field.md
        False,             # 10 don't chain to project
    ]


def test_bootstrap_happy_path(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """cmd_bootstrap with mocked inputs produces USER.md with expected sections."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    user_path = isolated_env / "USER.md"
    mock_user_input(_bootstrap_responses(user_path))

    result = run_command("cmd_bootstrap", [])

    assert user_path.exists(), f"USER.md not created at {user_path}"
    content = user_path.read_text(encoding="utf-8")
    assert "## Personal (always wins)" in content
    assert "## Defaults (fallback)" in content
    assert "TestUser" in content
    assert result.return_code in (0, None)


def test_bootstrap_output_path(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """USER.md is written to the path from get_default_paths()['user']."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    expected_path = deft_run_module.resolve_path(
        deft_run_module.get_default_paths()["user"]
    )
    mock_user_input(_bootstrap_responses(expected_path))

    run_command("cmd_bootstrap", [])

    assert expected_path.exists(), (
        f"USER.md not at default path {expected_path}"
    )


def test_bootstrap_no_crash(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """cmd_bootstrap exits without exception given minimal valid inputs."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    mock_user_input(_bootstrap_responses(isolated_env / "USER.md"))

    result = run_command("cmd_bootstrap", [])

    assert result.return_code in (0, None), (
        f"Expected success, got rc={result.return_code}\n{result.stderr}"
    )


def test_bootstrap_rejects_duplicate_languages(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """Duplicate language selections are rejected and the user is re-prompted."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    user_path = isolated_env / "USER.md"
    mock_user_input([
        str(user_path),   # 1  output path
        "TestUser",        # 2  name
        "85",              # 3  coverage
        "1,1",             # 4  duplicate language — rejected
        "1",               # 5  valid language — accepted
        "1",               # 6  strategy
        False,             # 7  no custom rules
        False,             # 8  skip SOUL.md
        False,             # 9  skip morals.md
        False,             # 10 skip code-field.md
        False,             # 11 don't chain to project
    ])

    result = run_command("cmd_bootstrap", [])

    assert result.return_code in (0, None)
    assert "Duplicate" in result.stdout


def test_bootstrap_collects_custom_rules(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """When user opts in to custom rules, per-line collection loop runs."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    user_path = isolated_env / "USER.md"
    mock_user_input([
        str(user_path),        # 1  output path
        "TestUser",            # 2  name
        "85",                  # 3  coverage
        "1",                   # 4  first language
        "1",                   # 5  first strategy
        True,                  # 6  yes, I have custom rules
        "Always use types",    # 7  rule 1
        "No magic numbers",    # 8  rule 2
        "",                    # 9  empty line ends the loop
        False,                 # 10 skip SOUL.md
        False,                 # 11 skip morals.md
        False,                 # 12 skip code-field.md
        False,                 # 13 don't chain to project
    ])

    result = run_command("cmd_bootstrap", [])

    assert result.return_code in (0, None)
    content = user_path.read_text(encoding="utf-8")
    assert "- Always use types" in content
    assert "- No magic numbers" in content


def test_bootstrap_keeps_existing_user_md(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """When USER.md exists and user declines overwrite, file is preserved."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    user_path = isolated_env / "USER.md"
    original_content = "# Existing preferences\nKeep me."
    user_path.write_text(original_content, encoding="utf-8")

    mock_user_input([
        str(user_path),   # 1  output path
        False,             # 2  Overwrite with new preferences? → No
        False,             # 3  Run 'run project' now? → No
    ])

    result = run_command("cmd_bootstrap", [])

    assert result.return_code in (0, None)
    assert user_path.read_text(encoding="utf-8") == original_content
    assert "Keeping existing" in result.stdout
