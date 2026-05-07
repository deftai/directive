"""
test_scope_lifecycle.py -- Tests for scripts/scope_lifecycle.py.

Covers all 7 scope lifecycle transitions (promote, activate, complete,
cancel, restore, block, unblock), invalid transitions, idempotent
behavior, edge cases, and CLI entry point.

Story #324. RFC #309 decision D16.
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()

# Import the module under test directly for unit tests
sys.path.insert(0, str(REPO_ROOT / "scripts"))
from scope_lifecycle import (  # noqa: E402, I001
    LIFECYCLE_FOLDERS,
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
# Fail: active/ -> completed/ (status: failed) -- #614
# ---------------------------------------------------------------------------

class TestFail:
    """Tests for the ``fail`` terminal transition (#614).

    ``fail`` parallels ``complete`` on folder movement (both move
    active/ -> completed/) but stamps ``plan.status = "failed"`` instead
    of ``"completed"``.  The semantic distinction from ``cancel`` is
    deliberate: ``cancel`` records a decision (scope no longer wanted,
    superseded, obsolete -> moves to cancelled/), ``fail`` records an
    attempt that could not be completed (external blocker, infeasibility,
    deadline) -> moves to completed/.  Collapsing the two would lose this
    information, per issue #614.
    """

    def test_fail_success(self, tmp_path):
        f = make_vbrief(tmp_path, "active", "running")
        ok, msg = run_transition("fail", f)
        assert ok
        assert "Failed" in msg
        assert "active/ -> completed/" in msg
        dest = tmp_path / "vbrief" / "completed" / f.name
        assert dest.exists()
        data = read_vbrief(dest)
        # The resulting status MUST be "failed" -- distinct from
        # "completed" (scope:complete) and "cancelled" (scope:cancel).
        assert data["plan"]["status"] == "failed"
        assert data["plan"]["status"] != "completed"
        assert data["plan"]["status"] != "cancelled"

    def test_fail_updates_timestamp(self, tmp_path):
        f = make_vbrief(tmp_path, "active", "running")
        run_transition("fail", f)
        dest = tmp_path / "vbrief" / "completed" / f.name
        data = read_vbrief(dest)
        ts = data["plan"]["updated"]
        # ISO 8601 UTC timestamp (mirrors TestValidation::test_timestamp_updated).
        assert "T" in ts
        assert ts.endswith("Z")

    def test_fail_from_blocked_status_is_accepted(self, tmp_path):
        """A blocked active scope can also fail -- matches complete's
        contract, which does not gate on ``plan.status`` (only the source
        folder), so an external blocker that proved unrecoverable does
        not first require an unblock round-trip.
        """
        f = make_vbrief(tmp_path, "active", "blocked")
        ok, msg = run_transition("fail", f)
        assert ok
        dest = tmp_path / "vbrief" / "completed" / f.name
        assert dest.exists()
        assert read_vbrief(dest)["plan"]["status"] == "failed"

    @pytest.mark.parametrize("folder,status", [
        ("proposed", "proposed"),
        ("pending", "pending"),
        ("completed", "completed"),
        ("cancelled", "cancelled"),
    ])
    def test_fail_outside_active_is_rejected(self, tmp_path, folder, status):
        """``scope:fail`` on a vBRIEF outside ``active/`` is rejected --
        same contract as the other transitions (see #614 Fix section).
        The error message identifies the required source folder so the
        user knows how to recover.
        """
        f = make_vbrief(tmp_path, folder, status)
        ok, msg = run_transition("fail", f)
        assert not ok
        assert "Invalid transition" in msg
        assert "active/" in msg

    def test_fail_idempotent_same_folder_noop(self, tmp_path):
        """Calling ``fail`` on a vBRIEF already in ``completed/`` is
        rejected because the allowed source is strictly ``active/`` --
        the completed-folder idempotency path in run_transition applies
        to actions whose target folder matches the current folder, which
        cannot arise for ``fail`` without the file already being in
        ``completed/``.  This test locks the rejection shape.
        """
        f = make_vbrief(tmp_path, "completed", "completed")
        ok, msg = run_transition("fail", f)
        assert not ok
        assert "Invalid transition" in msg

    def test_fail_failed_status_is_schema_valid(self, tmp_path):
        """The resulting vBRIEF (with plan.status == "failed") must pass
        the canonical v0.6 schema validator in
        scripts/vbrief_validate.py -- ``failed`` is already in the v0.6
        Status enum (vbrief/schemas/vbrief-core.schema.json:367) and the
        validator's FOLDER_ALLOWED_STATUSES maps ``completed/`` to
        ``{completed, failed}`` (#614).
        """
        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "vbrief_validate", REPO_ROOT / "scripts" / "vbrief_validate.py"
        )
        module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
        spec.loader.exec_module(module)  # type: ignore[union-attr]

        # Sanity: failed IS in the v0.6 Status enum.
        assert "failed" in module.VALID_STATUSES
        # Sanity: completed/ accepts both completed and failed.
        assert "failed" in module.FOLDER_ALLOWED_STATUSES["completed"]

        # Perform the transition and run the schema validator over the
        # resulting document.
        f = make_vbrief(tmp_path, "active", "running")
        ok, _ = run_transition("fail", f)
        assert ok
        dest = tmp_path / "vbrief" / "completed" / f.name
        data = read_vbrief(dest)
        # We inject the required vBRIEFInfo.version so the fixture
        # satisfies the strict 0.6-only acceptance rule (#533); the
        # lifecycle transition does not touch the envelope.
        data["vBRIEFInfo"] = {"version": "0.6"}
        errors = module.validate_vbrief_schema(data, str(dest))
        assert errors == [], f"Schema validation errors: {errors}"


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

    def test_cancel_already_cancelled_is_noop(self, tmp_path):
        """Cancel from cancelled/ is idempotent — no-op, no timestamp mutation."""
        f = make_vbrief(tmp_path, "cancelled", "cancelled")
        ok, msg = run_transition("cancel", f)
        assert ok
        assert "No-op" in msg
        assert f.exists()


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
        # argparse emits a lowercase "usage: " prefix; previous hand-rolled
        # parser used "Usage:". Accept either so future parser swaps are
        # backward compatible.
        assert "usage" in result.stderr.lower()

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
