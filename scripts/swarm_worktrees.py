#!/usr/bin/env python3
"""swarm_worktrees.py -- pre-created worktree-map resolver for swarm cohorts (#1387).

The low-ceremony / headless swarm launch (#1387, building on the #1378
allocation-context token) lets an operator hand the swarm a set of
PRE-CREATED git worktrees instead of forcing the phased skill flow to
recreate them on every run. This module is the reusable, independently
unit-testable resolver that the launch engine imports to turn a
story-to-worktree mapping into a normalized, git-validated worktree map.

Frozen contract (C3)
--------------------
The launch engine imports :func:`resolve_worktree_map` directly::

    from swarm_worktrees import resolve_worktree_map

Input ``mapping`` is a JSON-style array of records, each a dict with:

- ``story_id`` (str, required) -- the cohort story this worktree serves.
- ``worktree_path`` (str, required) -- the git worktree path (absolute, or
  relative to ``repo_root``).
- ``base_branch`` (str, optional) -- the branch the worktree is based on.
  When present it MUST equal the cohort-wide ``base_branch`` argument; a
  divergent value is a base-branch mismatch and is rejected.

:func:`resolve_worktree_map` returns a list of normalized C3 records with
exactly the three keys ``{"story_id", "worktree_path", "base_branch"}``;
``worktree_path`` is normalized to an absolute POSIX path and
``base_branch`` is the resolved cohort base branch.

What the resolver guarantees
----------------------------
1. **Validation against real git state.** Each ``worktree_path`` is checked
   against ``git worktree list --porcelain``. A path that is already a
   registered worktree is accepted idempotently.
2. **Base-branch validation.** A record whose ``base_branch`` differs from
   the configured cohort ``base_branch`` raises
   :class:`BaseBranchMismatchError` (validation failure, exit 1).
3. **Idempotent creation.** When ``create_missing`` is true (the default), a
   ``worktree_path`` that is not yet a registered worktree is created from
   the base branch via ``git worktree add --detach <path> <base_branch>``.
   Re-running is a no-op because already-registered paths are skipped. When
   ``create_missing`` is false a missing worktree raises
   :class:`MissingWorktreeError` (validation failure, exit 1).
4. **Collision rejection.** Two stories mapping to the same worktree path
   raise :class:`WorktreeCollisionError` naming both colliding stories, and a
   ``story_id`` that appears twice (even on distinct paths) raises
   :class:`DuplicateStoryError` -- both are validation failures (exit 1) that
   would otherwise let the launch engine dispatch a story twice.

The created worktree is checked out in DETACHED HEAD at the base-branch tip
on purpose: the per-story feature branch is the launch engine's concern
(the C2 launch-manifest carries ``branch``), so the resolver deliberately
does not invent or claim a branch name. This also sidesteps git's
one-branch-per-worktree rule when several cohort worktrees share a base.

CLI
---
The module doubles as a deterministic CLI mirroring the ``scripts/``
conventions (argparse ``main`` + importable functions, UTF-8 stdio,
three-state exit):

    task ...  # (Taskfile wiring is owned by the launch-CLI story)
    python scripts/swarm_worktrees.py --map worktree-map.json --base-branch master

Exit codes (three-state, mirrors ``scripts/preflight_story_start.py``):

- ``0`` -- resolved: every record validated; missing worktrees created when
  permitted. The normalized C3 map is printed to stdout as JSON.
- ``1`` -- validation failure the operator can fix in the MAP: a same-path
  collision, a base-branch mismatch, or a missing worktree with
  ``--no-create-missing``.
- ``2`` -- config / environment error: malformed map JSON, a record missing a
  required field, git not on PATH / not a work tree, or a failed
  ``git worktree add`` (e.g. the base branch does not exist).

Refs:
- #1387 (this resolver; headless swarm launch for pre-approved cohorts)
- #1378 (allocation-context token the launch engine threads alongside C3)
- #1366 (subprocess capture forces ``encoding="utf-8", errors="replace"``)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

# Make sibling scripts importable both when run as __main__ and when imported
# by tests via importlib (mirrors scripts/swarm_verify_review_clean.py).
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _safe_subprocess import run_text  # noqa: E402

try:
    from _stdio_utf8 import reconfigure_stdio  # noqa: E402

    reconfigure_stdio()
except ImportError:  # pragma: no cover - _stdio_utf8 is optional in some contexts
    pass

EXIT_OK = 0
EXIT_VALIDATION_ERROR = 1
EXIT_CONFIG_ERROR = 2

#: The exact field set of a normalized C3 record (frozen contract).
C3_FIELDS = ("story_id", "worktree_path", "base_branch")


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class WorktreeMapError(Exception):
    """A logical validation failure the operator can fix in the map (exit 1).

    Base class for same-path collisions, base-branch mismatches, and
    missing-worktree-with-creation-disabled. Distinct from
    :class:`WorktreeMapConfigError` so the CLI can map the two families to
    the deterministic exit codes 1 (validation) and 2 (config).
    """


class WorktreeCollisionError(WorktreeMapError):
    """Two stories mapped to the same worktree path."""


class BaseBranchMismatchError(WorktreeMapError):
    """A record's base_branch disagrees with the configured cohort base."""


class MissingWorktreeError(WorktreeMapError):
    """A mapped worktree does not exist and creation is disabled."""


class DuplicateStoryError(WorktreeMapError):
    """The same ``story_id`` appears in more than one mapping record.

    Distinct from :class:`WorktreeCollisionError` (two stories on the SAME
    path): here one story maps to two records (typically distinct paths via a
    copy-paste error). Returning both would hand the launch engine two C3
    records for one story and dispatch it twice, so it is rejected.
    """


class WorktreeMapConfigError(Exception):
    """An environment / config error (exit 2).

    Malformed input records, git unavailable / not a work tree, or a failed
    ``git worktree add`` (e.g. base branch does not exist).
    """


# ---------------------------------------------------------------------------
# Path + porcelain helpers
# ---------------------------------------------------------------------------


def _resolve_path(raw: str, repo_root: Path) -> Path:
    """Resolve ``raw`` to an absolute path, relative paths against repo_root."""
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = repo_root / candidate
    return candidate.resolve()


def _compare_key(path: Path) -> str:
    """Return a case-normalized comparison key for worktree-path equality.

    ``os.path.normcase`` folds case + slash direction on Windows so a record
    path and the git porcelain path compare equal regardless of how the
    operator typed them; ``resolve`` (applied by the caller) collapses
    symlinks / short names first.
    """
    return os.path.normcase(str(path))


def parse_worktree_porcelain(text: str) -> dict[str, str | None]:
    """Parse ``git worktree list --porcelain`` into ``{compare_key: branch}``.

    Each porcelain stanza opens with a ``worktree <path>`` line and may carry
    a ``branch refs/heads/<name>`` line (absent for a detached / bare entry).
    Returns a mapping from the resolved, case-normalized worktree path to its
    branch short-name (or ``None`` when detached / bare). Note that
    ``Path.resolve()`` is called on each path, so this issues one
    ``realpath`` / ``readlink`` syscall per worktree stanza (not pure).
    """
    registered: dict[str, str | None] = {}
    current_path: Path | None = None
    current_branch: str | None = None

    def _flush() -> None:
        if current_path is not None:
            registered[_compare_key(current_path)] = current_branch

    for line in text.splitlines():
        if line.startswith("worktree "):
            # A new stanza begins; flush the previous one first.
            _flush()
            current_path = Path(line[len("worktree ") :].strip()).resolve()
            current_branch = None
        elif line.startswith("branch "):
            ref = line[len("branch ") :].strip()
            current_branch = ref[len("refs/heads/") :] if ref.startswith("refs/heads/") else ref
    _flush()
    return registered


# ---------------------------------------------------------------------------
# git wrappers
# ---------------------------------------------------------------------------


def _git_worktree_list(repo_root: Path) -> dict[str, str | None]:
    """Return the registered worktrees as ``{compare_key: branch}``.

    Raises :class:`WorktreeMapConfigError` when git cannot be spawned or the
    directory is not a git work tree -- the resolver fails closed rather than
    assuming an empty worktree set.
    """
    try:
        proc = run_text(["git", "worktree", "list", "--porcelain"], cwd=str(repo_root))
    except OSError as exc:  # git not on PATH / no execute permission
        raise WorktreeMapConfigError(
            f"could not run `git worktree list` in {repo_root}: {exc}"
        ) from exc
    if proc.returncode != 0:
        raise WorktreeMapConfigError(
            f"`git worktree list` failed in {repo_root} (rc={proc.returncode}): "
            f"{proc.stderr.strip() or '<no stderr>'} -- is this a git work tree?"
        )
    return parse_worktree_porcelain(proc.stdout)


def _create_worktree(repo_root: Path, worktree_path: Path, base_branch: str) -> None:
    """Create a detached worktree at ``worktree_path`` from ``base_branch``.

    The leaf directory is created by git; we pre-create any missing parent
    directories so ``git worktree add`` does not fail on a deep target path.
    Detached HEAD is deliberate -- the per-story branch is the launch
    engine's concern (C2), so the resolver does not claim a branch name.

    Raises :class:`WorktreeMapConfigError` on any git failure (e.g. the base
    branch does not exist, or the target path already exists as a non-empty
    non-worktree directory).
    """
    worktree_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        proc = run_text(
            ["git", "worktree", "add", "--detach", str(worktree_path), base_branch],
            cwd=str(repo_root),
        )
    except OSError as exc:
        raise WorktreeMapConfigError(
            f"could not run `git worktree add` for {worktree_path}: {exc}"
        ) from exc
    if proc.returncode != 0:
        raise WorktreeMapConfigError(
            f"`git worktree add --detach {worktree_path} {base_branch}` failed "
            f"(rc={proc.returncode}): {proc.stderr.strip() or '<no stderr>'}"
        )


# ---------------------------------------------------------------------------
# core resolver (FROZEN C3 contract)
# ---------------------------------------------------------------------------


def resolve_worktree_map(
    mapping: list[dict],
    base_branch: str,
    create_missing: bool = True,
    *,
    repo_root: str | os.PathLike[str] | None = None,
) -> list[dict]:
    """Resolve a story-to-worktree mapping into normalized C3 records.

    Args:
        mapping: List of ``{story_id, worktree_path, base_branch?}`` records.
        base_branch: The cohort-wide base branch every worktree is based on.
        create_missing: When true (default) create any worktree that is not
            yet registered, from ``base_branch``; when false a missing
            worktree raises :class:`MissingWorktreeError`.
        repo_root: Git repository the worktrees belong to. Defaults to the
            current working directory. Keyword-only so the frozen positional
            signature ``(mapping, base_branch, create_missing=True)`` is
            preserved for the launch engine.

    Returns:
        A list of normalized C3 records, each with exactly
        ``{"story_id", "worktree_path", "base_branch"}``; ``worktree_path``
        is an absolute POSIX path and ``base_branch`` is the cohort base.
        Output order mirrors the input order.

    Raises:
        WorktreeMapConfigError: malformed record (missing/blank required
            field), non-list mapping, blank ``base_branch``, git unavailable,
            or a failed ``git worktree add``.
        BaseBranchMismatchError: a record's ``base_branch`` differs from the
            configured cohort ``base_branch``.
        WorktreeCollisionError: two stories map to the same worktree path.
        DuplicateStoryError: the same ``story_id`` appears more than once.
        MissingWorktreeError: a mapped worktree is absent and
            ``create_missing`` is false.
    """
    if not isinstance(mapping, list):
        raise WorktreeMapConfigError(
            f"worktree map must be a list of records, got {type(mapping).__name__}"
        )
    if not isinstance(base_branch, str) or not base_branch.strip():
        raise WorktreeMapConfigError("base_branch must be a non-empty string")
    base_branch = base_branch.strip()

    root = Path(repo_root).resolve() if repo_root is not None else Path.cwd().resolve()

    # First pass: validate record shape, base-branch agreement, and collisions
    # WITHOUT touching git. This keeps the cheap, deterministic checks ahead of
    # the (potentially mutating) git creation step so a bad map fails fast.
    resolved: list[dict] = []
    seen_paths: dict[str, str] = {}  # compare_key -> first story_id
    seen_story_ids: dict[str, str] = {}  # story_id -> first worktree_path
    for index, record in enumerate(mapping):
        if not isinstance(record, dict):
            raise WorktreeMapConfigError(
                f"record #{index} must be an object, got {type(record).__name__}"
            )
        story_id = record.get("story_id")
        if not isinstance(story_id, str) or not story_id.strip():
            raise WorktreeMapConfigError(
                f"record #{index} is missing a non-empty 'story_id'"
            )
        story_id = story_id.strip()
        raw_path = record.get("worktree_path")
        if not isinstance(raw_path, str) or not raw_path.strip():
            raise WorktreeMapConfigError(
                f"story {story_id!r} is missing a non-empty 'worktree_path'"
            )

        record_base = record.get("base_branch")
        if record_base is not None:
            if not isinstance(record_base, str) or not record_base.strip():
                raise WorktreeMapConfigError(
                    f"story {story_id!r} has a non-string / blank 'base_branch'"
                )
            if record_base.strip() != base_branch:
                raise BaseBranchMismatchError(
                    f"story {story_id!r} declares base_branch "
                    f"{record_base.strip()!r} but the cohort base branch is "
                    f"{base_branch!r}"
                )

        worktree_path = _resolve_path(raw_path.strip(), root)
        key = _compare_key(worktree_path)
        if key in seen_paths:
            raise WorktreeCollisionError(
                f"worktree path collision: stories {seen_paths[key]!r} and "
                f"{story_id!r} both map to {worktree_path.as_posix()!r}"
            )
        if story_id in seen_story_ids:
            raise DuplicateStoryError(
                f"duplicate story_id {story_id!r}: mapped to both "
                f"{seen_story_ids[story_id]!r} and {worktree_path.as_posix()!r}"
            )
        seen_paths[key] = story_id
        seen_story_ids[story_id] = worktree_path.as_posix()
        resolved.append(
            {
                "story_id": story_id,
                "worktree_path": worktree_path.as_posix(),
                "base_branch": base_branch,
                # internal-only carry; stripped before return.
                "_key": key,
                "_abs": str(worktree_path),
            }
        )

    # Second pass: reconcile against real git worktree state, creating missing
    # worktrees idempotently when permitted.
    registered = _git_worktree_list(root)
    for entry in resolved:
        key = entry.pop("_key")
        abs_path = entry.pop("_abs")
        if key in registered:
            # Already a registered worktree -> accept idempotently.
            continue
        if not create_missing:
            raise MissingWorktreeError(
                f"story {entry['story_id']!r} maps to {entry['worktree_path']!r} "
                "which is not a registered git worktree and create_missing is "
                "disabled"
            )
        _create_worktree(root, Path(abs_path), base_branch)

    return resolved


# ---------------------------------------------------------------------------
# CLI plumbing
# ---------------------------------------------------------------------------


def _load_map(map_path: Path) -> list[dict]:
    """Read + JSON-parse the worktree-map file. Raises WorktreeMapConfigError."""
    try:
        raw = map_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise WorktreeMapConfigError(f"could not read worktree map {map_path}: {exc}") from exc
    try:
        data: Any = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise WorktreeMapConfigError(
            f"worktree map {map_path} is not valid JSON: {exc.msg} (line {exc.lineno})"
        ) from exc
    if not isinstance(data, list):
        raise WorktreeMapConfigError(
            f"worktree map {map_path} top-level value must be a JSON array"
        )
    return data


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="swarm_worktrees.py",
        description=(
            "Resolve a swarm story-to-worktree mapping into a normalized, "
            "git-validated worktree map (#1387). Validates base-branch "
            "agreement, rejects same-path collisions, and idempotently "
            "creates missing worktrees from the base branch. Three-state exit "
            "(0 resolved / 1 validation error / 2 config error)."
        ),
    )
    parser.add_argument(
        "--map",
        dest="map_path",
        required=True,
        help=(
            "Path to the worktree-map JSON file (array of "
            "{story_id, worktree_path, base_branch})."
        ),
    )
    parser.add_argument(
        "--base-branch",
        required=True,
        help="The cohort-wide base branch every worktree is based on.",
    )
    parser.add_argument(
        "--repo-root",
        default=".",
        help="Git repository the worktrees belong to (default: cwd).",
    )
    parser.add_argument(
        "--no-create-missing",
        dest="create_missing",
        action="store_false",
        help=(
            "Do NOT create missing worktrees; a mapped worktree that is not "
            "already registered becomes a validation error (exit 1)."
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    # Force UTF-8 stdout/stderr at entry so the resolver's messages survive a
    # Windows codepage-default stdout (mirrors scripts/preflight_story_start.py).
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    args = _build_parser().parse_args(argv)
    try:
        mapping = _load_map(Path(args.map_path))
        resolved = resolve_worktree_map(
            mapping,
            args.base_branch,
            args.create_missing,
            repo_root=args.repo_root,
        )
    except WorktreeMapError as exc:
        # Logical validation failure (collision / base mismatch / missing).
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_VALIDATION_ERROR
    except WorktreeMapConfigError as exc:
        print(f"config error: {exc}", file=sys.stderr)
        return EXIT_CONFIG_ERROR

    print(json.dumps(resolved, indent=2))
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
