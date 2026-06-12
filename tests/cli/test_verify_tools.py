from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "scripts"


def _load_module():
    spec = importlib.util.spec_from_file_location("verify_tools", SCRIPTS_DIR / "verify_tools.py")
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["verify_tools"] = mod
    spec.loader.exec_module(mod)
    return mod


def _probe_with(*commands: str):
    available = set(commands)

    def probe(command: str) -> str | None:
        return f"/usr/bin/{command}" if command in available else None

    return probe


def test_verify_required_tools_passes_when_all_tools_exist() -> None:
    verify_tools = _load_module()
    lines: list[str] = []

    result = verify_tools.verify_required_tools(
        platform_id="linux",
        probe=_probe_with("git", "task", "uv", "python3", "gh", "apt-get"),
        output_fn=lines.append,
    )

    assert result.exit_code == 0
    assert result.missing == ()
    assert lines == ["[deft tools] Required tools are available."]


def test_missing_installable_tool_reports_prompt_manual_url_and_summary() -> None:
    verify_tools = _load_module()
    lines: list[str] = []

    result = verify_tools.verify_required_tools(
        platform_id="linux",
        probe=_probe_with("git", "uv", "python3", "gh", "apt-get"),
        output_fn=lines.append,
    )

    assert result.exit_code == 1
    task_status = next(status for status in result.statuses if status.name == "task")
    assert task_status.installable is True
    assert task_status.install_command == ("sudo", "apt-get", "install", "-y", "go-task")
    assert any("`task` is not installed" in line for line in lines)
    assert any("Manual install: sudo apt-get install go-task" in line for line in lines)
    assert any("https://taskfile.dev/installation/" in line for line in lines)
    assert lines[-1] == "[deft tools] Unresolved required tools: task."


def test_non_interactive_guidance_omits_yes_no_prompt() -> None:
    verify_tools = _load_module()
    lines: list[str] = []

    verify_tools.verify_required_tools(
        platform_id="linux",
        probe=_probe_with("git", "uv", "python3", "gh", "apt-get"),
        output_fn=lines.append,
    )

    assert not any("(Y/n)" in line for line in lines)
    assert any("re-run with `--install`" in line for line in lines)


def test_interactive_guidance_includes_yes_no_prompt() -> None:
    verify_tools = _load_module()
    lines: list[str] = []

    verify_tools.verify_required_tools(
        install=True,
        assume_yes=False,
        platform_id="linux",
        probe=_probe_with("git", "uv", "python3", "gh", "apt-get"),
        input_fn=lambda _prompt: "n",
        output_fn=lines.append,
    )

    assert any("Install it now? (Y/n)" in line for line in lines)


def test_approved_install_runs_command_and_rechecks_tool() -> None:
    verify_tools = _load_module()
    available = {"git", "uv", "python3", "gh", "apt-get"}
    commands_run: list[tuple[str, ...]] = []

    def probe(command: str) -> str | None:
        return f"/usr/bin/{command}" if command in available else None

    def run(command):
        commands_run.append(tuple(command))
        available.add("task")
        return subprocess.CompletedProcess(command, returncode=0, stdout="", stderr="")

    result = verify_tools.verify_required_tools(
        install=True,
        assume_yes=True,
        platform_id="linux",
        probe=probe,
        run_fn=run,
    )

    task_status = next(status for status in result.statuses if status.name == "task")
    assert result.exit_code == 0
    assert commands_run == [("sudo", "apt-get", "install", "-y", "go-task")]
    assert task_status.installed_after_offer is True
    assert task_status.command == "task"


def test_declined_install_keeps_manual_fallback_unresolved() -> None:
    verify_tools = _load_module()

    result = verify_tools.verify_required_tools(
        install=True,
        assume_yes=False,
        platform_id="linux",
        probe=_probe_with("git", "uv", "python3", "gh", "apt-get"),
        input_fn=lambda _prompt: "n",
    )

    task_status = next(status for status in result.statuses if status.name == "task")
    assert result.exit_code == 1
    assert task_status.declined is True
    assert task_status.manual_command == "sudo apt-get install go-task"


def test_missing_manual_only_tool_skips_install_prompt() -> None:
    verify_tools = _load_module()
    lines: list[str] = []

    result = verify_tools.verify_required_tools(
        platform_id="unknown",
        probe=_probe_with("git", "task", "python3", "gh"),
        output_fn=lines.append,
    )

    uv_status = next(status for status in result.statuses if status.name == "uv")
    assert result.exit_code == 1
    assert uv_status.installable is False
    assert any("no safe automated installer" in line for line in lines)
    assert not any("Install it now? (Y/n)" in line for line in lines)


def test_missing_git_is_foundational_failure_without_auto_install() -> None:
    verify_tools = _load_module()

    result = verify_tools.verify_required_tools(
        platform_id="linux",
        probe=_probe_with("task", "uv", "python3", "gh", "apt-get"),
    )

    git_status = next(status for status in result.statuses if status.name == "git")
    assert result.exit_code == 2
    assert git_status.foundational is True
    assert git_status.installable is False
