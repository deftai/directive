"""
test_precutover_guard.py -- Tests for Story S (#334) pre-cutover detection
and backward compatibility guard.

Covers:
- Post-migration placeholder integrity check (vbrief_validate.py)
- Actionable error message content in skill files
- Greenfield path documentation in deft-directive-setup

Story: #334 (RFC #309)
"""

import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()
SKILLS_DIR = REPO_ROOT / "skills"


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


def make_lifecycle_dirs(vbrief_dir: Path) -> None:
    """Create all lifecycle folders."""
    for folder in ("proposed", "pending", "active", "completed", "cancelled"):
        (vbrief_dir / folder).mkdir(parents=True, exist_ok=True)


def write_file(path: Path, content: str) -> None:
    """Write text content to a file, creating parent dirs."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def read_skill(name: str) -> str:
    """Read a skill SKILL.md file content."""
    skill_path = SKILLS_DIR / name / "SKILL.md"
    return skill_path.read_text(encoding="utf-8")


DEPRECATED_REDIRECT_CONTENT = """\
<!-- deft:deprecated-redirect -->
# SPECIFICATION.md (Deprecated)

This file is a deprecation redirect. The project specification is now
managed as scope vBRIEFs in `vbrief/`. See `vbrief/vbrief.md` for details.
"""

REAL_SPEC_CONTENT = """\
# Project Specification

## Overview
This is a real specification with actual content.

## Requirements
- FR-1: The system shall do things
"""

REAL_PROJECT_CONTENT = """\
# Project

## Overview
A real project file with actual content.

## Tech Stack
Python 3.11
"""


# ===========================================================================
# Placeholder integrity (vbrief_validate.py)
# ===========================================================================


class TestPlaceholderIntegrity:
    """Tests for the post-migration placeholder integrity check."""

    def test_no_deprecated_files_passes(self, tmp_path):
        """No SPECIFICATION.md or PROJECT.md -- no warnings."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        result = run_validator(vbrief_dir)
        assert result.returncode == 0
        assert "non-redirect content" not in result.stdout

    def test_spec_with_redirect_sentinel_passes(self, tmp_path):
        """SPECIFICATION.md with redirect sentinel -- no warning."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        write_file(tmp_path / "SPECIFICATION.md", DEPRECATED_REDIRECT_CONTENT)
        result = run_validator(vbrief_dir)
        assert result.returncode == 0
        assert "non-redirect content" not in result.stdout

    def test_project_with_redirect_sentinel_passes(self, tmp_path):
        """PROJECT.md with redirect sentinel -- no warning."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        write_file(tmp_path / "PROJECT.md", DEPRECATED_REDIRECT_CONTENT)
        result = run_validator(vbrief_dir)
        assert result.returncode == 0
        assert "non-redirect content" not in result.stdout

    def test_spec_without_sentinel_warns(self, tmp_path):
        """SPECIFICATION.md without redirect sentinel -- warns."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        write_file(tmp_path / "SPECIFICATION.md", REAL_SPEC_CONTENT)
        result = run_validator(vbrief_dir)
        assert result.returncode == 0  # warnings don't cause failure
        assert "SPECIFICATION.md contains non-redirect content" in result.stdout
        assert "WARN:" in result.stdout

    def test_project_without_sentinel_warns(self, tmp_path):
        """PROJECT.md without redirect sentinel -- warns."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        write_file(tmp_path / "PROJECT.md", REAL_PROJECT_CONTENT)
        result = run_validator(vbrief_dir)
        assert result.returncode == 0
        assert "PROJECT.md contains non-redirect content" in result.stdout
        assert "WARN:" in result.stdout

    def test_both_files_without_sentinel_warns_both(self, tmp_path):
        """Both files without sentinel -- warns for each."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        write_file(tmp_path / "SPECIFICATION.md", REAL_SPEC_CONTENT)
        write_file(tmp_path / "PROJECT.md", REAL_PROJECT_CONTENT)
        result = run_validator(vbrief_dir)
        assert result.returncode == 0
        assert "SPECIFICATION.md contains non-redirect content" in result.stdout
        assert "PROJECT.md contains non-redirect content" in result.stdout

    def test_spec_with_sentinel_and_project_without_warns_project_only(
        self, tmp_path
    ):
        """SPECIFICATION.md has sentinel, PROJECT.md does not -- warns only for PROJECT.md."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        write_file(tmp_path / "SPECIFICATION.md", DEPRECATED_REDIRECT_CONTENT)
        write_file(tmp_path / "PROJECT.md", REAL_PROJECT_CONTENT)
        result = run_validator(vbrief_dir)
        assert result.returncode == 0
        assert "SPECIFICATION.md contains non-redirect content" not in result.stdout
        assert "PROJECT.md contains non-redirect content" in result.stdout

    def test_warning_message_mentions_vbrief(self, tmp_path):
        """Warning message directs user to vbrief/ scope vBRIEFs."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        write_file(tmp_path / "SPECIFICATION.md", REAL_SPEC_CONTENT)
        result = run_validator(vbrief_dir)
        assert "scope vBRIEFs" in result.stdout
        assert "vbrief/" in result.stdout

    def test_empty_deprecated_file_warns(self, tmp_path):
        """Empty SPECIFICATION.md (no sentinel) -- warns."""
        vbrief_dir = tmp_path / "vbrief"
        make_lifecycle_dirs(vbrief_dir)
        write_file(tmp_path / "SPECIFICATION.md", "")
        result = run_validator(vbrief_dir)
        assert "SPECIFICATION.md contains non-redirect content" in result.stdout


# ===========================================================================
# Skill file content checks -- Pre-Cutover Detection Guard
# ===========================================================================


class TestSkillPreCutoverGuard:
    """Tests that skill files contain the pre-cutover detection guard."""

    def test_setup_skill_has_precutover_guard(self):
        """deft-directive-setup has a Pre-Cutover Detection Guard section."""
        content = read_skill("deft-directive-setup")
        assert "## Pre-Cutover Detection Guard" in content

    def test_build_skill_has_precutover_guard(self):
        """deft-directive-build has a Pre-Cutover Detection Guard section."""
        content = read_skill("deft-directive-build")
        assert "## Pre-Cutover Detection Guard" in content

    def test_sync_skill_has_precutover_guard(self):
        """deft-directive-sync has a Pre-Cutover Detection Guard section."""
        content = read_skill("deft-directive-sync")
        assert "## Pre-Cutover Detection Guard" in content


class TestSkillDetectionCriteria:
    """Tests that skill files document the correct detection criteria."""

    def test_setup_detects_spec_without_sentinel(self):
        """Setup skill detects SPECIFICATION.md without redirect sentinel."""
        content = read_skill("deft-directive-setup")
        assert "deft:deprecated-redirect" in content
        assert "SPECIFICATION.md" in content

    def test_setup_detects_project_without_sentinel(self):
        """Setup skill detects PROJECT.md without redirect sentinel."""
        content = read_skill("deft-directive-setup")
        assert "PROJECT.md" in content

    def test_setup_detects_missing_lifecycle_folders(self):
        """Setup skill detects missing lifecycle folders."""
        content = read_skill("deft-directive-setup")
        assert "lifecycle folders" in content.lower()
        assert "proposed/" in content
        assert "pending/" in content
        assert "active/" in content
        assert "completed/" in content
        assert "cancelled/" in content

    def test_build_detects_spec_without_sentinel(self):
        """Build skill detects SPECIFICATION.md without redirect sentinel."""
        content = read_skill("deft-directive-build")
        assert "deft:deprecated-redirect" in content

    def test_sync_detects_spec_without_sentinel(self):
        """Sync skill detects SPECIFICATION.md without redirect sentinel."""
        content = read_skill("deft-directive-sync")
        assert "deft:deprecated-redirect" in content


class TestSkillActionableMessages:
    """Tests that skill files contain actionable error messages."""

    def test_setup_redirects_to_migrate(self):
        """Setup skill redirects to task migrate:vbrief."""
        content = read_skill("deft-directive-setup")
        assert "task migrate:vbrief" in content

    def test_build_redirects_to_migrate(self):
        """Build skill redirects to task migrate:vbrief."""
        content = read_skill("deft-directive-build")
        assert "task migrate:vbrief" in content

    def test_sync_redirects_to_migrate(self):
        """Sync skill redirects to task migrate:vbrief."""
        content = read_skill("deft-directive-sync")
        assert "task migrate:vbrief" in content

    def test_setup_mentions_project_render(self):
        """Setup skill mentions task project:render for missing PROJECT-DEFINITION."""
        content = read_skill("deft-directive-setup")
        assert "task project:render" in content

    def test_build_mentions_project_render(self):
        """Build skill mentions task project:render for missing PROJECT-DEFINITION."""
        content = read_skill("deft-directive-build")
        assert "task project:render" in content

    def test_build_mentions_scope_activate(self):
        """Build skill mentions task scope:activate for wrong-folder vBRIEFs."""
        content = read_skill("deft-directive-build")
        assert "task scope:activate" in content

    def test_sync_mentions_scope_activate(self):
        """Sync skill mentions task scope:activate for wrong-folder vBRIEFs."""
        content = read_skill("deft-directive-sync")
        assert "task scope:activate" in content

    def test_setup_precutover_message_text(self):
        """Setup skill contains the standard pre-cutover user message."""
        content = read_skill("deft-directive-setup")
        assert "pre-v0.20 document model" in content

    def test_build_precutover_message_text(self):
        """Build skill contains the standard pre-cutover user message."""
        content = read_skill("deft-directive-build")
        assert "pre-v0.20 document model" in content

    def test_sync_precutover_message_text(self):
        """Sync skill contains the standard pre-cutover user message."""
        content = read_skill("deft-directive-sync")
        assert "pre-v0.20 document model" in content


class TestSkillAntiPatterns:
    """Tests that skill files prohibit ignoring pre-cutover state."""

    def test_setup_prohibits_proceeding_past_guard(self):
        """Setup skill has anti-pattern against proceeding past guard."""
        content = read_skill("deft-directive-setup")
        # Check for prohibition markers near the guard section
        assert "redirect to migration first" in content.lower()

    def test_build_prohibits_proceeding_past_guard(self):
        """Build skill has anti-pattern against proceeding past guard."""
        content = read_skill("deft-directive-build")
        assert "redirect to migration first" in content.lower()

    def test_sync_prohibits_skipping_model_state(self):
        """Sync skill has anti-pattern against skipping model state detection."""
        content = read_skill("deft-directive-sync")
        assert "always report the document model state" in content.lower()


# ===========================================================================
# Sync skill -- model state reporting
# ===========================================================================


class TestSyncModelStateReporting:
    """Tests that deft-directive-sync reports document model state."""

    def test_sync_reports_model_state_in_summary(self):
        """Sync skill includes Document Model line in summary."""
        content = read_skill("deft-directive-sync")
        assert "Document Model" in content

    def test_sync_reports_precutover_state(self):
        """Sync skill documents pre-v0.20 legacy state output."""
        content = read_skill("deft-directive-sync")
        assert "pre-v0.20 (legacy)" in content

    def test_sync_reports_postcutover_ok_state(self):
        """Sync skill documents v0.20+ OK state output."""
        content = read_skill("deft-directive-sync")
        assert "v0.20+ (vBRIEF-centric)" in content

    def test_sync_reports_tampered_placeholder_state(self):
        """Sync skill documents v0.20+ with warnings state output."""
        content = read_skill("deft-directive-sync")
        assert "non-redirect content" in content


# ===========================================================================
# Greenfield path documentation
# ===========================================================================


class TestGreenfieldPath:
    """Tests that deft-directive-setup documents the greenfield path."""

    def test_greenfield_section_exists(self):
        """Setup skill has a Greenfield Projects section."""
        content = read_skill("deft-directive-setup")
        assert "Greenfield Projects" in content

    def test_greenfield_creates_lifecycle_dirs(self):
        """Setup skill documents creation of 5 lifecycle subdirectories."""
        content = read_skill("deft-directive-setup")
        # The greenfield section should mention all 5 dirs
        guard_section = content[content.index("Greenfield Projects"):]
        assert "proposed/" in guard_section
        assert "pending/" in guard_section
        assert "active/" in guard_section
        assert "completed/" in guard_section
        assert "cancelled/" in guard_section

    def test_greenfield_creates_project_definition(self):
        """Setup skill documents creation of PROJECT-DEFINITION.vbrief.json."""
        content = read_skill("deft-directive-setup")
        guard_section = content[content.index("Greenfield Projects"):]
        assert "PROJECT-DEFINITION.vbrief.json" in guard_section

    def test_greenfield_creates_first_scope_vbrief(self):
        """Setup skill documents first scope vBRIEF in proposed/ or pending/."""
        content = read_skill("deft-directive-setup")
        guard_section = content[content.index("Greenfield Projects"):]
        assert "proposed/" in guard_section or "pending/" in guard_section

    def test_setup_phase2_creates_lifecycle_dirs(self):
        """Phase 2 Output Path creates vbrief/ and lifecycle subfolders."""
        content = read_skill("deft-directive-setup")
        # The existing Phase 2 output path already does this
        assert "lifecycle subfolders" in content or "lifecycle subdirectories" in content
