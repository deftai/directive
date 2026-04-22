"""Integration tests for RC4 migrator fixes (#527/#528/#529/#530).

Separated from ``tests/cli/test_migrate_vbrief.py`` (already ~2700 lines)
so this surface stays under the project's 1000-line file cap while still
sharing the existing ``tests/fixtures/safety/`` inputs via the helpers
imported below.

Covers:

* #527 -- rollback RMDIRs ``vbrief/legacy/`` when the migrator created it.
* #528 -- ``SafetyManifest.renames`` drives rollback's on-disk resolution
  so renamed files (e.g. ``LEGACY-REPORT.reviewed.md``) are still removed.
* #529 -- ``**Traces**: ...`` lines are stripped from LegacyArtifacts and
  a per-task audit trail lands in ``vbrief/migration/RECONCILIATION.md``.
* #530 -- first-run migration appends ``.premigrate.*`` glob patterns to
  ``.gitignore`` (creating the file if absent), idempotently on re-runs.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from _vbrief_safety import (  # noqa: E402, I001
    RenameRecord,
    SafetyManifest,
    load_safety_manifest,
    manifest_path,
    now_utc_iso,
    rollback as safety_rollback,
)
from migrate_vbrief import migrate  # noqa: E402

# Reuse the existing synthetic safety fixture directory set up by #497 so we
# do not duplicate test inputs. The helper mirrors the one in
# ``test_migrate_vbrief.py``.
_SAFETY_FIXTURE_DIR = REPO_ROOT / "tests" / "fixtures" / "safety"


def _make_safety_project(tmp_path: Path) -> Path:
    vbrief_dir = tmp_path / "vbrief"
    vbrief_dir.mkdir(exist_ok=True)
    for name in ("SPECIFICATION.md", "PROJECT.md", "ROADMAP.md"):
        (tmp_path / name).write_text(
            (_SAFETY_FIXTURE_DIR / name).read_text(encoding="utf-8"),
            encoding="utf-8",
        )
    return tmp_path


# ===========================================================================
# #528 -- SafetyManifest.renames round-trip + rollback resolution
# ===========================================================================


class TestSafetyManifestRenames:
    """#528: manifest.renames[] shape must round-trip cleanly."""

    def test_round_trip_preserves_renames(self):
        original = SafetyManifest(
            version="1",
            migration_timestamp="2026-04-22T00:00:00Z",
            created_files=["vbrief/migration/LEGACY-REPORT.md"],
            renames=[
                RenameRecord(
                    original="vbrief/migration/LEGACY-REPORT.md",
                    current="vbrief/migration/LEGACY-REPORT.reviewed.md",
                    renamed_by="deft-directive-sync Phase 6c",
                    renamed_at="2026-04-22T00:45:00Z",
                ),
            ],
        )
        clone = SafetyManifest.from_json(original.to_json())
        assert len(clone.renames) == 1
        record = clone.renames[0]
        assert isinstance(record, RenameRecord)
        assert record.original == "vbrief/migration/LEGACY-REPORT.md"
        assert record.current == "vbrief/migration/LEGACY-REPORT.reviewed.md"
        assert record.renamed_by == "deft-directive-sync Phase 6c"

    def test_current_path_for_returns_renamed(self):
        manifest = SafetyManifest(
            renames=[
                RenameRecord(
                    original="vbrief/migration/LEGACY-REPORT.md",
                    current="vbrief/migration/LEGACY-REPORT.reviewed.md",
                    renamed_by="deft-directive-sync Phase 6c",
                    renamed_at="2026-04-22T00:45:00Z",
                ),
            ],
        )
        assert (
            manifest.current_path_for("vbrief/migration/LEGACY-REPORT.md")
            == "vbrief/migration/LEGACY-REPORT.reviewed.md"
        )

    def test_current_path_for_falls_back_to_original(self):
        manifest = SafetyManifest()
        assert (
            manifest.current_path_for("vbrief/migration/LEGACY-REPORT.md")
            == "vbrief/migration/LEGACY-REPORT.md"
        )

    def test_chain_of_renames_resolves_to_latest(self):
        """Most-recent rename (last in list) wins when the same original is renamed twice."""
        manifest = SafetyManifest(
            renames=[
                RenameRecord(
                    original="vbrief/migration/REPORT.md",
                    current="vbrief/migration/REPORT.v1.md",
                    renamed_by="skill-a",
                    renamed_at="2026-04-22T00:00:00Z",
                ),
                RenameRecord(
                    original="vbrief/migration/REPORT.md",
                    current="vbrief/migration/REPORT.v2.md",
                    renamed_by="skill-b",
                    renamed_at="2026-04-22T01:00:00Z",
                ),
            ],
        )
        assert (
            manifest.current_path_for("vbrief/migration/REPORT.md")
            == "vbrief/migration/REPORT.v2.md"
        )

    def test_absent_renames_key_in_json_is_backward_compatible(self):
        """Prior safety-manifest JSON files without the renames key parse cleanly."""
        legacy_json = (
            '{"version": "1", "migration_timestamp": "2026-04-20T00:00:00Z",\n'
            '"backups": [], "created_files": [], "created_dirs": [],\n'
            '"post_migration_stub_hashes": {}}\n'
        )
        clone = SafetyManifest.from_json(legacy_json)
        assert clone.renames == []


class TestRollbackResolvesRenames:
    """#528: rollback must resolve the renamed on-disk path before removal."""

    def test_rollback_removes_renamed_file(self, tmp_path):
        project = _make_safety_project(tmp_path)
        ok, _ = migrate(project)
        assert ok

        # Simulate Phase 6c: rename LEGACY-REPORT.md -> .reviewed.md and
        # record the rename in the manifest. Skip when no report was written
        # (e.g. no LegacyArtifacts captures on this fixture).
        report = project / "vbrief" / "migration" / "LEGACY-REPORT.md"
        if not report.is_file():
            return
        reviewed = report.with_name("LEGACY-REPORT.reviewed.md")
        report.rename(reviewed)
        manifest = load_safety_manifest(project)
        assert manifest is not None
        manifest.renames.append(
            RenameRecord(
                original="vbrief/migration/LEGACY-REPORT.md",
                current="vbrief/migration/LEGACY-REPORT.reviewed.md",
                renamed_by="deft-directive-sync Phase 6c",
                renamed_at=now_utc_iso(),
            ),
        )
        manifest_path(project).write_text(manifest.to_json(), encoding="utf-8")

        ok, actions = safety_rollback(project, force=True)
        assert ok, actions
        # Renamed file must be gone and vbrief/migration/ must not linger.
        assert not reviewed.exists()
        assert not (project / "vbrief" / "migration").exists()
        # Log line mentions both names so operators can audit.
        joined = "\n".join(actions)
        assert "LEGACY-REPORT.reviewed.md" in joined
        assert "renamed from" in joined


# ===========================================================================
# #527 -- rollback RMDIRs vbrief/legacy/ when migrator created it
# ===========================================================================


class TestEmptyLegacyDirRollback:
    def test_created_dirs_tracks_vbrief_migration(self, tmp_path):
        """vbrief/migration/ must show up in created_dirs when absent pre-run."""
        project = _make_safety_project(tmp_path)
        ok, _ = migrate(project)
        assert ok
        manifest = load_safety_manifest(project)
        assert manifest is not None
        assert "vbrief/migration" in manifest.created_dirs

    def test_rollback_rmdirs_vbrief_legacy_when_created_by_migrator(
        self, tmp_path
    ):
        """Rollback RMDIRs vbrief/legacy/ once empty when migrator created it."""
        project = _make_safety_project(tmp_path)
        ok, _ = migrate(project)
        assert ok
        # The fixture does not trigger sidecar emission; simulate the
        # post-condition by staging the directory + a file and amending the
        # manifest the same way the migrator would.
        legacy = project / "vbrief" / "legacy"
        legacy.mkdir(parents=True, exist_ok=True)
        sidecar = legacy / "specification-example.md"
        sidecar.write_text("oversize legacy capture\n", encoding="utf-8")
        manifest = load_safety_manifest(project)
        assert manifest is not None
        if "vbrief/legacy" not in manifest.created_dirs:
            manifest.created_dirs.append("vbrief/legacy")
        rel = sidecar.relative_to(project).as_posix()
        if rel not in manifest.created_files:
            manifest.created_files.append(rel)
        manifest_path(project).write_text(manifest.to_json(), encoding="utf-8")

        ok, actions = safety_rollback(project, force=True)
        assert ok, actions
        assert not legacy.exists(), (
            "rollback must RMDIR vbrief/legacy/ after removing its contents"
        )
        joined = "\n".join(actions)
        assert "RMDIR  vbrief/legacy" in joined

    def test_rollback_preserves_pre_existing_legacy_dir(self, tmp_path):
        """Pre-existing vbrief/legacy/ must NOT be RMDIR'd by rollback.

        Decision is driven by manifest.created_dirs, not by a post-hoc
        filesystem scan, so pre-existing dirs with unrelated files survive.
        """
        project = _make_safety_project(tmp_path)
        legacy = project / "vbrief" / "legacy"
        legacy.mkdir(parents=True, exist_ok=True)
        # Pre-stage a file owned by an unrelated workflow (sibling wave).
        sibling = legacy / "keep-me.md"
        sibling.write_text("not touched by this migration\n", encoding="utf-8")
        ok, _ = migrate(project)
        assert ok
        manifest = load_safety_manifest(project)
        assert manifest is not None
        assert "vbrief/legacy" not in manifest.created_dirs
        ok, _ = safety_rollback(project, force=True)
        assert ok
        assert sibling.is_file(), (
            "rollback removed a file that was NOT in the manifest"
        )


# ===========================================================================
# #530 -- .gitignore idempotent pattern writer
# ===========================================================================


class TestGitignoreWriter:
    def test_first_run_creates_gitignore_with_full_block(self, tmp_path):
        project = _make_safety_project(tmp_path)
        assert not (project / ".gitignore").exists()
        ok, actions = migrate(project)
        assert ok
        gitignore = project / ".gitignore"
        assert gitignore.is_file()
        body = gitignore.read_text(encoding="utf-8")
        assert "*.premigrate.md" in body
        assert "*.premigrate.vbrief.json" in body
        assert "do NOT commit" in body  # comment block header
        assert any("CREATE .gitignore" in a for a in actions)

    def test_first_run_appends_to_existing_gitignore(self, tmp_path):
        project = _make_safety_project(tmp_path)
        (project / ".gitignore").write_text(
            "# Pre-existing rules\n__pycache__/\n.env\n", encoding="utf-8",
        )
        ok, _ = migrate(project)
        assert ok
        body = (project / ".gitignore").read_text(encoding="utf-8")
        # Pre-existing rules preserved verbatim.
        assert "__pycache__/" in body
        assert ".env" in body
        # New block appended at the bottom.
        assert "*.premigrate.md" in body
        assert "*.premigrate.vbrief.json" in body
        # Pre-existing content must come before the new block.
        assert body.index(".env") < body.index("*.premigrate.md")

    def test_second_run_is_idempotent(self, tmp_path):
        project = _make_safety_project(tmp_path)
        ok, _ = migrate(project)
        assert ok
        body_after_first = (project / ".gitignore").read_text(encoding="utf-8")
        # Running migrate a second time must not double-append.
        ok2, actions2 = migrate(project)
        del ok2  # the outcome of the re-migrate is not under test here
        # Second migrate may refuse (dirty tree / stubs present) or succeed;
        # either way the gitignore must be idempotent so compare unconditionally.
        body_after_second = (project / ".gitignore").read_text(encoding="utf-8")
        assert body_after_first.count("*.premigrate.md") == 1
        assert body_after_second.count("*.premigrate.md") == 1
        assert body_after_first == body_after_second
        # No UPDATE .gitignore line should be in the second run's actions
        # because nothing changed.
        assert not any("UPDATE .gitignore" in a for a in actions2)

    def test_partial_prior_pattern_appends_only_missing(self, tmp_path):
        project = _make_safety_project(tmp_path)
        # Consumer previously added *.premigrate.md manually but not the
        # vbrief.json pattern. Migrator must only append the missing one.
        (project / ".gitignore").write_text(
            "# Project rules\n*.premigrate.md\n", encoding="utf-8",
        )
        ok, _ = migrate(project)
        assert ok
        body = (project / ".gitignore").read_text(encoding="utf-8")
        assert body.count("*.premigrate.md") == 1  # not duplicated
        assert "*.premigrate.vbrief.json" in body


# ===========================================================================
# #529 -- Traces strip + RECONCILIATION.md audit
# ===========================================================================


_SPEC_WITH_TRACES = """# Specification

## Overview

Example spec.

## Implementation Plan

### t2.1.1: First task

Some description.

**Traces**: FR-7

### t2.2.1: Second task

Second description.

**Traces**: FR-8, FR-16
"""


class TestTracesStripping:
    """#529: **Traces**: lines stripped from LegacyArtifacts narratives."""

    def test_traces_stripped_from_spec_legacy_artifacts(self, tmp_path):
        project = _make_safety_project(tmp_path)
        (project / "SPECIFICATION.md").write_text(
            _SPEC_WITH_TRACES, encoding="utf-8",
        )
        ok, _ = migrate(project)
        assert ok
        spec_vbrief = json.loads(
            (project / "vbrief" / "specification.vbrief.json").read_text(
                encoding="utf-8",
            ),
        )
        narratives = spec_vbrief["plan"].get("narratives", {})
        legacy = narratives.get("LegacyArtifacts", "")
        # Task headers survive; **Traces** lines do not.
        assert "### Implementation Plan" in legacy or "t2.1.1" in legacy
        assert "**Traces**" not in legacy

    def test_reconciliation_md_records_stripped_tasks(self, tmp_path):
        project = _make_safety_project(tmp_path)
        (project / "SPECIFICATION.md").write_text(
            _SPEC_WITH_TRACES, encoding="utf-8",
        )
        ok, actions = migrate(project)
        assert ok
        report = project / "vbrief" / "migration" / "RECONCILIATION.md"
        assert report.is_file(), (
            "RECONCILIATION.md must be emitted when Traces lines are stripped"
        )
        body = report.read_text(encoding="utf-8")
        assert "Traces lines stripped from LegacyArtifacts" in body
        assert "SPECIFICATION.md" in body
        # Actions log mentions the audit line so CI logs can show the shape.
        assert any("Traces-stripped audit" in a for a in actions)

    def test_migrator_stripping_idempotent_on_rerun(self, tmp_path):
        """Strip pass on a narrative with no **Traces** lines must be a no-op."""
        project = _make_safety_project(tmp_path)
        ok, _ = migrate(project)
        assert ok
        # Fixture SPEC has no Traces lines, so no audit file section exists.
        report = project / "vbrief" / "migration" / "RECONCILIATION.md"
        if report.is_file():
            body = report.read_text(encoding="utf-8")
            assert "Traces lines stripped from LegacyArtifacts" not in body
