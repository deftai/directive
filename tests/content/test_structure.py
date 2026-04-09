"""
test_structure.py — Structural checks for the Deft Directive framework.

Spec: SPECIFICATION.md Subphase 2.2 (Task 2.2.1)

Verifies:
  - Required top-level directories exist
  - Required root files exist
  - Strategy files listed in strategies/README.md exist on disk
    (rapid.md and enterprise.md are xfail — listed as future)

Author: Scott Adams (msadams) — 2026-03-10
"""

import json
import re
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Module-level repo root (needed at parametrize time — fixtures not available)
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent


# ---------------------------------------------------------------------------
# Known failures loader
# ---------------------------------------------------------------------------

def _load_xfail_files() -> set[str]:
    """Return the set of file paths expected to be missing for structure checks.

    Only considers entries whose 'check' field references test_structure,
    so xfails for other suites (shape, standards, etc.) don't bleed in.
    """
    kf_path = _REPO_ROOT / "tests/content/snapshots/known_failures.json"
    data = json.loads(kf_path.read_text(encoding="utf-8"))
    return {
        entry["file"]
        for entry in data["known_failures"]
        if entry.get("xfail")
        and "file" in entry
        and "test_structure" in entry.get("check", "")
    }


_XFAIL_FILES: set[str] = _load_xfail_files()


# ---------------------------------------------------------------------------
# Required top-level directories
# ---------------------------------------------------------------------------

REQUIRED_DIRS = [
    "coding",
    "context",
    "contracts",
    "core",
    "deployments",
    "history",
    "interfaces",
    "languages",
    "meta",
    "resilience",
    "scm",
    "strategies",
    "swarm",
    "templates",
    "tools",
    "vbrief",
    "verification",
]


@pytest.mark.parametrize("dirname", REQUIRED_DIRS)
def test_required_directory_exists(dirname: str) -> None:
    """Each required top-level directory must exist."""
    assert (_REPO_ROOT / dirname).is_dir(), f"Required directory missing: {dirname}/"


# ---------------------------------------------------------------------------
# Required root files
# ---------------------------------------------------------------------------

REQUIRED_ROOT_FILES = [
    "commands.md",
    "main.md",
    "README.md",
    "REFERENCES.md",
    "CHANGELOG.md",
    "LICENSE.md",
    "Taskfile.yml",
    "run",
    "run.bat",
]


@pytest.mark.parametrize("filename", REQUIRED_ROOT_FILES)
def test_required_root_file_exists(filename: str) -> None:
    """Each required root-level file must exist."""
    assert (_REPO_ROOT / filename).exists(), f"Required root file missing: {filename}"


# ---------------------------------------------------------------------------
# Strategy files listed in strategies/README.md
# ---------------------------------------------------------------------------

def _parse_strategy_filenames() -> list[str]:
    """Extract .md filenames from the first column of the strategies/README.md table.

    Handles both linked entries  [name.md](./name.md)
    and plain entries            name.md
    by scanning only the first pipe-delimited cell of each table row.
    """
    readme_path = _REPO_ROOT / "strategies/README.md"
    readme = readme_path.read_text(encoding="utf-8")
    seen: set[str] = set()
    result: list[str] = []
    for line in readme.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        cells = stripped.split("|")
        if len(cells) < 2:
            continue
        first_cell = cells[1].strip()
        match = re.search(r"\b([a-z][a-z0-9_-]*\.md)\b", first_cell)
        if match:
            name = match.group(1)
            if name not in seen:
                seen.add(name)
                result.append(name)
    return result


def _strategy_params() -> list:
    """Build parametrize list, attaching xfail markers for known-missing files."""
    params = []
    for name in _parse_strategy_filenames():
        rel_path = f"strategies/{name}"
        if rel_path in _XFAIL_FILES:
            params.append(
                pytest.param(
                    name,
                    marks=pytest.mark.xfail(
                        reason=(
                            f"{rel_path} referenced in README as a future strategy "
                            "but file does not yet exist — see todo.md Phase 2"
                        ),
                        strict=True,
                    ),
                )
            )
        else:
            params.append(name)  # type: ignore[arg-type]
    return params


@pytest.mark.parametrize("filename", _strategy_params())
def test_strategy_file_exists(filename: str) -> None:
    """Every strategy listed in strategies/README.md must exist on disk."""
    target = _REPO_ROOT / "strategies" / filename
    assert target.exists(), f"Strategy file missing: strategies/{filename}"


# ---------------------------------------------------------------------------
# Explicit assertions for key strategy files
# ---------------------------------------------------------------------------

def test_bdd_strategy_exists() -> None:
    """strategies/bdd.md must exist (t2.7.8, #81)."""
    assert (_REPO_ROOT / "strategies" / "bdd.md").exists(), (
        "strategies/bdd.md missing — required by t2.7.8"
    )


def test_rapid_strategy_exists() -> None:
    """strategies/rapid.md must exist (t2.8.5, roadmap)."""
    assert (_REPO_ROOT / "strategies" / "rapid.md").exists(), (
        "strategies/rapid.md missing — required by t2.8.5"
    )


def test_enterprise_strategy_exists() -> None:
    """strategies/enterprise.md must exist (t2.8.5, roadmap)."""
    assert (_REPO_ROOT / "strategies" / "enterprise.md").exists(), (
        "strategies/enterprise.md missing — required by t2.8.5"
    )


def test_getting_started_exists() -> None:
    """docs/getting-started.md must exist (t2.8.6, #112)."""
    assert (_REPO_ROOT / "docs" / "getting-started.md").exists(), (
        "docs/getting-started.md missing — required by t2.8.6"
    )
