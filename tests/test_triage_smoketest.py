"""tests/test_triage_smoketest.py -- pytest wrapper for the N6 smoketest (#1146).

Runs ``scripts/triage_smoketest.py`` end-to-end against the committed
fixture under ``tests/fixtures/triage_smoketest/`` and asserts exit 0,
plus a sanity check on the JSON assert log that the script writes back
to ``tests/fixtures/triage_smoketest/last_run.json``.

The smoketest itself walks the 9-stage lifecycle (see the script
docstring); this wrapper exists so ``task check`` exercises the
smoketest on every CI run. It is marked ``@pytest.mark.slow`` because
the full lifecycle takes ~30s wall-clock under the worst-case stage-3
subprocess pair (queue x2 for determinism). Slow tests are excluded
from the default ``task check`` (#975 convention) but are picked up by
``task check:slow`` and CI.

Refs:

* Umbrella: #1119
* This deliverable: #1146 (N6)
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent
_SCRIPT = _REPO_ROOT / "scripts" / "triage_smoketest.py"
_FIXTURE = _REPO_ROOT / "tests" / "fixtures" / "triage_smoketest"


@pytest.mark.slow
def test_triage_smoketest_exits_zero_against_committed_fixture(
    tmp_path: Path,
) -> None:
    """``task triage:smoketest`` against the committed fixture exits 0.

    The driver writes its own assert log to
    ``tests/fixtures/triage_smoketest/last_run.json``; we copy the
    fixture into ``tmp_path`` first so the test does not mutate the
    on-disk last_run.json under the committed fixture tree.
    """
    # Materialise an isolated copy of the fixture so the smoketest's
    # last_run.json output never lands in the committed tree under CI.
    isolated = tmp_path / "fixture"
    isolated.mkdir()
    for src in _FIXTURE.iterdir():
        if src.name == "last_run.json":
            continue  # runtime artefact -- never copied
        dst = isolated / src.name
        if src.is_dir():
            _copytree(src, dst)
        else:
            dst.write_bytes(src.read_bytes())

    proc = subprocess.run(  # noqa: S603 -- known script, controlled args
        [sys.executable, str(_SCRIPT), "--fixture", str(isolated), "--verbose"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    assert proc.returncode == 0, (
        f"triage_smoketest exited {proc.returncode}.\n"
        f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}"
    )

    last_run = isolated / "last_run.json"
    assert last_run.is_file(), "last_run.json was not written"
    payload = json.loads(last_run.read_text(encoding="utf-8"))
    assert payload["exit_code"] == 0
    assert payload["stage_count"] == 9
    records = payload["records"]
    # Every stage either PASSed or was a graceful SKIP (D15 #1134 / D18
    # #1136 dependencies; either is acceptable on a green run).
    statuses = {r["stage"]: r["status"] for r in records}
    for stage in range(1, 10):
        assert statuses.get(stage) in {"PASS", "SKIP"}, (
            f"stage {stage} did not pass or skip: status={statuses.get(stage)!r}"
        )


def _copytree(src: Path, dst: Path) -> None:
    """Tiny shutil.copytree replacement -- avoids the ``dirs_exist_ok`` flag."""
    dst.mkdir(parents=True, exist_ok=True)
    for child in src.iterdir():
        if child.is_dir():
            _copytree(child, dst / child.name)
        else:
            (dst / child.name).write_bytes(child.read_bytes())
