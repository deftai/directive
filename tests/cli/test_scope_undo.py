"""test_scope_undo.py -- Tests for scripts/scope_undo.py (#1134 / D15).

Covers:
    - Demote undo round-trip (proposed/ -> pending/ + status flipped +
      undo audit entry written + original_decision_id wired).
    - Cancel undo round-trip (cancelled/ -> cancel_meta.cancelled_from
      with corresponding plan.status).
    - Batch undo on a 5-entry cohort with a shared batch_id.
    - Idempotency: re-running undo on an already-undone entry is a no-op
      with exit 0.
    - Terminal-action refusal (complete / fail) returns ok=False.
    - --dry-run preview: no audit-log write, no file move.
    - --decision-id / --batch-id mutex enforced at the CLI.

Refs: #1119 (umbrella), #1121 (D1 audit-log surface consumed),
#1134 (D15).
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()
SCRIPTS_DIR = REPO_ROOT / "scripts"

sys.path.insert(0, str(SCRIPTS_DIR))
from scope_audit_log import (  # noqa: E402, I001
    append as audit_append,
    canonical_log_path,
    new_decision_id,
    read_all,
)
from scope_demote import batch_demote, demote_one  # noqa: E402
from scope_undo import (  # noqa: E402
    _find_by_batch_id,
    main as undo_main,
    undo_batch,
    undo_one,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def make_vbrief(
    project_root: Path,
    folder: str,
    status: str,
    *,
    filename: str = "2026-05-18-1134-undo-target.vbrief.json",
    plan_updated: str | None = None,
) -> Path:
    """Create a vBRIEF fixture in <project_root>/vbrief/<folder>/."""
    vbrief_root = project_root / "vbrief"
    folder_path = vbrief_root / folder
    folder_path.mkdir(parents=True, exist_ok=True)
    plan: dict = {
        "title": "Undo target",
        "status": status,
        "items": [],
    }
    if plan_updated is not None:
        plan["updated"] = plan_updated
    data = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": plan,
    }
    file_path = folder_path / filename
    file_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return file_path


def read_plan(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))["plan"]


@pytest.fixture()
def project_root(tmp_path: Path) -> Path:
    (tmp_path / "vbrief").mkdir(parents=True, exist_ok=True)
    return tmp_path


@pytest.fixture()
def log_path(project_root: Path) -> Path:
    return canonical_log_path(project_root)


def _seed_cancel_entry(
    project_root: Path,
    log_path: Path,
    file_path: Path,
    cancelled_from: str,
    *,
    timestamp: str | None = None,
) -> dict:
    """Seed a synthetic cancel audit entry. Mirrors the shape a future
    scope_lifecycle audit-write would emit; tests need not depend on that
    landing.
    """
    rel = file_path.relative_to(project_root).as_posix()
    entry: dict = {
        "decision_id": new_decision_id(),
        "timestamp": timestamp or "2026-05-18T20:00:00Z",
        "action": "cancel",
        "vbrief_path": rel,
        "from_status": cancelled_from,
        "to_status": "cancelled",
        "actor": "operator",
        "cancel_meta": {"cancelled_from": cancelled_from},
    }
    audit_append(entry, log_path=log_path)
    return entry


def _seed_terminal_entry(
    project_root: Path,
    log_path: Path,
    file_path: Path,
    action: str,
) -> dict:
    rel = file_path.relative_to(project_root).as_posix()
    entry = {
        "decision_id": new_decision_id(),
        "timestamp": "2026-05-18T19:00:00Z",
        "action": action,
        "vbrief_path": rel,
        "from_status": "active",
        "to_status": action,
        "actor": "operator",
    }
    audit_append(entry, log_path=log_path)
    return entry


# ---------------------------------------------------------------------------
# Demote undo round-trip
# ---------------------------------------------------------------------------


class TestDemoteUndo:
    def test_round_trip_restores_to_pending(
        self, project_root: Path, log_path: Path
    ) -> None:
        f = make_vbrief(
            project_root,
            "pending",
            "pending",
            plan_updated="2026-05-01T00:00:00Z",
        )
        now = datetime(2026, 5, 18, 12, 0, 0, tzinfo=UTC)
        ok, _msg, demote_entry = demote_one(
            f, project_root, "operator-requested", now=now, log_path=log_path
        )
        assert ok
        assert demote_entry is not None
        proposed_path = project_root / "vbrief" / "proposed" / f.name
        assert proposed_path.exists()
        # Now undo the demote.
        log_entries = read_all(log_path=log_path)
        ok, msg, undo_entry = undo_one(
            demote_entry,
            project_root,
            now=datetime(2026, 5, 18, 12, 5, 0, tzinfo=UTC),
            log_path=log_path,
            log_entries=log_entries,
        )
        assert ok, msg
        # File back in pending/.
        pending_path = project_root / "vbrief" / "pending" / f.name
        assert pending_path.exists()
        assert not proposed_path.exists()
        # Plan status reverted.
        plan = read_plan(pending_path)
        assert plan["status"] == "pending"
        assert plan["updated"] == "2026-05-18T12:05:00Z"
        # Audit entry shape.
        assert undo_entry is not None
        assert undo_entry["action"] == "undo"
        assert undo_entry["from_status"] == "proposed"
        assert undo_entry["to_status"] == "pending"
        assert (
            undo_entry["undo_meta"]["original_decision_id"]
            == demote_entry["decision_id"]
        )
        assert undo_entry["undo_meta"]["original_action"] == "demote"
        # Two entries on the log now.
        assert len(read_all(log_path=log_path)) == 2

    def test_terminal_action_refused(
        self, project_root: Path, log_path: Path
    ) -> None:
        f = make_vbrief(project_root, "completed", "completed")
        entry = _seed_terminal_entry(project_root, log_path, f, "complete")
        ok, msg, undo_entry = undo_one(entry, project_root, log_path=log_path)
        assert not ok
        assert undo_entry is None
        assert "Refusing to undo terminal action" in msg

        f2 = make_vbrief(
            project_root,
            "completed",
            "failed",
            filename="2026-05-18-other-fail.vbrief.json",
        )
        entry2 = _seed_terminal_entry(project_root, log_path, f2, "fail")
        ok2, msg2, _ = undo_one(entry2, project_root, log_path=log_path)
        assert not ok2
        assert "Refusing to undo terminal action 'fail'" in msg2


# ---------------------------------------------------------------------------
# Cancel undo round-trip
# ---------------------------------------------------------------------------


class TestCancelUndo:
    def test_round_trip_restores_to_prior_folder(
        self, project_root: Path, log_path: Path
    ) -> None:
        # Place the brief in cancelled/ (simulating a prior cancel from
        # proposed/), then seed a cancel audit entry.
        cancelled_file = make_vbrief(project_root, "cancelled", "cancelled")
        _seed_cancel_entry(
            project_root, log_path, cancelled_file, cancelled_from="proposed"
        )
        entries = read_all(log_path=log_path)
        cancel_entry = entries[-1]
        ok, msg, undo_entry = undo_one(
            cancel_entry,
            project_root,
            now=datetime(2026, 5, 18, 12, 30, 0, tzinfo=UTC),
            log_path=log_path,
            log_entries=entries,
        )
        assert ok, msg
        # File moved back to proposed/.
        proposed_path = project_root / "vbrief" / "proposed" / cancelled_file.name
        assert proposed_path.exists()
        assert not cancelled_file.exists()
        plan = read_plan(proposed_path)
        assert plan["status"] == "proposed"
        assert undo_entry is not None
        assert undo_entry["action"] == "undo"
        assert undo_entry["to_status"] == "proposed"
        assert undo_entry["from_status"] == "cancelled"

    def test_round_trip_restores_to_pending(
        self, project_root: Path, log_path: Path
    ) -> None:
        cancelled_file = make_vbrief(
            project_root,
            "cancelled",
            "cancelled",
            filename="2026-05-18-pending-source.vbrief.json",
        )
        _seed_cancel_entry(
            project_root, log_path, cancelled_file, cancelled_from="pending"
        )
        entries = read_all(log_path=log_path)
        cancel_entry = entries[-1]
        ok, msg, _ = undo_one(
            cancel_entry,
            project_root,
            log_path=log_path,
            log_entries=entries,
        )
        assert ok, msg
        pending_path = project_root / "vbrief" / "pending" / cancelled_file.name
        assert pending_path.exists()
        assert read_plan(pending_path)["status"] == "pending"

    def test_restore_undo_re_cancels(
        self, project_root: Path, log_path: Path
    ) -> None:
        # Simulate a prior restore: brief is now in proposed/, audit
        # entry says cancelled/ -> proposed/.
        f = make_vbrief(
            project_root,
            "proposed",
            "proposed",
            filename="2026-05-18-restore-source.vbrief.json",
        )
        rel = f.relative_to(project_root).as_posix()
        restore_entry: dict = {
            "decision_id": new_decision_id(),
            "timestamp": "2026-05-18T18:00:00Z",
            "action": "restore",
            "vbrief_path": rel,
            "from_status": "cancelled",
            "to_status": "proposed",
            "actor": "operator",
        }
        audit_append(restore_entry, log_path=log_path)
        entries = read_all(log_path=log_path)
        ok, msg, undo_entry = undo_one(
            restore_entry,
            project_root,
            log_path=log_path,
            log_entries=entries,
        )
        assert ok, msg
        cancelled_path = project_root / "vbrief" / "cancelled" / f.name
        assert cancelled_path.exists()
        assert undo_entry is not None
        assert undo_entry["to_status"] == "cancelled"


# ---------------------------------------------------------------------------
# Batch undo on 5-entry cohort
# ---------------------------------------------------------------------------


class TestBatchUndo:
    def _build_5_entry_cohort(
        self, project_root: Path, log_path: Path
    ) -> tuple[str, list[Path]]:
        """Seed 5 pending/ vBRIEFs older than 7 days; batch-demote them
        so they share a `batch_id`. Returns (batch_id, file_paths).
        """
        files: list[Path] = []
        plan_updated = "2026-05-01T00:00:00Z"
        for i in range(5):
            f = make_vbrief(
                project_root,
                "pending",
                "pending",
                filename=f"2026-05-18-cohort-{i}.vbrief.json",
                plan_updated=plan_updated,
            )
            files.append(f)
        now = datetime(2026, 5, 18, 12, 0, 0, tzinfo=UTC)
        demoted, audit_entries, _ = batch_demote(
            project_root,
            older_than_days=7,
            now=now,
            log_path=log_path,
        )
        assert demoted == 5
        # All entries carry the same batch_id.
        batch_ids = {e["demote_meta"]["batch_id"] for e in audit_entries}
        assert len(batch_ids) == 1
        return batch_ids.pop(), files

    def test_batch_undo_reverses_all_members(
        self, project_root: Path, log_path: Path
    ) -> None:
        batch_id, files = self._build_5_entry_cohort(project_root, log_path)
        # All files now in proposed/.
        for f in files:
            assert (project_root / "vbrief" / "proposed" / f.name).exists()
        undone, audit_entries, skipped, previews = undo_batch(
            batch_id, project_root, log_path=log_path
        )
        assert undone == 5
        assert len(audit_entries) == 5
        assert skipped == []
        assert previews == []  # non-dry-run -> no previews
        # All files back in pending/.
        for f in files:
            assert (project_root / "vbrief" / "pending" / f.name).exists()
            assert not (project_root / "vbrief" / "proposed" / f.name).exists()
        # All undo entries share an undo_batch_id.
        undo_batch_ids = {
            e["undo_meta"]["undo_batch_id"] for e in audit_entries
        }
        assert len(undo_batch_ids) == 1

    def test_batch_undo_idempotent(
        self, project_root: Path, log_path: Path
    ) -> None:
        batch_id, _ = self._build_5_entry_cohort(project_root, log_path)
        undone1, _, _, _ = undo_batch(batch_id, project_root, log_path=log_path)
        assert undone1 == 5
        # Re-run: every member is already-undone -> all skipped.
        undone2, audit_entries2, skipped2, previews2 = undo_batch(
            batch_id, project_root, log_path=log_path
        )
        assert undone2 == 0
        assert audit_entries2 == []
        assert len(skipped2) == 5
        assert previews2 == []  # already-undone goes to skipped, not previews
        for line in skipped2:
            assert "already undone" in line

    def test_batch_undo_unknown_batch_id(
        self, project_root: Path, log_path: Path
    ) -> None:
        # Seed at least one unrelated audit entry so the log file exists.
        f = make_vbrief(project_root, "pending", "pending")
        demote_one(f, project_root, "operator-requested", log_path=log_path)
        undone, entries, skipped, previews = undo_batch(
            "no-such-batch-id", project_root, log_path=log_path
        )
        assert undone == 0
        assert entries == []
        assert len(skipped) == 1
        assert "No audit entries found" in skipped[0]
        assert previews == []

    def test_batch_undo_dry_run_surfaces_per_entry_previews(
        self, project_root: Path, log_path: Path
    ) -> None:
        """Greptile #1219 P1 regression guard: --dry-run --batch-id MUST
        surface a per-entry preview line for every member that would be
        reversed, NOT silently drop them with only the count reaching the
        caller (the contract that the original 3-tuple shape violated).
        """
        batch_id, files = self._build_5_entry_cohort(project_root, log_path)
        # All 5 files now in proposed/ (post-demote pre-dry-run-undo).
        for f in files:
            assert (project_root / "vbrief" / "proposed" / f.name).exists()
        undone, audit_entries, skipped, previews = undo_batch(
            batch_id, project_root, log_path=log_path, dry_run=True
        )
        # Dry-run still counts them as reversed (matching pre-Greptile-fix
        # behaviour) but now ALSO returns one preview line per member.
        assert undone == 5
        assert len(audit_entries) == 5  # preview entries built but not appended
        assert skipped == []
        assert len(previews) == 5
        for line in previews:
            assert line.startswith("DRY-RUN: would undo")
            assert "vbrief/pending/" in line  # demote inverse target
        # No file moved -- dry-run by contract.
        for f in files:
            assert (project_root / "vbrief" / "proposed" / f.name).exists()
            assert not (project_root / "vbrief" / "pending" / f.name).exists()

    def test_find_by_batch_id_legacy_top_level(
        self, project_root: Path, log_path: Path
    ) -> None:
        # Forward-compat: scope_undo accepts a top-level ``batch_id`` too.
        f = make_vbrief(project_root, "pending", "pending")
        entry = {
            "decision_id": new_decision_id(),
            "timestamp": "2026-05-18T10:00:00Z",
            "action": "demote",
            "vbrief_path": "vbrief/proposed/legacy.vbrief.json",
            "from_status": "pending",
            "to_status": "proposed",
            "actor": "operator",
            "batch_id": "legacy-batch",
            "demote_meta": {
                "was_promoted": True,
                "original_promotion_decision_id": None,
                "days_in_pending": 0,
                "demote_reason": "legacy",
                "demoted_from": "pending",
            },
        }
        audit_append(entry, log_path=log_path)
        entries = read_all(log_path=log_path)
        hits = _find_by_batch_id("legacy-batch", entries)
        assert len(hits) == 1
        assert hits[0]["decision_id"] == entry["decision_id"]
        # `f` was used only to ensure the audit-log parent exists; tidy up.
        f.unlink()


# ---------------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------------


class TestIdempotency:
    def test_undo_same_entry_twice_is_no_op(
        self, project_root: Path, log_path: Path
    ) -> None:
        f = make_vbrief(
            project_root,
            "pending",
            "pending",
            plan_updated="2026-05-01T00:00:00Z",
        )
        now = datetime(2026, 5, 18, 12, 0, 0, tzinfo=UTC)
        _, _, demote_entry = demote_one(
            f, project_root, "operator-requested", now=now, log_path=log_path
        )
        assert demote_entry is not None
        # First undo succeeds.
        log_entries = read_all(log_path=log_path)
        ok1, _, undo1 = undo_one(
            demote_entry,
            project_root,
            log_path=log_path,
            log_entries=log_entries,
        )
        assert ok1
        assert undo1 is not None
        # Second undo: no-op (already-undone is recognised).
        log_entries2 = read_all(log_path=log_path)
        ok2, msg2, undo2 = undo_one(
            demote_entry,
            project_root,
            log_path=log_path,
            log_entries=log_entries2,
        )
        assert ok2
        assert undo2 is None
        assert "already undone" in msg2
        # Log still has exactly demote + first-undo (no second-undo write).
        assert len(read_all(log_path=log_path)) == 2


# ---------------------------------------------------------------------------
# --dry-run
# ---------------------------------------------------------------------------


class TestDryRun:
    def test_dry_run_does_not_write(
        self, project_root: Path, log_path: Path
    ) -> None:
        f = make_vbrief(
            project_root,
            "pending",
            "pending",
            plan_updated="2026-05-01T00:00:00Z",
        )
        now = datetime(2026, 5, 18, 12, 0, 0, tzinfo=UTC)
        _, _, demote_entry = demote_one(
            f, project_root, "operator-requested", now=now, log_path=log_path
        )
        assert demote_entry is not None
        before_count = len(read_all(log_path=log_path))
        log_entries = read_all(log_path=log_path)
        ok, msg, preview = undo_one(
            demote_entry,
            project_root,
            log_path=log_path,
            log_entries=log_entries,
            dry_run=True,
        )
        assert ok
        assert "DRY-RUN" in msg
        assert preview is not None
        assert preview["action"] == "undo"
        # No file move; no audit-log write.
        assert (project_root / "vbrief" / "proposed" / f.name).exists()
        assert not (project_root / "vbrief" / "pending" / f.name).exists()
        assert len(read_all(log_path=log_path)) == before_count


# ---------------------------------------------------------------------------
# CLI tests
# ---------------------------------------------------------------------------


class TestCLI:
    def test_mutex_decision_and_batch(
        self, project_root: Path, log_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # Seed log file so the "audit log missing" path is not hit first.
        f = make_vbrief(project_root, "pending", "pending")
        demote_one(f, project_root, "operator-requested", log_path=log_path)
        exit_code = undo_main(
            [
                "abc",
                "--batch-id",
                "xyz",
                "--project-root",
                str(project_root),
            ]
        )
        assert exit_code == 2
        captured = capsys.readouterr()
        assert "mutually exclusive" in captured.err

    def test_missing_target_exits_2(
        self, project_root: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        exit_code = undo_main(
            ["--project-root", str(project_root)]
        )
        assert exit_code == 2
        captured = capsys.readouterr()
        assert "provide a <decision_id>" in captured.err

    def test_audit_log_missing_exits_1(
        self, project_root: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # No prior demote, so the audit log does not exist.
        exit_code = undo_main(
            ["some-id", "--project-root", str(project_root)]
        )
        assert exit_code == 1
        captured = capsys.readouterr()
        assert "audit log not found" in captured.err

    def test_subprocess_single_undo_happy_path(
        self, project_root: Path, log_path: Path
    ) -> None:
        f = make_vbrief(
            project_root,
            "pending",
            "pending",
            plan_updated="2026-05-01T00:00:00Z",
        )
        _, _, demote_entry = demote_one(
            f,
            project_root,
            "operator-requested",
            now=datetime(2026, 5, 18, 12, 0, 0, tzinfo=UTC),
            log_path=log_path,
        )
        assert demote_entry is not None
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPTS_DIR / "scope_undo.py"),
                demote_entry["decision_id"],
                "--project-root",
                str(project_root),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        assert "Undid demote" in result.stdout
        assert (project_root / "vbrief" / "pending" / f.name).exists()

    def test_subprocess_batch_undo(
        self, project_root: Path, log_path: Path
    ) -> None:
        # 3-file cohort.
        plan_updated = "2026-05-01T00:00:00Z"
        for i in range(3):
            make_vbrief(
                project_root,
                "pending",
                "pending",
                filename=f"2026-05-18-cli-cohort-{i}.vbrief.json",
                plan_updated=plan_updated,
            )
        now = datetime(2026, 5, 18, 12, 0, 0, tzinfo=UTC)
        _, audit_entries, _ = batch_demote(
            project_root,
            older_than_days=7,
            now=now,
            log_path=log_path,
        )
        batch_id = audit_entries[0]["demote_meta"]["batch_id"]
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPTS_DIR / "scope_undo.py"),
                "--batch-id",
                batch_id,
                "--project-root",
                str(project_root),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        assert "Batch undo: 3 reversed" in result.stdout
