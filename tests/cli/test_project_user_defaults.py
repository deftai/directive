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
    deft_run_module, isolated_env_no_user
):
    """_read_user_defaults returns empty dict when USER.md does not exist.

    Uses `isolated_env_no_user` (vs. the default `isolated_env`) because
    the CLI-scoped override of `isolated_env` (#163) pre-creates a
    minimal USER.md to satisfy the cmd_spec/cmd_project presence gate.
    The unit-level _read_user_defaults helper is what's under test here,
    not the gate -- so absence is what we want to assert against.
    """
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
    provides defaults -- needs fewer mock responses than the 8-response
    baseline.

    With USER.md present, cmd_project pre-fills from USER.md and the user
    can press Enter to accept each default. Prompt count is the same, but
    the user doesn't have to re-type answers:
      1. Where to write PROJECT-DEFINITION  (read_input)
      2. Project name                        (read_input)
      3. Project type                        (read_input)
      4. Languages -- Enter to keep          (read_input, "" = accept)
      5. Coverage -- Enter to keep           (read_input, "" = accept)
      6. Tech stack details                  (read_input)
      7. Strategy -- Enter to keep           (read_input, "" = accept)
      8. Branching preference                (read_input, "1" = branch-based)
      9. Run 'run spec' now?                (read_yn)
    """
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    (isolated_env / "deft").mkdir(exist_ok=True)

    # Write USER.md with defaults
    user_path = isolated_env / "USER.md"
    _write_user_md(user_path, lang="Python", strategy_stem="interview",
                   strategy_display="Interview", coverage="85")

    project_path = isolated_env / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
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

    assert project_path.exists(), "PROJECT-DEFINITION.vbrief.json not created"
    import json
    data = json.loads(project_path.read_text(encoding="utf-8"))
    narratives = data["plan"]["narratives"]
    assert "Python" in narratives.get("Languages", ""), "Language from USER.md should appear"
    assert "Interview" in narratives.get("Strategy", ""), "Strategy from USER.md should appear"
    assert result.return_code in (0, None)


def test_project_blocks_when_user_md_missing(
    run_command, isolated_env_no_user, deft_run_module, monkeypatch
):
    """cmd_project must short-circuit at the USER.md gate when USER.md
    is absent (#163).

    Replaces the previous `test_project_still_works_without_user_md`
    coverage: prior to #163 cmd_project would happily run without
    USER.md; the gate now mirrors the agentic-path behavior in
    deft-directive-build by exiting non-zero with an actionable redirect
    to `run bootstrap`.
    """
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    (isolated_env_no_user / "deft").mkdir(exist_ok=True)
    project_path = (
        isolated_env_no_user / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    )

    # No USER.md written, no prompts queued -- the gate must fire BEFORE
    # cmd_project asks the user anything.
    result = run_command("cmd_project", [])

    assert result.return_code == 1, (
        f"Expected non-zero exit at USER.md gate, got rc={result.return_code}\n"
        f"stdout={result.stdout}\nstderr={result.stderr}"
    )
    assert not project_path.exists(), (
        "PROJECT-DEFINITION.vbrief.json must not be created when the gate fires"
    )
    combined = result.stdout + result.stderr
    assert "USER.md" in combined and "run bootstrap" in combined, (
        "Gate message must name USER.md and redirect to `run bootstrap`"
    )
