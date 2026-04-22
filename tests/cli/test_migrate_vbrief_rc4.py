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

    def test_true_chain_resolves_a_to_b_to_c(self):
        """True A->B->C chain where skill-b's original = skill-a's current.

        Greptile #561 P2 clarification: downstream skills may use the
        previously-renamed name as the ``original`` of a subsequent
        RenameRecord, so current_path_for must iterate until a fixed point.
        """
        manifest = SafetyManifest(
            renames=[
                RenameRecord(
                    original="vbrief/migration/A.md",
                    current="vbrief/migration/B.md",
                    renamed_by="skill-a",
                    renamed_at="2026-04-22T00:00:00Z",
                ),
                RenameRecord(
                    original="vbrief/migration/B.md",
                    current="vbrief/migration/C.md",
                    renamed_by="skill-b",
                    renamed_at="2026-04-22T01:00:00Z",
                ),
            ],
        )
        assert (
            manifest.current_path_for("vbrief/migration/A.md")
            == "vbrief/migration/C.md"
        )

    def test_chain_resolve_does_not_spin_on_cycle(self):
        """Defensive: a pathological cycle A->B->A must terminate."""
        manifest = SafetyManifest(
            renames=[
                RenameRecord(
                    original="A",
                    current="B",
                    renamed_by="bad-skill",
                    renamed_at="2026-04-22T00:00:00Z",
                ),
                RenameRecord(
                    original="B",
                    current="A",
                    renamed_by="bad-skill",
                    renamed_at="2026-04-22T01:00:00Z",
                ),
            ],
        )
        # Loop bound must be <= len(renames)+1 = 3 iterations; the call
        # must return without spinning. Which endpoint is returned is
        # implementation-defined for a cycle; just assert it terminates.
        result = manifest.current_path_for("A")
        assert result in {"A", "B"}

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

    def test_reconciliation_md_section_is_idempotent(self, tmp_path):
        """Greptile #561 P2: re-running migrate must not duplicate the
        ``## Traces lines stripped from LegacyArtifacts`` section when
        PROJECT.md / PRD.md still carry **Traces** lines (neither file is
        replaced by a deprecation stub)."""
        project = _make_safety_project(tmp_path)
        (project / "PROJECT.md").write_text(
            "# Project\n\n## Foo\n\n### t9.9.9: Leftover\n\n**Traces**: FR-99\n",
            encoding="utf-8",
        )
        ok, _ = migrate(project)
        assert ok
        report = project / "vbrief" / "migration" / "RECONCILIATION.md"
        if not report.is_file():
            # PROJECT.md did not trigger LegacyArtifacts capture on this
            # fixture; nothing to assert here.
            return
        first_count = report.read_text(encoding="utf-8").count(
            "## Traces lines stripped from LegacyArtifacts",
        )
        # Re-inject the same PROJECT.md (first run may have replaced it
        # with a deprecation stub) and re-run the migrator.
        (project / "PROJECT.md").write_text(
            "# Project\n\n## Foo\n\n### t9.9.9: Leftover\n\n**Traces**: FR-99\n",
            encoding="utf-8",
        )
        migrate(project)
        second_count = report.read_text(encoding="utf-8").count(
            "## Traces lines stripped from LegacyArtifacts",
        )
        assert first_count == second_count, (
            "Traces-stripped section must not be duplicated on re-run"
        )


# ===========================================================================
# #571 -- migrator auto-bumps vBRIEFInfo.version v0.5 -> v0.6 on ingest
# ===========================================================================


_V05_SPEC_VBRIEF = {
    "vBRIEFInfo": {
        "version": "0.5",
        "description": "Pre-cutover specification carried over from v0.19.",
    },
    "plan": {
        "title": "Pre-cutover spec",
        "status": "approved",
        "narratives": {
            "Overview": "Legacy overview preserved across the version flip.",
        },
        "items": [],
    },
}


_V05_PLAN_VBRIEF = {
    "vBRIEFInfo": {
        "version": "0.5",
        "description": "Pre-cutover session plan.",
    },
    "plan": {
        "title": "Session plan",
        "status": "running",
        "items": [
            {"id": "task-1", "title": "Do the thing", "status": "pending"},
        ],
    },
}


class TestMigratorVersionBump:
    """#571: migrator bumps ``vBRIEFInfo.version`` from ``0.5`` to ``0.6``
    on both pre-existing ``vbrief/specification.vbrief.json`` (via the
    ``_ingest_spec_narratives`` code path) and pre-existing
    ``vbrief/plan.vbrief.json`` (non-speckit session scaffold).
    """

    def _seed_v05_fixture(self, tmp_path: Path) -> Path:
        """Create a synthetic pre-cutover project at v0.5 -- both
        ``specification.vbrief.json`` and ``plan.vbrief.json`` carry
        ``vBRIEFInfo.version: "0.5"`` before migration."""
        project = _make_safety_project(tmp_path)
        vbrief_dir = project / "vbrief"
        (vbrief_dir / "specification.vbrief.json").write_text(
            json.dumps(_V05_SPEC_VBRIEF, indent=2) + "\n",
            encoding="utf-8",
        )
        (vbrief_dir / "plan.vbrief.json").write_text(
            json.dumps(_V05_PLAN_VBRIEF, indent=2) + "\n",
            encoding="utf-8",
        )
        return project

    def test_specification_vbrief_bumped_to_v06(self, tmp_path):
        """Post-migration ``specification.vbrief.json`` must carry v0.6."""
        project = self._seed_v05_fixture(tmp_path)
        ok, actions = migrate(project)
        assert ok, actions
        data = json.loads(
            (project / "vbrief" / "specification.vbrief.json").read_text(
                encoding="utf-8",
            ),
        )
        assert data["vBRIEFInfo"]["version"] == "0.6"
        # Pre-existing narratives must be preserved through the bump --
        # the migrator only touches the envelope version.
        assert (
            data["plan"]["narratives"]["Overview"]
            == "Legacy overview preserved across the version flip."
        )
        # The migrator must surface a BUMP log line so operators can audit.
        assert any(
            "specification.vbrief.json" in a
            and "BUMP" in a
            and "'0.5' -> '0.6'" in a
            for a in actions
        ), (
            "Expected a BUMP log line for specification.vbrief.json, got: "
            f"{[a for a in actions if 'BUMP' in a]}"
        )

    def test_plan_vbrief_bumped_to_v06(self, tmp_path):
        """Post-migration ``plan.vbrief.json`` must carry v0.6."""
        project = self._seed_v05_fixture(tmp_path)
        ok, actions = migrate(project)
        assert ok, actions
        data = json.loads(
            (project / "vbrief" / "plan.vbrief.json").read_text(
                encoding="utf-8",
            ),
        )
        assert data["vBRIEFInfo"]["version"] == "0.6"
        # Items preserved across the bump -- the migrator must not
        # restructure a session plan, only bump the envelope.
        assert data["plan"]["items"][0]["id"] == "task-1"
        assert any(
            "plan.vbrief.json" in a and "BUMP" in a and "'0.5' -> '0.6'" in a
            for a in actions
        ), (
            "Expected a BUMP log line for plan.vbrief.json, got: "
            f"{[a for a in actions if 'BUMP' in a]}"
        )

    def test_dry_run_does_not_persist_bump(self, tmp_path):
        """``--dry-run`` must report the bumps without mutating disk."""
        project = self._seed_v05_fixture(tmp_path)
        ok, actions = migrate(project, dry_run=True)
        assert ok, actions
        spec = json.loads(
            (project / "vbrief" / "specification.vbrief.json").read_text(
                encoding="utf-8",
            ),
        )
        plan = json.loads(
            (project / "vbrief" / "plan.vbrief.json").read_text(
                encoding="utf-8",
            ),
        )
        assert spec["vBRIEFInfo"]["version"] == "0.5"
        assert plan["vBRIEFInfo"]["version"] == "0.5"
        # plan.vbrief.json bump logs under DRYRUN prefix; the
        # specification.vbrief.json bump is performed in-memory even
        # under dry-run (to keep downstream ingest logic consistent) but
        # is not persisted to disk.
        assert any(
            "DRYRUN BUMP plan.vbrief.json" in a for a in actions
        ), f"Missing dry-run BUMP log for plan.vbrief.json: {actions}"

    def test_post_migration_spec_validate_passes(self, tmp_path):
        """After migration, running ``scripts/spec_validate.py`` on the
        bumped ``specification.vbrief.json`` must succeed (the whole
        point of the #571 fix -- the pre-fix state failed here with a
        misleading "migrator sweep" pointer)."""
        import subprocess

        project = self._seed_v05_fixture(tmp_path)
        ok, _ = migrate(project)
        assert ok
        validate_script = REPO_ROOT / "scripts" / "spec_validate.py"
        result = subprocess.run(
            [
                sys.executable,
                str(validate_script),
                str(project / "vbrief" / "specification.vbrief.json"),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
        assert result.returncode == 0, (
            f"spec_validate.py failed on bumped spec\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        )

    def test_spec_validate_error_wording_lost_migrator_sweep(self, tmp_path):
        """When the validator DOES fire (e.g. user hand-wrote a v0.5
        spec somewhere), the error must no longer point at the
        non-existent 'migrator sweep' -- it must point at the real
        ``task migrate:vbrief`` command instead (#571 AC 2).
        """
        import subprocess

        bad_spec = tmp_path / "bad.vbrief.json"
        bad_spec.write_text(
            json.dumps(
                {
                    "vBRIEFInfo": {"version": "0.5"},
                    "plan": {
                        "title": "x",
                        "status": "draft",
                        "items": [],
                    },
                }
            ),
            encoding="utf-8",
        )
        validate_script = REPO_ROOT / "scripts" / "spec_validate.py"
        result = subprocess.run(
            [sys.executable, str(validate_script), str(bad_spec)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
        assert result.returncode == 1
        # Error must point at a real recovery command.
        assert "task migrate:vbrief" in result.stdout, (
            "#571 AC 2: error must point at a real recovery command, got:\n"
            f"{result.stdout}"
        )
        # Error must NOT reference the non-existent 'migrator sweep'.
        assert "migrator sweep" not in result.stdout, (
            "#571 AC 2: 'migrator sweep' phrase MUST be removed, got:\n"
            f"{result.stdout}"
        )


# ===========================================================================
# #567 -- migrate -> rollback leaves a clean working tree (.gitignore
# reversibility via SafetyManifest.file_modifications[])
# ===========================================================================


class TestRollbackReversesGitignore:
    """#567: forward migration records its ``.gitignore`` append in
    ``safety-manifest.json`` under the new ``file_modifications[]`` array,
    and rollback reverses it so ``git status --porcelain`` is empty.
    """

    def test_safety_manifest_records_gitignore_modification(self, tmp_path):
        project = _make_safety_project(tmp_path)
        # Seed a pre-existing .gitignore so the modification records
        # operation == "append" (the common consumer case). The
        # greenfield "create" path is exercised by
        # ``test_rollback_removes_gitignore_created_by_migrator``.
        (project / ".gitignore").write_text(
            "# Project rules\n__pycache__/\n", encoding="utf-8",
        )
        ok, actions = migrate(project)
        assert ok, actions
        manifest = load_safety_manifest(project)
        assert manifest is not None
        assert manifest.file_modifications, (
            "#567: safety manifest must record every in-place file "
            "modification (the .gitignore append) so rollback can reverse it"
        )
        entry = next(
            (
                m
                for m in manifest.file_modifications
                if m.path == ".gitignore"
            ),
            None,
        )
        assert entry is not None, (
            "#567: .gitignore append must appear as a file_modifications entry"
        )
        assert entry.operation == "append"
        assert entry.pre_hash != entry.post_hash
        assert "*.premigrate.md" in entry.appended_content

    def test_rollback_restores_gitignore_to_pre_migration_bytes(self, tmp_path):
        project = _make_safety_project(tmp_path)
        # Pre-seed with a non-trivial .gitignore so we can verify the
        # pre-migration bytes survive a round trip byte-for-byte.
        gitignore = project / ".gitignore"
        pre_content = "# Project rules\n__pycache__/\n.env\n"
        gitignore.write_text(pre_content, encoding="utf-8")
        ok, _ = migrate(project)
        assert ok
        # After migration the file must have grown to include the
        # migrator's appended block.
        post_content = gitignore.read_text(encoding="utf-8")
        assert "*.premigrate.md" in post_content
        # Rollback restores the pre-migration bytes.
        ok, actions = safety_rollback(project, force=True)
        assert ok, actions
        assert gitignore.read_text(encoding="utf-8") == pre_content, (
            "#567: rollback must restore .gitignore to its pre-migration "
            "bytes (strip the appended content)"
        )

    def test_rollback_removes_gitignore_created_by_migrator(self, tmp_path):
        """When the migrator CREATED the .gitignore (greenfield), rollback
        must delete it entirely -- the pre-migration state was 'file
        absent', not 'file empty'."""
        project = _make_safety_project(tmp_path)
        assert not (project / ".gitignore").exists()
        ok, _ = migrate(project)
        assert ok
        assert (project / ".gitignore").is_file()
        ok, _ = safety_rollback(project, force=True)
        assert ok
        assert not (project / ".gitignore").exists(), (
            "#567: a .gitignore the migrator CREATED from scratch must be "
            "removed on rollback (pre-migration state was absent)"
        )

    def test_rollback_refuses_if_gitignore_edited_without_force(self, tmp_path):
        """Operator edits after migration must block rollback unless
        ``--force`` is passed -- same pattern as
        ``post_migration_stub_hashes`` for SPECIFICATION.md / PROJECT.md."""
        project = _make_safety_project(tmp_path)
        ok, _ = migrate(project)
        assert ok
        gitignore = project / ".gitignore"
        # Operator appends a new rule post-migration.
        gitignore.write_text(
            gitignore.read_text(encoding="utf-8") + "\n# operator edit\n",
            encoding="utf-8",
        )
        ok, messages = safety_rollback(
            project, force=False, confirm_fn=lambda _: True,
        )
        assert not ok
        joined = "\n".join(messages)
        assert ".gitignore" in joined
        assert (
            "edited since migration" in joined
            or "edited .gitignore" in joined
        )

    def test_migrate_then_rollback_leaves_clean_git_tree(self, tmp_path):
        """Cross-platform end-to-end regression: migrate -> rollback ->
        ``git status --porcelain`` must be empty (#567 AC 3)."""
        import subprocess

        project = _make_safety_project(tmp_path)

        def _git(*args: str) -> subprocess.CompletedProcess:
            return subprocess.run(
                [
                    "git",
                    "-c", "user.email=rollback-567@example.invalid",
                    "-c", "user.name=Rollback 567 Test",
                    "-c", "commit.gpgsign=false",
                    "-c", "core.autocrlf=false",
                    *args,
                ],
                cwd=str(project),
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )

        init = _git("init", "-q", "-b", "main")
        if init.returncode != 0:
            import pytest as _pytest
            _pytest.skip(f"git not available: {init.stderr}")
        _git("add", "-A")
        _git("commit", "-q", "-m", "initial pre-migration state")
        assert _git("status", "--porcelain").stdout.strip() == ""

        ok, _ = migrate(project)
        assert ok
        # Sanity: something changed.
        assert _git("status", "--porcelain").stdout.strip() != ""

        ok, actions = safety_rollback(project, force=True)
        assert ok, actions
        status = _git("status", "--porcelain").stdout
        assert status.strip() == "", (
            "#567: migrate -> rollback must leave a clean tree, got:\n"
            f"{status}"
        )

    def test_gitignore_append_is_idempotent_on_force_rerun(self, tmp_path):
        """#567 minor: second migrate with ``--force`` must be a no-op on
        the .gitignore (the patterns are already present)."""
        project = _make_safety_project(tmp_path)
        ok, _ = migrate(project)
        assert ok
        first_body = (project / ".gitignore").read_text(encoding="utf-8")
        ok2, _ = migrate(project, force=True)
        # Second run may refuse further mutation (stubs in place), but if
        # it does proceed, the .gitignore must remain unchanged.
        del ok2
        second_body = (project / ".gitignore").read_text(encoding="utf-8")
        assert first_body == second_body
        assert second_body.count("*.premigrate.md") == 1
