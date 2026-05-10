"""_relocate_states.py -- state detection helpers for scripts/relocate.py (#992 PR2).

Extracted from :mod:`scripts.relocate` to keep the parent module under the
deft 1000-line MUST limit (mirrors the
``scripts/cache.py`` / ``scripts/_cache_validate.py`` /
``scripts/_cache_fetch.py`` split pattern from #883).

Public API:

- :func:`detect_install_state`         -- A/B/C/D/E/F/G classification.
- :func:`detect_active_swarm`          -- True iff any vbrief/active is running.
- :func:`active_swarm_paths`           -- list of running active vBRIEFs.
- :func:`is_framework_customized`      -- True iff framework dir != source.
- :func:`customization_paths`          -- list of customized files.
- :func:`advise_external_hardcodes`    -- legacy ``deft/run`` grep.
- :func:`iter_files`                   -- recursive regular-file walker.

This module is intentionally pure-stdlib + pathlib so it imports cleanly
under the same UTF-8 + Python 3.11 baseline as the rest of ``scripts/``.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator
from pathlib import Path

# Mirror the constants used by the parent module verbatim so a future
# rename in scripts/relocate.py only needs to update one place. The
# parent module re-imports these at module load.
CANONICAL_FRAMEWORK_DIR: str = ".deft/core"
LEGACY_FRAMEWORK_DIR: str = "deft"

AGENTS_MANAGED_OPEN: str = "<!-- deft:managed-section v2 -->"
AGENTS_MANAGED_CLOSE: str = "<!-- /deft:managed-section -->"

ADVISORY_LEGACY_TOKEN: str = "deft/run"

ADVISORY_GREP_SKIP_DIRS: tuple[str, ...] = (
    ".deft",
    ".deft-cache",
    LEGACY_FRAMEWORK_DIR,
    ".git",
    ".github",
    ".venv",
    ".pytest_cache",
    "__pycache__",
    "node_modules",
    "dist",
    "build",
)

ADVISORY_GREP_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".md",
        ".txt",
        ".yml",
        ".yaml",
        ".json",
        ".toml",
        ".sh",
        ".ps1",
        ".bat",
        ".py",
        ".go",
        ".js",
        ".ts",
        ".rs",
        ".rb",
    }
)

_ADVISORY_GREP_MAX_BYTES: int = 1_000_000


__all__ = [
    "ADVISORY_GREP_EXTENSIONS",
    "ADVISORY_GREP_SKIP_DIRS",
    "ADVISORY_LEGACY_TOKEN",
    "active_swarm_paths",
    "advise_external_hardcodes",
    "customization_paths",
    "detect_active_swarm",
    "detect_install_state",
    "is_framework_customized",
    "iter_files",
]


# ---------------------------------------------------------------------------
# Filesystem walker
# ---------------------------------------------------------------------------


def iter_files(root: Path) -> Iterator[Path]:
    """Yield every regular file under ``root`` recursively (no symlinks)."""
    if not root.is_dir():
        return
    for entry in root.iterdir():
        if entry.is_dir() and not entry.is_symlink():
            yield from iter_files(entry)
        elif entry.is_file():
            yield entry


# ---------------------------------------------------------------------------
# State A / B / C / D / E / F / G classifier
# ---------------------------------------------------------------------------


def _has_managed_markers(text: str) -> bool:
    return AGENTS_MANAGED_OPEN in text and AGENTS_MANAGED_CLOSE in text


def detect_install_state(
    project_root: Path,
    *,
    framework_source: Path | None = None,
) -> str:
    """Classify the consumer install layout (A/B/C/D/E/F/G/CANONICAL).

    State G (active swarm) and state E (customized framework) are
    pre-flight gates that take precedence over the layout states A-D
    when present. The relocator's plan-builder consults the customization
    + active-swarm probes independently so the full state vector is
    available even on layout state C / D / etc.
    """
    legacy = project_root / LEGACY_FRAMEWORK_DIR
    canonical = project_root / CANONICAL_FRAMEWORK_DIR
    agents_md = project_root / "AGENTS.md"
    vbrief_root = project_root / "vbrief"

    legacy_present = legacy.is_dir()
    canonical_present = canonical.is_dir()
    agents_md_present = agents_md.is_file()
    vbrief_present = vbrief_root.is_dir()

    if detect_active_swarm(project_root):
        return "G"

    if framework_source is not None and (
        (legacy_present and is_framework_customized(legacy, framework_source))
        or (canonical_present and is_framework_customized(canonical, framework_source))
    ):
        return "E"

    if legacy_present and canonical_present:
        return "C"
    if legacy_present and not canonical_present:
        return "A"
    if canonical_present and not legacy_present:
        if not agents_md_present:
            return "B"
        try:
            text = agents_md.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return "B"
        if not _has_managed_markers(text):
            return "B"
        return "CANONICAL"

    if agents_md_present:
        return "D"

    return "F" if not vbrief_present else "D"


# ---------------------------------------------------------------------------
# State G -- active swarm probe
# ---------------------------------------------------------------------------


def detect_active_swarm(project_root: Path) -> bool:
    """Return True iff any ``vbrief/active/*.vbrief.json`` has ``plan.status == "running"``."""
    return bool(active_swarm_paths(project_root))


def active_swarm_paths(project_root: Path) -> list[str]:
    """Return the list of running-status active vBRIEF paths (project-relative)."""
    active_dir = project_root / "vbrief" / "active"
    if not active_dir.is_dir():
        return []
    paths: list[str] = []
    for candidate in sorted(active_dir.glob("*.vbrief.json")):
        try:
            payload = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        plan = payload.get("plan") if isinstance(payload, dict) else None
        if not isinstance(plan, dict):
            continue
        if plan.get("status") == "running":
            try:
                rel = candidate.relative_to(project_root)
            except ValueError:
                rel = candidate
            paths.append(rel.as_posix())
    return paths


# ---------------------------------------------------------------------------
# State E -- customization detection
# ---------------------------------------------------------------------------


def _sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65_536), b""):
            h.update(chunk)
    return h.hexdigest()


def is_framework_customized(framework_dir: Path, framework_source: Path) -> bool:
    """Return True iff any file under ``framework_dir`` differs from ``framework_source``.

    Two signals, in order:

    1. Sentinel-marker fast-path -- ``framework_dir/.deft-customized``.
       Test fixtures use this for deterministic state-E construction.
    2. SHA-256 hash compare against the matching file in
       ``framework_source``. A file present only in ``framework_dir`` (an
       extra) also counts as customization.

    The reverse direction (files in source but absent in framework_dir)
    is NOT customization -- it just means the consumer is behind, which
    is the relocator's whole job.
    """
    return bool(customization_paths(framework_dir, framework_source))


def customization_paths(framework_dir: Path, framework_source: Path) -> list[str]:
    """Return the project-relative paths that differ from ``framework_source``."""
    if not framework_dir.is_dir():
        return []

    sentinel = framework_dir / ".deft-customized"
    paths: list[str] = []
    if sentinel.is_file():
        try:
            paths.append(sentinel.relative_to(framework_dir.parent).as_posix())
        except ValueError:
            paths.append(sentinel.name)

    if not framework_source.is_dir():
        return paths

    for src_path in iter_files(framework_dir):
        try:
            rel = src_path.relative_to(framework_dir)
        except ValueError:
            continue
        if rel.as_posix() == ".deft-customized":
            continue
        canonical = framework_source / rel
        try:
            project_rel = src_path.relative_to(framework_dir.parent).as_posix()
        except ValueError:
            project_rel = rel.as_posix()
        if not canonical.is_file():
            paths.append(project_rel)
            continue
        try:
            if _sha256_of(src_path) != _sha256_of(canonical):
                paths.append(project_rel)
        except OSError:
            paths.append(project_rel)
    return paths


# ---------------------------------------------------------------------------
# Advisory grep -- find legacy `deft/run` hardcodes outside .deft/core/
# ---------------------------------------------------------------------------


def advise_external_hardcodes(
    project_root: Path,
    *,
    token: str = ADVISORY_LEGACY_TOKEN,
) -> list[tuple[str, int, str]]:
    """Return the ``(rel_path, line_number, line_text)`` tuples for legacy hardcodes.

    Skips ``.deft/``, ``.deft-cache/``, ``deft/`` (the legacy framework
    dir, which the relocator may not have wiped yet on a dry-run), plus
    standard development noise. Inspects only the curated set of text
    extensions to keep the walk fast on large consumer repos.
    """
    hits: list[tuple[str, int, str]] = []
    for path in _iter_consumer_text_files(project_root):
        try:
            rel = path.relative_to(project_root).as_posix()
        except ValueError:
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        if stat.st_size > _ADVISORY_GREP_MAX_BYTES:
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except (OSError, UnicodeDecodeError):
            continue
        if token not in text:
            continue
        for idx, line in enumerate(text.splitlines(), start=1):
            if token in line:
                hits.append((rel, idx, line.rstrip()))
    return hits


def _iter_consumer_text_files(project_root: Path) -> Iterator[Path]:
    for path in iter_files(project_root):
        try:
            rel = path.relative_to(project_root)
        except ValueError:
            continue
        first = rel.parts[0] if rel.parts else ""
        if first in ADVISORY_GREP_SKIP_DIRS:
            continue
        if path.suffix.lower() not in ADVISORY_GREP_EXTENSIONS:
            continue
        yield path
