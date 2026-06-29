#!/usr/bin/env python3
"""verify_hooks_installed.py -- honest health check for the deft git hooks (#1463 / #2049).

Pure stdlib, cross-platform. Invoked from ``task verify:hooks-installed``.

Before #1463 the ``verify:hooks-installed`` task only asserted
``core.hooksPath == .githooks``. In a vendored consumer (framework at
``.deft/core/``) that produced a FALSE GREEN: ``core.hooksPath`` was set but the
hooks directory did not exist at the repo root and the gates were silently
inert while the check reported success.

After #2049 consumer hooks dispatch through the ``deft`` CLI only (no Python
scripts under ``scripts/``). This gate asserts hooks are not merely *configured*
but *functional*:

1. ``core.hooksPath`` is set (non-empty).
2. The resolved hooks directory exists.
3. The ``pre-commit`` and ``pre-push`` hooks are present in it.
4. On POSIX, those hooks are EXECUTABLE (#1477).
5. Hook bodies invoke ``deft`` for the required gate commands (#2049) and do
   not reference legacy Python dispatch paths.

Exit codes (three-state):

- ``0`` -- hooks installed AND functional.
- ``1`` -- hooks NOT installed, OR wired-but-non-functional.
- ``2`` -- config error: project root missing, or ``git`` unavailable.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

REQUIRED_HOOKS = ("pre-commit", "pre-push")

PRE_COMMIT_DEFT_COMMANDS = ("verify:branch", "verify:encoding")
PRE_PUSH_DEFT_COMMANDS = ("preflight-gh",)

_LEGACY_HOOK_PATTERNS = (
    re.compile(r"\.py\b", re.I),
    re.compile(r"\bpython\b", re.I),
    re.compile(r"\bdeft_py\b"),
    re.compile(r"\bSCRIPTS_DIR\b"),
    re.compile(r"\bpreflight_branch\.py\b"),
)


def _strip_shell_comment_lines(content: str) -> str:
    """Drop shell ``#`` comment lines before pattern scans (#2049 false positives)."""
    return "\n".join(line for line in content.splitlines() if not re.match(r"^\s*#", line))


def _executable_hook_body(content: str) -> str:
    return _strip_shell_comment_lines(content)


def _configured_hooks_path(project_root: Path) -> tuple[str | None, str | None]:
    try:
        proc = subprocess.run(
            ["git", "-C", str(project_root), "config", "--get", "core.hooksPath"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except FileNotFoundError:
        return None, "git executable not found on PATH"
    if proc.returncode != 0:
        return None, None
    value = proc.stdout.strip()
    return (value or None), None


def _uses_legacy_python_dispatch(content: str) -> bool:
    body = _executable_hook_body(content)
    return any(pattern.search(body) for pattern in _LEGACY_HOOK_PATTERNS)


def _hook_invokes_deft_cli(content: str, required_commands: tuple[str, ...]) -> bool:
    body = _executable_hook_body(content)
    if not re.search(r"\bdeft\b", body):
        return False
    if _uses_legacy_python_dispatch(content):
        return False
    return all(cmd in body for cmd in required_commands)


def _pre_push_invokes_verify_branch(content: str) -> bool:
    return bool(re.search(r"\bdeft\s+verify:branch\b", _executable_hook_body(content)))


def _validate_hook_content(
    hook_name: str,
    content: str | None,
    required_commands: tuple[str, ...],
) -> str | None:
    if content is None:
        return f"{hook_name}: unreadable hook file"
    if _uses_legacy_python_dispatch(content):
        return (
            f"{hook_name}: still dispatches through Python scripts "
            "(expected deft CLI only, #2049)"
        )
    if not _hook_invokes_deft_cli(content, required_commands):
        missing = ", ".join(required_commands)
        return f"{hook_name}: missing required deft CLI gate(s): {missing}"
    return None


def evaluate(project_root: Path) -> tuple[int, str]:
    if not project_root.is_dir():
        return 2, (
            f"❌ deft hooks: project root {project_root} does not exist "
            "(config error)."
        )

    hooks_path, git_err = _configured_hooks_path(project_root)
    if git_err:
        return 2, (
            f"❌ deft hooks: cannot read core.hooksPath -- {git_err}.\n"
            "  Recovery: install git (https://git-scm.com/) so the check can run."
        )
    if not hooks_path:
        return 1, (
            "❌ deft hooks not installed: core.hooksPath is unset.\n"
            "  Recovery: run `task setup` (or re-run the deft installer)."
        )

    hooks_dir = Path(hooks_path)
    if not hooks_dir.is_absolute():
        hooks_dir = project_root / hooks_path

    if not hooks_dir.is_dir():
        return 1, (
            f"❌ deft hooks wired but NON-FUNCTIONAL: core.hooksPath={hooks_path} "
            f"but the directory {hooks_dir} does not exist (#1463 false-green).\n"
            "  Recovery: re-run the deft installer / `task setup` to deposit the "
            "hooks."
        )

    missing_hooks = [h for h in REQUIRED_HOOKS if not (hooks_dir / h).is_file()]
    if missing_hooks:
        return 1, (
            f"❌ deft hooks wired but NON-FUNCTIONAL: {hooks_dir} is missing "
            f"{', '.join(missing_hooks)} (#1463 false-green).\n"
            "  Recovery: re-run the deft installer / `task setup`."
        )

    if os.name == "posix":
        non_exec = [h for h in REQUIRED_HOOKS if not os.access(hooks_dir / h, os.X_OK)]
        if non_exec:
            return 1, (
                f"❌ deft hooks wired but NON-FUNCTIONAL: {hooks_dir} hook(s) "
                f"{', '.join(non_exec)} are not executable (git mode is not "
                "100755); git silently skips non-executable hooks on Unix "
                "(#1477).\n"
                "  Recovery: re-run the deft installer / `task setup`, or "
                "`chmod +x .githooks/pre-commit .githooks/pre-push`."
            )

    pre_commit_path = hooks_dir / "pre-commit"
    pre_commit_content = (
        pre_commit_path.read_text(encoding="utf-8") if pre_commit_path.is_file() else None
    )
    pre_commit_issue = _validate_hook_content(
        "pre-commit", pre_commit_content, PRE_COMMIT_DEFT_COMMANDS
    )
    if pre_commit_issue:
        return 1, (
            f"❌ deft hooks wired but NON-FUNCTIONAL: {pre_commit_issue} (#2049).\n"
            "  Recovery: re-run the deft installer / `task setup` to refresh .githooks/."
        )

    pre_push_path = hooks_dir / "pre-push"
    pre_push_content = (
        pre_push_path.read_text(encoding="utf-8") if pre_push_path.is_file() else None
    )
    pre_push_issue = _validate_hook_content(
        "pre-push", pre_push_content, PRE_PUSH_DEFT_COMMANDS
    )
    if pre_push_issue:
        return 1, (
            f"❌ deft hooks wired but NON-FUNCTIONAL: {pre_push_issue} (#2049).\n"
            "  Recovery: re-run the deft installer / `task setup` to refresh .githooks/."
        )
    if pre_push_content and _pre_push_invokes_verify_branch(pre_push_content):
        return 1, (
            "❌ deft hooks wired but NON-FUNCTIONAL: pre-push must not invoke "
            "verify:branch (#1814).\n"
            "  Recovery: re-run the deft installer / `task setup` to refresh .githooks/."
        )

    return 0, (
        f"✓ deft hooks installed and functional: core.hooksPath={hooks_path}, "
        f"hooks {', '.join(REQUIRED_HOOKS)} present and dispatch via deft CLI (#2049)."
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Assert the deft git hooks are installed AND functional (#1463 / #2049). "
            "Three-state exit: 0 ok / 1 not-installed-or-non-functional / 2 "
            "config error."
        )
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help="project root to inspect (default: current directory).",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="suppress the human-readable message (exit code only).",
    )
    args = parser.parse_args(argv)

    project_root = Path(args.project_root).resolve()
    code, message = evaluate(project_root)
    if not args.quiet:
        stream = sys.stdout if code == 0 else sys.stderr
        print(message, file=stream)
    return code


if __name__ == "__main__":
    sys.exit(main())
