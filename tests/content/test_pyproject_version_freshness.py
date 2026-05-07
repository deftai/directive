"""test_pyproject_version_freshness.py -- pyproject [project].version drift gate (#771).

Regression counterpart to the release-pipeline ``Step 5`` pyproject sync
landed in #771. If the root ``pyproject.toml`` ``[project].version``
diverges from the PEP 440-normalized form of the latest published
release tag, this test fails.

Behaviour matrix:

    Latest tag        | Publishable? | Test outcome
    ------------------|--------------|--------------
    vX.Y.Z            | yes          | FAIL if pyproject != to_pep440(tag)
    vX.Y.Z-rc.N       | yes          | FAIL if pyproject != to_pep440(tag)
    vX.Y.Z-test.N     | NO           | SKIP (non-publishable; sync intentionally skipped)
    no tag / no git   | n/a          | SKIP (likely shallow clone / fresh repo)

The CHANGELOG entry under [Unreleased]/Added in #771 also references
this regression gate -- the rule body lives in the deterministic test,
not in prose, per the Rule Authority [AXIOM] block in ``main.md``.
"""

from __future__ import annotations

import importlib.util
import re
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = REPO_ROOT / "scripts"


def _load_resolve_version():
    if str(SCRIPTS) not in sys.path:
        sys.path.insert(0, str(SCRIPTS))
    spec = importlib.util.spec_from_file_location(
        "resolve_version",
        SCRIPTS / "resolve_version.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["resolve_version"] = module
    spec.loader.exec_module(module)
    return module


resolve_version = _load_resolve_version()


_VERSION_LINE_RE = re.compile(r'version\s*=\s*"([^"]+)"')


def _read_project_version(pyproject_path: Path) -> str | None:
    """Return the ``[project].version`` value, or None if not found.

    Mirrors the parsing rules used by ``scripts/release.update_pyproject_version``:
    only the first ``version = "..."`` line under ``[project]`` is considered.
    """
    text = pyproject_path.read_text(encoding="utf-8")
    in_project = False
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("[") and stripped.endswith("]"):
            in_project = stripped == "[project]"
            continue
        if in_project:
            match = _VERSION_LINE_RE.match(stripped)
            if match:
                return match.group(1)
    return None


def _latest_git_tag() -> str | None:
    """Return the latest annotated git tag, or None when unavailable.

    A None return indicates the repo has no tags (fresh clone, shallow CI
    checkout, etc.) -- the freshness assertion is skipped in that case.
    """
    try:
        result = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "describe", "--tags", "--abbrev=0"],
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
    return tag or None


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_pyproject_has_project_version():
    """Sanity: the root pyproject.toml carries a [project].version key."""
    pyproject = REPO_ROOT / "pyproject.toml"
    assert pyproject.is_file(), f"{pyproject} missing"
    version = _read_project_version(pyproject)
    assert version, (
        f"pyproject.toml at {pyproject} has no [project].version line; "
        "the release pipeline relies on this key (#771)"
    )


def test_pyproject_version_matches_latest_tag():
    """[project].version MUST equal to_pep440(latest tag) (#771).

    The release pipeline syncs this on every cut. If the assertion fails
    locally, run ``task release -- <version>`` (which now syncs
    pyproject.toml in Step 5) or update the line manually to match
    ``to_pep440(<latest tag>)``.
    """
    pyproject = REPO_ROOT / "pyproject.toml"
    project_version = _read_project_version(pyproject)
    assert project_version, "pyproject.toml [project].version missing"

    tag = _latest_git_tag()
    if tag is None:
        pytest.skip(
            "no git tag available (fresh / shallow clone); "
            "freshness gate cannot determine the expected version"
        )

    if not resolve_version.is_publishable(tag):
        pytest.skip(
            f"latest tag {tag!r} is non-publishable "
            f"(disposable / test tag); pyproject sync is intentionally "
            f"skipped per #771 Phase B"
        )

    expected = resolve_version.to_pep440(tag)
    assert project_version == expected, (
        f"pyproject.toml [project].version drifted: got {project_version!r}, "
        f"expected {expected!r} (PEP 440 normalization of latest tag {tag!r}). "
        f"Run `task release -- <version>` (which syncs pyproject.toml in "
        f"Step 5 per #771) or update the line manually."
    )


def test_pyproject_version_is_pep440_publishable():
    """The committed [project].version MUST itself be a publishable PEP 440 string.

    Defends against an operator manually editing the value to a non-PEP 440
    form (e.g. carrying a leading ``v`` or a semver-style ``-rc.3`` suffix).
    The pipeline always writes the PEP 440-normalized form; the freshness
    test ensures the committed file is consistent with that contract.
    """
    pyproject = REPO_ROOT / "pyproject.toml"
    project_version = _read_project_version(pyproject)
    assert project_version, "pyproject.toml [project].version missing"
    # The version SHOULD round-trip through to_pep440 unchanged when it
    # is already in PEP 440 form. We accept the no-op in two ways:
    # (a) bare X.Y.Z -- to_pep440 returns the same value;
    # (b) X.Y.Z{a,b,rc}N -- already PEP 440 compressed; to_pep440 would
    #     reject it (the helper accepts only semver-shaped input). For
    #     case (b) we fall back to a literal regex check.
    pep440_re = re.compile(r"^\d+\.\d+\.\d+(?:(?:a|b|rc)\d+)?$")
    assert pep440_re.match(project_version), (
        f"pyproject.toml [project].version {project_version!r} is not "
        f"in PEP 440 form (X.Y.Z or X.Y.Z[a|b|rc]N). Per #771 the value "
        f"MUST be the PEP 440 normalization of the latest tag."
    )
