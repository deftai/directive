"""Fixture-driven migration tests for #496 reconciliation + #499 routing.

Each sub-directory under ``tests/fixtures/migration/`` is a minimal
pre-cutover project paired with an ``expected.json`` assertion map. This
test copies the fixture into ``tmp_path``, runs ``migrate()`` over it, and
asserts the declared expectations.

The fixtures are intentionally exhaustive across the routing matrix so
regressions in the reconciliation or routing logic surface here even if a
targeted integration test goes stale.
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()
FIXTURES_ROOT = REPO_ROOT / "tests" / "fixtures" / "migration"

sys.path.insert(0, str(REPO_ROOT / "scripts"))
from migrate_vbrief import migrate  # noqa: E402


def _scenario_dirs() -> list[Path]:
    """Return every scenario directory under FIXTURES_ROOT (sorted)."""
    return sorted(p for p in FIXTURES_ROOT.iterdir() if p.is_dir())


@pytest.fixture(params=_scenario_dirs(), ids=lambda p: p.name)
def scenario(request, tmp_path: Path) -> dict:
    src: Path = request.param
    dest = tmp_path / src.name
    shutil.copytree(src, dest)

    expected_path = dest / "expected.json"
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    # Expected.json is a fixture-side helper; strip it before migration so it
    # does not end up polluting the project root the migrator inspects.
    expected_path.unlink()

    ok, actions = migrate(dest)
    assert ok, f"migrate failed for scenario {src.name}: {actions}"

    return {"project": dest, "expected": expected, "actions": actions}


def test_scenario_folder_counts(scenario):
    project: Path = scenario["project"]
    expected = scenario["expected"]
    for folder, count in expected["folder_counts"].items():
        files = list((project / "vbrief" / folder).glob("*.vbrief.json"))
        assert len(files) == count, (
            f"{expected['scenario']}: expected {count} vBRIEF(s) in "
            f"vbrief/{folder}/, got {len(files)}: "
            f"{[f.name for f in files]}"
        )


def test_scenario_statuses(scenario):
    project: Path = scenario["project"]
    expected = scenario["expected"]
    for folder, allowed_statuses in expected.get("statuses", {}).items():
        for fpath in (project / "vbrief" / folder).glob("*.vbrief.json"):
            data = json.loads(fpath.read_text(encoding="utf-8"))
            assert data["plan"]["status"] in allowed_statuses, (
                f"{expected['scenario']}: {fpath.relative_to(project)} "
                f"status {data['plan']['status']!r} not in "
                f"{allowed_statuses}"
            )


def test_scenario_reconciliation_md(scenario):
    project: Path = scenario["project"]
    expected = scenario["expected"]
    report = project / "vbrief" / "migration" / "RECONCILIATION.md"
    if expected.get("reconciliation_md"):
        assert report.exists(), (
            f"{expected['scenario']}: RECONCILIATION.md expected but missing"
        )
    else:
        assert not report.exists(), (
            f"{expected['scenario']}: RECONCILIATION.md should not exist "
            f"but was written"
        )


def test_scenario_registry_statuses(scenario):
    project: Path = scenario["project"]
    expected = scenario["expected"]
    pd_path = project / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    assert pd_path.exists()
    data = json.loads(pd_path.read_text(encoding="utf-8"))
    statuses = [item.get("status", "") for item in data["plan"]["items"]]
    if "registry_statuses" in expected:
        assert statuses == expected["registry_statuses"], (
            f"{expected['scenario']}: registry statuses differ. "
            f"expected={expected['registry_statuses']}, got={statuses}"
        )
    if "registry_statuses_include" in expected:
        for status in expected["registry_statuses_include"]:
            assert status in statuses, (
                f"{expected['scenario']}: expected registry to include "
                f"{status!r} but got {statuses}"
            )


def test_scenario_forbidden_values(scenario):
    """The #499 correction guard: no fixture's output may contain 'in_progress'."""
    project: Path = scenario["project"]
    expected = scenario["expected"]
    forbidden = expected.get("forbidden_values_in_any_file", ["in_progress"])
    for fpath in (project / "vbrief").rglob("*.vbrief.json"):
        content = fpath.read_text(encoding="utf-8")
        for value in forbidden:
            assert value not in content, (
                f"{expected['scenario']}: forbidden value {value!r} leaked into "
                f"{fpath.relative_to(project)}"
            )


def test_scenario_narrative_contains(scenario):
    project: Path = scenario["project"]
    expected = scenario["expected"]
    for folder, pairs in expected.get("narrative_contains", {}).items():
        for fpath in (project / "vbrief" / folder).glob("*.vbrief.json"):
            data = json.loads(fpath.read_text(encoding="utf-8"))
            narratives = data["plan"].get("narratives", {})
            for key, value in pairs.items():
                assert narratives.get(key) == value, (
                    f"{expected['scenario']}: {fpath.relative_to(project)} "
                    f"narrative[{key!r}] = {narratives.get(key)!r} != "
                    f"{value!r}"
                )
