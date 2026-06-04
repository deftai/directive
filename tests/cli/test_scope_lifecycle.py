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
    update_decomposed_child_back_references,
    update_decomposed_parent_back_references,
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


PARENT_NAME = "2026-06-03-parent-epic.vbrief.json"
CHILD_NAME = "2026-06-03-child-story.vbrief.json"


def make_decomposed_pair(
    tmp_path: Path,
    *,
    parent_folder: str = "active",
    parent_status: str = "running",
    child_folder: str = "pending",
    child_status: str = "pending",
    child_ref_uri: str | None = None,
) -> tuple[Path, Path]:
    """Create a schema-valid parent epic + decomposed child pair.

    Mirrors the shape ``scripts/scope_decompose.py`` produces: the parent
    lists the child via an ``x-vbrief/plan`` reference whose ``uri`` is the
    child's current lifecycle path (relative to vbrief/), and the child
    carries a plan-level ``planRef`` back to the parent. Returns
    ``(parent_path, child_path)``.
    """
    vbrief_root = tmp_path / "vbrief"
    for folder in LIFECYCLE_FOLDERS:
        (vbrief_root / folder).mkdir(parents=True, exist_ok=True)

    parent_rel = f"{parent_folder}/{PARENT_NAME}"
    if child_ref_uri is None:
        child_ref_uri = f"{child_folder}/{CHILD_NAME}"

    origin_ref = {
        "uri": "https://github.com/deftai/directive/issues/1485",
        "type": "x-vbrief/github-issue",
        "title": "Issue #1485",
    }
    parent = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "title": "Parent epic",
            "status": parent_status,
            "items": [],
            "metadata": {"kind": "epic"},
            "references": [
                origin_ref,
                {"uri": child_ref_uri, "type": "x-vbrief/plan", "title": "Child story"},
            ],
        },
    }
    child = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "title": "Child story",
            "status": child_status,
            "items": [],
            "planRef": parent_rel,
            "metadata": {"kind": "story"},
            "references": [origin_ref],
        },
    }
    parent_path = vbrief_root / parent_folder / PARENT_NAME
    child_path = vbrief_root / child_folder / CHILD_NAME
    parent_path.write_text(json.dumps(parent, indent=2) + "\n", encoding="utf-8")
    child_path.write_text(json.dumps(child, indent=2) + "\n", encoding="utf-8")
    return parent_path, child_path


def parent_child_ref_uri(parent_path: Path) -> str | None:
    """Return the parent's x-vbrief/plan reference uri (the child back-ref)."""
    data = read_vbrief(parent_path)
    for ref in data["plan"].get("references", []):
        if isinstance(ref, dict) and ref.get("type") == "x-vbrief/plan":
            return ref.get("uri")
    return None


def child_plan_ref(child_path: Path) -> str | None:
    """Return the child's plan-level planRef (the parent back-pointer)."""
    return read_vbrief(child_path)["plan"].get("planRef")


def validate_errors(tmp_path: Path) -> list[str]:
    """Run the full vBRIEF validator over tmp_path/vbrief and return errors."""
    import vbrief_validate

    errors, _warnings, _count = vbrief_validate.validate_all(tmp_path / "vbrief")
    return errors


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
        # Pass --project-root so the D4 WIP cap check (#1124) reads the
        # isolated tmp_path tree (empty pending/active) rather than
        # walking up to the real deft worktree where the count is over
        # cap during landing-day overage.
        result = subprocess.run(
            [
                sys.executable,
                str(REPO_ROOT / "scripts" / "scope_lifecycle.py"),
                "promote",
                str(f),
                "--project-root",
                str(tmp_path),
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        assert result.returncode == 0
        assert "Promoted" in result.stdout

    def test_cli_invalid_transition_returns_1(self, tmp_path):
        f = make_vbrief(tmp_path, "active", "running")
        # Pass --project-root so the D4 cap check (#1124) reads the
        # isolated tmp_path tree (empty pending/active) -- otherwise the
        # cap check would short-circuit with its own refusal before the
        # invalid-transition check fires. The test's intent is to exercise
        # the invalid-transition path, so we keep the cap satisfied.
        result = subprocess.run(
            [
                sys.executable,
                str(REPO_ROOT / "scripts" / "scope_lifecycle.py"),
                "promote",
                str(f),
                "--project-root",
                str(tmp_path),
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        assert result.returncode == 1
        # Match either "Error" (legacy invalid-transition prefix) or
        # "ERROR" (D4 cap-check prefix) so a future re-ordering doesn't
        # silently break this regression guard.
        assert "rror" in result.stderr


# ---------------------------------------------------------------------------
# Decomposed parent back-reference maintenance (#1485)
# ---------------------------------------------------------------------------

class TestDecomposedParentBackReference:
    """Regression coverage for #1485.

    A lifecycle move of a decomposed child (``scope:activate``,
    ``scope:complete``, ...) must rewrite the parent epic's ``x-vbrief/plan``
    forward reference to the child's NEW path, keeping the D4 bidirectional-
    linkage check green with no manual repair. Before this fix the parent
    reference pointed at the child's old lifecycle path and
    ``task vbrief:validate`` failed.
    """

    def test_baseline_pair_validates(self, tmp_path):
        """Sanity: the fixture pair is schema- and D4-valid before any move."""
        parent_path, _child_path = make_decomposed_pair(tmp_path)
        assert parent_child_ref_uri(parent_path) == f"pending/{CHILD_NAME}"
        assert validate_errors(tmp_path) == []

    def test_activate_updates_parent_reference(self, tmp_path):
        parent_path, child_path = make_decomposed_pair(tmp_path)

        ok, _ = run_transition("activate", child_path)
        assert ok
        # Child moved pending/ -> active/ ...
        assert (tmp_path / "vbrief" / "active" / CHILD_NAME).exists()
        # ... and the parent's forward reference followed it.
        assert parent_child_ref_uri(parent_path) == f"active/{CHILD_NAME}"
        # D4 bidirectional linkage holds with no manual repair.
        assert validate_errors(tmp_path) == []

    def test_complete_updates_parent_reference(self, tmp_path):
        parent_path, child_path = make_decomposed_pair(tmp_path)
        ok, _ = run_transition("activate", child_path)
        assert ok
        active_child = tmp_path / "vbrief" / "active" / CHILD_NAME

        ok, _ = run_transition("complete", active_child)
        assert ok
        assert (tmp_path / "vbrief" / "completed" / CHILD_NAME).exists()
        assert parent_child_ref_uri(parent_path) == f"completed/{CHILD_NAME}"
        assert validate_errors(tmp_path) == []

    def test_activate_then_complete_round_trip_validates(self, tmp_path):
        """The full activate -> complete round trip leaves validation clean."""
        parent_path, child_path = make_decomposed_pair(tmp_path)
        ok, _ = run_transition("activate", child_path)
        assert ok
        ok, _ = run_transition(
            "complete", tmp_path / "vbrief" / "active" / CHILD_NAME
        )
        assert ok
        assert parent_child_ref_uri(parent_path) == f"completed/{CHILD_NAME}"
        assert validate_errors(tmp_path) == []

    def test_file_uri_prefix_is_preserved(self, tmp_path):
        """A ``file://`` reference prefix is preserved across the rewrite."""
        parent_path, child_path = make_decomposed_pair(
            tmp_path, child_ref_uri=f"file://pending/{CHILD_NAME}"
        )
        ok, _ = run_transition("activate", child_path)
        assert ok
        assert parent_child_ref_uri(parent_path) == f"file://active/{CHILD_NAME}"
        assert validate_errors(tmp_path) == []

    def test_non_decomposed_child_move_is_noop(self, tmp_path):
        """A plain child with no planRef moves cleanly and touches no parent."""
        child = make_vbrief(tmp_path, "pending", "pending")
        ok, _ = run_transition("activate", child)
        assert ok
        assert (tmp_path / "vbrief" / "active" / child.name).exists()

    def test_helper_returns_rewritten_parent(self, tmp_path):
        """The helper reports the parent path whose reference it rewrote."""
        parent_path, child_path = make_decomposed_pair(tmp_path)
        child_data = read_vbrief(child_path)
        new_child = tmp_path / "vbrief" / "active" / CHILD_NAME
        updated = update_decomposed_parent_back_references(
            child_data, child_path, new_child, tmp_path / "vbrief"
        )
        assert updated == [parent_path.resolve()]
        assert parent_child_ref_uri(parent_path) == f"active/{CHILD_NAME}"

    def test_helper_noop_when_parent_missing(self, tmp_path):
        """A planRef to a non-existent parent yields no rewrite (no raise)."""
        child = make_vbrief(tmp_path, "pending", "pending")
        data = read_vbrief(child)
        data["plan"]["planRef"] = "active/2026-06-03-missing-parent.vbrief.json"
        new_child = tmp_path / "vbrief" / "active" / child.name
        updated = update_decomposed_parent_back_references(
            data, child, new_child, tmp_path / "vbrief"
        )
        assert updated == []

    def test_helper_swallows_parent_write_failure(self, tmp_path, monkeypatch):
        """A parent write failure is swallowed -- best-effort, never raises.

        The child move has already succeeded by the time the parent is
        rewritten, so a disk-write error (disk full, EROFS, PermissionError)
        must not escape ``run_transition``'s ``tuple[bool, str]`` contract.
        """
        import pathlib

        parent_path, child_path = make_decomposed_pair(tmp_path)
        child_data = read_vbrief(child_path)
        new_child = tmp_path / "vbrief" / "active" / CHILD_NAME

        def boom(self, *args, **kwargs):
            raise OSError("simulated disk-write failure")

        monkeypatch.setattr(pathlib.Path, "write_text", boom)
        # Must not raise; reports no rewrite because the write failed.
        updated = update_decomposed_parent_back_references(
            child_data, child_path, new_child, tmp_path / "vbrief"
        )
        assert updated == []


# ---------------------------------------------------------------------------
# Decomposed child back-reference maintenance (#1487, symmetric to #1485)
# ---------------------------------------------------------------------------

class TestDecomposedChildBackReference:
    """Regression coverage for #1487.

    A lifecycle move of a decompose-created epic PARENT (e.g. the cohort
    completion sweep promoting it ``pending/ -> active/ -> completed/``) must
    rewrite each child's ``planRef`` back-pointer to the parent's NEW path,
    keeping the D4 backward-linkage check green with no manual repair. This is
    the mirror image of the #1485 child-move case above.
    """

    def test_complete_active_parent_updates_child_planref(self, tmp_path):
        # Parent active, child active -- a valid decomposed pair.
        parent_path, child_path = make_decomposed_pair(
            tmp_path,
            parent_folder="active",
            parent_status="running",
            child_folder="active",
            child_status="running",
        )
        assert child_plan_ref(child_path) == f"active/{PARENT_NAME}"
        assert validate_errors(tmp_path) == []

        ok, _ = run_transition("complete", parent_path)
        assert ok
        # Parent moved active/ -> completed/ ...
        assert (tmp_path / "vbrief" / "completed" / PARENT_NAME).exists()
        # ... and the child's planRef followed it.
        assert child_plan_ref(child_path) == f"completed/{PARENT_NAME}"
        assert validate_errors(tmp_path) == []

    def test_activate_pending_parent_updates_child_planref(self, tmp_path):
        parent_path, child_path = make_decomposed_pair(
            tmp_path,
            parent_folder="pending",
            parent_status="pending",
            child_folder="active",
            child_status="running",
        )
        ok, _ = run_transition("activate", parent_path)
        assert ok
        assert child_plan_ref(child_path) == f"active/{PARENT_NAME}"
        assert validate_errors(tmp_path) == []

    def test_file_uri_prefix_is_preserved(self, tmp_path):
        """A ``file://`` planRef prefix is preserved across the rewrite."""
        parent_path, child_path = make_decomposed_pair(
            tmp_path,
            parent_folder="active",
            parent_status="running",
            child_folder="active",
            child_status="running",
        )
        # Rewrite the child's planRef to use a file:// prefix.
        data = read_vbrief(child_path)
        data["plan"]["planRef"] = f"file://active/{PARENT_NAME}"
        child_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")

        ok, _ = run_transition("complete", parent_path)
        assert ok
        assert child_plan_ref(child_path) == f"file://completed/{PARENT_NAME}"
        assert validate_errors(tmp_path) == []

    def test_helper_returns_rewritten_children(self, tmp_path):
        """The helper reports the child paths whose planRefs it rewrote."""
        parent_path, child_path = make_decomposed_pair(
            tmp_path,
            parent_folder="active",
            parent_status="running",
            child_folder="active",
            child_status="running",
        )
        parent_data = read_vbrief(parent_path)
        new_parent = tmp_path / "vbrief" / "completed" / PARENT_NAME
        updated = update_decomposed_child_back_references(
            parent_data, parent_path, new_parent, tmp_path / "vbrief"
        )
        assert updated == [child_path.resolve()]
        assert child_plan_ref(child_path) == f"completed/{PARENT_NAME}"

    def test_helper_noop_when_no_children(self, tmp_path):
        """A file with no x-vbrief/plan children rewrites nothing (no raise)."""
        plain = make_vbrief(tmp_path, "active", "running")
        data = read_vbrief(plain)
        new_path = tmp_path / "vbrief" / "completed" / plain.name
        updated = update_decomposed_child_back_references(
            data, plain, new_path, tmp_path / "vbrief"
        )
        assert updated == []

    def test_helper_swallows_child_write_failure(self, tmp_path, monkeypatch):
        """A child write failure is swallowed -- best-effort, never raises."""
        import pathlib

        parent_path, child_path = make_decomposed_pair(
            tmp_path,
            parent_folder="active",
            parent_status="running",
            child_folder="active",
            child_status="running",
        )
        parent_data = read_vbrief(parent_path)
        new_parent = tmp_path / "vbrief" / "completed" / PARENT_NAME

        def boom(self, *args, **kwargs):
            raise OSError("simulated disk-write failure")

        monkeypatch.setattr(pathlib.Path, "write_text", boom)
        updated = update_decomposed_child_back_references(
            parent_data, parent_path, new_parent, tmp_path / "vbrief"
        )
        assert updated == []


# ---------------------------------------------------------------------------
# Capacity-accounting completion stamp (#1419 Slice 4, acceptance a3)
# ---------------------------------------------------------------------------


def _write_project_definition_with_capacity(tmp_path: Path, capacity: dict) -> None:
    """Drop a PROJECT-DEFINITION carrying a capacityAllocation block."""
    (tmp_path / "vbrief").mkdir(parents=True, exist_ok=True)
    payload = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "title": "P",
            "status": "running",
            "items": [],
            "policy": {"capacityAllocation": capacity},
        },
    }
    (tmp_path / "vbrief" / "PROJECT-DEFINITION.vbrief.json").write_text(
        json.dumps(payload, indent=2) + "\n", encoding="utf-8"
    )


class TestCapacityCompletionStamp:
    """``scope:complete`` stamps capacityBucket + completedAt (#1419 a3)."""

    def test_complete_stamps_completed_at(self, tmp_path):
        f = make_vbrief(tmp_path, "active", "running")
        ok, _ = run_transition("complete", f)
        assert ok
        dest = tmp_path / "vbrief" / "completed" / f.name
        meta = read_vbrief(dest)["plan"]["metadata"]
        ts = meta["completedAt"]
        assert "T" in ts and ts.endswith("Z")

    def test_complete_without_policy_leaves_bucket_unset(self, tmp_path):
        """No capacity policy -> completedAt stamped, capacityBucket absent."""
        f = make_vbrief(tmp_path, "active", "running")
        ok, _ = run_transition("complete", f)
        assert ok
        dest = tmp_path / "vbrief" / "completed" / f.name
        meta = read_vbrief(dest)["plan"]["metadata"]
        assert "completedAt" in meta
        assert "capacityBucket" not in meta

    def test_complete_preserves_existing_bucket(self, tmp_path):
        """An explicit capacityBucket is preserved, not overwritten."""
        _write_project_definition_with_capacity(
            tmp_path,
            {
                "window": 30,
                "defaultBucket": "feature",
                "buckets": [
                    {"id": "debt", "target": 0.5},
                    {"id": "feature", "target": 0.5},
                ],
            },
        )
        f = make_vbrief(tmp_path, "active", "running")
        data = read_vbrief(f)
        data["plan"]["metadata"] = {"capacityBucket": "debt"}
        f.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")

        ok, _ = run_transition("complete", f)
        assert ok
        dest = tmp_path / "vbrief" / "completed" / f.name
        meta = read_vbrief(dest)["plan"]["metadata"]
        assert meta["capacityBucket"] == "debt"
        assert "completedAt" in meta

    def test_complete_backfills_default_bucket(self, tmp_path):
        """An absent capacityBucket is back-filled from policy defaultBucket."""
        _write_project_definition_with_capacity(
            tmp_path,
            {
                "window": 30,
                "defaultBucket": "feature",
                "buckets": [
                    {"id": "debt", "target": 0.5},
                    {"id": "feature", "target": 0.5},
                ],
            },
        )
        f = make_vbrief(tmp_path, "active", "running")
        ok, _ = run_transition("complete", f)
        assert ok
        dest = tmp_path / "vbrief" / "completed" / f.name
        meta = read_vbrief(dest)["plan"]["metadata"]
        assert meta["capacityBucket"] == "feature"
        assert "completedAt" in meta

    def test_fail_does_not_stamp_capacity(self, tmp_path):
        """``fail`` records an attempt, not a completion -- no capacity stamp."""
        f = make_vbrief(tmp_path, "active", "running")
        ok, _ = run_transition("fail", f)
        assert ok
        dest = tmp_path / "vbrief" / "completed" / f.name
        meta = read_vbrief(dest)["plan"].get("metadata", {})
        assert "completedAt" not in meta
        assert "capacityBucket" not in meta
