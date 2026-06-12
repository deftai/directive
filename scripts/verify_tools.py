#!/usr/bin/env python3
"""Verify Deft's required host tooling and print setup guidance (#1187)."""

from __future__ import annotations

import argparse
import json
import platform
import shutil
import subprocess
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace

ProbeFn = Callable[[str], str | None]
InputFn = Callable[[str], str]
OutputFn = Callable[[str], None]
RunFn = Callable[[Sequence[str]], subprocess.CompletedProcess[str]]


@dataclass(frozen=True)
class ToolSpec:
    name: str
    commands: tuple[str, ...]
    url: str
    manual_commands: dict[str, str]
    packages: dict[str, dict[str, tuple[str, ...]]]
    foundational: bool = False


@dataclass(frozen=True)
class ToolStatus:
    name: str
    installed: bool
    command: str | None = None
    installable: bool = False
    install_command: tuple[str, ...] | None = None
    manual_command: str | None = None
    url: str | None = None
    installed_after_offer: bool = False
    declined: bool = False
    install_error: str | None = None
    foundational: bool = False

    @property
    def unresolved(self) -> bool:
        return not self.installed and not self.installed_after_offer


@dataclass(frozen=True)
class VerificationResult:
    statuses: tuple[ToolStatus, ...]
    platform_id: str
    package_manager: str | None

    @property
    def missing(self) -> tuple[ToolStatus, ...]:
        return tuple(status for status in self.statuses if status.unresolved)

    @property
    def exit_code(self) -> int:
        if any(status.foundational and status.unresolved for status in self.statuses):
            return 2
        return 1 if self.missing else 0

    def to_json(self) -> str:
        payload = {
            "platform": self.platform_id,
            "package_manager": self.package_manager,
            "exit_code": self.exit_code,
            "tools": [
                {
                    "name": status.name,
                    "installed": status.installed or status.installed_after_offer,
                    "command": status.command,
                    "installable": status.installable,
                    "install_command": list(status.install_command or ()),
                    "manual_command": status.manual_command,
                    "url": status.url,
                    "declined": status.declined,
                    "install_error": status.install_error,
                    "foundational": status.foundational,
                }
                for status in self.statuses
            ],
        }
        return json.dumps(payload, sort_keys=True)


TOOL_SPECS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name="git",
        commands=("git",),
        url="https://git-scm.com/downloads",
        manual_commands={
            "windows": "winget install --id Git.Git -e",
            "macos": "brew install git",
            "linux": "sudo apt-get install git",
            "unknown": "Install Git from https://git-scm.com/downloads",
        },
        packages={},
        foundational=True,
    ),
    ToolSpec(
        name="task",
        commands=("task",),
        url="https://taskfile.dev/installation/",
        manual_commands={
            "windows": "winget install --id Task.Task -e",
            "macos": "brew install go-task",
            "linux": "sudo apt-get install go-task",
            "unknown": "Install Task from https://taskfile.dev/installation/",
        },
        packages={
            "windows": {
                "winget": ("winget", "install", "--id", "Task.Task", "-e"),
                "scoop": ("scoop", "install", "go-task"),
                "choco": ("choco", "install", "go-task", "-y"),
            },
            "macos": {"brew": ("brew", "install", "go-task")},
            "linux": {
                "apt-get": ("sudo", "apt-get", "install", "-y", "go-task"),
                "dnf": ("sudo", "dnf", "install", "-y", "go-task"),
                "pacman": ("sudo", "pacman", "-S", "--noconfirm", "go-task"),
            },
        },
    ),
    ToolSpec(
        name="uv",
        commands=("uv",),
        url="https://docs.astral.sh/uv/getting-started/installation/",
        manual_commands={
            "windows": "winget install --id astral-sh.uv -e",
            "macos": "brew install uv",
            "linux": "sudo apt-get install uv",
            "unknown": "Install uv from https://docs.astral.sh/uv/getting-started/installation/",
        },
        packages={
            "windows": {
                "winget": ("winget", "install", "--id", "astral-sh.uv", "-e"),
                "scoop": ("scoop", "install", "uv"),
                "choco": ("choco", "install", "uv", "-y"),
            },
            "macos": {"brew": ("brew", "install", "uv")},
            "linux": {
                "apt-get": ("sudo", "apt-get", "install", "-y", "uv"),
                "dnf": ("sudo", "dnf", "install", "-y", "uv"),
                "pacman": ("sudo", "pacman", "-S", "--noconfirm", "uv"),
            },
        },
    ),
    ToolSpec(
        name="python",
        commands=("python3", "python"),
        url="https://www.python.org/downloads/",
        manual_commands={
            "windows": "winget install --id Python.Python.3 -e",
            "macos": "brew install python",
            "linux": "sudo apt-get install python3",
            "unknown": "Install Python from https://www.python.org/downloads/",
        },
        packages={
            "windows": {
                "winget": ("winget", "install", "--id", "Python.Python.3", "-e"),
                "scoop": ("scoop", "install", "python"),
                "choco": ("choco", "install", "python", "-y"),
            },
            "macos": {"brew": ("brew", "install", "python")},
            "linux": {
                "apt-get": ("sudo", "apt-get", "install", "-y", "python3"),
                "dnf": ("sudo", "dnf", "install", "-y", "python3"),
                "pacman": ("sudo", "pacman", "-S", "--noconfirm", "python"),
            },
        },
    ),
    ToolSpec(
        name="gh",
        commands=("gh",),
        url="https://cli.github.com/",
        manual_commands={
            "windows": "winget install --id GitHub.cli -e",
            "macos": "brew install gh",
            "linux": "sudo apt-get install gh",
            "unknown": "Install GitHub CLI from https://cli.github.com/",
        },
        packages={
            "windows": {
                "winget": ("winget", "install", "--id", "GitHub.cli", "-e"),
                "scoop": ("scoop", "install", "gh"),
                "choco": ("choco", "install", "gh", "-y"),
            },
            "macos": {"brew": ("brew", "install", "gh")},
            "linux": {
                "apt-get": ("sudo", "apt-get", "install", "-y", "gh"),
                "dnf": ("sudo", "dnf", "install", "-y", "gh"),
                "pacman": ("sudo", "pacman", "-S", "--noconfirm", "github-cli"),
            },
        },
    ),
)


PACKAGE_MANAGERS: dict[str, tuple[str, ...]] = {
    "windows": ("winget", "scoop", "choco"),
    "macos": ("brew",),
    "linux": ("apt-get", "dnf", "pacman"),
}


def detect_platform() -> str:
    system = platform.system().lower()
    if system == "windows":
        return "windows"
    if system == "darwin":
        return "macos"
    if system == "linux":
        return "linux"
    return "unknown"


def detect_package_manager(platform_id: str, *, probe: ProbeFn = shutil.which) -> str | None:
    for manager in PACKAGE_MANAGERS.get(platform_id, ()):
        if probe(manager):
            return manager
    return None


def _installed_command(spec: ToolSpec, probe: ProbeFn) -> str | None:
    for command in spec.commands:
        if probe(command):
            return command
    return None


def _install_command(
    spec: ToolSpec,
    *,
    platform_id: str,
    package_manager: str | None,
) -> tuple[str, ...] | None:
    if package_manager is None:
        return None
    return spec.packages.get(platform_id, {}).get(package_manager)


def _default_run(command: Sequence[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(command),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )


def verify_required_tools(
    *,
    install: bool = False,
    assume_yes: bool = False,
    platform_id: str | None = None,
    probe: ProbeFn = shutil.which,
    input_fn: InputFn = input,
    run_fn: RunFn = _default_run,
    output_fn: OutputFn | None = None,
) -> VerificationResult:
    resolved_platform = platform_id or detect_platform()
    package_manager = detect_package_manager(resolved_platform, probe=probe)
    statuses: list[ToolStatus] = []
    lines: list[str] = []

    for spec in TOOL_SPECS:
        found = _installed_command(spec, probe)
        if found:
            statuses.append(
                ToolStatus(
                    name=spec.name,
                    installed=True,
                    command=found,
                    foundational=spec.foundational,
                )
            )
            continue

        manual_command = spec.manual_commands.get(
            resolved_platform,
            spec.manual_commands["unknown"],
        )
        install_command = _install_command(
            spec,
            platform_id=resolved_platform,
            package_manager=package_manager,
        )
        base = ToolStatus(
            name=spec.name,
            installed=False,
            installable=install_command is not None and not spec.foundational,
            install_command=install_command,
            manual_command=manual_command,
            url=spec.url,
            foundational=spec.foundational,
        )
        will_prompt = install and not assume_yes
        lines.extend(_guidance_lines(base, will_prompt=will_prompt))
        if not install or spec.foundational or install_command is None:
            statuses.append(base)
            continue

        approved = assume_yes
        if not assume_yes:
            prompt = f"{spec.name} is not installed on this machine. Install it now? (Y/n) "
            answer = input_fn(prompt)
            approved = answer.strip().lower() in {"", "y", "yes"}
        if not approved:
            statuses.append(replace(base, declined=True))
            continue

        proc = run_fn(install_command)
        rechecked = _installed_command(spec, probe)
        if proc.returncode == 0 and rechecked:
            statuses.append(replace(base, installed_after_offer=True, command=rechecked))
        else:
            error = (proc.stderr or proc.stdout or "installer did not put tool on PATH").strip()
            statuses.append(replace(base, install_error=error))

    result = VerificationResult(
        statuses=tuple(statuses),
        platform_id=resolved_platform,
        package_manager=package_manager,
    )
    if result.missing:
        unresolved = ", ".join(status.name for status in result.missing)
        lines.append(f"[deft tools] Unresolved required tools: {unresolved}.")
    elif lines:
        lines.append("[deft tools] Required tools are now available.")
    else:
        lines.append("[deft tools] Required tools are available.")

    if output_fn is not None:
        for line in lines:
            output_fn(line)
    return result


def _guidance_lines(status: ToolStatus, *, will_prompt: bool = False) -> list[str]:
    if status.foundational:
        return [
            (
                f"[deft tools] Required foundational tool `{status.name}` is missing; "
                "install it before continuing."
            ),
            f"[deft tools] Manual install: {status.manual_command}",
            f"[deft tools] Canonical install URL: {status.url}",
        ]
    if status.install_command:
        if will_prompt:
            headline = (
                f"[deft tools] `{status.name}` is not installed on this machine. "
                "Install it now? (Y/n)"
            )
        else:
            headline = (
                f"[deft tools] `{status.name}` is not installed on this machine; "
                "re-run with `--install` to set it up."
            )
        return [
            headline,
            f"[deft tools] Auto-install command: {' '.join(status.install_command)}",
            f"[deft tools] Manual install: {status.manual_command}",
            f"[deft tools] Canonical install URL: {status.url}",
        ]
    return [
        (
            f"[deft tools] `{status.name}` is not installed and no safe automated "
            "installer was detected."
        ),
        f"[deft tools] Manual install: {status.manual_command}",
        f"[deft tools] Canonical install URL: {status.url}",
    ]


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Verify required Deft host tools.")
    parser.add_argument("--install", action="store_true", help="Offer to run installers.")
    parser.add_argument("--yes", action="store_true", help="Approve installer prompts.")
    parser.add_argument("--json", action="store_true", dest="emit_json")
    parser.add_argument(
        "--platform",
        choices=("windows", "macos", "linux", "unknown"),
        help="Override platform detection for tests or diagnostics.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    captured: list[str] = []
    result = verify_required_tools(
        install=args.install,
        assume_yes=args.yes,
        platform_id=args.platform,
        output_fn=captured.append,
    )
    if args.emit_json:
        print(result.to_json())
    else:
        for line in captured:
            print(line)
    return result.exit_code


if __name__ == "__main__":
    sys.exit(main())
