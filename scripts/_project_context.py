"""_project_context.py -- resolve consumer project root + GitHub repo slug.

Shared helpers used by ``scope_lifecycle``, ``issue_ingest``,
``reconcile_issues`` and ``prd_render`` so every script follows the same
precedence rules and fails loudly when no project context can be inferred.

Precedence for ``resolve_project_root``:

1. ``--project-root`` flag (explicit, highest precedence).
2. ``$DEFT_PROJECT_ROOT`` environment variable.
3. Walk upward from CWD looking for a ``vbrief/`` directory or a ``.git``
   directory -- the first match is the project root.
4. Fall back to the current working directory ONLY if it visibly looks
   like a project root (contains either ``vbrief/`` or ``.git``).

If none of those match, the caller gets ``None`` and is expected to emit
a loud, actionable error -- silently falling back to ``deft/`` is exactly
the bug that shipped #535 / #538.

Precedence for ``resolve_project_repo``:

1. ``--repo OWNER/NAME`` flag (explicit, highest precedence).
2. ``$DEFT_PROJECT_REPO`` environment variable.
3. ``git remote get-url origin`` run from the resolved project root --
   this is the key anti-regression for #538: deft's own ``.git`` remote
   (``deftai/directive``) is used only if the project root happens to be
   deft itself.
4. ``None`` -- caller must emit a loud error.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
from pathlib import Path

# Sentinel directories that mark a deft project root.
_PROJECT_ROOT_SENTINELS = ("vbrief", ".git")


def _is_project_root(candidate: Path) -> bool:
    """Return True if *candidate* contains any deft project-root sentinel."""
    return any((candidate / sentinel).exists() for sentinel in _PROJECT_ROOT_SENTINELS)


def resolve_project_root(
    cli_project_root: str | None = None,
    *,
    start: Path | None = None,
) -> Path | None:
    """Resolve the consumer project root using the documented precedence.

    Returns ``None`` when no candidate matches; callers MUST fail loudly
    in that case (never silently fall back to deft's own directory).
    """
    if cli_project_root:
        candidate = Path(cli_project_root).resolve()
        if candidate.is_dir():
            return candidate
        return None

    env_root = os.environ.get("DEFT_PROJECT_ROOT")
    if env_root:
        candidate = Path(env_root).resolve()
        if candidate.is_dir():
            return candidate
        return None

    cwd = (start or Path.cwd()).resolve()
    # Walk upward from CWD looking for a sentinel.
    for candidate in (cwd, *cwd.parents):
        if _is_project_root(candidate):
            return candidate
    return None


def resolve_project_repo(
    cli_repo: str | None = None,
    *,
    project_root: Path | None = None,
) -> str | None:
    """Resolve the consumer GitHub repo (``OWNER/NAME``).

    Returns ``None`` when detection fails so the caller can emit an
    actionable error. ``project_root`` narrows ``git remote`` detection to
    the consumer repo; without it we fall back to CWD, which may be wrong
    under a ``task deft:*`` include (#538).
    """
    if cli_repo:
        slug = _normalise_repo_slug(cli_repo)
        if slug:
            return slug
        return None

    env_repo = os.environ.get("DEFT_PROJECT_REPO")
    if env_repo:
        slug = _normalise_repo_slug(env_repo)
        if slug:
            return slug
        # Greptile P2 on #562: fail loudly when the env var is set but
        # unparseable, to match the explicit-flag path (which returns
        # None on a malformed value rather than falling through to git
        # auto-detection). Silent fallback to git is exactly the
        # anti-pattern this helper was introduced to prevent.
        return None

    return _detect_repo_from_git(project_root)


def _normalise_repo_slug(value: str) -> str | None:
    r"""Accept ``OWNER/NAME`` or a full GitHub URL, return ``OWNER/NAME``.

    Allows dots in the name component (``acme/dotnet.runtime``,
    ``acme/my.project.git``) -- the previous ``[^/\.\s]+`` pattern stopped
    at the first dot and silently truncated the repo name, routing ``gh``
    calls to the wrong (or non-existent) repository (Greptile P1 on #562).
    Strips a trailing ``.git`` suffix explicitly so SSH clone URLs still
    normalise to the bare ``OWNER/NAME`` form.
    """
    value = value.strip()
    if not value:
        return None
    match = re.search(
        r"github\.com[:/]([^/\s]+)/([^/\s]+?)(?:\.git)?(?:\s|$)",
        value,
    )
    if match:
        return f"{match.group(1)}/{match.group(2)}"
    if re.match(r"^[^/\s]+/[^/\s]+$", value):
        return value
    return None


def _detect_repo_from_git(project_root: Path | None) -> str | None:
    """Run ``git remote get-url origin`` in *project_root* (or CWD)."""
    cwd = str(project_root) if project_root else None
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            timeout=10,
            cwd=cwd,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    return _normalise_repo_slug(result.stdout.strip())


def is_framework_source_context(framework_root: Path, project_root: Path) -> bool:
    """Return True when a task is running from the framework checkout itself.

    Vendored consumer installs execute framework tasks from ``.deft/core`` while
    the user working directory remains the consumer repo.  Equality of the two
    lexical absolute roots is the stable distinction: only the source checkout
    should run source-repo self-tests by default.  Do not resolve symlinks here:
    a consumer project may symlink ``.deft/core`` to a local framework checkout
    and should still run the consumer-safe gate.
    """
    return Path(os.path.abspath(framework_root)) == Path(os.path.abspath(project_root))


def dispatch_task_check(
    framework_root: Path,
    project_root: Path,
    *,
    runner=subprocess.run,
) -> int:
    """Dispatch ``task check`` to the context-appropriate aggregate target."""
    target = (
        "check:framework-source"
        if is_framework_source_context(framework_root, project_root)
        else "check:consumer"
    )
    result = runner(
        ["task", "-t", str(framework_root / "Taskfile.yml"), target],
        cwd=str(project_root),
    )
    return int(result.returncode)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dispatch-task-check",
        action="store_true",
        help="Dispatch the task check aggregate for the current install context.",
    )
    parser.add_argument("--framework-root", type=Path)
    parser.add_argument("--project-root", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.dispatch_task_check:
        if args.framework_root is None or args.project_root is None:
            raise SystemExit("--framework-root and --project-root are required")
        return dispatch_task_check(args.framework_root, args.project_root)
    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
