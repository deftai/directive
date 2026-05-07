"""Tests for scripts/policy_set.py (#746 G1/G2)."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
POLICY_PATH = REPO_ROOT / "scripts" / "policy.py"
SET_PATH = REPO_ROOT / "scripts" / "policy_set.py"


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def policy_set_module():
    _load_module("policy", POLICY_PATH)
    return _load_module("policy_set", SET_PATH)


@pytest.fixture()
def project_root(tmp_path: Path) -> Path:
    (tmp_path / "vbrief").mkdir()
    payload = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {"title": "T", "status": "running", "items": []},
    }
    (tmp_path / "vbrief" / "PROJECT-DEFINITION.vbrief.json").write_text(
        json.dumps(payload), encoding="utf-8"
    )
    return tmp_path


def test_enforce_branches_writes_false(policy_set_module, project_root, capsys):
    rc = policy_set_module.main(
        ["enforce-branches", "--project-root", str(project_root), "--actor", "test"]
    )
    out = capsys.readouterr().out
    assert rc == 0
    assert "branch-protection ON" in out
    data = json.loads(
        (project_root / "vbrief" / "PROJECT-DEFINITION.vbrief.json").read_text(
            encoding="utf-8"
        )
    )
    assert data["plan"]["policy"]["allowDirectCommitsToMaster"] is False


def test_allow_direct_commits_without_confirm_refuses(
    policy_set_module, project_root, capsys
):
    rc = policy_set_module.main(
        ["allow-direct-commits", "--project-root", str(project_root)]
    )
    out = capsys.readouterr().out
    assert rc == 1
    assert "Capability-cost disclosure" in out
    assert "--confirm" in out


def test_allow_direct_commits_with_confirm_writes_true(
    policy_set_module, project_root, capsys
):
    rc = policy_set_module.main(
        [
            "allow-direct-commits",
            "--project-root",
            str(project_root),
            "--confirm",
            "--actor",
            "test",
            "--note",
            "solo project",
        ]
    )
    out = capsys.readouterr().out
    assert rc == 0
    assert "branch-protection OFF" in out
    data = json.loads(
        (project_root / "vbrief" / "PROJECT-DEFINITION.vbrief.json").read_text(
            encoding="utf-8"
        )
    )
    assert data["plan"]["policy"]["allowDirectCommitsToMaster"] is True
    log = (project_root / "meta" / "policy-changes.log").read_text(encoding="utf-8")
    assert "note=solo project" in log


def test_missing_project_def_returns_config_error(policy_set_module, tmp_path, capsys):
    rc = policy_set_module.main(
        ["enforce-branches", "--project-root", str(tmp_path)]
    )
    err = capsys.readouterr().err
    assert rc == 2
    assert "not found" in err
    assert "task setup" in err
