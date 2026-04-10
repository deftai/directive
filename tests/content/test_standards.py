"""
test_standards.py — Standards compliance checks for the Deft Directive framework.

Spec: SPECIFICATION.md Subphase 2.3 (Task 2.3.1)

Checks:
  1. RFC2119 legend: every file in LEGEND_DIRS must contain "!=MUST, ~=SHOULD"
  2. Deprecated path: no .md file should reference "core/user.md"
     (correct path is ~/.config/deft/USER.md)
  3. Deprecated name: no .md file outside old/ should contain "warping"
     (project was renamed to Deft)

Known failures are loaded from tests/content/snapshots/known_failures.json and
automatically marked xfail or exempted so they don't block the test run.

Author: Scott Adams (msadams) — 2026-03-10
"""

import json
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Module-level constants
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

RFC2119_LEGEND = "!=MUST, ~=SHOULD"

# Directories whose .md files must carry the RFC2119 legend
LEGEND_DIRS = [
    "languages",
    "interfaces",
    "tools",
    "strategies",
    "context",
    "vbrief",
    "verification",
    "resilience",
]

# Directories to skip when collecting files for deprecated checks
_SKIP_DIRS = {".git", ".venv", "__pycache__", ".pytest_cache", "backup", "dist", "tests"}


# ---------------------------------------------------------------------------
# Known-failures helpers
# ---------------------------------------------------------------------------

def _load_entries() -> list[dict]:
    kf_path = _REPO_ROOT / "tests/content/snapshots/known_failures.json"
    return json.loads(kf_path.read_text(encoding="utf-8"))["known_failures"]


def _xfail_set(check: str) -> set[str]:
    return {e["file"] for e in _load_entries() if e.get("xfail") and e.get("check") == check}


def _exempt_set(check: str) -> set[str]:
    return {e["file"] for e in _load_entries() if e.get("exempt") and e.get("check") == check}


# ---------------------------------------------------------------------------
# File collection helpers
# ---------------------------------------------------------------------------

def _all_md_files(exclude_trees: list[str] | None = None) -> list[str]:
    """Return all .md paths (relative to repo root), excluding skip dirs and trees."""
    result = []
    for path in sorted(_REPO_ROOT.rglob("*.md")):
        if any(part in _SKIP_DIRS for part in path.parts):
            continue
        rel = path.relative_to(_REPO_ROOT).as_posix()
        if exclude_trees and any(rel.startswith(t + "/") for t in exclude_trees):
            continue
        result.append(rel)
    return result


# ---------------------------------------------------------------------------
# 1. RFC2119 legend check
# ---------------------------------------------------------------------------

_RFC2119_CHECK = "test_standards.rfc2119_legend_present"


def _rfc2119_params() -> list:
    xfail = _xfail_set(_RFC2119_CHECK)
    exempt = _exempt_set(_RFC2119_CHECK)
    params = []
    for dirname in LEGEND_DIRS:
        for path in sorted((_REPO_ROOT / dirname).glob("*.md")):
            rel = path.relative_to(_REPO_ROOT).as_posix()
            if rel in exempt:
                continue
            if rel in xfail:
                params.append(
                    pytest.param(
                        rel,
                        marks=pytest.mark.xfail(
                            reason=f"{rel}: missing RFC2119 legend — see todo.md Phase 2",
                            strict=True,
                        ),
                    )
                )
            else:
                params.append(rel)  # type: ignore[arg-type]
    return params


@pytest.mark.parametrize("rel_path", _rfc2119_params())
def test_rfc2119_legend_present(rel_path: str) -> None:
    """Framework standard files must contain the RFC2119 legend line."""
    text = (_REPO_ROOT / rel_path).read_text(encoding="utf-8", errors="replace")
    assert RFC2119_LEGEND in text, (
        f"{rel_path}: missing RFC2119 legend '!=MUST, ~=SHOULD' — "
        "add the Legend line near the top of the file"
    )


# ---------------------------------------------------------------------------
# 2. Deprecated path check: no file should reference core/user.md
# ---------------------------------------------------------------------------

_DEPRECATED_PATH_CHECK = "test_standards.no_deprecated_user_path"


def _deprecated_path_params() -> list:
    xfail = _xfail_set(_DEPRECATED_PATH_CHECK)
    exempt = _exempt_set(_DEPRECATED_PATH_CHECK)
    params = []
    for rel in _all_md_files():
        if rel in exempt:
            continue
        if rel in xfail:
            params.append(
                pytest.param(
                    rel,
                    marks=pytest.mark.xfail(
                        reason=(
                            f"{rel}: still references deprecated path 'core/user.md' "
                            "— see todo.md Phase 2"
                        ),
                        strict=True,
                    ),
                )
            )
        else:
            params.append(rel)  # type: ignore[arg-type]
    return params


@pytest.mark.parametrize("rel_path", _deprecated_path_params())
def test_no_deprecated_user_path(rel_path: str) -> None:
    """No file should reference the deprecated 'core/user.md' path."""
    text = (_REPO_ROOT / rel_path).read_text(encoding="utf-8", errors="replace")
    assert "core/user.md" not in text.lower(), (
        f"{rel_path}: contains deprecated path 'core/user.md' "
        "(correct path is '~/.config/deft/USER.md')"
    )


# ---------------------------------------------------------------------------
# 3. Deprecated name check: no file outside old/ should contain "warping"
# ---------------------------------------------------------------------------

_WARPING_CHECK = "test_standards.no_warping_references"


def _warping_params() -> list:
    xfail = _xfail_set(_WARPING_CHECK)
    exempt = _exempt_set(_WARPING_CHECK)
    params = []
    for rel in _all_md_files(exclude_trees=["old"]):
        if rel in exempt:
            continue
        if rel in xfail:
            params.append(
                pytest.param(
                    rel,
                    marks=pytest.mark.xfail(
                        reason=(
                            f"{rel}: contains deprecated name 'warping' "
                            "— see todo.md Phase 2"
                        ),
                        strict=True,
                    ),
                )
            )
        else:
            params.append(rel)  # type: ignore[arg-type]
    return params


@pytest.mark.parametrize("rel_path", _warping_params())
def test_no_warping_references(rel_path: str) -> None:
    """Files outside old/ must not contain the deprecated name 'warping'."""
    text = (_REPO_ROOT / rel_path).read_text(encoding="utf-8", errors="replace")
    assert "warping" not in text.lower(), (
        f"{rel_path}: contains deprecated name 'warping' "
        "(project was renamed to Deft — update all references)"
    )


# ---------------------------------------------------------------------------
# 4. OS temp directory guidance for --body-file in scm/github.md
# ---------------------------------------------------------------------------


def test_body_file_os_temp_dir_guidance() -> None:
    """scm/github.md must contain OS temp directory guidance for --body-file."""
    text = (_REPO_ROOT / "scm/github.md").read_text(encoding="utf-8", errors="replace")
    assert "GetTempFileName" in text, (
        "scm/github.md: missing PowerShell OS temp dir pattern "
        "(expected GetTempFileName for --body-file guidance)"
    )
    assert "mktemp" in text, (
        "scm/github.md: missing Unix OS temp dir pattern "
        "(expected mktemp for --body-file guidance)"
    )
