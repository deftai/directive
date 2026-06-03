#!/usr/bin/env python3
"""verify_hooks_installed.py -- honest health check for the deft git hooks (#1463 / #747).

Pure stdlib, cross-platform. Invoked from ``task verify:hooks-installed``.

Before #1463 the ``verify:hooks-installed`` task only asserted
``core.hooksPath == .githooks``. In a vendored consumer (framework at
``.deft/core/``) that produced a FALSE GREEN: ``core.hooksPath`` was set but the
hooks directory did not exist at the repo root and the gate scripts the hooks
reference (``preflight_branch.py`` / ``verify_encoding.py`` / ``preflight_gh.py``)
could not be resolved, so the branch / encoding / destructive-gh-verb gates were
silently inert while the check reported success.

This gate now asserts the hooks are not merely *configured* but *functional*:

1. ``core.hooksPath`` is set (non-empty).
2. The resolved hooks directory exists.
3. The ``pre-commit`` and ``pre-push`` hooks are present in it.
4. On POSIX, those hooks are EXECUTABLE -- git silently skips a non-executable
   hook, so a present-but-mode-100644 hook is the #1477 inert-gate class (the
   exec bit is meaningless on Windows, so the check is POSIX-only).
5. The gate scripts the hooks reference resolve in THIS layout -- own-repo
   ``scripts/``, canonical vendored ``.deft/core/scripts/``, or legacy
   ``deft/scripts/``.

Exit codes (three-state, mirrors ``scripts/preflight_branch.py`` and friends):

- ``0`` -- hooks installed AND functional.
- ``1`` -- hooks NOT installed, OR wired-but-non-functional (the #1463
  false-green class). The message names the exact missing piece.
- ``2`` -- config error: the project root does not exist, or ``git`` is not on
  PATH so ``core.hooksPath`` cannot be read.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

#: Hook scripts the framework ships and the installer wires (#1463). Both must
#: be present in the resolved hooks directory for the gate to pass.
REQUIRED_HOOKS = ("pre-commit", "pre-push")

#: Gate scripts the hooks dispatch to. ``preflight_branch.py`` is the probe file
#: used to LOCATE the scripts dir (it must exist in every layout); all three are
#: then asserted present so a partial payload cannot pass the check.
SCRIPTS_PROBE = "preflight_branch.py"
GATE_SCRIPTS = ("preflight_branch.py", "verify_encoding.py", "preflight_gh.py")

#: Candidate scripts directories, in the same priority order the layout-aware
#: hooks (`.githooks/pre-commit`) probe: own-repo, canonical vendored, legacy
#: vendored. Each is relative to the project root.
SCRIPTS_DIR_CANDIDATES = ("scripts", ".deft/core/scripts", "deft/scripts")


def _configured_hooks_path(project_root: Path) -> tuple[str | None, str | None]:
    """Return ``(hooks_path, error)`` for the repo at ``project_root``.

    ``hooks_path`` is ``None`` when ``core.hooksPath`` is unset (``git config
    --get`` exits 1). ``error`` is set ONLY when git itself is unavailable, so
    the caller can map that to the config-error exit (2) rather than the
    not-installed exit (1).
    """
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
        # `git config --get` exits 1 when the key is unset -- not an error here.
        return None, None
    value = proc.stdout.strip()
    return (value or None), None


def _resolve_scripts_dir(project_root: Path) -> Path | None:
    """Return the first candidate scripts dir containing the probe script."""
    for rel in SCRIPTS_DIR_CANDIDATES:
        candidate = project_root / Path(rel)
        if (candidate / SCRIPTS_PROBE).is_file():
            return candidate
    return None


def evaluate(project_root: Path) -> tuple[int, str]:
    """Pure function returning ``(exit_code, human_message)``.

    Separated from :func:`main` so tests can drive every state directly.
    """
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

    # On POSIX the hooks MUST be executable or git silently skips them, leaving
    # the branch / encoding / destructive-gh-verb gates inert (#1477). The exec
    # bit does not exist on Windows, so this check is POSIX-only.
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

    scripts_dir = _resolve_scripts_dir(project_root)
    if scripts_dir is None:
        return 1, (
            "❌ deft hooks wired but NON-FUNCTIONAL: the gate scripts cannot be "
            "resolved.\n"
            f"  Looked for {SCRIPTS_PROBE} under: "
            f"{', '.join(SCRIPTS_DIR_CANDIDATES)} (relative to {project_root}).\n"
            "  Recovery: re-run the deft installer so the payload is present."
        )

    missing_scripts = [s for s in GATE_SCRIPTS if not (scripts_dir / s).is_file()]
    if missing_scripts:
        return 1, (
            f"❌ deft hooks wired but NON-FUNCTIONAL: {scripts_dir} is missing "
            f"gate script(s): {', '.join(missing_scripts)} (#1463 false-green).\n"
            "  Recovery: re-run the deft installer to restore the payload."
        )

    return 0, (
        f"✓ deft hooks installed and functional: core.hooksPath={hooks_path}, "
        f"hooks {', '.join(REQUIRED_HOOKS)} present, gate scripts resolve under "
        f"{scripts_dir}."
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Assert the deft git hooks are installed AND functional (#1463). "
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
