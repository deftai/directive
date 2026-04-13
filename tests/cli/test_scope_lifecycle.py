"""
test_scope_lifecycle.py -- Tests for scripts/scope_lifecycle.py.

Covers all 7 scope lifecycle transitions (promote, activate, complete,
cancel, restore, block, unblock), invalid transitions, idempotent
behavior, edge cases, and CLI entry point.

Story #324. RFC #309 decision D16.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()

# Import the module under test directly for unit tests
sys.path.insert(0, str(REPO_ROOT / "scripts"))
from scope_lifecycle import (  # noqa: E402
    LIFECYCLE_FOLDERS,
    TRANSITIONS,
    detect_lifecycle_folder,
    run_transition,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

SAMPLE_VBRIEF = {
    "vBRIEFInfo": {"version": "0.5"},
    "plan": {
        "title": "Add OAuth support",
        "status": "proposed",
        "items": [],
    },
}


def make_vbrief(
    tmp_path: Path,
    folder: str,
    status: str,
    filename: str = "2026-04-12-add-oauth.vbrief.json",
) -> Path:
    """Create a sample vBRIEF file in a lifecycle folder under tmp_path/vbrief/."""
    vbrief_root = tmp_path / "vbrief"
    folder_path = vbrief_root / folder
    folder_path.mkdir(parents=True, exist_ok=True)
    data = {
        "vBRIEFInfo": {"version": "0.5"},
        "plan": {
            "title": "Add OAuth support",
            "status": status,
            "items": [],
        },
    }
    file_path = folder_path / filename
    file_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return file_path


def read_vbrief(path: Path) -> dict:
    """Read and parse a vBRIEF file."""
    return json.loads(path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# detect_lifecycle_folder
# ---------------------------------------------------------------------------

class TestDetectLifecycleFolder:
    def test_recognized_folders(self, tmp_path):
        for folder in LIFECYCLE_FOLDERS:
            p = tmp_path / "vbrief" / folder / "test.vbrief.json"
            p.parent.mkdir(parents=True, exist_ok=True)
            assert detect_lifecycle_folder(p) == folder

    def test_unrecognized_folder(self, tmp_path):
        p = tmp_path / "vbrief" / "unknown" / "test.vbrief.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        assert detect_lifecycle_folder(p) is None


# ---------------------------------------------------------------------------
# Promote: proposed/ -> pending/
# ---------------------------------------------------------------------------

class TestPromote:
    def test_promote_success(self, tmp_path):
        f = make_vbrief(tmp_path, "proposed", "proposed")
        ok, msg = run_transition("promote", f)
        assert ok
        assert "Promoted" in msg
        assert "proposed/ -> pending/" in msg
        dest = tmp_path / "vbrief" / "pending" / f.name
        assert dest.exists()
        data = read_vbrief(dest)
        assert data["plan"]["status"] == "pending"
        assert "updated" in data["plan"]

    def test_promote_from_active_rejected(self, tmp_path):
        f = make_vbrief(tmp_path, "active", "running")
        ok, msg = run_transition("promote", f)
        assert not ok
        assert "Invalid transition" in msg
        assert "proposed" in msg


# ---------------------------------------------------------------------------
# Activate: pending/ -> active/
# ---------------------------------------------------------------------------

class TestActivate:
    def test_activate_success(self, tmp_path):
        f = make_vbrief(tmp_path, "pending", "pending")
        ok, msg = run_transition("activate", f)
        assert ok
        assert "Activated" in msg
        assert "pending/ -> active/" in msg
        dest = tmp_path / "vbrief" / "active" / f.name
        assert dest.exists()
        assert read_vbrief(dest)["plan"]["status"] == "running"

    def test_activate_from_proposed_rejected(self, tmp_path):
        f = make_vbrief(tmp_path, "proposed", "proposed")
        ok, msg = run_transition("activate", f)
        assert not ok
        assert "Invalid transition" in msg


# ---------------------------------------------------------------------------
# Complete: active/ -> completed/
# ---------------------------------------------------------------------------

class TestComplete:
    def test_complete_success(self, tmp_path):
        f = make_vbrief(tmp_path, "active", "running")
        ok, msg = run_transition("complete", f)
        assert ok
        assert "Completed" in msg
        assert "active/ -> completed/" in msg
        dest = tmp_path / "vbrief" / "completed" / f.name
        assert dest.exists()
        assert read_vbrief(dest)["plan"]["status"] == "completed"

    def test_complete_from_pending_rejected(self, tmp_path):
        f = make_vbrief(tmp_path, "pending", "pending")
        ok, msg = run_transition("complete", f)
        assert not ok
        assert "Invalid transition" in msg


# ---------------------------------------------------------------------------
# Cancel: any folder -> cancelled/
# ---------------------------------------------------------------------------

class TestCancel:
    @pytest.mark.parametrize("folder,status", [
        ("proposed", "proposed"),
        ("pending", "pending"),
        ("active", "running"),
        ("completed", "completed"),
        ("cancelled", "cancelled"),
    ])
    def test_cancel_from_any_folder(self, tmp_path, folder, status):
        f = make_vbrief(tmp_path, folder, status)
        ok, msg = run_transition("cancel", f)
        assert ok
        assert "Cancelled" in msg or "cancelled" in msg
        if folder != "cancelled":
            dest = tmp_path / "vbrief" / "cancelled" / f.name
            assert dest.exists()
            assert read_vbrief(dest)["plan"]["status"] == "cancelled"

    def test_cancel_already_cancelled_stays_in_place(self, tmp_path):
        """Cancel from cancelled/ is a valid transition (idempotent-ish)."""
        f = make_vbrief(tmp_path, "cancelled", "cancelled")
        ok, msg = run_transition("cancel", f)
        assert ok
        # File should still be in cancelled/ (target == current)
        assert f.exists() or (tmp_path / "vbrief" / "cancelled" / f.name).exists()


# ---------------------------------------------------------------------------
# Restore: cancelled/ -> proposed/
# ---------------------------------------------------------------------------

class TestRestore:
    def test_restore_success(self, tmp_path):
        f = make_vbrief(tmp_path, "cancelled", "cancelled")
        ok, msg = run_transition("restore", f)
        assert ok
        assert "Restored" in msg
        assert "cancelled/ -> proposed/" in msg
        dest = tmp_path / "vbrief" / "proposed" / f.name
        assert dest.exists()
        assert read_vbrief(dest)["plan"]["status"] == "proposed"

    def test_restore_from_active_rejected(self, tmp_path):
        f = make_vbrief(tmp_path, "active", "running")
        ok, msg = run_transition("restore", f)
        assert not ok
        assert "Invalid transition" in msg


# ---------------------------------------------------------------------------
# Block: stays in active/ (running -> blocked)
# ---------------------------------------------------------------------------

class TestBlock:
    def test_block_success(self, tmp_path):
        f = make_vbrief(tmp_path, "active", "running")
        ok, msg = run_transition("block", f)
        assert ok
        assert "Blocked" in msg
        assert "stays in active/" in msg
        assert f.exists()  # File did not move
        assert read_vbrief(f)["plan"]["status"] == "blocked"

    def test_block_already_blocked_is_noop(self, tmp_path):
        f = make_vbrief(tmp_path, "active", "blocked")
        ok, msg = run_transition("block", f)
        assert ok
        assert "No-op" in msg

    def test_block_from_pending_rejected(self, tmp_path):
        f = make_vbrief(tmp_path, "pending", "pending")
        ok, msg = run_transition("block", f)
        assert not ok
        assert "Invalid transition" in msg

    def test_block_requires_running_status(self, tmp_path):
        f = make_vbrief(tmp_path, "active", "completed")
        ok, msg = run_transition("block", f)
        assert not ok
        assert "requires status='running'" in msg


# ---------------------------------------------------------------------------
# Unblock: stays in active/ (blocked -> running)
# ---------------------------------------------------------------------------

class TestUnblock:
    def test_unblock_success(self, tmp_path):
        f = make_vbrief(tmp_path, "active", "blocked")
        ok, msg = run_transition("unblock", f)
        assert ok
        assert "Unblocked" in msg
        assert "stays in active/" in msg
        assert f.exists()
        assert read_vbrief(f)["plan"]["status"] == "running"

    def test_unblock_already_running_is_noop(self, tmp_path):
        f = make_vbrief(tmp_path, "active", "running")
        ok, msg = run_transition("unblock", f)
        assert ok
        assert "No-op" in msg

    def test_unblock_from_proposed_rejected(self, tmp_path):
        f = make_vbrief(tmp_path, "proposed", "proposed")
        ok, msg = run_transition("unblock", f)
        assert not ok
        assert "Invalid transition" in msg

    def test_unblock_requires_blocked_status(self, tmp_path):
        f = make_vbrief(tmp_path, "active", "pending")
        ok, msg = run_transition("unblock", f)
        assert not ok
        assert "requires status='blocked'" in msg


# ---------------------------------------------------------------------------
# Validation / edge cases
# ---------------------------------------------------------------------------

class TestValidation:
    def test_unknown_action(self, tmp_path):
        f = make_vbrief(tmp_path, "proposed", "proposed")
        ok, msg = run_transition("invalid_action", f)
        assert not ok
        assert "Unknown action" in msg

    def test_file_not_found(self, tmp_path):
        f = tmp_path / "vbrief" / "proposed" / "nonexistent.vbrief.json"
        ok, msg = run_transition("promote", f)
        assert not ok
        assert "File not found" in msg

    def test_not_vbrief_extension(self, tmp_path):
        bad = tmp_path / "vbrief" / "proposed" / "test.json"
        bad.parent.mkdir(parents=True, exist_ok=True)
        bad.write_text("{}", encoding="utf-8")
        ok, msg = run_transition("promote", bad)
        assert not ok
        assert "Not a vBRIEF file" in msg

    def test_file_not_in_lifecycle_folder(self, tmp_path):
        f = tmp_path / "vbrief" / "test.vbrief.json"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(SAMPLE_VBRIEF, indent=2), encoding="utf-8")
        ok, msg = run_transition("promote", f)
        assert not ok
        assert "not inside a lifecycle folder" in msg

    def test_invalid_json(self, tmp_path):
        f = tmp_path / "vbrief" / "proposed" / "bad.vbrief.json"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text("{invalid json", encoding="utf-8")
        ok, msg = run_transition("promote", f)
        assert not ok
        assert "Invalid JSON" in msg

    def test_missing_plan_object(self, tmp_path):
        f = tmp_path / "vbrief" / "proposed" / "noplan.vbrief.json"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps({"vBRIEFInfo": {"version": "0.5"}}), encoding="utf-8")
        ok, msg = run_transition("promote", f)
        assert not ok
        assert "Missing or invalid 'plan'" in msg

    def test_timestamp_updated(self, tmp_path):
        f = make_vbrief(tmp_path, "proposed", "proposed")
        run_transition("promote", f)
        dest = tmp_path / "vbrief" / "pending" / f.name
        data = read_vbrief(dest)
        ts = data["plan"]["updated"]
        # Should be a valid ISO 8601 timestamp
        assert "T" in ts
        assert ts.endswith("Z")

    def test_creates_target_folder_if_missing(self, tmp_path):
        """Target folder is created automatically if it doesn't exist."""
        vbrief_root = tmp_path / "vbrief"
        proposed = vbrief_root / "proposed"
        proposed.mkdir(parents=True)
        # Do NOT create pending/ -- the script should create it
        f = proposed / "2026-04-12-test.vbrief.json"
        f.write_text(json.dumps(SAMPLE_VBRIEF, indent=2) + "\n", encoding="utf-8")
        ok, msg = run_transition("promote", f)
        assert ok
        assert (vbrief_root / "pending" / f.name).exists()


# ---------------------------------------------------------------------------
# Full lifecycle round-trip
# ---------------------------------------------------------------------------

class TestFullLifecycle:
    def test_proposed_to_completed_round_trip(self, tmp_path):
        """Test the full happy path: proposed -> pending -> active -> completed."""
        f = make_vbrief(tmp_path, "proposed", "proposed")
        name = f.name
        vbrief_root = tmp_path / "vbrief"

        # promote
        ok, _ = run_transition("promote", f)
        assert ok
        f = vbrief_root / "pending" / name
        assert f.exists()

        # activate
        ok, _ = run_transition("activate", f)
        assert ok
        f = vbrief_root / "active" / name
        assert f.exists()

        # complete
        ok, _ = run_transition("complete", f)
        assert ok
        f = vbrief_root / "completed" / name
        assert f.exists()
        assert read_vbrief(f)["plan"]["status"] == "completed"

    def test_cancel_and_restore_round_trip(self, tmp_path):
        """Test cancel from active, then restore back to proposed."""
        f = make_vbrief(tmp_path, "active", "running")
        name = f.name
        vbrief_root = tmp_path / "vbrief"

        # cancel
        ok, _ = run_transition("cancel", f)
        assert ok
        f = vbrief_root / "cancelled" / name
        assert f.exists()

        # restore
        ok, _ = run_transition("restore", f)
        assert ok
        f = vbrief_root / "proposed" / name
        assert f.exists()
        assert read_vbrief(f)["plan"]["status"] == "proposed"

    def test_block_and_unblock_round_trip(self, tmp_path):
        """Test block then unblock within active/."""
        f = make_vbrief(tmp_path, "active", "running")

        # block
        ok, _ = run_transition("block", f)
        assert ok
        assert f.exists()
        assert read_vbrief(f)["plan"]["status"] == "blocked"

        # unblock
        ok, _ = run_transition("unblock", f)
        assert ok
        assert f.exists()
        assert read_vbrief(f)["plan"]["status"] == "running"


# ---------------------------------------------------------------------------
# CLI subprocess tests
# ---------------------------------------------------------------------------

class TestCLI:
    def test_usage_error_no_args(self):
        result = subprocess.run(
            [sys.executable, str(REPO_ROOT / "scripts" / "scope_lifecycle.py")],
            capture_output=True,
            text=True,
            timeout=15,
        )
        assert result.returncode == 2
        assert "Usage" in result.stderr

    def test_cli_promote_success(self, tmp_path):
        f = make_vbrief(tmp_path, "proposed", "proposed")
        result = subprocess.run(
            [
                sys.executable,
                str(REPO_ROOT / "scripts" / "scope_lifecycle.py"),
                "promote",
                str(f),
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        assert result.returncode == 0
        assert "Promoted" in result.stdout

    def test_cli_invalid_transition_returns_1(self, tmp_path):
        f = make_vbrief(tmp_path, "active", "running")
        result = subprocess.run(
            [
                sys.executable,
                str(REPO_ROOT / "scripts" / "scope_lifecycle.py"),
                "promote",
                str(f),
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        assert result.returncode == 1
        assert "Error" in result.stderr
