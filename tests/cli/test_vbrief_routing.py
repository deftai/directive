"""Unit tests for scripts/_vbrief_routing.py (Agent B, #499).

Covers the schema-locked lifecycle <-> status mapping and the reconciled
scope vBRIEF builder. Most critically: guards against the legacy
``in_progress`` value ever being emitted again (#499 correction comment).
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from _vbrief_routing import (  # noqa: E402
    DEFAULT_STATUS_FOR_FOLDER,
    FOLDER_TO_STATUSES,
    STATUS_TO_FOLDER,
    build_scope_vbrief_from_reconciled,
    default_status_for_folder,
    folder_for_status,
    plan_status_matches_folder,
)

# ---------------------------------------------------------------------------
# Schema vocabulary guards
# ---------------------------------------------------------------------------


class TestSchemaVocabularyNeverInProgress:
    """#499 correction: ``in_progress`` must never appear anywhere."""

    def test_status_to_folder_has_no_in_progress(self):
        assert "in_progress" not in STATUS_TO_FOLDER

    def test_default_status_for_folder_has_no_in_progress(self):
        assert "in_progress" not in DEFAULT_STATUS_FOR_FOLDER.values()

    def test_active_folder_default_is_running(self):
        assert DEFAULT_STATUS_FOR_FOLDER["active"] == "running"
        assert "running" in FOLDER_TO_STATUSES["active"]
        assert "blocked" in FOLDER_TO_STATUSES["active"]


class TestFolderForStatus:
    """#506 lifecycle <-> status mapping."""

    @pytest.mark.parametrize(
        "status,folder",
        [
            ("draft", "proposed"),
            ("proposed", "proposed"),
            ("approved", "pending"),
            ("pending", "pending"),
            ("running", "active"),
            ("blocked", "active"),
            ("completed", "completed"),
            ("cancelled", "cancelled"),
        ],
    )
    def test_every_schema_status_maps(self, status, folder):
        assert folder_for_status(status) == folder

    def test_unknown_status_raises(self):
        with pytest.raises(ValueError):
            folder_for_status("in_progress")


class TestDefaultStatusForFolder:
    def test_proposed_default(self):
        assert default_status_for_folder("proposed") == "proposed"

    def test_pending_default(self):
        assert default_status_for_folder("pending") == "pending"

    def test_active_default_is_running(self):
        # Critical: #499 correction says active/ uses ``running`` not ``in_progress``.
        assert default_status_for_folder("active") == "running"

    def test_unknown_folder_raises(self):
        with pytest.raises(ValueError):
            default_status_for_folder("archive")


class TestCrossModuleStatusMappingSync:
    """Greptile #524 P2: ``_vbrief_reconciliation._folder_from_status`` keeps a
    local copy of the status->folder map to avoid an import cycle. If someone
    adds a new status to the router without updating reconciliation, the
    reconciliation copy would silently fall back to ``pending`` while the
    router raises. This test fails loudly when the two go out of sync.
    """

    def test_reconciliation_local_copy_matches_router(self):
        from _vbrief_reconciliation import _folder_from_status

        for status, expected_folder in STATUS_TO_FOLDER.items():
            assert _folder_from_status(status) == expected_folder, (
                f"_vbrief_reconciliation._folder_from_status is out of sync with "
                f"STATUS_TO_FOLDER on status={status!r}; update both dicts together"
            )


class TestPlanStatusMatchesFolder:
    def test_running_permitted_in_active(self):
        assert plan_status_matches_folder("running", "active") is True

    def test_blocked_permitted_in_active(self):
        assert plan_status_matches_folder("blocked", "active") is True

    def test_pending_not_permitted_in_active(self):
        assert plan_status_matches_folder("pending", "active") is False

    def test_completed_only_permitted_in_completed(self):
        assert plan_status_matches_folder("completed", "completed") is True
        assert plan_status_matches_folder("completed", "pending") is False


# ---------------------------------------------------------------------------
# build_scope_vbrief_from_reconciled
# ---------------------------------------------------------------------------


def _reconciled(**overrides):
    base = {
        "task_id": "#99",
        "number": "99",
        "title": "Widget feature",
        "description": "Add a widget.",
        "description_source": "SPECIFICATION.md",
        "status": "pending",
        "status_source": "default",
        "folder": "pending",
        "phase": "Phase 1",
        "phase_description": "",
        "tier": "",
        "spec_phase": "",
        "roadmap_summary": "",
        "source_conflict": "",
        "title_source": "",
        "override_applied": False,
        "synthetic_id": "",
        "original_task_id": "",
    }
    base.update(overrides)
    return base


class TestBuildReconciledScopeVbrief:
    def test_envelope_and_title(self):
        scope = build_scope_vbrief_from_reconciled(_reconciled())
        # #533: emitted envelope bumped to "0.6".
        assert scope["vBRIEFInfo"]["version"] == "0.6"
        assert scope["plan"]["title"] == "Widget feature"
        assert scope["plan"]["status"] == "pending"

    def test_description_and_source_emitted(self):
        scope = build_scope_vbrief_from_reconciled(_reconciled())
        narratives = scope["plan"]["narratives"]
        assert narratives["Description"] == "Add a widget."
        assert narratives["Description_source"] == "SPECIFICATION.md"

    def test_active_folder_emits_running_not_in_progress(self):
        """The #499 correction comment made this the explicit contract."""
        scope = build_scope_vbrief_from_reconciled(
            _reconciled(status="running", folder="active")
        )
        assert scope["plan"]["status"] == "running"
        # The schema-native value must appear verbatim in the written payload.
        assert scope["plan"]["status"] != "in_progress"

    def test_orphan_source_conflict_emitted(self):
        scope = build_scope_vbrief_from_reconciled(
            _reconciled(
                status="proposed",
                folder="proposed",
                source_conflict="missing-from-spec",
            )
        )
        assert scope["plan"]["narratives"]["SourceConflict"] == "missing-from-spec"

    def test_spec_phase_preserved_alongside_roadmap_phase(self):
        scope = build_scope_vbrief_from_reconciled(
            _reconciled(phase="Milestone 2", spec_phase="Phase 3: Integration")
        )
        narratives = scope["plan"]["narratives"]
        assert narratives["Phase"] == "Milestone 2"
        assert narratives["SpecPhase"] == "Phase 3: Integration"

    def test_roadmap_summary_emitted_on_title_drift(self):
        scope = build_scope_vbrief_from_reconciled(
            _reconciled(
                title="Repo indexer (full and incremental)",
                title_source="SPECIFICATION.md",
                roadmap_summary="Repo indexer (full + incremental)",
            )
        )
        narratives = scope["plan"]["narratives"]
        assert narratives["RoadmapSummary"] == "Repo indexer (full + incremental)"
        assert narratives["Title_source"] == "SPECIFICATION.md"

    def test_github_origin_provenance_preserved(self):
        scope = build_scope_vbrief_from_reconciled(
            _reconciled(), repo_url="https://github.com/acme/widget",
        )
        refs = scope["plan"]["references"]
        assert any(
            r.get("type") == "github-issue" and r.get("id") == "#99"
            and r.get("url") == "https://github.com/acme/widget/issues/99"
            for r in refs
        )
