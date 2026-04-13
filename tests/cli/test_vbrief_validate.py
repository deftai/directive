"""
test_vbrief_validate.py -- Tests for scripts/vbrief_validate.py.

Covers scope vBRIEF validation (schema, required fields, status enum,
filename convention), PROJECT-DEFINITION validation (narratives, item refs),
folder/status consistency (D2), epic-story bidirectional links (D4),
and origin provenance warnings (D11).

Story: #333 (RFC #309)
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def run_validator(
    vbrief_dir: Path, env: dict | None = None
) -> subprocess.CompletedProcess:
    """Run vbrief_validate.py with --vbrief-dir pointing to a test fixture."""
    script = REPO_ROOT / "scripts" / "vbrief_validate.py"
    merged_env = {**os.environ, **(env or {})}
    return subprocess.run(
        [sys.executable, str(script), "--vbrief-dir", str(vbrief_dir)],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        env=merged_env,
        timeout=30,
    )


def minimal_vbrief(
    *,
    title: str = "Test scope",
    status: str = "draft",
    version: str = "0.5",
    items: list | None = None,
    narratives: dict | None = None,
    references: list | None = None,
    plan_ref: str | None = None,
) -> dict:
    """Build a minimal valid vBRIEF v0.5 document."""
    plan: dict = {
        "title": title,
        "status": status,
        "items": items if items is not None else [
            {"title": "Task 1", "status": "pending"}
        ],
    }
    if narratives is not None:
        plan["narratives"] = narratives
    if references is not None:
        plan["references"] = references
    if plan_ref is not None:
        plan["planRef"] = plan_ref
    return {
        "vBRIEFInfo": {"version": version},
        "plan": plan,
    }


def write_vbrief(filepath: Path, data: dict) -> None:
    """Write a vBRIEF JSON file."""
    filepath.parent.mkdir(parents=True, exist_ok=True)
    filepath.write_text(json.dumps(data, indent=2), encoding="utf-8")


def make_lifecycle_dirs(vbrief_dir: Path) -> None:
    """Create all lifecycle folders."""
    for folder in ("proposed", "pending", "active", "completed", "cancelled"):
        (vbrief_dir / folder).mkdir(parents=True, exist_ok=True)


# ===========================================================================
# Scope vBRIEF schema validation
# ===========================================================================

class TestScopeSchemaValidation:
    """Tests for individual scope vBRIEF schema validation."""

    def test_valid_scope_vbrief_passes(self, tmp_path):
        """A well-formed scope vBRIEF in a lifecycle folder passes."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        write_vbrief(
            vbrief_dir / "proposed" / "2026-04-13-test-feature.vbrief.json",
            minimal_vbrief(status="draft"),
        )
        result = run_validator(vbrief_dir)
        assert result.returncode == 0
        assert "validation passed" in result.stdout

    def test_missing_vbrief_info(self, tmp_path):
        """Missing vBRIEFInfo key is an error."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        bad = {"plan": {"title": "X", "status": "draft", "items": []}}
        write_vbrief(
            vbrief_dir / "proposed" / "2026-04-13-bad.vbrief.json", bad
        )
        result = run_validator(vbrief_dir)
        assert result.returncode == 1
        assert "vBRIEFInfo" in result.stdout

    def test_wrong_version(self, tmp_path):
        """vBRIEFInfo.version != '0.5' is an error."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        write_vbrief(
            vbrief_dir / "proposed" / "2026-04-13-old-ver.vbrief.json",
            minimal_vbrief(version="0.4"),
        )
        result = run_validator(vbrief_dir)
        assert result.returncode == 1
        assert "0.5" in result.stdout

    def test_missing_plan(self, tmp_path):
        """Missing plan key is an error."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        bad = {"vBRIEFInfo": {"version": "0.5"}}
        write_vbrief(
            vbrief_dir / "proposed" / "2026-04-13-no-plan.vbrief.json", bad
        )
        result = run_validator(vbrief_dir)
        assert result.returncode == 1
        assert "plan" in result.stdout.lower()

    def test_missing_plan_title(self, tmp_path):
        """Missing plan.title is an error."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        doc = minimal_vbrief()
        del doc["plan"]["title"]
        write_vbrief(
            vbrief_dir / "proposed" / "2026-04-13-no-title.vbrief.json", doc
        )
        result = run_validator(vbrief_dir)
        assert result.returncode == 1
        assert "title" in result.stdout

    def test_missing_plan_status(self, tmp_path):
        """Missing plan.status is an error."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        doc = minimal_vbrief()
        del doc["plan"]["status"]
        write_vbrief(
            vbrief_dir / "proposed" / "2026-04-13-no-status.vbrief.json", doc
        )
        result = run_validator(vbrief_dir)
        assert result.returncode == 1
        assert "status" in result.stdout

    def test_missing_plan_items(self, tmp_path):
        """Missing plan.items is an error."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        doc = minimal_vbrief()
        del doc["plan"]["items"]
        write_vbrief(
            vbrief_dir / "proposed" / "2026-04-13-no-items.vbrief.json", doc
        )
        result = run_validator(vbrief_dir)
        assert result.returncode == 1
        assert "items" in result.stdout

    def test_invalid_status_value(self, tmp_path):
        """Invalid plan.status value is an error."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        write_vbrief(
            vbrief_dir / "proposed" / "2026-04-13-bad-status.vbrief.json",
            minimal_vbrief(status="invalid_status"),
        )
        result = run_validator(vbrief_dir)
        assert result.returncode == 1
        assert "invalid" in result.stdout.lower()

    def test_invalid_json_file(self, tmp_path):
        """Malformed JSON is an error."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        bad_file = vbrief_dir / "proposed" / "2026-04-13-bad-json.vbrief.json"
        bad_file.parent.mkdir(parents=True, exist_ok=True)
        bad_file.write_text("{invalid json", encoding="utf-8")
        result = run_validator(vbrief_dir)
        assert result.returncode == 1
        assert "invalid JSON" in result.stdout or "JSON" in result.stdout


# ===========================================================================
# D7: Filename convention
# ===========================================================================

class TestFilenameConvention:
    """Tests for YYYY-MM-DD-descriptive-slug.vbrief.json naming (D7)."""

    def test_valid_filename_passes(self, tmp_path):
        """Correctly named file passes filename validation."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        write_vbrief(
            vbrief_dir / "proposed" / "2026-04-13-add-oauth.vbrief.json",
            minimal_vbrief(status="draft"),
        )
        result = run_validator(vbrief_dir)
        assert result.returncode == 0

    def test_bad_filename_no_date(self, tmp_path):
        """Filename without date prefix fails (D7)."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        write_vbrief(
            vbrief_dir / "proposed" / "add-oauth.vbrief.json",
            minimal_vbrief(status="draft"),
        )
        result = run_validator(vbrief_dir)
        assert result.returncode == 1
        assert "D7" in result.stdout

    def test_bad_filename_uppercase(self, tmp_path):
        """Filename with uppercase slug fails (D7)."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        write_vbrief(
            vbrief_dir / "proposed" / "2026-04-13-Add-OAuth.vbrief.json",
            minimal_vbrief(status="draft"),
        )
        result = run_validator(vbrief_dir)
        assert result.returncode == 1
        assert "D7" in result.stdout

    def test_bad_filename_underscores(self, tmp_path):
        """Filename with underscores instead of hyphens fails (D7)."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        write_vbrief(
            vbrief_dir / "proposed" / "2026-04-13-add_oauth.vbrief.json",
            minimal_vbrief(status="draft"),
        )
        result = run_validator(vbrief_dir)
        assert result.returncode == 1
        assert "D7" in result.stdout


# ===========================================================================
# D2: Folder/status consistency
# ===========================================================================

class TestFolderStatusConsistency:
    """Tests for folder/status matching (D2)."""

    @pytest.mark.parametrize(
        "folder,status",
        [
            ("proposed", "draft"),
            ("proposed", "proposed"),
            ("pending", "approved"),
            ("pending", "pending"),
            ("active", "running"),
            ("active", "blocked"),
            ("completed", "completed"),
            ("cancelled", "cancelled"),
        ],
    )
    def test_valid_folder_status_combinations(self, tmp_path, folder, status):
        """Each valid folder/status combination passes."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        write_vbrief(
            vbrief_dir / folder / "2026-04-13-test.vbrief.json",
            minimal_vbrief(status=status),
        )
        result = run_validator(vbrief_dir)
        assert result.returncode == 0

    def test_status_mismatch_proposed_running(self, tmp_path):
        """File in proposed/ with status=running is an error (D2)."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        write_vbrief(
            vbrief_dir / "proposed" / "2026-04-13-mismatch.vbrief.json",
            minimal_vbrief(status="running"),
        )
        result = run_validator(vbrief_dir)
        assert result.returncode == 1
        assert "D2" in result.stdout

    def test_status_mismatch_active_completed(self, tmp_path):
        """File in active/ with status=completed is an error (D2)."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        write_vbrief(
            vbrief_dir / "active" / "2026-04-13-done-wrong.vbrief.json",
            minimal_vbrief(status="completed"),
        )
        result = run_validator(vbrief_dir)
        assert result.returncode == 1
        assert "D2" in result.stdout

    def test_status_mismatch_completed_draft(self, tmp_path):
        """File in completed/ with status=draft is an error (D2)."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        write_vbrief(
            vbrief_dir / "completed" / "2026-04-13-not-done.vbrief.json",
            minimal_vbrief(status="draft"),
        )
        result = run_validator(vbrief_dir)
        assert result.returncode == 1
        assert "D2" in result.stdout


# ===========================================================================
# D3: PROJECT-DEFINITION.vbrief.json
# ===========================================================================

class TestProjectDefinitionValidation:
    """Tests for PROJECT-DEFINITION.vbrief.json validation (D3)."""

    def test_valid_project_definition(self, tmp_path):
        """Valid PROJECT-DEFINITION passes."""
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()
        write_vbrief(
            vbrief_dir / "PROJECT-DEFINITION.vbrief.json",
            minimal_vbrief(
                title="My Project",
                status="running",
                narratives={
                    "Overview": "A test project.",
                    "Tech Stack": "Python, Go",
                },
            ),
        )
        result = run_validator(vbrief_dir)
        assert result.returncode == 0

    def test_missing_overview_narrative(self, tmp_path):
        """Missing 'overview' narrative key is an error (D3)."""
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()
        write_vbrief(
            vbrief_dir / "PROJECT-DEFINITION.vbrief.json",
            minimal_vbrief(
                title="My Project",
                status="running",
                narratives={"Tech Stack": "Python"},
            ),
        )
        result = run_validator(vbrief_dir)
        assert result.returncode == 1
        assert "overview" in result.stdout.lower()

    def test_missing_tech_stack_narrative(self, tmp_path):
        """Missing 'tech stack' narrative key is an error (D3)."""
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()
        write_vbrief(
            vbrief_dir / "PROJECT-DEFINITION.vbrief.json",
            minimal_vbrief(
                title="My Project",
                status="running",
                narratives={"Overview": "A project"},
            ),
        )
        result = run_validator(vbrief_dir)
        assert result.returncode == 1
        assert "tech stack" in result.stdout.lower()

    def test_items_reference_nonexistent_file(self, tmp_path):
        """Items referencing nonexistent scope vBRIEF is an error (D3)."""
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()
        doc = minimal_vbrief(
            title="My Project",
            status="running",
            narratives={
                "Overview": "A project",
                "Tech Stack": "Python",
            },
            items=[
                {
                    "title": "Feature X",
                    "status": "running",
                    "references": [
                        {
                            "uri": "active/2026-04-13-nonexistent.vbrief.json",
                            "type": "x-vbrief/plan",
                        }
                    ],
                }
            ],
        )
        write_vbrief(
            vbrief_dir / "PROJECT-DEFINITION.vbrief.json", doc
        )
        result = run_validator(vbrief_dir)
        assert result.returncode == 1
        assert "does not exist" in result.stdout

    def test_items_reference_existing_file(self, tmp_path):
        """Items referencing existing scope vBRIEF passes."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        # Create the referenced scope vBRIEF
        write_vbrief(
            vbrief_dir / "active" / "2026-04-13-feature-x.vbrief.json",
            minimal_vbrief(status="running"),
        )
        doc = minimal_vbrief(
            title="My Project",
            status="running",
            narratives={
                "Overview": "A project",
                "Tech Stack": "Python",
            },
            items=[
                {
                    "title": "Feature X",
                    "status": "running",
                    "references": [
                        {
                            "uri": "active/2026-04-13-feature-x.vbrief.json",
                            "type": "x-vbrief/plan",
                        }
                    ],
                }
            ],
        )
        write_vbrief(
            vbrief_dir / "PROJECT-DEFINITION.vbrief.json", doc
        )
        result = run_validator(vbrief_dir)
        assert result.returncode == 0


# ===========================================================================
# D4: Epic-story bidirectional link validation
# ===========================================================================

class TestEpicStoryLinks:
    """Tests for epic-story bidirectional references (D4)."""

    def test_valid_bidirectional_links(self, tmp_path):
        """Epic references child, child has planRef back -- passes."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)

        epic_path = "active/2026-04-13-epic.vbrief.json"
        story_path = "active/2026-04-13-story.vbrief.json"

        # Epic references story
        write_vbrief(
            vbrief_dir / epic_path,
            minimal_vbrief(
                title="Epic",
                status="running",
                references=[
                    {"uri": story_path, "type": "x-vbrief/plan"}
                ],
            ),
        )
        # Story has planRef back to epic
        write_vbrief(
            vbrief_dir / story_path,
            minimal_vbrief(
                title="Story",
                status="running",
                plan_ref=epic_path,
            ),
        )

        result = run_validator(vbrief_dir)
        assert result.returncode == 0

    def test_epic_references_nonexistent_child(self, tmp_path):
        """Epic references a child file that doesn't exist -- error (D4)."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)

        write_vbrief(
            vbrief_dir / "active" / "2026-04-13-epic.vbrief.json",
            minimal_vbrief(
                title="Epic",
                status="running",
                references=[
                    {
                        "uri": "active/2026-04-13-ghost.vbrief.json",
                        "type": "x-vbrief/plan",
                    }
                ],
            ),
        )

        result = run_validator(vbrief_dir)
        assert result.returncode == 1
        assert "does not exist" in result.stdout
        assert "D4" in result.stdout

    def test_child_missing_plan_ref_back(self, tmp_path):
        """Epic references child but child has no planRef back -- error (D4)."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)

        epic_path = "active/2026-04-13-epic.vbrief.json"
        story_path = "active/2026-04-13-story.vbrief.json"

        write_vbrief(
            vbrief_dir / epic_path,
            minimal_vbrief(
                title="Epic",
                status="running",
                references=[
                    {"uri": story_path, "type": "x-vbrief/plan"}
                ],
            ),
        )
        # Story has NO planRef
        write_vbrief(
            vbrief_dir / story_path,
            minimal_vbrief(title="Story", status="running"),
        )

        result = run_validator(vbrief_dir)
        assert result.returncode == 1
        assert "planRef" in result.stdout
        assert "D4" in result.stdout

    def test_story_planref_to_nonexistent_parent(self, tmp_path):
        """Story has planRef to a parent that doesn't exist -- error (D4)."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)

        write_vbrief(
            vbrief_dir / "active" / "2026-04-13-orphan.vbrief.json",
            minimal_vbrief(
                title="Orphan Story",
                status="running",
                plan_ref="active/2026-04-13-missing-parent.vbrief.json",
            ),
        )

        result = run_validator(vbrief_dir)
        assert result.returncode == 1
        assert "does not exist" in result.stdout
        assert "D4" in result.stdout

    def test_story_planref_parent_not_listing_child(self, tmp_path):
        """Story has planRef to parent, but parent doesn't list child -- error (D4)."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)

        epic_path = "active/2026-04-13-epic.vbrief.json"
        story_path = "active/2026-04-13-story.vbrief.json"

        # Epic exists but does NOT reference the story
        write_vbrief(
            vbrief_dir / epic_path,
            minimal_vbrief(title="Epic", status="running"),
        )
        # Story points back to epic
        write_vbrief(
            vbrief_dir / story_path,
            minimal_vbrief(
                title="Story",
                status="running",
                plan_ref=epic_path,
            ),
        )

        result = run_validator(vbrief_dir)
        assert result.returncode == 1
        assert "does not list this file" in result.stdout
        assert "D4" in result.stdout


# ===========================================================================
# D11: Origin provenance check
# ===========================================================================

class TestOriginProvenance:
    """Tests for origin provenance warnings (D11)."""

    def test_pending_without_origin_warns(self, tmp_path):
        """Scope vBRIEF in pending/ with no origin reference triggers warning."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        write_vbrief(
            vbrief_dir / "pending" / "2026-04-13-no-origin.vbrief.json",
            minimal_vbrief(status="pending"),
        )
        result = run_validator(vbrief_dir)
        # Should pass (warnings are not errors) but show warning
        assert result.returncode == 0
        assert "D11" in result.stdout

    def test_active_without_origin_warns(self, tmp_path):
        """Scope vBRIEF in active/ with no origin reference triggers warning."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        write_vbrief(
            vbrief_dir / "active" / "2026-04-13-no-origin.vbrief.json",
            minimal_vbrief(status="running"),
        )
        result = run_validator(vbrief_dir)
        assert result.returncode == 0
        assert "D11" in result.stdout

    def test_pending_with_origin_no_warning(self, tmp_path):
        """Scope vBRIEF in pending/ with origin reference does not warn."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        write_vbrief(
            vbrief_dir / "pending" / "2026-04-13-has-origin.vbrief.json",
            minimal_vbrief(
                status="pending",
                references=[
                    {
                        "uri": "https://github.com/deftai/directive/issues/100",
                        "type": "github-issue",
                        "id": "#100",
                    }
                ],
            ),
        )
        result = run_validator(vbrief_dir)
        assert result.returncode == 0
        assert "D11" not in result.stdout

    def test_proposed_without_origin_no_warning(self, tmp_path):
        """Scope vBRIEF in proposed/ without origin does NOT warn.

        D11 only checks pending/ and active/ folders.
        """
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        write_vbrief(
            vbrief_dir / "proposed" / "2026-04-13-idea.vbrief.json",
            minimal_vbrief(status="draft"),
        )
        result = run_validator(vbrief_dir)
        assert result.returncode == 0
        assert "D11" not in result.stdout


# ===========================================================================
# Edge cases
# ===========================================================================

class TestEdgeCases:
    """Edge case tests."""

    def test_no_vbrief_dir_passes(self, tmp_path):
        """When vbrief directory doesn't exist, validator passes silently."""
        result = run_validator(tmp_path / "nonexistent")
        assert result.returncode == 0
        assert "skipping" in result.stdout.lower()

    def test_empty_lifecycle_folders_pass(self, tmp_path):
        """Empty lifecycle folders with no vBRIEF files pass."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        result = run_validator(vbrief_dir)
        assert result.returncode == 0

    def test_multiple_valid_files(self, tmp_path):
        """Multiple valid scope vBRIEFs across folders all pass."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        write_vbrief(
            vbrief_dir / "proposed" / "2026-04-01-feature-a.vbrief.json",
            minimal_vbrief(status="draft"),
        )
        write_vbrief(
            vbrief_dir / "active" / "2026-04-10-feature-b.vbrief.json",
            minimal_vbrief(status="running"),
        )
        write_vbrief(
            vbrief_dir / "completed" / "2026-03-15-feature-c.vbrief.json",
            minimal_vbrief(status="completed"),
        )
        result = run_validator(vbrief_dir)
        assert result.returncode == 0
        assert "3 scope vBRIEF(s)" in result.stdout

    def test_multiple_errors_all_reported(self, tmp_path):
        """Multiple validation errors are all reported."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        # Bad schema + bad filename + status mismatch
        bad = {"plan": {"title": "X", "status": "running", "items": []}}
        filepath = vbrief_dir / "proposed" / "BAD_NAME.vbrief.json"
        write_vbrief(filepath, bad)
        result = run_validator(vbrief_dir)
        assert result.returncode == 1
        assert "error(s) found" in result.stdout

    def test_all_eight_statuses_accepted(self, tmp_path):
        """All 8 valid status values are accepted in schema validation."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        folder_for_status = {
            "draft": "proposed",
            "proposed": "proposed",
            "approved": "pending",
            "pending": "pending",
            "running": "active",
            "blocked": "active",
            "completed": "completed",
            "cancelled": "cancelled",
        }
        for status, folder in folder_for_status.items():
            write_vbrief(
                vbrief_dir / folder / f"2026-04-13-status-{status}.vbrief.json",
                minimal_vbrief(status=status),
            )
        result = run_validator(vbrief_dir)
        assert result.returncode == 0
