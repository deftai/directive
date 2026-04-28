#!/usr/bin/env python3
"""resolve_version.py -- Resolve the deft framework version for build/dist tasks (#723).

Used by ``Taskfile.yml`` ``vars: VERSION: { sh: ... }`` so ``task build``
produces ``dist/deft-<version>.{zip,tar.gz}`` reflecting the actual
release version rather than a stale Taskfile literal.

Resolution priority (first match wins):
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
newline so go-task's ``sh:`` capture (which strips trailing whitespace
in any case) yields a clean ``X.Y.Z`` string ready for template
interpolation. ``stderr`` is intentionally silent on the happy path.

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
