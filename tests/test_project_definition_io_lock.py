"""#1311 regressions: the PROJECT-DEFINITION mutation lock must not leak its
sidecar ``vbrief/PROJECT-DEFINITION.vbrief.json.lock`` file.

The lock file was created on acquisition but never removed, so a clean
``task project:render`` / triage mutation left an untracked 1-byte file in
``vbrief/`` that ``git add -A`` trapped on the next chore commit. These tests
pin the deterministic gate: after the mutation-lock context exits -- on the
happy path AND on an exception -- no ``.lock`` file remains.
"""
# ruff: noqa: E402

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO_ROOT / "scripts"))

from _project_definition_io import project_definition_mutation_lock


def _lock_path(project_root: Path) -> Path:
    return project_root / "vbrief" / "PROJECT-DEFINITION.vbrief.json.lock"


def test_mutation_lock_removes_sidecar_on_clean_exit(tmp_path: Path) -> None:
    """A successful critical section leaves NO .lock behind (#1311)."""
    with project_definition_mutation_lock(tmp_path):
        # The lock is held here; the sidecar exists while acquired.
        assert _lock_path(tmp_path).exists()

    assert not _lock_path(tmp_path).exists(), (
        "PROJECT-DEFINITION.vbrief.json.lock leaked after a clean mutation "
        "(git add -A would trap it) -- see #1311"
    )


def test_mutation_lock_removes_sidecar_on_exception(tmp_path: Path) -> None:
    """An exception inside the critical section still cleans up the lock."""
    with pytest.raises(RuntimeError), project_definition_mutation_lock(tmp_path):
        raise RuntimeError("boom")

    assert not _lock_path(tmp_path).exists(), (
        "lock sidecar leaked after the critical section raised -- cleanup "
        "must run in a finally (#1311)"
    )


def test_no_lock_files_remain_under_vbrief(tmp_path: Path) -> None:
    """Defensive: no ``*.lock`` artefact survives a mutation cycle."""
    with project_definition_mutation_lock(tmp_path):
        pass

    leaked = list((tmp_path / "vbrief").glob("*.lock"))
    assert leaked == [], f"unexpected leaked lock files under vbrief/: {leaked}"
