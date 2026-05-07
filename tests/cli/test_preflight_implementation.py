"""Tests for scripts/preflight_implementation.py (#810).

Covers the structural implementation-intent gate's full state matrix:

- Folder x status combinations (proposed/, pending/, active/-{various}).
- Edge cases: nonexistent path, malformed JSON, top-level not-an-object,
  missing ``plan`` object, missing ``plan.status``.
- ``--json`` output schema.
- ``main()`` exit codes + stderr redirect on reject paths.
- Self-test against the #810 vBRIEF in ``vbrief/pending/`` (recursively
  appropriate: the gate MUST exit non-zero against its own scope file).

Mirrors the testing pattern in ``tests/cli/test_preflight_branch.py``
(#747): drive ``preflight_implementation.evaluate()`` directly so the
state matrix is exhaustive without disk-side flakiness, plus a small
``main()`` smoke-test layer for CLI plumbing.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PREFLIGHT_PATH = REPO_ROOT / "scripts" / "preflight_implementation.py"


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def preflight():
    return _load_module("preflight_implementation", PREFLIGHT_PATH)


def _write_vbrief(
    base: Path,
    folder: str,
    *,
    status: str | None = "running",
    include_plan: bool = True,
    raw_override: str | None = None,
    name: str = "2026-05-01-test.vbrief.json",
) -> Path:
    """Write a minimal vBRIEF to ``<base>/vbrief/<folder>/<name>``.

    Returns the resolved path.
    """
    folder_dir = base / "vbrief" / folder
    folder_dir.mkdir(parents=True, exist_ok=True)
    path = folder_dir / name
    if raw_override is not None:
        path.write_text(raw_override, encoding="utf-8")
        return path
    payload: dict[str, Any] = {
        "vBRIEFInfo": {"version": "0.6"},
    }
    if include_plan:
        plan: dict[str, Any] = {"title": "T", "items": []}
        if status is not None:
            plan["status"] = status
        payload["plan"] = plan
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# (folder, status) state matrix
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("folder", "status", "expected_code", "expected_match"),
    [
        # Only happy path:
        ("active", "running", 0, "ready for implementation"),
        # active/ with non-running statuses MUST reject.
        ("active", "blocked", 1, "plan.status is 'blocked'"),
        ("active", "completed", 1, "plan.status is 'completed'"),
        ("active", "cancelled", 1, "plan.status is 'cancelled'"),
        ("active", "approved", 1, "plan.status is 'approved'"),
        # pending/ MUST reject regardless of status (folder gate fires
        # first, so the message names the folder).
        ("pending", "pending", 1, "vBRIEF is in pending/"),
        ("pending", "approved", 1, "vBRIEF is in pending/"),
        ("pending", "running", 1, "vBRIEF is in pending/"),
        # proposed/ likewise.
        ("proposed", "draft", 1, "vBRIEF is in proposed/"),
        ("proposed", "proposed", 1, "vBRIEF is in proposed/"),
        # Terminal folders.
        ("completed", "completed", 1, "vBRIEF is in completed/"),
        ("cancelled", "cancelled", 1, "vBRIEF is in cancelled/"),
    ],
)
def test_state_matrix(
    preflight, tmp_path, folder, status, expected_code, expected_match
):
    """Every cell of the (folder, status) matrix lands on the expected exit."""
    path = _write_vbrief(tmp_path, folder, status=status)
    code, msg = preflight.evaluate(path)
    assert code == expected_code, msg
    assert expected_match in msg, (
        f"Expected '{expected_match}' in message, got: {msg}"
    )


def test_actionable_redirect_on_every_reject(preflight, tmp_path):
    """Every reject path MUST surface the canonical actionable redirect."""
    for folder, status in [
        ("pending", "pending"),
        ("proposed", "draft"),
        ("active", "blocked"),
        ("completed", "completed"),
    ]:
        path = _write_vbrief(tmp_path, folder, status=status)
        code, msg = preflight.evaluate(path)
        assert code == 1
        assert "task vbrief:activate" in msg, (
            f"Reject for ({folder}, {status}) MUST include `task vbrief:activate` redirect."
        )


# ---------------------------------------------------------------------------
# Edge cases: missing / malformed input
# ---------------------------------------------------------------------------


def test_nonexistent_path_rejects(preflight, tmp_path):
    missing = tmp_path / "vbrief" / "active" / "does-not-exist.vbrief.json"
    code, msg = preflight.evaluate(missing)
    assert code == 1
    assert "vBRIEF not found" in msg
    assert "task vbrief:activate" in msg


def test_directory_path_rejects(preflight, tmp_path):
    """Pointing at a directory (not a file) rejects with a useful message."""
    folder = tmp_path / "vbrief" / "active"
    folder.mkdir(parents=True)
    code, msg = preflight.evaluate(folder)
    assert code == 1
    assert "is not a regular file" in msg


def test_malformed_json_rejects_without_traceback(preflight, tmp_path):
    """A malformed-JSON vBRIEF MUST NOT raise; exit 1 with a useful message."""
    path = _write_vbrief(
        tmp_path, "active", raw_override="{ not json"
    )
    code, msg = preflight.evaluate(path)
    assert code == 1
    assert "is not valid JSON" in msg
    assert "task vbrief:activate" in msg


def test_top_level_not_object_rejects(preflight, tmp_path):
    path = _write_vbrief(tmp_path, "active", raw_override='["array", "not", "object"]')
    code, msg = preflight.evaluate(path)
    assert code == 1
    assert "top-level value is not a JSON object" in msg


def test_missing_plan_rejects(preflight, tmp_path):
    """A vBRIEF missing the `plan` object MUST reject with a useful message."""
    path = _write_vbrief(tmp_path, "active", include_plan=False)
    code, msg = preflight.evaluate(path)
    assert code == 1
    assert "lacks a `plan` object" in msg


def test_missing_plan_status_rejects(preflight, tmp_path):
    """A vBRIEF whose plan object lacks `status` MUST reject."""
    path = _write_vbrief(tmp_path, "active", status=None)
    code, msg = preflight.evaluate(path)
    assert code == 1
    assert "lacks `plan.status`" in msg


def test_plan_status_non_string_rejects(preflight, tmp_path):
    """A plan.status that isn't a string is treated as missing (defensive)."""
    folder_dir = tmp_path / "vbrief" / "active"
    folder_dir.mkdir(parents=True)
    path = folder_dir / "weird.vbrief.json"
    path.write_text(
        json.dumps({"plan": {"status": 42}}),
        encoding="utf-8",
    )
    code, msg = preflight.evaluate(path)
    assert code == 1
    assert "lacks `plan.status`" in msg


# ---------------------------------------------------------------------------
# main() / argparse integration
# ---------------------------------------------------------------------------


def test_main_accept_path_returns_0(preflight, tmp_path, capsys):
    path = _write_vbrief(tmp_path, "active", status="running")
    code = preflight.main(["--vbrief-path", str(path)])
    out = capsys.readouterr()
    assert code == 0
    assert "ready for implementation" in out.out
    # Reject paths land on stderr; the accept message is on stdout.
    assert out.err == ""


def test_main_reject_path_returns_1_on_stderr(preflight, tmp_path, capsys):
    path = _write_vbrief(tmp_path, "pending", status="pending")
    code = preflight.main(["--vbrief-path", str(path)])
    out = capsys.readouterr()
    assert code == 1
    # Reject messages MUST land on stderr so calling skills can chain.
    assert "vBRIEF is in pending/" in out.err
    assert "task vbrief:activate" in out.err


def test_main_missing_required_arg_exits_2(preflight, capsys):
    """argparse exits 2 when --vbrief-path is missing (CLI contract)."""
    with pytest.raises(SystemExit) as excinfo:
        preflight.main([])
    assert excinfo.value.code == 2


# ---------------------------------------------------------------------------
# --json schema
# ---------------------------------------------------------------------------


def test_json_emit_accept_schema(preflight, tmp_path, capsys):
    path = _write_vbrief(tmp_path, "active", status="running")
    code = preflight.main(["--vbrief-path", str(path), "--json"])
    out = capsys.readouterr().out.strip()
    assert code == 0
    payload = json.loads(out)
    assert payload == {
        "ready": True,
        "exit_code": 0,
        "vbrief_path": str(path),
        "message": payload["message"],  # rendered, asserted separately
    }
    assert "ready for implementation" in payload["message"]


def test_json_emit_reject_schema(preflight, tmp_path, capsys):
    path = _write_vbrief(tmp_path, "pending", status="pending")
    code = preflight.main(["--vbrief-path", str(path), "--json"])
    out = capsys.readouterr().out.strip()
    assert code == 1
    payload = json.loads(out)
    assert payload["ready"] is False
    assert payload["exit_code"] == 1
    assert payload["vbrief_path"] == str(path)
    # Multi-line message preserved (the actionable redirect is the
    # second line, joined by a real newline character).
    assert "vBRIEF is in pending/" in payload["message"]
    assert "task vbrief:activate" in payload["message"]


def test_json_keys_are_stable(preflight, tmp_path, capsys):
    """Schema is exactly ``ready``, ``exit_code``, ``vbrief_path``, ``message``."""
    path = _write_vbrief(tmp_path, "active", status="running")
    preflight.main(["--vbrief-path", str(path), "--json"])
    out = capsys.readouterr().out.strip()
    payload = json.loads(out)
    assert set(payload.keys()) == {"ready", "exit_code", "vbrief_path", "message"}


# ---------------------------------------------------------------------------
# Self-test: the #810 vBRIEF in pending/ MUST reject (recursively appropriate).
# ---------------------------------------------------------------------------


def test_self_test_against_810_vbrief_in_pending_rejects(preflight):
    """The #810 vBRIEF lives in vbrief/pending/, so the gate MUST reject it.

    This is the recursively-appropriate self-test: a vBRIEF that
    introduces the gate MUST itself fail the gate while it is in
    ``pending/``. Once #810 lands and is activated, the file moves to
    ``vbrief/active/`` with status ``running`` and this test would need
    to follow it (or be retired) -- but until then, it's a strong
    signal that the gate is wired correctly end-to-end.
    """
    candidates = list(
        (REPO_ROOT / "vbrief" / "pending").glob(
            "*-810-implementation-intent-gate-*.vbrief.json"
        )
    )
    if not candidates:
        pytest.skip(
            "#810 vBRIEF not present in vbrief/pending/ -- it has likely "
            "moved to vbrief/active/ post-activation."
        )
    code, msg = preflight.evaluate(candidates[0])
    assert code == 1, (
        f"Expected the #810 vBRIEF to fail the gate while in pending/, got: {msg}"
    )
    assert "vBRIEF is in pending/" in msg
    assert "task vbrief:activate" in msg
