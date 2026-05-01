#!/usr/bin/env python3
"""resolve_version.py -- Python mirror of the Taskfile VERSION resolver (#723)
plus the canonical semver -> PEP 440 normalization helper (#771).

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

PEP 440 normalization (#771)
----------------------------
``to_pep440(version)`` is the SINGLE CANONICAL converter from deft's
semver-shaped release tags (``vX.Y.Z`` / ``vX.Y.Z-rc.N`` / etc.) to
Python-package-safe PEP 440 versions. It is consumed by:

    * ``scripts/release.py`` Step 5 -- syncs ``[project].version`` in
      ``pyproject.toml`` so the root metadata stops drifting from the
      released tag (Phase A of #771);
    * ``tests/content/test_pyproject_version_freshness.py`` -- regression
      gate that fails if pyproject drifts;
    * any FUTURE pip-packaging path (root-repo or thin wrapper, see #11)
      MUST consume ``to_pep440`` rather than reimplementing the rule --
      this is the documented Phase C extension hook so exactly ONE
      normalization rule governs release-tag / CLI / PyPI surfaces.

Disposable / test-only tags (``v0.0.0-test.N``, etc.) are explicitly
classified non-publishable: ``to_pep440`` raises
``NonPublishableVersionError`` and ``is_publishable`` returns False.
The release pipeline catches this and skips the pyproject sync rather
than emitting a polluting throwaway version.

Refs #723, #74 (release foundation), #716 (safety hardening), #721
(canonical recovery anchor for the v0.21.0 cut session), #771
(pyproject truthfulness + PEP 440 normalization), #11 (future pip
packaging consumes this helper).
"""

from __future__ import annotations

import os
import re
import subprocess
import sys

DEV_FALLBACK = "0.0.0-dev"
ENV_VAR = "DEFT_RELEASE_VERSION"

# ---------------------------------------------------------------------------
# PEP 440 normalization (#771)
# ---------------------------------------------------------------------------

# Accepts an optional leading ``v`` followed by strict ``X.Y.Z`` and an
# optional pre-release suffix ``-(rc|alpha|beta|test).N``. ``-test.N``
# is parsed (so we can classify it explicitly) but is NEVER mapped to a
# PEP 440 form -- see ``_NON_PUBLISHABLE_KINDS`` below.
_PEP440_TAG_RE = re.compile(
    r"^v?(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)"
    r"(?:-(?P<kind>rc|alpha|beta|test)\.(?P<num>\d+))?$"
)

# Mapping from the semver-style pre-release token to PEP 440's compressed
# spelling. PEP 440 collapses ``rc.3`` -> ``rc3`` (no separator) and
# spells ``alpha`` / ``beta`` as ``a`` / ``b``.
_PRE_KIND_MAP: dict[str, str] = {
    "alpha": "a",
    "beta": "b",
    "rc": "rc",
}

# Pre-release tokens that classify a tag as non-publishable. ``test.N``
# is reserved for disposable / e2e-rehearsal tags (e.g. ``v0.0.0-test.1``
# from ``task release:e2e``) -- the release pipeline MUST skip the
# pyproject sync for these so PyPI / consumer-visible metadata is never
# polluted with throwaway versions.
_NON_PUBLISHABLE_KINDS: frozenset[str] = frozenset({"test"})


class NonPublishableVersionError(ValueError):
    """Raised when a tag is classified as non-publishable for PyPI.

    The release pipeline catches this in ``scripts/release.py`` Step 5
    and skips the ``pyproject.toml`` ``[project].version`` rewrite so
    disposable-tag releases (e.g. ``v0.0.0-test.1`` from the e2e
    rehearsal harness) never leak into Python-packaging metadata.

    Subclassing ``ValueError`` keeps catch-blocks that already trap
    ``ValueError`` (e.g. argparse error reporting) backward compatible;
    callers that need to distinguish the publishability classification
    from a generic parse failure check the concrete type.
    """


def to_pep440(version: str) -> str:
    """Normalize a semver-shaped release tag to a PEP 440 version string.

    Mappings (#771 acceptance):

        ``v0.22.0``         -> ``"0.22.0"``
        ``v0.20.0-rc.3``    -> ``"0.20.0rc3"``
        ``v0.20.0-beta.2``  -> ``"0.20.0b2"``
        ``v0.20.0-alpha.1`` -> ``"0.20.0a1"``
        ``v0.0.0-test.1``   -> raises ``NonPublishableVersionError``

    The leading ``v`` is optional (matching ``_from_git`` which strips
    it) so callers can pass either ``v0.22.0`` or ``0.22.0``.

    Raises
    ------
    NonPublishableVersionError
        For ``test.N`` (and any other ``_NON_PUBLISHABLE_KINDS``) tags.
    ValueError
        For anything that does not parse as ``[v]X.Y.Z[-(rc|alpha|beta|test).N]``.
    """
    if not isinstance(version, str):
        raise ValueError(f"version must be a string, got {type(version).__name__}")
    candidate = version.strip()
    if not candidate:
        raise ValueError("version must be a non-empty string")
    match = _PEP440_TAG_RE.match(candidate)
    if match is None:
        raise ValueError(
            f"Cannot normalize {candidate!r} to PEP 440: expected "
            f"[v]X.Y.Z or [v]X.Y.Z-(rc|alpha|beta|test).N"
        )
    base = f"{int(match['major'])}.{int(match['minor'])}.{int(match['patch'])}"
    kind = match.group("kind")
    if kind is None:
        return base
    if kind in _NON_PUBLISHABLE_KINDS:
        raise NonPublishableVersionError(
            f"Version {candidate!r} carries non-publishable pre-release "
            f"tag {kind!r}.{match.group('num')} -- release pipeline MUST "
            f"skip pyproject.toml [project].version sync for this tag."
        )
    # Greptile advisory (#774): defensive .get() guard so a future regex
    # extension that adds a kind without registering a mapping raises a
    # clean ValueError instead of a bare KeyError. _PEP440_TAG_RE and
    # _PRE_KIND_MAP / _NON_PUBLISHABLE_KINDS are kept in lockstep by
    # convention; this guard converts a contract drift into an actionable
    # diagnostic for the next maintainer.
    pep_kind = _PRE_KIND_MAP.get(kind)
    if pep_kind is None:
        raise ValueError(
            f"Unmapped pre-release kind {kind!r} for version {candidate!r}; "
            "add it to _PRE_KIND_MAP or _NON_PUBLISHABLE_KINDS to keep "
            "_PEP440_TAG_RE in lockstep with the publishability classifier."
        )
    pep_num = int(match.group("num"))
    return f"{base}{pep_kind}{pep_num}"


def is_publishable(version: str) -> bool:
    """Return True iff ``version`` normalizes to a publishable PEP 440 string.

    A return of False means the caller MUST NOT propagate ``version`` to
    PyPI-facing metadata (e.g. ``pyproject.toml`` ``[project].version``).
    Both ``NonPublishableVersionError`` and a generic parse ``ValueError``
    classify as non-publishable -- a malformed tag is not safe to publish.
    """
    try:
        to_pep440(version)
    except (NonPublishableVersionError, ValueError):
        return False
    return True


# ---------------------------------------------------------------------------
# Resolver priority chain (#723)
# ---------------------------------------------------------------------------


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
