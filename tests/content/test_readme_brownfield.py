"""test_readme_brownfield.py -- Content tests for #407 README accuracy
and #408 brownfield adoption guide (docs/BROWNFIELD.md).

Story: #407 + #408 (swarm-402)
"""

from __future__ import annotations

import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]


# ---------------------------------------------------------------------------
# #407: README.md describes the vBRIEF-centric model (not SPECIFICATION.md)
# ---------------------------------------------------------------------------


class TestReadmeVbriefCentric:
    """README must describe the vBRIEF-centric model, not SPECIFICATION.md."""

    def _readme(self) -> str:
        return (_REPO_ROOT / "README.md").read_text(encoding="utf-8")

    def test_setup_step_references_vbrief_project_definition(self):
        """Step 2 output must reference PROJECT-DEFINITION.vbrief.json."""
        content = self._readme()
        assert "vbrief/PROJECT-DEFINITION.vbrief.json" in content, (
            "README Step 2 must reference vbrief/PROJECT-DEFINITION.vbrief.json "
            "as the setup output (not PROJECT.md)."
        )

    def test_scope_vbrief_section_replaces_specification_md_language(self):
        """Step 3 must be about scope vBRIEFs, not about creating SPECIFICATION.md."""
        content = self._readme()
        assert "Generate a Scope vBRIEF" in content, (
            "README Step 3 heading should describe scope vBRIEF creation (#407)."
        )
        # The old 'creating a SPECIFICATION.md' wording must be gone.
        assert "creating a `SPECIFICATION.md`" not in content, (
            "README Step 3 must no longer describe SPECIFICATION.md as the "
            "primary creation target."
        )

    def test_build_example_reads_project_definition_not_specification(self):
        """The 'Build With AI' example must point agents at the vBRIEF files."""
        content = self._readme()
        assert "Read vbrief/PROJECT-DEFINITION.vbrief.json" in content, (
            "README Step 4 example must direct agents to read "
            "vbrief/PROJECT-DEFINITION.vbrief.json and scope vBRIEFs."
        )
        # Old wording "Read SPECIFICATION.md and implement" must be gone.
        assert "Read SPECIFICATION.md and implement" not in content, (
            "README Step 4 must no longer instruct 'Read SPECIFICATION.md and implement' -- "
            "update to the vBRIEF-centric flow."
        )

    def test_source_of_truth_note_exists(self):
        """README must clarify that .vbrief.json is source of truth; .md are renders."""
        content = self._readme()
        assert "source of truth" in content.lower(), (
            "README must state somewhere that .vbrief.json files are the source of truth."
        )
        assert "rendered view" in content.lower(), (
            "README must clarify that .md files like SPECIFICATION.md are rendered views."
        )

    def test_rule_precedence_lists_vbrief_files(self):
        """Rule Hierarchy list must reference vbrief/PROJECT-DEFINITION.vbrief.json."""
        content = self._readme()
        # Extract the '### Rule Hierarchy' section to avoid false positives elsewhere.
        match = re.search(
            r"### Rule Hierarchy\s*\n(.+?)(?=\n### |\n## )",
            content,
            re.DOTALL,
        )
        assert match, "Rule Hierarchy section missing from README."
        section = match.group(1)
        assert "vbrief/PROJECT-DEFINITION.vbrief.json" in section, (
            "Rule Hierarchy must list vbrief/PROJECT-DEFINITION.vbrief.json "
            "(replacing stale 'project.md' entry)."
        )
        assert "vbrief/specification.vbrief.json" in section, (
            "Rule Hierarchy must list vbrief/specification.vbrief.json at the bottom."
        )

    def test_brownfield_link_from_readme(self):
        """README must link to docs/BROWNFIELD.md from the Getting Started flow."""
        content = self._readme()
        assert "docs/BROWNFIELD.md" in content, (
            "README must link to docs/BROWNFIELD.md so brownfield users can find "
            "the migration guide (#408)."
        )


# ---------------------------------------------------------------------------
# #408: docs/BROWNFIELD.md exists and covers the required sections
# ---------------------------------------------------------------------------


class TestBrownfieldGuide:
    """docs/BROWNFIELD.md must exist and cover the acceptance criteria from #408."""

    BROWNFIELD_PATH = _REPO_ROOT / "docs" / "BROWNFIELD.md"

    def _content(self) -> str:
        assert self.BROWNFIELD_PATH.is_file(), (
            "docs/BROWNFIELD.md must exist (#408 acceptance criterion)."
        )
        return self.BROWNFIELD_PATH.read_text(encoding="utf-8")

    def test_file_exists(self):
        assert self.BROWNFIELD_PATH.is_file(), "docs/BROWNFIELD.md missing (#408)"

    def test_covers_install_options(self):
        """Must describe submodule / installer / direct-clone install options."""
        content = self._content()
        assert "submodule" in content.lower(), (
            "BROWNFIELD.md must mention git submodule as an install option."
        )
        assert "installer" in content.lower() or "install-" in content.lower(), (
            "BROWNFIELD.md must describe the installer binary path."
        )

    def test_covers_migrate_vbrief(self):
        """Must describe `task migrate:vbrief` and what it does."""
        content = self._content()
        assert "task migrate:vbrief" in content, (
            "BROWNFIELD.md must reference `task migrate:vbrief`."
        )
        assert "idempotent" in content.lower(), (
            "BROWNFIELD.md must state that migration is idempotent."
        )

    def test_covers_rendered_views_semantics(self):
        """Must explain .vbrief.json source of truth vs .md rendered views."""
        content = self._content()
        assert "source of truth" in content.lower(), (
            "BROWNFIELD.md must state that .vbrief.json files are the source of truth."
        )
        assert "rendered view" in content.lower() or "rendered views" in content.lower(), (
            "BROWNFIELD.md must explain .md files are rendered views."
        )

    def test_covers_pre_cutover_detection_guard(self):
        """Must describe the pre-cutover detection guard behavior."""
        content = self._content()
        guard_present = (
            "Pre-Cutover Detection Guard" in content
            or "pre-cutover" in content.lower()
        )
        assert guard_present, (
            "BROWNFIELD.md must describe the pre-cutover detection guard "
            "from the setup/build skills."
        )
        assert "<!-- deft:deprecated-redirect -->" in content, (
            "BROWNFIELD.md must reference the deprecation redirect sentinel."
        )

    def test_covers_post_migration_task_check(self):
        """Must instruct the user to run `task check` post-migration."""
        content = self._content()
        assert "task check" in content, (
            "BROWNFIELD.md must include `task check` in the post-migration checklist."
        )

    def test_covers_prd_spec_ingestion(self):
        """Must mention existing spec content preservation (#397 ingestion)."""
        content = self._content()
        assert "#397" in content or "preserv" in content.lower(), (
            "BROWNFIELD.md must explain existing spec content preservation (#397)."
        )

    def test_referenced_by_quickstart(self):
        """QUICK-START.md must link to docs/BROWNFIELD.md per charter."""
        quickstart = (_REPO_ROOT / "QUICK-START.md").read_text(encoding="utf-8")
        assert "docs/BROWNFIELD.md" in quickstart, (
            "QUICK-START.md must link to docs/BROWNFIELD.md (charter Phase 3 item)."
        )

    def test_rfc2119_legend_present(self):
        """BROWNFIELD.md uses deft's standard RFC 2119 notation; legend must be present."""
        content = self._content()
        assert "RFC2119" in content or "RFC 2119" in content, (
            "BROWNFIELD.md should declare its use of RFC2119 notation."
        )
