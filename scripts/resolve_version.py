#!/usr/bin/env python3
"""resolve_version.py -- Python mirror of the Taskfile VERSION resolver (#723).

This script is an INDEPENDENT Python mirror of the version-resolution
priority chain that the canonical Taskfile-side resolver implements
inline in ``Taskfile.yml`` ``vars: VERSION: { sh: ... }``. The Taskfile
inline POSIX ``sh:`` block is the ACTUAL resolver consumed by
``task build`` / ``task release`` (run via go-task's embedded
mvdan/sh interpreter so it works cross-platform without requiring
``uv`` / Python at parse time).

This Python module is NOT invoked from ``Taskfile.yml``. It exists so
Python callers (regression tests in ``tests/cli/test_resolve_version.py``,
``scripts/release.py::run_build``, future scripts that need the
version at import time, etc.) have a single source of truth for the
same resolution priority -- avoiding silent drift between the Taskfile
``sh:`` block and ad-hoc Python re-implementations.

Resolution priority (first match wins -- mirrors the Taskfile sh block):
    1. ``$DEFT_RELEASE_VERSION`` -- set by ``scripts/release.py::run_build``
       so the in-flight release version (e.g. ``0.21.0``) becomes the
       build artifact filename during ``task release -- 0.21.0``. The
       Taskfile literal previously hard-coded ``0.20.0``, which produced
       ``dist/deft-0.20.0.zip`` during the v0.21.0 cut (#723).
    2. ``git describe --tags --abbrev=0`` (stripped of leading ``v``) --
       reflects the latest annotated release tag for standalone
       ``task build`` invocations on a tagged checkout.
    3. ``0.0.0-dev`` -- fallback for fresh checkouts with no tags or
       repositories where ``git`` is unavailable.

The script writes the resolved version to stdout WITHOUT a trailing
newline so its output matches the Taskfile inline ``sh:`` block's
``printf '%s'`` shape byte-for-byte (no trailing whitespace either
way). ``stderr`` is intentionally silent on the happy path.

If you change the priority chain here, you MUST also update the inline
``sh:`` block in ``Taskfile.yml`` (and vice versa) -- the two are kept
in lockstep by convention, not by code reuse.

Refs #723, #74 (release foundation), #716 (safety hardening), #721
(canonical recovery anchor for the v0.21.0 cut session).
"""

from __future__ import annotations

import os
import subprocess
import sys

DEV_FALLBACK = "0.0.0-dev"
ENV_VAR = "DEFT_RELEASE_VERSION"


def _from_env() -> str | None:
    value = os.environ.get(ENV_VAR, "").strip()
    return value or None


def _from_git() -> str | None:
    """Return the latest annotated tag (without leading ``v``) or None."""
    try:
        result = subprocess.run(
            ["git", "describe", "--tags", "--abbrev=0"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    tag = (result.stdout or "").strip()
    if not tag:
        return None
    if tag.startswith("v"):
        tag = tag[1:]
    return tag or None


def resolve_version() -> str:
    """Resolve the version using the documented priority chain."""
    env_value = _from_env()
    if env_value:
        return env_value
    git_value = _from_git()
    if git_value:
        return git_value
    return DEV_FALLBACK


def main(argv: list[str] | None = None) -> int:
    # No flags today; argv is accepted for symmetry with sibling scripts
    # that follow the argparse convention.
    del argv
    sys.stdout.write(resolve_version())
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
