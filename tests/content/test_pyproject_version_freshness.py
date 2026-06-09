"""test_pyproject_version_freshness.py -- pyproject [project].version drift gate (#771).

Regression counterpart to the release-pipeline ``Step 5`` pyproject sync
landed in #771. If the root ``pyproject.toml`` ``[project].version``
diverges from the PEP 440-normalized form of the latest published
release tag, this test fails. The freshness gate checks the read-only
remote tag advertisement first so stale local tags do not make master red
after a normal release.

Behaviour matrix:

    Latest tag source | Publishable? | Test outcome
    ------------------|--------------|--------------
    origin vX.Y.Z     | yes          | FAIL if pyproject != to_pep440(tag)
    origin vX.Y.Z-rc.N| yes          | FAIL if pyproject != to_pep440(tag)
    local-only tag    | yes          | fallback when origin cannot be queried
    vX.Y.Z-test.N     | NO           | ignored (non-publishable; sync intentionally skipped)
    no tags / no git  | n/a          | SKIP (likely shallow clone / fresh repo)

The CHANGELOG entry under [Unreleased]/Added in #771 also references
this regression gate -- the rule body lives in the deterministic test,
not in prose, per the Rule Authority [AXIOM] block in ``main.md``.
"""

from __future__ import annotations

import importlib.util
import re
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


def _latest_release_tag() -> tuple[str | None, str]:
    """Return the latest publishable release tag and its discovery source.

    The remote lookup is read-only: it observes ``origin`` tags without
    fetching or mutating local refs. If the remote is unavailable, local tags
    are still good enough for offline/shallow-clone checks.
    """
    remote_tag = resolve_version.latest_remote_publishable_tag("origin", REPO_ROOT)
    if remote_tag is not None:
        return remote_tag, "origin"
    local_tag = resolve_version.latest_local_publishable_tag(REPO_ROOT)
    if local_tag is not None:
        return local_tag, "local"
    return None, "none"


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_latest_release_tag_prefers_origin_over_stale_local(monkeypatch):
    """A stale local tag must not override the published release tag (#1564)."""
    monkeypatch.setattr(
        resolve_version,
        "latest_remote_publishable_tag",
        lambda _remote, _repo_root: "v0.44.0",
    )
    monkeypatch.setattr(
        resolve_version,
        "latest_local_publishable_tag",
        lambda _repo_root: "v0.43.0",
    )

    assert _latest_release_tag() == ("v0.44.0", "origin")


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
    """[project].version MUST equal to_pep440(latest published tag) (#771).

    The release pipeline syncs this on every cut. The test prefers the
    read-only remote tag advertisement so stale local tag state does not
    misreport the latest published release after a normal release.
    """
    pyproject = REPO_ROOT / "pyproject.toml"
    project_version = _read_project_version(pyproject)
    assert project_version, "pyproject.toml [project].version missing"

    tag, source = _latest_release_tag()
    if tag is None:
        pytest.skip(
            "no publishable git tag available (fresh / shallow clone); "
            "freshness gate cannot determine the expected version"
        )

    expected = resolve_version.to_pep440(tag)
    assert project_version == expected, (
        f"pyproject.toml [project].version drifted: got {project_version!r}, "
        f"expected {expected!r} (PEP 440 normalization of latest {source} "
        f"published tag {tag!r}). "
        f"Run `task release -- <version>` (which syncs pyproject.toml in "
        f"Step 5 per #771) or verify the release tag is published."
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
