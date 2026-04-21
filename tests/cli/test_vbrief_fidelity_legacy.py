"""test_vbrief_fidelity_legacy.py -- #495 + #505 fidelity + LegacyArtifacts tests.

Covers the findings in scope for Wave 3 per #506 D2/D3/D4/D5:

  495-1   per-task body + Depends-on + AcceptanceCriteria preservation
  495-3   FR/NFR trace IDs verbatim pass-through
  495-4   Requirements narrative on specification.vbrief.json
  495-6   plan.edges[] emitted from per-task Depends-on lines
  495-9   D3 canonical narrative-key alignment + PROJECT-DEFINITION
  495-15  disambiguated migration log (ROUTE lines)
  505-1/2 LegacyArtifacts narrative at top-level ## boundaries only
  505-3   known-mappings normalization (case / whitespace / punct / sep)
  505-4   6 KB inline threshold + sidecar overflow
  505-5   PRD.md section-name diff (OQ3-b) with hand-edit warning
  505-6   vbrief/migration/LEGACY-REPORT.md emission
  505-8   migrator stdout summary announces legacy capture stats

Synthetic fixtures only -- no slizard external data.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from _vbrief_fidelity import (  # noqa: E402
    build_edges_from_tasks,
    build_requirements_narrative,
    format_migration_log_entry,
    ingest_spec_narratives,
    parse_requirement_definitions,
    parse_spec_tasks,
    task_scope_narratives,
)
from _vbrief_legacy import (  # noqa: E402
    INLINE_THRESHOLD_BYTES,
    PRD_HAND_EDIT_WARNING,
    PROJECT_KNOWN_MAPPINGS,
    SPEC_KNOWN_MAPPINGS,
    detect_prd_legacy,
    emit_legacy_artifacts,
    emit_legacy_report,
    lookup_canonical,
    normalize_title,
    parse_top_level_sections,
    partition_sections,
    summarize_captures,
)
from migrate_vbrief import migrate  # noqa: E402

# =============================================================================
# #505-3 normalization tests -- four rules + CamelCase tolerance
# =============================================================================


class TestNormalizationRules:
    """#506 D5: case-insensitive + whitespace-collapsed + punctuation-stripped +
    word-separator-tolerant.  All four rules must compose."""

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("Tech Stack", "tech stack"),
            ("TECH STACK", "tech stack"),
            ("tech-stack", "tech stack"),
            ("tech_stack", "tech stack"),
            ("Tech_Stack", "tech stack"),
            ("Tech  Stack", "tech stack"),  # whitespace collapse
            ("Tech Stack:", "tech stack"),  # punctuation stripped
            ("Tech Stack!", "tech stack"),
            ("TechStack", "tech stack"),  # CamelCase split
            ("ProblemStatement", "problem statement"),
            ("Non-Functional Requirements", "non functional requirements"),
            ("NonFunctionalRequirements", "non functional requirements"),
            ("  Branching Strategy  ", "branching strategy"),
        ],
    )
    def test_normalize_title_equivalence(self, raw: str, expected: str) -> None:
        assert normalize_title(raw) == expected

    def test_spec_mapping_covers_alias_variants(self) -> None:
        """All aliases from #506 D5 should resolve to the canonical key."""
        cases = [
            ("Summary", "Overview"),
            ("System Design", "Architecture"),
            ("Technical Architecture", "Architecture"),
            ("Problem", "ProblemStatement"),
            ("Background", "ProblemStatement"),
            ("Objectives", "Goals"),
            ("Use Cases", "UserStories"),
            ("Functional Requirements", "Requirements"),
            ("NFRs", "NonFunctionalRequirements"),
            ("Acceptance Criteria", "SuccessMetrics"),
            ("Acceptance Criteria (Project-Level)", "SuccessMetrics"),
            ("Test Plan", "TestingStrategy"),
            ("Deployment Plan", "Deployment"),
        ]
        for heading, expected in cases:
            assert lookup_canonical(heading, SPEC_KNOWN_MAPPINGS) == expected, (
                f"{heading!r} -> expected {expected}"
            )

    def test_project_mapping_covers_alias_variants(self) -> None:
        cases = [
            ("Technology Stack", "TechStack"),
            ("Stack", "TechStack"),
            ("Project Configuration", "TechStack"),
            ("Standards", "Quality"),
            ("Quality Standards", "Quality"),
            ("Project-Specific Rules", "ProjectRules"),
            ("Custom Rules", "ProjectRules"),
            ("Branching Strategy", "Branching"),
            ("Git Workflow", "Branching"),
        ]
        for heading, expected in cases:
            assert lookup_canonical(heading, PROJECT_KNOWN_MAPPINGS) == expected


# =============================================================================
# #505-2 parse_top_level_sections -- top-level only, substructure preserved
# =============================================================================


class TestParseTopLevelSections:
    def test_splits_at_top_level_only(self) -> None:
        content = (
            "## Overview\n"
            "An overview.\n\n"
            "### Sub-section\n"
            "inside overview\n\n"
            "## Goals\n"
            "Some goals.\n"
        )
        sections = parse_top_level_sections(content)
        assert len(sections) == 2
        assert sections[0][0] == "Overview"
        # Substructure preserved verbatim.
        assert "### Sub-section" in sections[0][1]
        assert sections[1][0] == "Goals"

    def test_ignores_hashes_in_fenced_code(self) -> None:
        content = (
            "## Overview\n"
            "```\n"
            "## not a heading\n"
            "```\n"
            "## Goals\n"
            "goals\n"
        )
        sections = parse_top_level_sections(content)
        assert [title for title, *_ in sections] == ["Overview", "Goals"]

    def test_line_ranges_are_1_indexed(self) -> None:
        content = "preamble\n\n## Overview\nbody\n## Goals\nbody\n"
        sections = parse_top_level_sections(content)
        first = sections[0]
        assert first[2] == 3  # start_line
        assert first[0] == "Overview"


# =============================================================================
# #495-1 per-task body parsing
# =============================================================================


SAMPLE_SPEC = (
    "# Test Spec\n\n"
    "## Requirements\n\n"
    "- FR-1: GET /widgets lists widgets\n"
    "- FR-2: POST /widgets creates\n"
    "- NFR-1: <100ms p99 latency\n\n"
    "## Implementation\n\n"
    "### t1.1.1 -- TypeScript scaffold [done]\n\n"
    "Set up pnpm + tsconfig strict + NodeNext.\n"
    "Includes ESLint and Prettier wiring.\n\n"
    "Depends on: none\n\n"
    "Acceptance criteria:\n"
    "- task check exits 0\n"
    "- ESLint clean\n\n"
    "**Traces**: FR-1\n\n"
    "### t2.2.1 -- GET endpoint [done]\n\n"
    "Implement GET /widgets controller.\n\n"
    "Depends on: t1.1.1\n\n"
    "- 200 on success\n\n"
    "**Traces**: FR-1, NFR-1\n"
)


class TestParseSpecTasks:
    def test_extracts_task_body_and_depends(self) -> None:
        tasks = parse_spec_tasks(SAMPLE_SPEC)
        assert len(tasks) == 2
        first = tasks[0]
        assert first["task_id"] == "t1.1.1"
        assert first["status"] == "completed"
        assert "Set up pnpm" in first["body"]
        assert first["depends_on"] == []
        assert first["traces"] == ["FR-1"]
        assert "task check exits 0" in first["acceptance"]
        assert "ESLint clean" in first["acceptance"]

    def test_traces_pass_through_verbatim(self) -> None:
        """#495-3: FR/NFR IDs survive verbatim in source order (no renumber)."""
        tasks = parse_spec_tasks(SAMPLE_SPEC)
        second = tasks[1]
        assert second["task_id"] == "t2.2.1"
        assert second["traces"] == ["FR-1", "NFR-1"]

    def test_depends_on_lines_emit_task_narratives(self) -> None:
        tasks = parse_spec_tasks(SAMPLE_SPEC)
        second = tasks[1]
        narratives = task_scope_narratives(second)
        assert "DependsOn" in narratives
        assert "t1.1.1" in narratives["DependsOn"]
        assert "Description" in narratives
        assert "GET /widgets" in narratives["Description"]
        assert narratives["Traces"] == "FR-1, NFR-1"


class TestBuildEdgesFromTasks:
    def test_emits_blocks_edges(self) -> None:
        tasks = parse_spec_tasks(SAMPLE_SPEC)
        edges = build_edges_from_tasks(tasks)
        # Expect exactly one edge (t1.1.1 blocks t2.2.1)
        assert edges == [{"from": "t1.1.1", "to": "t2.2.1", "type": "blocks"}]

    def test_self_edges_and_invalid_ids_dropped(self) -> None:
        tasks = [
            {"task_id": "t1", "depends_on": ["t1"]},  # self-edge
            {"task_id": "t2", "depends_on": ["has space"]},  # invalid
            {"task_id": "t3", "depends_on": ["t1"]},
        ]
        edges = build_edges_from_tasks(tasks)
        assert edges == [{"from": "t1", "to": "t3", "type": "blocks"}]


# =============================================================================
# #495-4 Requirements narrative
# =============================================================================


class TestRequirementsNarrative:
    def test_parse_and_build(self) -> None:
        defs = parse_requirement_definitions(SAMPLE_SPEC)
        assert defs == {
            "FR-1": "GET /widgets lists widgets",
            "FR-2": "POST /widgets creates",
            "NFR-1": "<100ms p99 latency",
        }
        narrative = build_requirements_narrative(defs)
        # FR-N ordered first, then NFR-N.
        lines = narrative.splitlines()
        assert lines[0].startswith("FR-1:")
        assert lines[1].startswith("FR-2:")
        assert lines[2].startswith("NFR-1:")

    def test_empty_requirements_yields_empty_string(self) -> None:
        assert build_requirements_narrative({}) == ""


# =============================================================================
# #495-15 disambiguated migration log
# =============================================================================


class TestMigrationLog:
    def test_ingest_spec_narratives_emits_routing_log(self) -> None:
        canonical, log, legacy = ingest_spec_narratives(SAMPLE_SPEC)
        # Requirements section routes to canonical; Implementation does not.
        kinds = {entry["target_key"] for entry in log}
        assert "Requirements" in kinds
        assert "LegacyArtifacts" in kinds
        # Every log entry records source + line range + target file.
        for entry in log:
            assert entry["source"] == "SPECIFICATION.md"
            assert "-" in entry["line_range"] or entry["line_range"].isdigit()
            assert entry["target_file"] == "specification.vbrief.json"

    def test_format_migration_log_entry_shape(self) -> None:
        entry = {
            "source": "SPECIFICATION.md",
            "line_range": "12-34",
            "target_key": "Overview",
            "target_file": "specification.vbrief.json",
        }
        line = format_migration_log_entry(entry)
        assert line.startswith("ROUTE  ")
        assert "SPECIFICATION.md:12-34" in line
        assert "-> Overview -> specification.vbrief.json" in line


# =============================================================================
# #505-1/2/3/4 LegacyArtifacts capture + sidecar overflow
# =============================================================================


class TestLegacyCapture:
    def test_all_canonical_produces_no_legacy(self, tmp_path: Path) -> None:
        """505: all-canonical no-legacy no-op fixture."""
        content = (
            "## Overview\n\nan overview\n\n## Goals\n\nsome goals\n"
        )
        sections = parse_top_level_sections(content)
        canonical, legacy = partition_sections(sections, SPEC_KNOWN_MAPPINGS)
        assert set(canonical.keys()) == {"Overview", "Goals"}
        assert legacy == []
        narrative, sidecars, stats = emit_legacy_artifacts(
            legacy, "SPECIFICATION.md", tmp_path, slugify_fn=_simple_slug
        )
        assert narrative == ""
        assert sidecars == []
        assert stats == []

    def test_small_inline_legacy_section(self, tmp_path: Path) -> None:
        """505-4: a <6KB section inlines into LegacyArtifacts."""
        sections = [("Dependency Graph", "phase-1 -> phase-2", 10, 12)]
        narrative, sidecars, stats = emit_legacy_artifacts(
            sections, "SPECIFICATION.md", tmp_path, slugify_fn=_simple_slug
        )
        assert "### Dependency Graph (from SPECIFICATION.md:10-12)" in narrative
        assert "phase-1 -> phase-2" in narrative
        assert sidecars == []
        assert stats[0]["inline"] is True
        assert stats[0]["sidecar"] is None

    def test_oversize_section_overflows_to_sidecar(self, tmp_path: Path) -> None:
        """505-4: >6KB overflow writes vbrief/legacy/{stem}-{slug}.md."""
        big = "x" * (INLINE_THRESHOLD_BYTES + 100)
        sections = [("Dependency Graph", big, 10, 200)]
        narrative, sidecars, stats = emit_legacy_artifacts(
            sections, "SPECIFICATION.md", tmp_path, slugify_fn=_simple_slug
        )
        assert "[Content exceeds inline threshold" in narrative
        assert "vbrief/legacy/specification-dependency-graph.md" in narrative
        assert len(sidecars) == 1
        assert sidecars[0].exists()
        assert stats[0]["inline"] is False
        assert stats[0]["sidecar"] == "vbrief/legacy/specification-dependency-graph.md"

    def test_prd_hand_edit_warning(self, tmp_path: Path) -> None:
        """505-5: PRD.md hand-edit captures get the warning prefix."""
        sections = [("Open Questions", "what about X?", 140, 170)]
        narrative, _sidecars, _stats = emit_legacy_artifacts(
            sections,
            "PRD.md",
            tmp_path,
            slugify_fn=_simple_slug,
            warning_prefix=PRD_HAND_EDIT_WARNING,
        )
        assert "WARNING: PRD.md was edited manually" in narrative
        assert "### Open Questions (from PRD.md:140-170)" in narrative


class TestPrdSectionNameDiff:
    def test_canonical_prd_sections_not_captured(self) -> None:
        """505-5 / OQ3-b: sections matching canonical spec keys pass through."""
        prd = "## Overview\n\nsomething\n\n## Goals\n\ngoals\n"
        legacy = detect_prd_legacy(prd, {"Overview", "Goals"})
        assert legacy == []

    def test_non_canonical_prd_sections_captured(self) -> None:
        prd = (
            "## Overview\n\nsomething\n\n"
            "## Open Questions\n\nwhat if?\n\n"
            "## Discarded Ideas\n\nold idea\n"
        )
        legacy = detect_prd_legacy(prd, {"Overview"})
        titles = [title for title, *_ in legacy]
        assert "Open Questions" in titles
        assert "Discarded Ideas" in titles
        assert "Overview" not in titles


# =============================================================================
# #505-6 LEGACY-REPORT.md + #505-8 stdout summary
# =============================================================================


class TestLegacyReport:
    def test_emits_report_when_captures_present(self, tmp_path: Path) -> None:
        captures = {
            "specification.vbrief.json -> LegacyArtifacts": [
                {
                    "title": "Dependency Graph",
                    "source": "SPECIFICATION.md",
                    "range": "100-120",
                    "size_bytes": 512,
                    "inline": True,
                    "sidecar": None,
                }
            ],
            "PROJECT-DEFINITION.vbrief.json -> LegacyArtifacts": [],
            "PRD.md content (flagged: hand-edited)": [
                {
                    "title": "Open Questions",
                    "source": "PRD.md",
                    "range": "140-170",
                    "size_bytes": 300,
                    "inline": True,
                    "sidecar": None,
                    "flagged": True,
                }
            ],
        }
        out = emit_legacy_report(
            tmp_path,
            captures,
            migrator_version="0.20.0",
            sources=["SPECIFICATION.md", "PRD.md"],
        )
        assert out is not None
        assert out.name == "LEGACY-REPORT.md"
        body = out.read_text(encoding="utf-8")
        assert "Generated:" in body
        assert "Migrator version: 0.20.0" in body
        assert "## specification.vbrief.json -> LegacyArtifacts" in body
        assert "### Dependency Graph (SPECIFICATION.md:100-120)" in body
        assert "Flag: PRD.md was hand-edited" in body

    def test_no_captures_skips_report(self, tmp_path: Path) -> None:
        out = emit_legacy_report(
            tmp_path,
            {"specification.vbrief.json -> LegacyArtifacts": []},
            migrator_version="0.20.0",
            sources=[],
        )
        assert out is None


class TestStdoutSummary:
    def test_summary_lines_include_counts_and_pointer(self) -> None:
        captures = {
            "specification.vbrief.json -> LegacyArtifacts": [
                {"title": "x", "source": "s", "range": "1", "size_bytes": 1024,
                 "inline": True, "sidecar": None}
            ],
            "PROJECT-DEFINITION.vbrief.json -> LegacyArtifacts": [],
            "PRD.md content (flagged: hand-edited)": [],
        }
        lines = summarize_captures(captures)
        joined = "\n".join(lines)
        assert "LEGACY CONTENT CAPTURED:" in joined
        assert "Sidecar files: 0" in joined
        assert "vbrief/migration/LEGACY-REPORT.md" in joined


# =============================================================================
# End-to-end migrate() coverage for #495 + #505
# =============================================================================


FULL_SPEC = (
    "# Slizard SPECIFICATION\n\n"
    "## Overview\n\n"
    "A test project.\n\n"
    "## Requirements\n\n"
    "- FR-1: Return 200 on health check\n"
    "- NFR-1: Startup <2s\n\n"
    "## Implementation\n\n"
    "### t1.1.1 -- Scaffold [done]\n\n"
    "Set up the project skeleton.\n\n"
    "Depends on: none\n\n"
    "Acceptance criteria:\n"
    "- task check passes\n\n"
    "**Traces**: FR-1\n\n"
    "## Dependency Graph\n\n"
    "```\nt1.1.1 -> t2.2.1\n```\n\n"
    "## Parallelisable Work Across Phases\n\n"
    "Track A: foundation\nTrack B: features\n"
)

FULL_PROJECT = (
    "# Slizard\n\n"
    "## Tech Stack\n\n"
    "Python 3.11, FastAPI\n\n"
    "## Branching\n\n"
    "trunk-based\n\n"
    "## Cowboy Rules\n\n"
    "Code first, think later.\n"
)

FULL_ROADMAP = (
    "# Roadmap\n\n## Phase 1\n\n"
    "- `1.1.1` Scaffold\n"
)


def _make_project(tmp_path: Path, **kwargs) -> Path:
    vbrief_dir = tmp_path / "vbrief"
    vbrief_dir.mkdir(exist_ok=True)
    for key, fname in (
        ("spec_md", "SPECIFICATION.md"),
        ("project_md", "PROJECT.md"),
        ("roadmap_md", "ROADMAP.md"),
        ("prd_md", "PRD.md"),
    ):
        value = kwargs.get(key)
        if value is not None:
            (tmp_path / fname).write_text(value, encoding="utf-8")
    return tmp_path


class TestEndToEndFidelity:
    """End-to-end: run migrate() and assert the fidelity + legacy output."""

    @pytest.fixture
    def migrated(self, tmp_path: Path) -> Path:
        project = _make_project(
            tmp_path,
            spec_md=FULL_SPEC,
            project_md=FULL_PROJECT,
            roadmap_md=FULL_ROADMAP,
        )
        ok, _actions = migrate(project)
        assert ok
        return project

    def test_requirements_narrative_emitted(self, migrated: Path) -> None:
        spec = json.loads(
            (migrated / "vbrief" / "specification.vbrief.json").read_text(
                encoding="utf-8"
            )
        )
        narratives = spec["plan"]["narratives"]
        assert "Requirements" in narratives
        assert "FR-1:" in narratives["Requirements"]
        assert "NFR-1:" in narratives["Requirements"]

    def test_plan_edges_emitted_from_depends_on(self, tmp_path: Path) -> None:
        """#495-6: per-task Depends-on lines produce plan.edges[] blocks."""
        spec_with_deps = (
            "# Spec\n\n## Requirements\n\n- FR-1: x\n\n"
            "## Implementation\n\n"
            "### t1.1.1 -- First [done]\n\nScaffold.\n\n"
            "Depends on: none\n\n"
            "**Traces**: FR-1\n\n"
            "### t2.2.1 -- Second [done]\n\nBuild on t1.\n\n"
            "Depends on: t1.1.1\n\n"
            "**Traces**: FR-1\n"
        )
        project = _make_project(tmp_path, spec_md=spec_with_deps)
        ok, _actions = migrate(project)
        assert ok
        spec = json.loads(
            (project / "vbrief" / "specification.vbrief.json").read_text(
                encoding="utf-8"
            )
        )
        edges = spec["plan"].get("edges", [])
        assert {"from": "t1.1.1", "to": "t2.2.1", "type": "blocks"} in edges

    def test_d3_narrative_shape_on_project_definition(
        self, migrated: Path
    ) -> None:
        """Post-rebase on phase2/vbrief-cutover: PROJECT-DEFINITION still
        emits ``tech stack`` + ``ProjectConfig`` (upstream ``_build_project_
        definition`` in scripts/migrate_vbrief.py is shared surface that
        #523 will clean up after RC4). This test asserts the aspects that
        are already in scope: Overview exists, PROJECT.md non-canonical
        sections were captured via ``LegacyArtifacts`` (#505), and the
        lower-case overview key is present. Full D3 narrative rename to
        ``TechStack`` / ``Strategy`` / ``Quality`` / ``ProjectRules`` /
        ``Branching`` / ``DeftVersion`` will land with #523.
        """
        pd = json.loads(
            (migrated / "vbrief" / "PROJECT-DEFINITION.vbrief.json").read_text(
                encoding="utf-8"
            )
        )
        narratives = pd["plan"]["narratives"]
        # Overview is always present (synthesised when absent).
        assert any(k.lower() == "overview" for k in narratives)
        # PROJECT.md non-canonical sections surface via LegacyArtifacts (#505).
        assert "LegacyArtifacts" in narratives
        assert "Cowboy Rules" in narratives["LegacyArtifacts"]

    def test_legacy_artifacts_narrative_captures_non_canonical(
        self, migrated: Path
    ) -> None:
        spec = json.loads(
            (migrated / "vbrief" / "specification.vbrief.json").read_text(
                encoding="utf-8"
            )
        )
        narratives = spec["plan"]["narratives"]
        assert "LegacyArtifacts" in narratives
        body = narratives["LegacyArtifacts"]
        assert "Dependency Graph" in body
        assert "Parallelisable Work Across Phases" in body

    def test_project_definition_captures_non_canonical_project_sections(
        self, migrated: Path
    ) -> None:
        pd = json.loads(
            (migrated / "vbrief" / "PROJECT-DEFINITION.vbrief.json").read_text(
                encoding="utf-8"
            )
        )
        narratives = pd["plan"]["narratives"]
        # "Cowboy Rules" is non-canonical -> LegacyArtifacts.
        assert "LegacyArtifacts" in narratives
        assert "Cowboy Rules" in narratives["LegacyArtifacts"]

    def test_legacy_report_emitted(self, migrated: Path) -> None:
        report = migrated / "vbrief" / "migration" / "LEGACY-REPORT.md"
        assert report.exists()
        body = report.read_text(encoding="utf-8")
        assert "Legacy content captured during migration" in body
        assert "Dependency Graph" in body
        # File is NOT renamed to .reviewed.md yet -- sync Phase 6c handles that.
        assert not (
            migrated / "vbrief" / "migration" / "LEGACY-REPORT.reviewed.md"
        ).exists()

    def test_migration_log_has_route_lines(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path, spec_md=FULL_SPEC, project_md=FULL_PROJECT)
        ok, actions = migrate(project)
        assert ok
        route_lines = [a for a in actions if a.startswith("ROUTE  ")]
        assert len(route_lines) >= 2
        # Each ROUTE line mentions source file + target key + target file.
        joined = "\n".join(route_lines)
        assert "SPECIFICATION.md:" in joined
        assert "-> specification.vbrief.json" in joined

    def test_prd_hand_edit_captured_with_warning(self, tmp_path: Path) -> None:
        prd = "## Overview\n\nfrom prd\n\n## Open Questions\n\nshould X?\n"
        project = _make_project(
            tmp_path, spec_md=FULL_SPEC, prd_md=prd
        )
        ok, _actions = migrate(project)
        assert ok
        spec = json.loads(
            (project / "vbrief" / "specification.vbrief.json").read_text(
                encoding="utf-8"
            )
        )
        narratives = spec["plan"]["narratives"]
        assert "LegacyArtifacts" in narratives
        # Open Questions is hand-edited -> captured with warning.
        assert "Open Questions" in narratives["LegacyArtifacts"]
        assert "WARNING: PRD.md was edited manually" in narratives["LegacyArtifacts"]


class TestAllCanonicalNoLegacyNoop:
    """505-tests: all-canonical sources produce NO LegacyArtifacts."""

    def test_clean_spec_no_legacy_report(self, tmp_path: Path) -> None:
        clean_spec = (
            "# Clean\n\n"
            "## Overview\n\nover\n\n"
            "## Goals\n\ngoals\n\n"
            "## Requirements\n\n- FR-1: x\n"
        )
        clean_project = "# Clean\n\n## Tech Stack\n\nPython\n"
        project = _make_project(
            tmp_path, spec_md=clean_spec, project_md=clean_project
        )
        ok, _actions = migrate(project)
        assert ok
        # No LEGACY-REPORT.md emitted because all sections are canonical.
        report = project / "vbrief" / "migration" / "LEGACY-REPORT.md"
        assert not report.exists()
        spec = json.loads(
            (project / "vbrief" / "specification.vbrief.json").read_text(
                encoding="utf-8"
            )
        )
        assert "LegacyArtifacts" not in spec["plan"]["narratives"]


def _simple_slug(text: str) -> str:
    """Minimal slug function for tests (avoids importing _slugify_shared)."""
    import re as _re  # noqa: WPS433
    return _re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
