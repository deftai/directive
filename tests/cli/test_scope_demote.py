"""test_scope_demote.py -- Tests for scripts/scope_demote.py (#1121).

Covers:
    - Single-demote happy path (pending/ -> proposed/, plan.status flipped,
      plan.updated refreshed).
    - Rejection when source folder is not pending/ (idempotent re-demote falls
      out of this naturally).
    - Batch demote with --older-than-days N: only old items demote.
    - Batch demote with no eligible items: clean no-op.
    - demote_meta block presence + content (every required field).
    - original_promotion_decision_id traceability when a prior promote audit
      entry exists for the same path.
    - CLI subprocess form (single + batch + mutual-exclusion error).

Refs: #1119 (umbrella), #1121 (D1).
"""

from __future__ import annotations

import json
import subprocess
import sys
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()
SCRIPTS_DIR = REPO_ROOT / "scripts"

# Import the modules under test directly (the package layout matches
# test_scope_lifecycle.py).
sys.path.insert(0, str(SCRIPTS_DIR))
from scope_audit_log import (  # noqa: E402, I001
    append as audit_append,
    canonical_log_path,
    new_decision_id,
    read_all,
)
from scope_demote import batch_demote, demote_one  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def make_vbrief(
    tmp_path: Path,
    folder: str,
    status: str,
    filename: str = "2026-04-12-1121-demote-target.vbrief.json",
    *,
    plan_updated: str | None = None,
) -> Path:
    """Create a vBRIEF fixture in tmp_path/vbrief/<folder>/."""
    vbrief_root = tmp_path / "vbrief"
    folder_path = vbrief_root / folder
    folder_path.mkdir(parents=True, exist_ok=True)
    plan: dict = {
        "title": "Demote target",
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
    file_path.write_text(
        json.dumps(data, indent=2) + "\n", encoding="utf-8"
    )
    return file_path


def read_vbrief(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture()
def project_root(tmp_path: Path) -> Path:
    """Tmp project root that contains vbrief/ (so resolve_project_root works)."""
    (tmp_path / "vbrief").mkdir(parents=True, exist_ok=True)
    return tmp_path


@pytest.fixture()
def log_path(project_root: Path) -> Path:
    """Audit log path under the tmp project root."""
    return canonical_log_path(project_root)


# ---------------------------------------------------------------------------
# Single demote
# ---------------------------------------------------------------------------


class TestSingleDemote:
    def test_happy_path(self, project_root: Path, log_path: Path) -> None:
        f = make_vbrief(
            project_root,
            "pending",
            "pending",
            plan_updated="2026-04-15T00:00:00Z",
        )
        now = datetime(2026, 4, 27, 12, 0, 0, tzinfo=UTC)
        ok, msg, entry = demote_one(
            f, project_root, "needs-reshape", now=now, log_path=log_path
        )
        assert ok, msg
        # File moved.
        dest = project_root / "vbrief" / "proposed" / f.name
        assert dest.exists()
        assert not f.exists()
        # plan flipped.
        data = read_vbrief(dest)
        assert data["plan"]["status"] == "proposed"
        assert data["plan"]["updated"] == "2026-04-27T12:00:00Z"
        # demote_meta on the audit entry.
        assert entry is not None
        meta = entry["demote_meta"]
        assert meta["was_promoted"] is True
        assert meta["original_promotion_decision_id"] is None
        assert meta["days_in_pending"] == 12
        assert meta["demote_reason"] == "needs-reshape"
        assert meta["demoted_from"] == "pending"
        # audit log persisted exactly one entry.
        assert log_path.exists()
        lines = read_all(log_path=log_path)
        assert len(lines) == 1
        assert lines[0]["decision_id"] == entry["decision_id"]
        assert lines[0]["action"] == "demote"
        assert lines[0]["from_status"] == "pending"
        assert lines[0]["to_status"] == "proposed"
        # Canonical path is project-root-relative with forward slashes.
        assert lines[0]["vbrief_path"] == f"vbrief/proposed/{f.name}"

    def test_rejects_non_pending_source(
        self, project_root: Path, log_path: Path
    ) -> None:
        # Place vBRIEF in proposed/; demote MUST refuse.
        f = make_vbrief(project_root, "proposed", "proposed")
        ok, msg, entry = demote_one(
            f, project_root, "operator-requested", log_path=log_path
        )
        assert not ok
        assert "Invalid transition" in msg
        assert "pending/" in msg
        assert entry is None
        # No audit entry written.
        assert not log_path.exists() or not read_all(log_path=log_path)

    def test_idempotent_re_demote_is_rejected(
        self, project_root: Path, log_path: Path
    ) -> None:
        """A second demote of the same brief lands on a proposed/ file and is
        therefore rejected with the same invalid-transition message -- a re-
        demote requires an explicit operator re-promote first.
        """
        f = make_vbrief(
            project_root,
            "pending",
            "pending",
            plan_updated="2026-04-15T00:00:00Z",
        )
        ok, _, _ = demote_one(
            f,
            project_root,
            "operator-requested",
            now=datetime(2026, 4, 25, tzinfo=UTC),
            log_path=log_path,
        )
        assert ok
        # File is now in proposed/. Re-demote on that path MUST fail.
        moved = project_root / "vbrief" / "proposed" / f.name
        ok2, msg2, entry2 = demote_one(
            moved, project_root, "again", log_path=log_path
        )
        assert not ok2
        assert "Invalid transition" in msg2
        assert entry2 is None
        # Still exactly one audit entry on the log.
        assert len(read_all(log_path=log_path)) == 1

    def test_original_promotion_decision_id_traced(
        self, project_root: Path, log_path: Path
    ) -> None:
        # Seed a prior promote audit entry for the target path BEFORE we move
        # the file out of pending/. Path used here is the form scope_demote
        # canonicalises (project-root-relative, forward slashes).
        f = make_vbrief(
            project_root,
            "pending",
            "pending",
            plan_updated="2026-04-10T00:00:00Z",
        )
        prior_id = str(uuid.uuid4())
        promote_entry = {
            "decision_id": prior_id,
            "timestamp": "2026-04-10T00:00:00Z",
            "action": "promote",
            "vbrief_path": f"vbrief/pending/{f.name}",
            "from_status": "proposed",
            "to_status": "pending",
            "actor": "operator",
        }
        audit_append(promote_entry, log_path=log_path)

        ok, _, entry = demote_one(
            f,
            project_root,
            "needs-reshape",
            now=datetime(2026, 4, 30, tzinfo=UTC),
            log_path=log_path,
        )
        assert ok
        assert entry is not None
        assert entry["demote_meta"]["original_promotion_decision_id"] == prior_id

    def test_falls_back_to_file_mtime_when_plan_updated_missing(
        self, project_root: Path, log_path: Path
    ) -> None:
        # No plan.updated -- days_in_pending should fall back to file mtime.
        f = make_vbrief(project_root, "pending", "pending", plan_updated=None)
        # Backdate mtime by 10 days.
        ten_days_ago = (datetime.now(UTC) - timedelta(days=10)).timestamp()
        import os

        os.utime(f, (ten_days_ago, ten_days_ago))
        ok, _, entry = demote_one(
            f, project_root, "old", log_path=log_path
        )
        assert ok
        assert entry is not None
        # Allow some wiggle room for execution time -- expect ~10 days.
        assert 9 <= entry["demote_meta"]["days_in_pending"] <= 11


# ---------------------------------------------------------------------------
# Batch demote
# ---------------------------------------------------------------------------


class TestBatchDemote:
    def test_demotes_only_old_items(
        self, project_root: Path, log_path: Path
    ) -> None:
        # Two old vBRIEFs (50d, 100d) and one recent (10d).
        old1 = make_vbrief(
            project_root,
            "pending",
            "pending",
            filename="2026-02-01-old1.vbrief.json",
            plan_updated="2026-02-01T00:00:00Z",
        )
        old2 = make_vbrief(
            project_root,
            "pending",
            "pending",
            filename="2026-01-01-old2.vbrief.json",
            plan_updated="2026-01-01T00:00:00Z",
        )
        recent = make_vbrief(
            project_root,
            "pending",
            "pending",
            filename="2026-04-10-recent.vbrief.json",
            plan_updated="2026-04-10T00:00:00Z",
        )
        now = datetime(2026, 4, 20, tzinfo=UTC)
        demoted, entries, skipped = batch_demote(
            project_root,
            older_than_days=45,
            now=now,
            log_path=log_path,
        )
        assert demoted == 2
        assert len(entries) == 2
        # Old ones moved.
        assert (project_root / "vbrief" / "proposed" / old1.name).exists()
        assert (project_root / "vbrief" / "proposed" / old2.name).exists()
        # Recent one still in pending/.
        assert recent.exists()
        # Skipped tally records the recent (one line).
        assert any(recent.name in line for line in skipped)
        # All audit entries carry the batch reason.
        for e in entries:
            assert e["demote_meta"]["demote_reason"] == "batch:older-than-days:45"
            assert e["demote_meta"]["was_promoted"] is True
            assert e["demote_meta"]["demoted_from"] == "pending"
            assert e["demote_meta"]["days_in_pending"] >= 45

    def test_no_eligible_items_is_noop(
        self, project_root: Path, log_path: Path
    ) -> None:
        # Single recent vBRIEF; should NOT be demoted at default threshold.
        recent = make_vbrief(
            project_root,
            "pending",
            "pending",
            plan_updated="2026-04-19T00:00:00Z",
        )
        now = datetime(2026, 4, 20, tzinfo=UTC)
        demoted, entries, skipped = batch_demote(
            project_root,
            older_than_days=45,
            now=now,
            log_path=log_path,
        )
        assert demoted == 0
        assert entries == []
        assert len(skipped) == 1
        # No audit entry written.
        assert read_all(log_path=log_path) == []
        # File untouched.
        assert recent.exists()

    def test_empty_pending_folder_is_clean_noop(
        self, project_root: Path, log_path: Path
    ) -> None:
        (project_root / "vbrief" / "pending").mkdir(parents=True, exist_ok=True)
        demoted, entries, skipped = batch_demote(
            project_root,
            older_than_days=45,
            log_path=log_path,
        )
        assert demoted == 0
        assert entries == []
        assert skipped == []
        assert read_all(log_path=log_path) == []

    def test_negative_threshold_raises(self, project_root: Path, log_path: Path) -> None:
        with pytest.raises(ValueError):
            batch_demote(project_root, older_than_days=-1, log_path=log_path)


# ---------------------------------------------------------------------------
# demote_meta block schema
# ---------------------------------------------------------------------------


class TestDemoteMeta:
    def test_meta_required_fields_present(
        self, project_root: Path, log_path: Path
    ) -> None:
        f = make_vbrief(
            project_root,
            "pending",
            "pending",
            plan_updated="2026-04-10T00:00:00Z",
        )
        ok, _, entry = demote_one(
            f,
            project_root,
            "needs-reshape",
            now=datetime(2026, 4, 27, tzinfo=UTC),
            log_path=log_path,
        )
        assert ok
        assert entry is not None
        meta = entry["demote_meta"]
        expected_keys = {
            "was_promoted",
            "original_promotion_decision_id",
            "days_in_pending",
            "demote_reason",
            "demoted_from",
        }
        assert expected_keys <= set(meta.keys())
        # Types.
        assert isinstance(meta["was_promoted"], bool)
        assert (
            meta["original_promotion_decision_id"] is None
            or isinstance(meta["original_promotion_decision_id"], str)
        )
        assert isinstance(meta["days_in_pending"], int)
        assert meta["days_in_pending"] >= 0
        assert isinstance(meta["demote_reason"], str) and meta["demote_reason"]
        assert isinstance(meta["demoted_from"], str) and meta["demoted_from"]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


class TestCLI:
    SCRIPT = SCRIPTS_DIR / "scope_demote.py"

    def _run(self, *argv: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(self.SCRIPT), *argv],
            capture_output=True,
            text=True,
            timeout=20,
        )

    def test_no_args_is_usage_error(self) -> None:
        result = self._run()
        assert result.returncode == 2
        assert "Error:" in result.stderr or "usage" in result.stderr.lower()

    def test_batch_and_file_mutually_exclusive(self, project_root: Path) -> None:
        f = make_vbrief(project_root, "pending", "pending")
        result = self._run(
            str(f),
            "--batch",
            "--project-root",
            str(project_root),
        )
        assert result.returncode == 2
        assert "mutually exclusive" in result.stderr.lower()

    def test_cli_single_demote(self, project_root: Path) -> None:
        f = make_vbrief(
            project_root,
            "pending",
            "pending",
            plan_updated="2026-04-10T00:00:00Z",
        )
        result = self._run(
            str(f),
            "--reason",
            "cli-test",
            "--project-root",
            str(project_root),
        )
        assert result.returncode == 0, result.stderr
        assert "Demoted" in result.stdout
        # Audit log written to canonical location.
        log = canonical_log_path(project_root)
        assert log.exists()
        entries = read_all(log_path=log)
        assert len(entries) == 1
        assert entries[0]["demote_meta"]["demote_reason"] == "cli-test"

    def test_cli_batch_no_eligible(self, project_root: Path) -> None:
        # Recent vBRIEF -- batch should report 0 demoted.
        recent_iso = (datetime.now(UTC) - timedelta(days=1)).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        make_vbrief(
            project_root,
            "pending",
            "pending",
            plan_updated=recent_iso,
        )
        result = self._run(
            "--batch",
            "--older-than-days",
            "45",
            "--project-root",
            str(project_root),
        )
        assert result.returncode == 0, result.stderr
        assert "0 demoted" in result.stdout

    def test_cli_negative_older_than_days_rejected(
        self, project_root: Path
    ) -> None:
        result = self._run(
            "--batch",
            "--older-than-days",
            "-3",
            "--project-root",
            str(project_root),
        )
        assert result.returncode == 2

    def test_cli_invalid_source_returns_1(self, project_root: Path) -> None:
        f = make_vbrief(project_root, "proposed", "proposed")
        result = self._run(
            str(f),
            "--project-root",
            str(project_root),
        )
        assert result.returncode == 1
        assert "Invalid transition" in result.stderr


# ---------------------------------------------------------------------------
# scope_audit_log validation guardrails (defensive coverage)
# ---------------------------------------------------------------------------


class TestAuditLogValidation:
    def test_demote_entry_requires_demote_meta(self, log_path: Path) -> None:
        from scope_audit_log import ScopeAuditLogError

        with pytest.raises(ScopeAuditLogError):
            audit_append(
                {
                    "decision_id": new_decision_id(),
                    "timestamp": "2026-05-17T21:05:00Z",
                    "action": "demote",
                    "vbrief_path": "vbrief/proposed/x.vbrief.json",
                    "from_status": "pending",
                    "to_status": "proposed",
                    "actor": "operator",
                    # demote_meta MISSING
                },
                log_path=log_path,
            )

    def test_demote_meta_required_fields(self, log_path: Path) -> None:
        from scope_audit_log import ScopeAuditLogError

        with pytest.raises(ScopeAuditLogError):
            audit_append(
                {
                    "decision_id": new_decision_id(),
                    "timestamp": "2026-05-17T21:05:00Z",
                    "action": "demote",
                    "vbrief_path": "vbrief/proposed/x.vbrief.json",
                    "from_status": "pending",
                    "to_status": "proposed",
                    "actor": "operator",
                    "demote_meta": {
                        "was_promoted": True,
                        # original_promotion_decision_id missing
                        "days_in_pending": 5,
                        "demote_reason": "x",
                        "demoted_from": "pending",
                    },
                },
                log_path=log_path,
            )

    def test_non_demote_action_does_not_require_meta(self, log_path: Path) -> None:
        # Forward-compat: a future "promote" emitter should be acceptable
        # without a demote_meta block.
        decision_id = audit_append(
            {
                "decision_id": new_decision_id(),
                "timestamp": "2026-05-17T21:05:00Z",
                "action": "promote",
                "vbrief_path": "vbrief/pending/foo.vbrief.json",
                "from_status": "proposed",
                "to_status": "pending",
                "actor": "operator",
            },
            log_path=log_path,
        )
        assert decision_id
