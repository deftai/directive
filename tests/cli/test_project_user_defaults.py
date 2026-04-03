"""
test_project_user_defaults.py — Tests for cmd_project reading USER.md defaults.

Verifies fix for #7: when cmd_bootstrap chains into cmd_project, the
overlapping questions (languages, coverage, strategy) should be pre-filled
from the just-written USER.md rather than asked again from scratch.

Author: Scott Adams (msadams) — 2026-03-16
"""

from pathlib import Path


def _write_user_md(path: Path, *, lang="Python", strategy_stem="interview",
                   strategy_display="Interview", coverage="90") -> None:
    """Write a USER.md with known defaults for testing."""
    coverage_line = (
        f"\n**Coverage**: ! ≥{coverage}% test coverage" if coverage != "85" else ""
    )
    path.write_text(
        f"# User Preferences\n\n"
        f"## Personal (always wins)\n\n"
        f"**Name**: Address the user as: **Test User**\n\n"
        f"**Custom Rules**:\nNo custom rules defined yet.\n\n"
        f"## Defaults (fallback)\n\n"
        f"**Primary Languages**:\n- {lang}\n\n"
        f"**Default Strategy**: [{strategy_display}](../strategies/{strategy_stem}.md)\n"
        f"{coverage_line}\n",
        encoding="utf-8",
    )


# -- _read_user_defaults unit tests ------------------------------------------

def test_read_user_defaults_parses_language(deft_run_module, isolated_env):
    """_read_user_defaults extracts language from USER.md."""
    user_path = isolated_env / "USER.md"
    _write_user_md(user_path, lang="TypeScript")

    defaults = deft_run_module._read_user_defaults(
        deft_run_module.get_default_paths()
    )
    assert "TypeScript" in defaults["languages"]


def test_read_user_defaults_parses_strategy(deft_run_module, isolated_env):
    """_read_user_defaults extracts strategy stem from USER.md."""
    user_path = isolated_env / "USER.md"
    _write_user_md(user_path, strategy_stem="discuss", strategy_display="Discuss")

    defaults = deft_run_module._read_user_defaults(
        deft_run_module.get_default_paths()
    )
    assert defaults["strategy"] == "discuss"


def test_read_user_defaults_parses_coverage(deft_run_module, isolated_env):
    """_read_user_defaults extracts coverage threshold from USER.md."""
    user_path = isolated_env / "USER.md"
    _write_user_md(user_path, coverage="90")

    defaults = deft_run_module._read_user_defaults(
        deft_run_module.get_default_paths()
    )
    assert defaults["coverage"] == "90"


def test_read_user_defaults_returns_none_when_missing(
    deft_run_module, isolated_env
):
    """_read_user_defaults returns empty dict when USER.md does not exist."""
    # Don't write any USER.md
    defaults = deft_run_module._read_user_defaults(
        deft_run_module.get_default_paths()
    )
    assert defaults == {}


# -- cmd_project integration: fewer prompts when USER.md exists ---------------

def test_project_uses_user_defaults_fewer_prompts(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """cmd_project skips language/coverage/strategy questions when USER.md
    provides defaults — needs fewer mock responses than the 8-response
    baseline.

    With USER.md present, cmd_project pre-fills from USER.md and the user
    can press Enter to accept each default. Prompt count is the same, but
    the user doesn't have to re-type answers:
      1. Where to write PROJECT.md      (read_input)
      2. Project name                    (read_input)
      3. Project type                    (read_input)
      4. Languages — Enter to keep       (read_input, "" = accept)
      5. Coverage — Enter to keep        (read_input, "" = accept)
      6. Tech stack details              (read_input)
      7. Strategy — Enter to keep        (read_input, "" = accept)
      8. Branching preference              (read_input, "1" = branch-based)
      9. Run 'run spec' now?            (read_yn)
    """
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    (isolated_env / "deft").mkdir(exist_ok=True)

    # Write USER.md with defaults
    user_path = isolated_env / "USER.md"
    _write_user_md(user_path, lang="Python", strategy_stem="interview",
                   strategy_display="Interview", coverage="85")

    project_path = isolated_env / "PROJECT.md"
    mock_user_input([
        str(project_path),   # 1  output path
        "TestProject",        # 2  project name
        "1",                  # 3  CLI
        "",                   # 4  accept languages from USER.md
        "",                   # 5  accept coverage from USER.md
        "Flask",              # 6  tech stack
        "",                   # 7  accept strategy from USER.md
        "1",                  # 8  branch-based (default)
        False,                # 9  don't chain to spec
    ])

    result = run_command("cmd_project", [])

    assert project_path.exists(), "PROJECT.md not created"
    content = project_path.read_text(encoding="utf-8")
    assert "Python" in content, "Language from USER.md should appear in PROJECT.md"
    assert "Interview" in content, "Strategy from USER.md should appear in PROJECT.md"
    assert result.return_code in (0, None)


def test_project_still_works_without_user_md(
    run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
):
    """cmd_project still works with full prompts when no USER.md exists
    (backward compatibility).
    """
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    (isolated_env / "deft").mkdir(exist_ok=True)

    # No USER.md written — should fall back to asking all questions
    project_path = isolated_env / "PROJECT.md"
    mock_user_input([
        str(project_path),   # 1  output path
        "TestProject",        # 2  project name
        "1",                  # 3  CLI
        "1",                  # 4  first language
        "85",                 # 5  coverage
        "Flask",              # 6  tech stack
        "1",                  # 7  strategy
        "1",                  # 8  branch-based (default)
        False,                # 9  don't chain to spec
    ])

    result = run_command("cmd_project", [])

    assert project_path.exists(), "PROJECT.md not created"
    assert result.return_code in (0, None)
