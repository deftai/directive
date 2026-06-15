"""Tests for scripts/verify_vbrief_conformance.py -- the #1620 deterministic
vBRIEF 0.6 conformance gate.

Pins the contract that:

- A conformant corpus exits 0.
- A planted bare key at document / plan / item level exits 1 with the offending
  path reported.
- The TEMPORARY Category B allow-list keeps ``plan.policy`` / ``plan.completedNote``
  green.
- ``x-directive/`` and ``x-vbrief/`` namespaced keys are accepted at any level.
- ``metadata`` is an arbitrary bag and is NOT descended into.
- ``--allow-list`` (file-glob override) skips matching files.
- Three-state exit: 0 clean / 1 violations / 2 config error (missing vbrief/).

Strategy mirrors tests/cli/test_verify_encoding.py: build synthetic git repos
via ``git init`` + ``git add`` in ``tmp_path`` for the ``--all`` / ``--staged``
modes, and drive ``evaluate()`` directly for the state matrix.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "verify_vbrief_conformance.py"


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "verify_vbrief_conformance", SCRIPT_PATH
    )
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["verify_vbrief_conformance"] = mod
    spec.loader.exec_module(mod)
    return mod


gate = _load_module()


def _init_git_repo(root: Path) -> None:
    subprocess.run(
        ["git", "init", "--quiet", "--initial-branch=main", str(root)], check=True
    )
    subprocess.run(
        ["git", "-C", str(root), "config", "user.email", "test@example.com"],
        check=True,
    )
    subprocess.run(["git", "-C", str(root), "config", "user.name", "Test"], check=True)
    subprocess.run(
        ["git", "-C", str(root), "config", "commit.gpgsign", "false"], check=True
    )


def _git_add(root: Path, *rel_paths: str) -> None:
    subprocess.run(["git", "-C", str(root), "add", *rel_paths], check=True)


def _write_vbrief(root: Path, rel: str, plan: dict) -> Path:
    path = root / "vbrief" / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = {"vBRIEFInfo": {"version": "0.6"}, "plan": plan}
    path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def _conformant_plan() -> dict:
    return {
        "id": "p",
        "title": "T",
        "status": "proposed",
        "narratives": {"Description": "d"},
        "items": [
            {
                "title": "i",
                "status": "pending",
                "narrative": {"Acceptance": "ac"},
                "planRef": "#42",
            }
        ],
        "metadata": {"kind": "story", "anything_goes_here": True},
        "references": [
            {
                "uri": "https://github.com/deftai/directive/issues/1",
                "type": "x-vbrief/github-issue",
                "title": "Issue #1",
            }
        ],
    }


def _setup_repo(tmp_path: Path, plan: dict, rel: str = "active/x.vbrief.json") -> Path:
    root = tmp_path / "proj"
    root.mkdir()
    _init_git_repo(root)
    _write_vbrief(root, rel, plan)
    _git_add(root, "vbrief")
    return root


# --------------------------------------------------------------------------- #
# Clean / violation matrix
# --------------------------------------------------------------------------- #


def test_clean_corpus_exits_0(tmp_path):
    root = _setup_repo(tmp_path, _conformant_plan())
    code, findings, _msg = gate.evaluate(root, mode="all")
    assert code == 0
    assert findings == []


def test_bare_document_level_key_exits_1(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    _init_git_repo(root)
    path = root / "vbrief" / "active" / "x.vbrief.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": _conformant_plan(),
        "bogusRoot": "nope",
    }
    path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    _git_add(root, "vbrief")
    code, findings, msg = gate.evaluate(root, mode="all")
    assert code == 1
    assert any(f.level == "document" and f.key == "bogusRoot" for f in findings)
    assert "x.vbrief.json" in msg


def test_bare_plan_level_key_exits_1(tmp_path):
    plan = _conformant_plan()
    plan["bogusPlanKey"] = "nope"
    root = _setup_repo(tmp_path, plan)
    code, findings, _msg = gate.evaluate(root, mode="all")
    assert code == 1
    assert any(f.level == "plan" and f.key == "bogusPlanKey" for f in findings)


def test_bare_item_level_key_exits_1(tmp_path):
    plan = _conformant_plan()
    plan["items"][0]["description"] = "bare item prose"
    root = _setup_repo(tmp_path, plan)
    code, findings, _msg = gate.evaluate(root, mode="all")
    assert code == 1
    assert any(f.level == "item" and f.key == "description" for f in findings)


def test_nested_item_bare_key_exits_1(tmp_path):
    plan = _conformant_plan()
    plan["items"][0]["items"] = [
        {"title": "child", "status": "pending", "narratives": {"Action": "a"}}
    ]
    root = _setup_repo(tmp_path, plan)
    code, findings, _msg = gate.evaluate(root, mode="all")
    assert code == 1
    assert any(f.level == "item" and f.key == "narratives" for f in findings)


def test_plan_level_path_planref_allowed(tmp_path):
    # Path-style plan-level planRef is the load-bearing D4 epic<->story linkage;
    # the gate allows it (TEMPORARY carve-out, #1650) so vbrief:validate keeps
    # working.
    plan = _conformant_plan()
    plan["planRef"] = "completed/2026-06-01-1387-headless-swarm-launch.vbrief.json"
    root = _setup_repo(tmp_path, plan)
    code, findings, _msg = gate.evaluate(root, mode="all")
    assert code == 0, [f.render() for f in findings]


def test_plan_level_issue_planref_flagged(tmp_path):
    # A "#"-prefixed plan-level planRef is the misused issue-pointer pattern
    # behind the statusreport #34 false-RED -- it MUST be flagged.
    plan = _conformant_plan()
    plan["planRef"] = "#1348"
    root = _setup_repo(tmp_path, plan)
    code, findings, _msg = gate.evaluate(root, mode="all")
    assert code == 1
    assert any(f.level == "plan" and f.key == "planRef" for f in findings)


# --------------------------------------------------------------------------- #
# Allow-lists + namespacing
# --------------------------------------------------------------------------- #


def test_category_b_allow_list_keeps_policy_green(tmp_path):
    plan = _conformant_plan()
    plan["policy"] = {"wipCap": 10}
    plan["completedNote"] = "closed via PR #1"
    root = _setup_repo(tmp_path, plan)
    code, findings, _msg = gate.evaluate(root, mode="all")
    assert code == 0, [f.render() for f in findings]


def test_x_namespaced_keys_accepted(tmp_path):
    plan = _conformant_plan()
    plan["x-directive/policy"] = {"wipCap": 10}
    plan["x-vbrief/whatever"] = "ok"
    plan["items"][0]["x-directive/itemExt"] = "ok"
    root = _setup_repo(tmp_path, plan)
    code, findings, _msg = gate.evaluate(root, mode="all")
    assert code == 0, [f.render() for f in findings]


def test_metadata_bag_not_descended(tmp_path):
    plan = _conformant_plan()
    plan["metadata"]["nonCoreLookingKey"] = {"deeplyNested": "fine"}
    plan["items"][0]["metadata"] = {"alsoBareLooking": True}
    root = _setup_repo(tmp_path, plan)
    code, findings, _msg = gate.evaluate(root, mode="all")
    assert code == 0, [f.render() for f in findings]


def test_allow_list_file_glob_override(tmp_path):
    plan = _conformant_plan()
    plan["bogusPlanKey"] = "nope"
    root = _setup_repo(tmp_path, plan, rel="active/skipme.vbrief.json")
    allow = root / "allow.txt"
    allow.write_text("# documented exception\nvbrief/active/skipme.vbrief.json\n",
                     encoding="utf-8")
    code, findings, _msg = gate.evaluate(root, mode="all", allow_list_path=allow)
    assert code == 0, [f.render() for f in findings]


def test_staged_mode_only_scans_staged(tmp_path):
    plan = _conformant_plan()
    root = _setup_repo(tmp_path, plan)
    # Commit the clean baseline so it is tracked but not staged.
    subprocess.run(["git", "-C", str(root), "commit", "--quiet", "-m", "init"],
                   check=True)
    # Add a NEW staged file with a bare key.
    bad = _conformant_plan()
    bad["bogusPlanKey"] = "nope"
    _write_vbrief(root, "active/staged.vbrief.json", bad)
    _git_add(root, "vbrief/active/staged.vbrief.json")
    code, findings, _msg = gate.evaluate(root, mode="staged")
    assert code == 1
    assert all("staged.vbrief.json" in f.path for f in findings)


# --------------------------------------------------------------------------- #
# Config errors + CLI
# --------------------------------------------------------------------------- #


def test_missing_vbrief_dir_is_config_error(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    _init_git_repo(root)
    code, _findings, msg = gate.evaluate(root, mode="all")
    assert code == 2
    assert "no vbrief/ directory" in msg


def test_unreadable_allow_list_is_config_error(tmp_path):
    root = _setup_repo(tmp_path, _conformant_plan())
    code, _findings, _msg = gate.evaluate(
        root, mode="all", allow_list_path=root / "does-not-exist.txt"
    )
    assert code == 2


def test_main_exit_codes(tmp_path):
    root = _setup_repo(tmp_path, _conformant_plan())
    assert gate.main(["--project-root", str(root), "--all"]) == 0
    plan = _conformant_plan()
    plan["bogusPlanKey"] = "x"
    _write_vbrief(root, "active/bad.vbrief.json", plan)
    _git_add(root, "vbrief/active/bad.vbrief.json")
    assert gate.main(["--project-root", str(root), "--all"]) == 1
