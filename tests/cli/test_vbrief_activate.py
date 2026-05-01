"""Tests for scripts/vbrief_activate.py (#810).

Covers the lifecycle move pending/ -> active/:

- Happy path: status flip + atomic move + vBRIEFInfo.updated stamp.
- Idempotent no-op when the vBRIEF is already active+running.
- Reject paths: nonexistent file, malformed JSON, missing plan/status,
  source folder outside the allow-list, ineligible source status.
- Atomic-move durability: source file is removed only after the
  destination is in place; collision detection.

Forward-coverage companion to ``scripts/vbrief_activate.py``, satisfying
the AGENTS.md rule for new ``scripts/`` source files.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
ACTIVATE_PATH = REPO_ROOT / "scripts" / "vbrief_activate.py"


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def activator():
    return _load_module("vbrief_activate", ACTIVATE_PATH)


def _write(
    base: Path,
    folder: str,
    *,
    status: str = "pending",
    name: str = "2026-05-01-test.vbrief.json",
    raw_override: str | None = None,
    payload_override: dict[str, Any] | None = None,
) -> Path:
    folder_dir = base / "vbrief" / folder
    folder_dir.mkdir(parents=True, exist_ok=True)
    path = folder_dir / name
    if raw_override is not None:
        path.write_text(raw_override, encoding="utf-8")
        return path
    if payload_override is not None:
        path.write_text(json.dumps(payload_override), encoding="utf-8")
        return path
    payload = {
        "vBRIEFInfo": {"version": "0.6", "updated": "2026-04-30T00:00:00Z"},
        "plan": {"title": "T", "status": status, "items": []},
    }
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Happy path + idempotency
# ---------------------------------------------------------------------------


def test_pending_to_active_flips_status_and_moves(activator, tmp_path):
    src = _write(tmp_path, "pending", status="pending")
    code, msg = activator.activate(src)

    assert code == 0
    assert "Activated" in msg

    dest = tmp_path / "vbrief" / "active" / src.name
    assert dest.exists(), "Destination file must exist after activate"
    assert not src.exists(), "Source file must be removed after atomic move"

    payload = json.loads(dest.read_text(encoding="utf-8"))
    assert payload["plan"]["status"] == "running"
    # updated stamp moves forward.
    assert payload["vBRIEFInfo"]["updated"] != "2026-04-30T00:00:00Z"
    # ISO-8601 UTC with Z suffix.
    assert payload["vBRIEFInfo"]["updated"].endswith("Z")


def test_approved_status_also_flips_to_running(activator, tmp_path):
    src = _write(tmp_path, "pending", status="approved")
    code, msg = activator.activate(src)
    assert code == 0
    dest = tmp_path / "vbrief" / "active" / src.name
    payload = json.loads(dest.read_text(encoding="utf-8"))
    assert payload["plan"]["status"] == "running"


def test_already_active_is_idempotent_noop(activator, tmp_path):
    """Re-running activate against an already-active vBRIEF MUST exit 0."""
    src = _write(tmp_path, "active", status="running")
    code, msg = activator.activate(src)
    assert code == 0
    assert "No-op" in msg
    # Source unchanged.
    assert src.exists()


# ---------------------------------------------------------------------------
# Reject paths
# ---------------------------------------------------------------------------


def test_proposed_folder_rejects(activator, tmp_path):
    src = _write(tmp_path, "proposed", status="proposed")
    code, msg = activator.activate(src)
    assert code == 1
    assert "only pending/ vBRIEFs can be activated" in msg
    assert src.exists(), "Source must remain on reject"


def test_completed_folder_rejects(activator, tmp_path):
    src = _write(tmp_path, "completed", status="completed")
    code, msg = activator.activate(src)
    assert code == 1
    assert "only pending/ vBRIEFs can be activated" in msg


def test_active_folder_with_blocked_status_rejects(activator, tmp_path):
    src = _write(tmp_path, "active", status="blocked")
    code, msg = activator.activate(src)
    assert code == 1
    assert "task scope:unblock" in msg


def test_pending_folder_ineligible_status_rejects(activator, tmp_path):
    """A pending/ vBRIEF with a non-eligible status MUST reject."""
    src = _write(tmp_path, "pending", status="draft")
    code, msg = activator.activate(src)
    assert code == 1
    assert "only ['approved', 'pending']" in msg


def test_nonexistent_path_rejects(activator, tmp_path):
    code, msg = activator.activate(tmp_path / "does-not-exist.vbrief.json")
    assert code == 1
    assert "vBRIEF not found" in msg


def test_malformed_json_rejects_without_traceback(activator, tmp_path):
    src = _write(tmp_path, "pending", raw_override="{ not json")
    code, msg = activator.activate(src)
    assert code == 1
    assert "is not valid JSON" in msg


def test_missing_plan_rejects(activator, tmp_path):
    src = _write(tmp_path, "pending", payload_override={"vBRIEFInfo": {"version": "0.6"}})
    code, msg = activator.activate(src)
    assert code == 1
    assert "lacks a `plan` object" in msg


def test_missing_plan_status_rejects(activator, tmp_path):
    src = _write(
        tmp_path,
        "pending",
        payload_override={"vBRIEFInfo": {"version": "0.6"}, "plan": {"title": "T"}},
    )
    code, msg = activator.activate(src)
    assert code == 1
    assert "lacks `plan.status`" in msg


def test_destination_collision_rejects_without_clobber(activator, tmp_path):
    """If the destination already exists, refuse and keep the source."""
    src = _write(tmp_path, "pending", status="pending")
    # Create a colliding file in active/.
    active_dir = tmp_path / "vbrief" / "active"
    active_dir.mkdir(parents=True, exist_ok=True)
    (active_dir / src.name).write_text("{}", encoding="utf-8")

    code, msg = activator.activate(src)
    assert code == 1
    assert "Refusing to overwrite" in msg
    assert src.exists(), "Source must remain on collision"


# ---------------------------------------------------------------------------
# CLI plumbing
# ---------------------------------------------------------------------------


def test_main_accept_path_returns_0_on_stdout(activator, tmp_path, capsys):
    src = _write(tmp_path, "pending", status="pending")
    code = activator.main([str(src)])
    out = capsys.readouterr()
    assert code == 0
    assert "Activated" in out.out


def test_main_reject_path_returns_1_on_stderr(activator, tmp_path, capsys):
    src = _write(tmp_path, "completed", status="completed")
    code = activator.main([str(src)])
    out = capsys.readouterr()
    assert code == 1
    assert "only pending/ vBRIEFs can be activated" in out.err
