#!/usr/bin/env python3
"""build_dist.py -- cross-platform release-archive builder (#736).

Replaces the prior ``tasks/core.yml::build`` shape which dispatched
``tar -czf ... --exclude=...`` on Linux / macOS but
``Compress-Archive -Path . -DestinationPath dist\\deft-X.Y.Z.zip -Force``
on Windows. The Windows branch had no exclude list, so the resulting zip
included ``.git/`` (often hundreds of MB of history), ``backup/``,
``node_modules/``, AND -- because ``Compress-Archive -Path .`` walks the
output directory recursively -- the prior ``dist/`` artifact, leading to
unbounded growth on every re-run.

The fix is a single Python helper using stdlib ``tarfile`` and ``zipfile``
with one canonical exclude list, dispatched as a single command from
``tasks/core.yml::build`` (no platform split). Format selection is
data-driven by ``sys.platform`` (overridable via ``--format`` for tests).

The script is intentionally stdlib-only -- it ships with the framework
distribution itself, so any external dependency would be a chicken-and-egg
problem during release.

Usage
-----
    uv run python scripts/build_dist.py --version 0.22.0
    uv run python scripts/build_dist.py --version 0.22.0 --format zip
    uv run python scripts/build_dist.py --version 0.22.0 \\
        --exclude-extra .venv,htmlcov

Exit codes
----------
    0 -- archive written
    1 -- runtime failure (filesystem error, archive write failure)
    2 -- configuration error (missing --version / missing root)

Refs #736.
"""

from __future__ import annotations

import argparse
import os
import sys
import tarfile
import zipfile
from pathlib import Path

# Make sibling helpers importable both when run as __main__ and when imported
# by tests via importlib.util.spec_from_file_location.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _stdio_utf8 import reconfigure_stdio  # noqa: E402

reconfigure_stdio()


# ---- Constants --------------------------------------------------------------

# Canonical exclude list. Top-level directory names that MUST never be in
# the archive per the #736 acceptance criteria + the broader .gitignore
# conventions in this repo. The match is purely by path-component name --
# any directory anywhere under the root whose basename matches one of these
# is pruned during the os.walk traversal.
#
# The first four entries (.git, dist, backup, node_modules) mirror the
# previous Linux/macOS tar exclude list verbatim so the cross-platform
# parity test in tests/content/test_taskfile_zip_parity.py can assert the
# exclude set is preserved as the task contract changes shape. The
# additional entries (__pycache__ ... .ruff_cache) extend the list for
# Python-tooling artifacts that appear in development checkouts and would
# otherwise bloat the archive.
DEFAULT_EXCLUDES: tuple[str, ...] = (
    ".git",
    "dist",
    "backup",
    "node_modules",
    "__pycache__",
    ".venv",
    "htmlcov",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".coverage",
)

EXIT_OK = 0
EXIT_RUNTIME_ERROR = 1
EXIT_CONFIG_ERROR = 2

# Archive root directory inside the produced artifact. Consumers extracting
# the tarball / zip get a single top-level ``deft/`` directory rather than
# a sea of top-level files, matching the previous tar(1) behaviour where
# ``tar -czf foo.tar.gz .`` produces ``./`` entries that extract into the
# current directory but most tools display as ``./<name>``.
ARCHIVE_ROOT = "deft"


# ---- Path filtering ---------------------------------------------------------


def _iter_source_files(
    root: Path, excludes: frozenset[str]
) -> list[tuple[Path, str]]:
    """Return a sorted list of ``(absolute_path, archive_relative_posix)``.

    Walks ``root`` skipping any directory or file whose basename matches
    an entry in ``excludes``. Returns deterministic ordering so the
    produced archive is reproducible across runs and across platforms
    (the task contract ``test_idempotent_rerun`` depends on this).

    Two pruning paths apply:

    1. Directory pruning -- ``dirnames`` is mutated in place so any
       directory whose basename matches an exclude is skipped along with
       its entire subtree. The dist/ output dir is implicitly pruned by
       being in the canonical exclude list, which delivers the
       idempotency guarantee called out in the #736 acceptance criteria.
    2. File pruning -- bare filenames whose basename matches an exclude
       (e.g. ``.coverage`` is written as a single regular file at the
       repo root by coverage.py, NOT a directory) are skipped. Without
       this branch the directory-only prune would silently fail to honor
       the documented intent for file-shaped artifacts (Greptile P1
       review on PR #773).
    """
    entries: list[tuple[Path, str]] = []
    for dirpath, dirnames, filenames in os.walk(root):
        # Mutate dirnames in place to prune the walk -- canonical os.walk
        # idiom. Sort for determinism.
        dirnames[:] = sorted(d for d in dirnames if d not in excludes)
        for fname in sorted(filenames):
            if fname in excludes:
                # File-level pruning -- catches single-file artifacts
                # like .coverage that os.walk surfaces in `filenames`,
                # not `dirnames`.
                continue
            abs_path = Path(dirpath) / fname
            try:
                rel = abs_path.relative_to(root)
            except ValueError:
                # Defensive: os.walk should never yield a path outside
                # root, but symlinked traversals can in theory.
                continue
            entries.append((abs_path, rel.as_posix()))
    return entries


# ---- Archive writers --------------------------------------------------------


def _write_tar_gz(
    root: Path, output: Path, entries: list[tuple[Path, str]]
) -> int:
    """Write a gzipped tar archive of ``entries`` to ``output``.

    Each entry is added under the ``ARCHIVE_ROOT`` prefix so extraction
    yields a single top-level directory.
    """
    output.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with tarfile.open(output, "w:gz") as tar:
        for abs_path, rel in entries:
            tar.add(abs_path, arcname=f"{ARCHIVE_ROOT}/{rel}", recursive=False)
            count += 1
    return count


def _write_zip(
    root: Path, output: Path, entries: list[tuple[Path, str]]
) -> int:
    """Write a deflate-compressed zip archive of ``entries`` to ``output``."""
    output.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as zf:
        for abs_path, rel in entries:
            zf.write(abs_path, arcname=f"{ARCHIVE_ROOT}/{rel}")
            count += 1
    return count


# ---- Format / path resolution ----------------------------------------------


def select_format(arg: str | None) -> str:
    """Return the archive format token (``tar`` or ``zip``).

    When ``arg`` is None the platform default applies: ``zip`` on Windows
    (``sys.platform`` startswith ``win``), ``tar`` everywhere else.
    """
    if arg:
        return arg.lower()
    if sys.platform.startswith("win"):
        return "zip"
    return "tar"


def output_path(root: Path, version: str, fmt: str) -> Path:
    """Return the final artifact path for ``version`` + ``fmt`` under root."""
    suffix = "zip" if fmt == "zip" else "tar.gz"
    return root / "dist" / f"deft-{version}.{suffix}"


# ---- Public build entry point ----------------------------------------------


def build(
    root: Path,
    version: str,
    fmt: str,
    extra_excludes: tuple[str, ...] = (),
) -> Path:
    """Produce the release archive and return its path.

    Idempotency: the canonical exclude list contains ``dist`` so the
    output directory is pruned during traversal -- a stale prior artifact
    sitting at ``dist/deft-<version>.<ext>`` cannot be ingested into the
    new archive. As a belt-and-suspenders guard we also unlink the target
    output file if it already exists so the new archive is fresh.
    """
    excludes = frozenset((*DEFAULT_EXCLUDES, *extra_excludes))
    output = output_path(root, version, fmt)
    if output.exists():
        output.unlink()
    entries = _iter_source_files(root, excludes)
    if fmt == "zip":
        _write_zip(root, output, entries)
    else:
        _write_tar_gz(root, output, entries)
    return output


# ---- CLI --------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="build_dist.py",
        description=(
            "Build a cross-platform release archive (#736). Default format "
            "is tar.gz on Linux/macOS and zip on Windows; override with "
            "--format. Excludes .git, dist, backup, node_modules, and "
            "Python-tooling caches by default."
        ),
    )
    parser.add_argument(
        "--version",
        required=True,
        help=(
            "Version string used as the archive filename suffix "
            "(e.g. 0.22.0). Passed by tasks/core.yml::build via "
            "{{.VERSION}}, which itself resolves through "
            "scripts/resolve_version.py's priority chain."
        ),
    )
    parser.add_argument(
        "--format",
        choices=("tar", "zip"),
        default=None,
        help=(
            "Archive format override. tar=tar.gz, zip=zip. Default is "
            "platform-driven (zip on Windows, tar.gz elsewhere)."
        ),
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=None,
        help=(
            "Repository root to package (default: parent of the scripts/ "
            "directory)."
        ),
    )
    parser.add_argument(
        "--exclude-extra",
        default="",
        help=(
            "Comma-separated extra directory basenames to exclude in "
            "addition to the canonical list."
        ),
    )
    return parser


def _parse_extras(raw: str) -> tuple[str, ...]:
    """Split ``raw`` (comma-separated) into a tuple, stripping empties."""
    return tuple(p.strip() for p in raw.split(",") if p.strip())


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    if not args.version:
        print("error: --version is required", file=sys.stderr)
        return EXIT_CONFIG_ERROR
    root = (args.root or Path(__file__).resolve().parent.parent).resolve()
    if not root.is_dir():
        print(f"error: root not found: {root}", file=sys.stderr)
        return EXIT_CONFIG_ERROR
    fmt = select_format(args.format)
    extras = _parse_extras(args.exclude_extra)
    try:
        out = build(root, args.version, fmt, extras)
    except OSError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_RUNTIME_ERROR
    try:
        printable = out.relative_to(root)
    except ValueError:
        printable = out
    print(f"Created {printable}")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
