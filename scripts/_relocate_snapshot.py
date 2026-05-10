"""_relocate_snapshot.py -- snapshot tarball helpers for scripts/relocate.py (#992 PR2).

Extracted from :mod:`scripts.relocate` to keep the parent under the deft
1000-line MUST limit. Mirrors the
``scripts/cache.py`` / ``scripts/_cache_validate.py`` /
``scripts/_cache_fetch.py`` split pattern.

Public API:

- :func:`create_snapshot`  -- tar the consumer pre-relocate state.
- :func:`extract_snapshot` -- untar a previously-written snapshot back.
- :func:`latest_snapshot`  -- newest snapshot in ``.deft-cache/``.
- :func:`snapshot_path`    -- conventional path for the next snapshot.
- :func:`snapshot_dir`     -- ``<project-root>/.deft-cache``.
- :func:`utc_timestamp`    -- ``YYYYMMDDTHHMMSSZ`` for snapshot filenames.

The snapshot is gzip-compressed tar with members rooted at
``project_root`` so ``tar.extractall(project_root, filter='data')``
restores them directly into place.
"""

from __future__ import annotations

import shutil
import tarfile
from datetime import UTC, datetime
from pathlib import Path

CANONICAL_FRAMEWORK_DIR: str = ".deft/core"
LEGACY_FRAMEWORK_DIR: str = "deft"
SNAPSHOT_PREFIX: str = "relocate-snapshot-"


__all__ = [
    "CANONICAL_FRAMEWORK_DIR",
    "LEGACY_FRAMEWORK_DIR",
    "SNAPSHOT_PREFIX",
    "SnapshotError",
    "create_snapshot",
    "extract_snapshot",
    "latest_snapshot",
    "snapshot_dir",
    "snapshot_path",
    "utc_timestamp",
]


class SnapshotError(RuntimeError):
    """Snapshot create / extract failure (raised with a descriptive message)."""

    def __init__(self, message: str, *, exit_code: int = 1) -> None:
        super().__init__(message)
        self.exit_code = exit_code


def utc_timestamp() -> str:
    """Return ``YYYYMMDDTHHMMSSZ`` suitable for the snapshot filename."""
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")


def snapshot_dir(project_root: Path) -> Path:
    return project_root / ".deft-cache"


def snapshot_path(project_root: Path, *, timestamp: str | None = None) -> Path:
    stamp = timestamp or utc_timestamp()
    return snapshot_dir(project_root) / f"{SNAPSHOT_PREFIX}{stamp}.tar.gz"


def latest_snapshot(project_root: Path) -> Path | None:
    sdir = snapshot_dir(project_root)
    if not sdir.is_dir():
        return None
    candidates = sorted(sdir.glob(f"{SNAPSHOT_PREFIX}*.tar.gz"))
    return candidates[-1] if candidates else None


def create_snapshot(
    project_root: Path,
    *,
    target: Path | None = None,
    timestamp: str | None = None,
) -> Path:
    """Tarball the consumer's pre-relocate state into ``.deft-cache/``.

    Captures (when present): ``<project-root>/deft/``,
    ``<project-root>/.deft/core/``, ``<project-root>/AGENTS.md``, and
    ``<project-root>/.gitignore``. The tarball uses paths relative to
    ``project_root`` so :func:`extract_snapshot` restores them directly.
    """
    out = target or snapshot_path(project_root, timestamp=timestamp)
    out.parent.mkdir(parents=True, exist_ok=True)
    members = [
        project_root / LEGACY_FRAMEWORK_DIR,
        project_root / CANONICAL_FRAMEWORK_DIR,
        project_root / "AGENTS.md",
        project_root / ".gitignore",
    ]
    captured = [m for m in members if m.exists()]
    with tarfile.open(out, "w:gz") as tar:
        for member in captured:
            try:
                arcname = member.relative_to(project_root).as_posix()
            except ValueError:
                arcname = member.name
            tar.add(str(member), arcname=arcname, recursive=True)
    return out


def extract_snapshot(
    project_root: Path,
    *,
    snapshot: Path | None = None,
) -> Path:
    """Extract ``snapshot`` (or the most recent) back into ``project_root``.

    The wipe targets (``deft/`` and ``.deft/core/``) and ``AGENTS.md`` are
    removed first so a partially-relocated tree doesn't carry stale bytes
    forward into the rolled-back state. Returns the snapshot path that
    was actually extracted (handy for the operator-facing log line).
    """
    chosen = snapshot or latest_snapshot(project_root)
    if chosen is None:
        raise SnapshotError(
            f"no snapshot found under {snapshot_dir(project_root)} -- "
            "rollback requires either --snapshot PATH or a prior wipe-and-reinstall"
        )
    if not chosen.is_file():
        raise SnapshotError(
            f"snapshot path {chosen} does not exist or is not a file",
            exit_code=2,
        )

    for name in (LEGACY_FRAMEWORK_DIR, CANONICAL_FRAMEWORK_DIR):
        target = project_root / name
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
    agents_md = project_root / "AGENTS.md"
    if agents_md.is_file():
        agents_md.unlink()

    with tarfile.open(chosen, "r:gz") as tar:
        _safe_extract(tar, project_root)
    return chosen


def _safe_extract(tar: tarfile.TarFile, dest: Path) -> None:
    """Reject path traversal before extracting (per Python 3.12 best practice)."""
    dest_resolved = dest.resolve()
    for member in tar.getmembers():
        member_target = (dest / member.name).resolve()
        try:
            member_target.relative_to(dest_resolved)
        except ValueError:
            raise SnapshotError(
                f"snapshot member {member.name!r} would extract outside {dest}",
                exit_code=2,
            ) from None
    tar.extractall(dest, filter="data")  # type: ignore[arg-type]
