"""test_speckit_phase4.py -- Content tests for #436.

Verifies:
- strategies/speckit.md Phase 4 emits scope vBRIEFs per implementation phase
- Artifacts Summary includes 3c PRD render row and Phase 4 pending/ entry
- plan.vbrief.json is documented as session-todo only (not project plan)
- vbrief/vbrief.md documents the ip<NNN> 3-digit padded filename convention,
  canonical narrative keys (Description / Acceptance / Traces), and
  plan.metadata.dependencies plan-level placement.

Story: #436 (speckit Phase 4 scope vBRIEFs)
"""

from __future__ import annotations

from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]


def _read(relpath: str) -> str:
    return (_REPO_ROOT / relpath).read_text(encoding="utf-8", errors="replace")


class TestSpeckitPhase4Emission:
    """Phase 4 must direct scope vBRIEF emission to vbrief/pending/."""

    _text = _read("strategies/speckit.md")

    def test_phase_4_heading_updated(self) -> None:
        assert "## Phase 4: Tasks (Scope vBRIEF Emission)" in self._text, (
            "speckit Phase 4 heading must announce scope vBRIEF emission (#436)"
        )

    def test_phase_4_writes_to_pending_folder(self) -> None:
        assert "./vbrief/pending/" in self._text, (
            "Phase 4 output must reference `./vbrief/pending/` (#436)"
        )

    def test_phase_4_filename_convention(self) -> None:
        assert "YYYY-MM-DD-ip<NNN>-<slug>.vbrief.json" in self._text, (
            "Phase 4 filename convention must be documented as "
            "YYYY-MM-DD-ip<NNN>-<slug>.vbrief.json (#436)"
        )

    def test_phase_4_requires_canonical_narrative_keys(self) -> None:
        for key in ("Description", "Acceptance", "Traces"):
            assert f"plan.narratives.{key}" in self._text, (
                f"Phase 4 must require the canonical '{key}' narrative key (#436)"
            )

    def test_phase_4_links_back_to_specification(self) -> None:
        assert "x-vbrief/plan" in self._text, (
            "Phase 4 scope vBRIEFs must link back via x-vbrief/plan reference (#436)"
        )

    def test_phase_4_plan_metadata_dependencies(self) -> None:
        assert "plan.metadata.dependencies" in self._text, (
            "Phase 4 must place cross-scope dependencies in "
            "plan.metadata.dependencies (#436)"
        )

    def test_phase_4_plan_vbrief_is_session_todo(self) -> None:
        assert "session-todo role" in self._text, (
            "speckit.md must describe plan.vbrief.json as the session-todo role (#436)"
        )

    def test_phase_4_forbids_project_wide_task_list_in_plan_vbrief(self) -> None:
        assert (
            "Emit the project-wide Phase 4 task list to `plan.vbrief.json`"
            in self._text
        ), (
            "speckit.md must forbid emitting the project-wide Phase 4 task list "
            "to plan.vbrief.json (#436)"
        )

    def test_artifacts_summary_has_3c_render_row(self) -> None:
        assert "3c. Render PRD" in self._text, (
            "speckit.md Artifacts Summary must include a 3c. Render PRD row (#433)"
        )

    def test_artifacts_summary_points_phase_4_at_pending_scope_vbriefs(self) -> None:
        assert "`./vbrief/pending/YYYY-MM-DD-ip<NNN>-<slug>.vbrief.json`" in self._text, (
            "Artifacts Summary must show Phase 4 -> pending scope vBRIEF path (#436)"
        )

    def test_migrator_flag_documented(self) -> None:
        assert "--speckit-plan" in self._text, (
            "speckit.md must document the `migrate_vbrief.py --speckit-plan` flag (#436)"
        )


class TestVbriefMdUpdates:
    """vbrief/vbrief.md must document the new conventions."""

    _text = _read("vbrief/vbrief.md")

    def test_ip_filename_convention_documented(self) -> None:
        assert "YYYY-MM-DD-ip<NNN>-<slug>.vbrief.json" in self._text, (
            "vbrief.md must document ip<NNN> filename convention (#436 Risk 5)"
        )

    def test_ip_padding_is_three_digits(self) -> None:
        assert "3 digits" in self._text or "three digits" in self._text.lower(), (
            "vbrief.md must state the IP index is zero-padded to exactly 3 digits "
            "(#436 Risk 5)"
        )

    def test_canonical_narrative_keys_documented(self) -> None:
        for key in ("Description", "Acceptance", "Traces"):
            assert key in self._text, (
                f"vbrief.md must document canonical narrative key '{key}' (#436 Risk 7)"
            )

    def test_plan_metadata_dependencies_documented(self) -> None:
        assert "plan.metadata.dependencies" in self._text, (
            "vbrief.md must document plan.metadata.dependencies (#436 Risk 6)"
        )

    def test_plan_level_placement_explicit(self) -> None:
        assert "plan-level" in self._text.lower(), (
            "vbrief.md must call out that plan.metadata.dependencies is plan-level "
            "(not item-level) (#436 Risk 6)"
        )
