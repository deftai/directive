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

import os
import re
import subprocess
from pathlib import Path

# Sentinel directories that mark a deft project root.
_PROJECT_ROOT_SENTINELS = ("vbrief", ".git")


def _is_project_root(candidate: Path) -> bool:
    """Return True if *candidate* contains any deft project-root sentinel."""
    return any(
        (candidate / sentinel).exists() for sentinel in _PROJECT_ROOT_SENTINELS
    )


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

    return _detect_repo_from_git(project_root)


def _normalise_repo_slug(value: str) -> str | None:
    """Accept ``OWNER/NAME`` or a full GitHub URL, return ``OWNER/NAME``."""
    value = value.strip()
    if not value:
        return None
    match = re.search(r"github\.com[:/]([^/]+)/([^/\.\s]+)", value)
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
