"""Tests for scripts/vbrief_migrate_conformance.py -- the #1620 Category A
idempotent vBRIEF 0.6 conformance migration.

Pins the contract that:

- plan-level ``planRef`` ``"#N"`` -> a ``x-vbrief/github-issue``
  ``references[]`` entry, deduped against an existing reference to the same
  issue.
- plan-level PATH-style ``planRef`` is LEFT UNTOUCHED (it is the load-bearing
  D4 epic<->story child->parent linkage; reconciliation deferred to #1650).
- plan-level ``#``-prefixed non-numeric ``planRef`` (stale slug) -> deleted.
- item-level ``description`` -> item-level ``narrative`` (wrapped in an object).
- item-level ``narratives`` (plural typo) -> item-level ``narrative``.
- plan-level ``narratives`` (the correct key) is LEFT UNTOUCHED.
- item-level ``planRef`` (legit core field) is LEFT UNTOUCHED.
- ``--check`` is a no-op second run (idempotency) and reports drift with exit 1.
- formatting (2-space indent + trailing newline) is preserved; an unchanged
  file is never rewritten.
- exit 2 on a missing ``vbrief/`` directory.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "vbrief_migrate_conformance.py"


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "vbrief_migrate_conformance", SCRIPT_PATH
    )
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["vbrief_migrate_conformance"] = mod
    spec.loader.exec_module(mod)
    return mod


migrate = _load_module()


def _write_vbrief(root: Path, rel: str, data: dict) -> Path:
    """Write a vBRIEF file in the migrator's canonical formatting."""
    path = root / "vbrief" / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return path


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _doc(plan: dict) -> dict:
    return {"vBRIEFInfo": {"version": "0.6"}, "plan": plan}


# --------------------------------------------------------------------------- #
# migrate_data unit behavior
# --------------------------------------------------------------------------- #


def test_planref_issue_to_new_references_entry():
    data = _doc({"id": "p", "title": "T", "status": "proposed", "items": [],
                 "planRef": "#1348"})
    changes = migrate.migrate_data(data)
    assert changes
    assert "planRef" not in data["plan"]
    refs = data["plan"]["references"]
    assert refs == [
        {
            "uri": "https://github.com/deftai/directive/issues/1348",
            "type": "x-vbrief/github-issue",
            "title": "Issue #1348",
        }
    ]


def test_planref_issue_dedupes_against_existing_reference():
    existing = {
        "uri": "https://github.com/deftai/directive/issues/1348",
        "type": "x-vbrief/github-issue",
        "title": "Issue #1348: original title",
    }
    data = _doc(
        {
            "id": "p",
            "title": "T",
            "status": "proposed",
            "items": [],
            "planRef": "#1348",
            "references": [existing],
        }
    )
    migrate.migrate_data(data)
    assert "planRef" not in data["plan"]
    # No duplicate added; the original reference is preserved verbatim.
    assert data["plan"]["references"] == [existing]


def test_planref_path_style_left_untouched():
    # A path-style plan-level planRef is the D4 epic<->story child->parent link
    # validated by scripts/vbrief_validate.py -- migrating it would break that
    # bidirectional check, so the migration deliberately leaves it (#1650).
    path_ref = "completed/2026-06-01-1387-headless-swarm-launch.vbrief.json"
    data = _doc(
        {
            "id": "p",
            "title": "T",
            "status": "completed",
            "items": [],
            "planRef": path_ref,
        }
    )
    changes = migrate.migrate_data(data)
    assert changes == []
    assert data["plan"]["planRef"] == path_ref
    assert "references" not in data["plan"]


def test_planref_hash_slug_junk_is_deleted():
    # A "#"-prefixed but non-numeric planRef carries no valid issue/path target
    # (the real references already live in references[]); it is dropped.
    data = _doc(
        {
            "id": "p",
            "title": "T",
            "status": "completed",
            "items": [],
            "planRef": "#release-narrative-gap",
            "references": [
                {
                    "uri": "https://github.com/deftai/directive/issues/730",
                    "type": "x-vbrief/github-issue",
                    "title": "Issue #730",
                }
            ],
        }
    )
    changes = migrate.migrate_data(data)
    assert changes
    assert "planRef" not in data["plan"]
    # The pre-existing references[] is preserved verbatim (no junk reference).
    assert data["plan"]["references"] == [
        {
            "uri": "https://github.com/deftai/directive/issues/730",
            "type": "x-vbrief/github-issue",
            "title": "Issue #730",
        }
    ]


def test_item_description_string_to_narrative_object():
    data = _doc(
        {
            "id": "p",
            "title": "T",
            "status": "proposed",
            "items": [
                {"title": "i", "status": "pending", "description": "do the thing"}
            ],
        }
    )
    migrate.migrate_data(data)
    item = data["plan"]["items"][0]
    assert "description" not in item
    assert item["narrative"] == {"Description": "do the thing"}


def test_item_description_folds_into_existing_narrative():
    data = _doc(
        {
            "id": "p",
            "title": "T",
            "status": "proposed",
            "items": [
                {
                    "title": "i",
                    "status": "pending",
                    "narrative": {"Acceptance": "ac"},
                    "description": "extra prose",
                }
            ],
        }
    )
    migrate.migrate_data(data)
    item = data["plan"]["items"][0]
    assert "description" not in item
    # Existing narrative key preserved; description folded under "Description".
    assert item["narrative"] == {"Acceptance": "ac", "Description": "extra prose"}


def test_item_narratives_plural_to_narrative():
    data = _doc(
        {
            "id": "p",
            "title": "T",
            "status": "completed",
            "items": [
                {
                    "title": "i",
                    "status": "completed",
                    "narratives": {"Action": "did the thing"},
                }
            ],
        }
    )
    migrate.migrate_data(data)
    item = data["plan"]["items"][0]
    assert "narratives" not in item
    assert item["narrative"] == {"Action": "did the thing"}


def test_plan_level_narratives_left_untouched():
    plan_narratives = {"Description": "plan desc", "UserStory": "us"}
    data = _doc(
        {
            "id": "p",
            "title": "T",
            "status": "proposed",
            "narratives": plan_narratives,
            "items": [{"title": "i", "status": "pending", "narrative": {"A": "b"}}],
        }
    )
    changes = migrate.migrate_data(data)
    assert changes == []
    assert data["plan"]["narratives"] == plan_narratives


def test_item_level_planref_left_untouched():
    data = _doc(
        {
            "id": "p",
            "title": "T",
            "status": "proposed",
            "items": [
                {"title": "i", "status": "pending", "planRef": "#42",
                 "narrative": {"A": "b"}}
            ],
        }
    )
    changes = migrate.migrate_data(data)
    assert changes == []
    assert data["plan"]["items"][0]["planRef"] == "#42"


def test_nested_items_are_migrated():
    data = _doc(
        {
            "id": "p",
            "title": "T",
            "status": "proposed",
            "items": [
                {
                    "title": "parent",
                    "status": "pending",
                    "items": [
                        {"title": "child", "status": "pending",
                         "description": "child prose"}
                    ],
                }
            ],
        }
    )
    migrate.migrate_data(data)
    child = data["plan"]["items"][0]["items"][0]
    assert "description" not in child
    assert child["narrative"] == {"Description": "child prose"}


# --------------------------------------------------------------------------- #
# evaluate() filesystem + CLI behavior
# --------------------------------------------------------------------------- #


def test_evaluate_writes_and_is_idempotent(tmp_path):
    _write_vbrief(
        tmp_path,
        "proposed/x.vbrief.json",
        _doc({"id": "p", "title": "T", "status": "proposed", "items": [],
              "planRef": "#7"}),
    )
    code, per_file, _msg = migrate.evaluate(tmp_path, check=False)
    assert code == 0
    assert len(per_file) == 1

    # Second --check run is a no-op (idempotency): exit 0, nothing to change.
    code2, per_file2, _msg2 = migrate.evaluate(tmp_path, check=True)
    assert code2 == 0
    assert per_file2 == []


def test_check_reports_drift_with_exit_1(tmp_path):
    _write_vbrief(
        tmp_path,
        "proposed/x.vbrief.json",
        _doc({"id": "p", "title": "T", "status": "proposed", "items": [],
              "planRef": "#7"}),
    )
    code, per_file, _msg = migrate.evaluate(tmp_path, check=True)
    assert code == 1
    assert len(per_file) == 1
    # --check must not mutate the file on disk.
    on_disk = _read(tmp_path / "vbrief" / "proposed" / "x.vbrief.json")
    assert on_disk["plan"]["planRef"] == "#7"


def test_unchanged_file_is_not_rewritten(tmp_path):
    path = _write_vbrief(
        tmp_path,
        "proposed/clean.vbrief.json",
        _doc({"id": "p", "title": "T", "status": "proposed", "items": [],
              "narratives": {"Description": "d"}}),
    )
    before = path.read_bytes()
    code, per_file, _msg = migrate.evaluate(tmp_path, check=False)
    assert code == 0
    assert per_file == []
    assert path.read_bytes() == before


def test_formatting_preserved_after_write(tmp_path):
    path = _write_vbrief(
        tmp_path,
        "proposed/x.vbrief.json",
        _doc({"id": "p", "title": "T", "status": "proposed", "items": [],
              "planRef": "#7"}),
    )
    migrate.evaluate(tmp_path, check=False)
    text = path.read_text(encoding="utf-8")
    assert text.endswith("}\n")
    assert '\n  "plan"' in text  # 2-space indent at top level


def test_missing_vbrief_dir_is_config_error(tmp_path):
    code, _per_file, msg = migrate.evaluate(tmp_path, check=False)
    assert code == 2
    assert "no vbrief/ directory" in msg


def test_main_check_exit_codes(tmp_path):
    _write_vbrief(
        tmp_path,
        "proposed/x.vbrief.json",
        _doc({"id": "p", "title": "T", "status": "proposed", "items": [],
              "planRef": "#7"}),
    )
    assert migrate.main(["--check", "--project-root", str(tmp_path)]) == 1
    assert migrate.main(["--project-root", str(tmp_path)]) == 0
    assert migrate.main(["--check", "--project-root", str(tmp_path)]) == 0
