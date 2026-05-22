"""_session_start_hook.py -- session-start ritual sentinel writer (#1269).

Thin wrapper around :func:`scripts.ritual_sentinel.write`. The
session-start ritual orchestration calls this module at exit to persist
the sentinel; the module is intentionally minimal so the orchestrator
side can shell out without re-implementing the on-disk shape.

Today no canonical session-start orchestrator script exists in
``deft``; this CLI is the entry point a future orchestrator will wire
into, and meanwhile operators can invoke it manually::

    python scripts/_session_start_hook.py --write

The ``--write`` flag derives the sentinel payload from the current
``git`` state:

* ``deftVersion`` -- resolved via :mod:`resolve_version` (the same
  priority chain ``task build`` consumes; #723).
* ``lastBranch`` -- ``git symbolic-ref --short HEAD`` (with
  ``git rev-parse --short HEAD`` as the detached-HEAD fallback,
  recorded as ``"detached:<short-sha>"`` when HEAD is detached).
* ``lastActiveVbrief`` -- the most-recently-modified
  ``vbrief/active/*.vbrief.json`` file, recorded as a POSIX-style
  relative path. If no candidate file exists, the hook exits ``2``
  with a one-line diagnostic to stderr instead of writing an
  incomplete sentinel.

Exit codes
----------

* ``0`` -- sentinel written.
* ``2`` -- precondition not satisfied (no active vBRIEF, no git repo,
  etc.). The ritual treats this as fail-open: ritual continues silently.
* ``1`` -- unexpected error (re-raised :class:`Exception` from the
  writer's ``except`` branch). Surfaces the underlying error to stderr.

The hook is intentionally side-effect-free beyond the sentinel write;
it does NOT mutate git state, the cache, or the vBRIEF lifecycle.

Refs #1269.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

# Sibling-script import (mirrors the pattern used by
# ``scripts/resume_conditions.py`` and the other scripts/ modules).
_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import resolve_version  # type: ignore[import-not-found]  # noqa: E402
import ritual_sentinel  # type: ignore[import-not-found]  # noqa: E402


def _detect_branch(project_root: Path) -> str | None:
    """Return the current git branch (or short SHA on detached HEAD)."""
    try:
        result = subprocess.run(
            ["git", "symbolic-ref", "--short", "HEAD"],
            cwd=str(project_root),
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if result.returncode == 0:
        branch = (result.stdout or "").strip()
        if branch:
            return branch
    # Detached HEAD -- fall back to the short SHA so the sentinel still
    # records *something* the operator can correlate with their checkout.
    try:
        rev_result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(project_root),
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if rev_result.returncode == 0:
        sha = (rev_result.stdout or "").strip()
        if sha:
            return f"detached:{sha}"
    return None


def _detect_latest_active_vbrief(project_root: Path) -> str | None:
    """Return the most-recently-modified active vBRIEF as a POSIX relpath.

    Fail-open across OSError -- a vBRIEF whose ``stat()`` raises
    (TOCTOU delete between ``glob()`` and ``stat()``, permission
    denied, broken symlink) is skipped rather than crashing the
    ritual. Returns ``None`` when no readable candidate survives.
    """
    active_dir = project_root / "vbrief" / "active"
    try:
        if not active_dir.is_dir():
            return None
    except OSError:
        return None
    candidates: list[tuple[float, Path]] = []
    try:
        children = list(active_dir.glob("*.vbrief.json"))
    except OSError:
        return None
    for child in children:
        try:
            if not child.is_file():
                continue
            mtime = child.stat().st_mtime
        except OSError:
            # Race with another process deleting the file between glob
            # and stat, or permission denied on a specific entry. Skip.
            continue
        candidates.append((mtime, child))
    if not candidates:
        return None
    candidates.sort(key=lambda pair: pair[0], reverse=True)
    latest = candidates[0][1]
    try:
        return latest.relative_to(project_root).as_posix()
    except ValueError:
        return None


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="_session_start_hook",
        description="Write the session-start ritual sentinel (#1269).",
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="Write .deft/last-session.json from the current git state.",
    )
    parser.add_argument(
        "--project-root",
        type=Path,
        default=None,
        help="Project root directory (default: current working directory).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    if not args.write:
        # No-op invocation; print the usage hint to stderr and return 0
        # so the ritual orchestration is never broken by a missing flag.
        sys.stderr.write(
            "_session_start_hook.py: pass --write to persist the sentinel.\n"
        )
        return 0
    project_root: Path = (args.project_root or Path(os.getcwd())).resolve()
    branch = _detect_branch(project_root)
    if not branch:
        sys.stderr.write(
            "_session_start_hook.py: could not determine current git branch; "
            "skipping sentinel write.\n"
        )
        return 2
    last_active = _detect_latest_active_vbrief(project_root)
    if not last_active:
        sys.stderr.write(
            "_session_start_hook.py: no active vBRIEF found under "
            "vbrief/active/; skipping sentinel write.\n"
        )
        return 2
    try:
        deft_version = resolve_version.resolve_version()
    except Exception as exc:  # noqa: BLE001 -- best-effort
        sys.stderr.write(
            f"_session_start_hook.py: resolve_version failed: {exc}; "
            "skipping sentinel write.\n"
        )
        return 2
    try:
        sentinel_path = ritual_sentinel.write(
            project_root,
            deft_version=deft_version,
            last_active_vbrief=last_active,
            last_branch=branch,
        )
    except Exception as exc:  # noqa: BLE001 -- surface to caller
        sys.stderr.write(
            f"_session_start_hook.py: sentinel write failed: {exc}\n"
        )
        return 1
    sys.stdout.write(f"{sentinel_path}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
