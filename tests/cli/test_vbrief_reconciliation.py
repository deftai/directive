"""Unit tests for scripts/_vbrief_reconciliation.py (Agent B, #496).

Covers:
  - parse_overrides_yaml / load_overrides
  - build_spec_task_index (normalisation, nested subItems, issue-number index)
  - reconcile_scope_items (four scenarios: spec-stale, roadmap-stale,
    both-stale, clean) + orphan routing + override application
  - write_reconciliation_report format + non-emission when no disagreement
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from _vbrief_reconciliation import (  # noqa: E402
    ReconciliationReport,
    build_spec_task_index,
    format_reconciliation_markdown,
    load_overrides,
    parse_overrides_yaml,
    reconcile_scope_items,
    write_reconciliation_report,
)

# ---------------------------------------------------------------------------
# Overrides parser
# ---------------------------------------------------------------------------


class TestParseOverridesYaml:
    def test_empty_returns_empty(self):
        assert parse_overrides_yaml("") == {}

    def test_missing_overrides_key_returns_empty(self):
        assert parse_overrides_yaml("unrelated:\n  foo: bar\n") == {}

    def test_full_schema_shape(self):
        text = (
            "overrides:\n"
            "  t2.4.1:\n"
            "    status: completed\n"
            "    body_source: spec\n"
            "  t3.1.2:\n"
            "    status: pending\n"
            "    body_source: roadmap\n"
            "  roadmap-9:\n"
            "    drop: true\n"
        )
        result = parse_overrides_yaml(text)
        assert result["t2.4.1"] == {"status": "completed", "body_source": "spec"}
        assert result["t3.1.2"] == {"status": "pending", "body_source": "roadmap"}
        assert result["roadmap-9"] == {"drop": True}

    def test_comments_and_blank_lines_ignored(self):
        text = (
            "# top comment\n"
            "overrides:\n"
            "\n"
            "  t1:\n"
            "    status: running  \n"
        )
        result = parse_overrides_yaml(text)
        assert result == {"t1": {"status": "running"}}

    def test_quoted_values_unwrapped(self):
        text = 'overrides:\n  t1:\n    status: "completed"\n    body_source: \'spec\'\n'
        result = parse_overrides_yaml(text)
        assert result == {"t1": {"status": "completed", "body_source": "spec"}}

    def test_boolean_coercion(self):
        text = (
            "overrides:\n"
            "  a:\n"
            "    drop: true\n"
            "  b:\n"
            "    drop: false\n"
            "  c:\n"
            "    drop: yes\n"
        )
        result = parse_overrides_yaml(text)
        assert result["a"]["drop"] is True
        assert result["b"]["drop"] is False
        assert result["c"]["drop"] is True

    def test_load_overrides_missing_file(self, tmp_path):
        assert load_overrides(tmp_path / "vbrief") == {}

    def test_load_overrides_present_file(self, tmp_path):
        vbrief = tmp_path / "vbrief"
        vbrief.mkdir()
        (vbrief / "migration-overrides.yaml").write_text(
            "overrides:\n  t1:\n    status: completed\n",
            encoding="utf-8",
        )
        assert load_overrides(vbrief) == {"t1": {"status": "completed"}}


# ---------------------------------------------------------------------------
# Spec task index
# ---------------------------------------------------------------------------


def _spec_with(items):
    return {
        "vBRIEFInfo": {"version": "0.5", "description": "spec"},
        "plan": {
            "title": "Spec", "status": "approved", "narratives": {}, "items": items,
        },
    }


class TestBuildSpecTaskIndex:
    def test_empty_spec_gives_empty_index(self):
        assert build_spec_task_index(None) == {}
        assert build_spec_task_index({}) == {}

    def test_flat_items_indexed_by_id(self):
        spec = _spec_with([
            {"id": "t1.1", "title": "One", "status": "pending"},
            {"id": "t2.3", "title": "Two", "status": "completed"},
        ])
        index = build_spec_task_index(spec)
        assert "t1.1" in index
        assert "t2.3" in index
        # Normalised keys (without the leading ``t``) also resolve.
        assert "1.1" in index
        assert "2.3" in index

    def test_subitems_walked(self):
        spec = _spec_with([
            {
                "id": "phase-1",
                "title": "Phase 1: Foundation",
                "status": "pending",
                "subItems": [
                    {"id": "t1.1.1", "title": "Deep task", "status": "pending"},
                ],
            },
        ])
        index = build_spec_task_index(spec)
        assert "t1.1.1" in index
        assert index["t1.1.1"].spec_phase == "Phase 1: Foundation"

    def test_github_issue_ref_indexed(self):
        spec = _spec_with([
            {
                "id": "t1",
                "title": "Issue-backed task",
                "status": "pending",
                "references": [{"type": "github-issue", "id": "#123"}],
            },
        ])
        index = build_spec_task_index(spec)
        assert "123" in index
        assert "#123" in index


# ---------------------------------------------------------------------------
# reconcile_scope_items: four scenarios from #496
# ---------------------------------------------------------------------------


class TestReconcileScenarios:
    def test_clean_no_drift_no_report(self):
        """SPEC and ROADMAP agree -> no conflicts, no report content."""
        spec = _spec_with([
            {"id": "t1", "title": "Task one", "status": "pending"},
        ])
        reconciled, report = reconcile_scope_items(
            roadmap_active=[{"number": "", "task_id": "t1", "title": "Task one",
                             "phase": "Phase 1"}],
            roadmap_completed=[],
            spec_vbrief=spec,
        )
        assert len(reconciled) == 1
        assert reconciled[0]["status"] == "pending"
        assert reconciled[0]["folder"] == "pending"
        assert not report.has_disagreement()

    def test_spec_stale_roadmap_wins_completed(self):
        """ROADMAP marks task completed; SPEC says pending -> ROADMAP wins."""
        spec = _spec_with([
            {"id": "t2.4.1", "title": "Repo indexer", "status": "pending"},
        ])
        reconciled, report = reconcile_scope_items(
            roadmap_active=[],
            roadmap_completed=[{"number": "", "task_id": "t2.4.1",
                                "title": "Repo indexer", "phase": "Completed"}],
            spec_vbrief=spec,
        )
        assert reconciled[0]["status"] == "completed"
        assert reconciled[0]["folder"] == "completed"
        assert reconciled[0]["status_source"] == "ROADMAP.md"
        assert report.has_disagreement()

    def test_roadmap_stale_spec_tiebreaker(self):
        """SPEC status=completed, ROADMAP silent -> SPEC tiebreaker."""
        spec = _spec_with([
            {"id": "t3.1", "title": "Login bug", "status": "completed"},
        ])
        reconciled, _ = reconcile_scope_items(
            roadmap_active=[{"number": "", "task_id": "t3.1",
                             "title": "Login bug", "phase": "Phase 1"}],
            roadmap_completed=[],
            spec_vbrief=spec,
        )
        assert reconciled[0]["status"] == "completed"
        assert reconciled[0]["folder"] == "completed"
        assert "tiebreaker" in reconciled[0]["status_source"]

    def test_both_stale_resolves_to_roadmap_then_report(self):
        """SPEC says running, ROADMAP marks completed -> ROADMAP wins; conflict logged."""
        spec = _spec_with([
            {"id": "t5", "title": "X", "status": "running"},
        ])
        _, report = reconcile_scope_items(
            roadmap_active=[],
            roadmap_completed=[{"number": "", "task_id": "t5", "title": "X",
                                "phase": "Completed"}],
            spec_vbrief=spec,
        )
        # There should be a STATUS conflict dimension recorded.
        assert len(report.conflicts) == 1
        dims = report.conflicts[0].dimensions
        assert any(d["dimension"] == "STATUS conflict" for d in dims)

    def test_orphan_roadmap_routes_to_proposed(self):
        """ROADMAP item with no SPEC match AND SPEC has items -> proposed/ orphan."""
        spec = _spec_with([
            {"id": "t1", "title": "One", "status": "pending"},
        ])
        reconciled, report = reconcile_scope_items(
            roadmap_active=[{"number": "9", "title": "Orphan task",
                             "phase": "Phase 1", "synthetic_id": "roadmap-9"}],
            roadmap_completed=[],
            spec_vbrief=spec,
        )
        assert reconciled[0]["folder"] == "proposed"
        assert reconciled[0]["status"] == "proposed"
        assert reconciled[0]["source_conflict"] == "missing-from-spec"
        assert len(report.orphans) == 1

    def test_no_spec_items_means_no_orphan_detection(self):
        """Degenerate case: no SPEC items -> ROADMAP items stay in pending/."""
        reconciled, report = reconcile_scope_items(
            roadmap_active=[{"number": "9", "title": "Some task", "phase": "Phase 1"}],
            roadmap_completed=[],
            spec_vbrief=None,
        )
        assert reconciled[0]["folder"] == "pending"
        assert reconciled[0]["source_conflict"] == ""
        assert not report.has_disagreement()

    def test_title_drift_preserved_in_roadmap_summary(self):
        spec = _spec_with([
            {"id": "t1", "title": "Repo indexer (full and incremental)",
             "status": "pending"},
        ])
        reconciled, report = reconcile_scope_items(
            roadmap_active=[{"number": "", "task_id": "t1",
                             "title": "Repo indexer (full + incremental)",
                             "phase": "Phase 1"}],
            roadmap_completed=[],
            spec_vbrief=spec,
        )
        assert reconciled[0]["title"] == "Repo indexer (full and incremental)"
        assert reconciled[0]["roadmap_summary"] == "Repo indexer (full + incremental)"
        assert any(
            d["dimension"] == "TITLE drift" for c in report.conflicts for d in c.dimensions
        )


# ---------------------------------------------------------------------------
# Overrides applied
# ---------------------------------------------------------------------------


class TestOverridesApplied:
    def test_override_status_wins(self):
        spec = _spec_with([{"id": "t1", "title": "X", "status": "pending"}])
        reconciled, report = reconcile_scope_items(
            roadmap_active=[{"number": "", "task_id": "t1", "title": "X",
                             "phase": "Phase 1"}],
            roadmap_completed=[],
            spec_vbrief=spec,
            overrides={"t1": {"status": "completed"}},
        )
        assert reconciled[0]["status"] == "completed"
        assert reconciled[0]["status_source"] == "migration-overrides.yaml"
        assert reconciled[0]["override_applied"] is True
        assert len(report.overrides_triggered) == 1

    def test_override_body_source_roadmap(self):
        spec = _spec_with([
            {"id": "t1", "title": "Task",
             "narrative": {"Description": "SPEC rich body"}},
        ])
        reconciled, _ = reconcile_scope_items(
            roadmap_active=[{"number": "", "task_id": "t1",
                             "title": "Task (roadmap one-liner)", "phase": "P1"}],
            roadmap_completed=[],
            spec_vbrief=spec,
            overrides={"t1": {"body_source": "roadmap"}},
        )
        assert reconciled[0]["description"] == "Task (roadmap one-liner)"
        assert reconciled[0]["description_source"] == "ROADMAP.md (override)"

    def test_override_drop_removes_item(self):
        reconciled, report = reconcile_scope_items(
            roadmap_active=[{"number": "9", "title": "Bogus", "phase": "P",
                             "synthetic_id": "roadmap-9"}],
            roadmap_completed=[],
            spec_vbrief=None,
            overrides={"#9": {"drop": True}},
        )
        assert reconciled == []
        assert len(report.overrides_triggered) == 1
        assert report.overrides_triggered[0]["action"] == "dropped from migration"

    def test_override_drop_false_is_noop_does_not_trip_strict(self):
        # Regression for Greptile #524 P1: `drop: false` explicitly records
        # "do NOT drop this task" and must not flag a disagreement (which
        # would make --strict exit non-zero on a no-op).
        spec = _spec_with([{"id": "t1", "title": "X", "status": "pending"}])
        reconciled, report = reconcile_scope_items(
            roadmap_active=[{"number": "", "task_id": "t1", "title": "X",
                             "phase": "Phase 1"}],
            roadmap_completed=[],
            spec_vbrief=spec,
            overrides={"t1": {"drop": False}},
        )
        # Task still migrated (not dropped).
        assert len(reconciled) == 1
        assert reconciled[0]["task_id"] == "t1"
        # has_disagreement() must be False -- there were no actual conflicts
        # and drop:false is a no-op pin.
        assert not report.has_disagreement(), (
            "drop:false no-op must not trigger --strict; only drop:true is a triggered action"
        )
        # No-op overrides are not recorded in overrides_triggered -- only
        # overrides that actually changed a field (status, body_source, drop:true)
        # are listed there.  has_disagreement() therefore stays False.
        assert report.overrides_triggered == []
        # But the override key is not counted as "unused" either -- it matched
        # a real task, just with no triggered change.
        assert report.overrides_unused == []

    def test_unused_override_surfaced_in_report(self):
        _, report = reconcile_scope_items(
            roadmap_active=[],
            roadmap_completed=[],
            spec_vbrief=None,
            overrides={"t99": {"status": "completed"}},
        )
        assert report.overrides_unused == ["t99"]


# ---------------------------------------------------------------------------
# Reconciliation report
# ---------------------------------------------------------------------------


class TestReconciliationReport:
    def test_no_disagreement_no_file(self, tmp_path):
        result = write_reconciliation_report(ReconciliationReport(), tmp_path)
        assert result is None
        assert not (tmp_path / "migration" / "RECONCILIATION.md").exists()

    def test_file_written_on_disagreement(self, tmp_path):
        report = ReconciliationReport(
            orphans=[{"task_id": "#9", "title": "Orphan"}],
        )
        result = write_reconciliation_report(report, tmp_path)
        assert result is not None
        assert result.name == "RECONCILIATION.md"
        content = result.read_text(encoding="utf-8")
        assert "Orphans in ROADMAP" in content
        assert "#9" in content
        assert "missing-from-spec" in content

    def test_format_includes_per_task_conflict_section(self):
        spec = _spec_with([{"id": "t1", "title": "X", "status": "pending"}])
        _, report = reconcile_scope_items(
            roadmap_active=[],
            roadmap_completed=[{"number": "", "task_id": "t1", "title": "X",
                                "phase": "Completed"}],
            spec_vbrief=spec,
        )
        md = format_reconciliation_markdown(report)
        assert "## t1 -- X" in md
        assert "STATUS conflict" in md
        assert "Resolution:" in md
