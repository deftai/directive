from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def test_speckit_documents_phase_45() -> None:
    text = _read("content/strategies/speckit.md")
    assert "## Phase 4.5: Story Decomposition / Swarm Readiness" in text
    assert "task scope:decompose" in text
    assert "vbrief/.eval/decompositions/ip001-auth.json" in text
    assert "temporary proposal artifact, not a vBRIEF" in text
    assert "Agents MUST NOT leave decomposition draft JSON files at the workspace root" in text
    assert "Derive `<parent-slug>` from the parent vBRIEF filename" in text
    assert "task swarm:readiness" in text
    assert "plan.metadata.swarm" in text
    assert "Parent `plan.items` are input signals, not automatic child stories" in text
    assert "plan.narratives.ImplementationPlan" in text


def test_vbrief_documents_epic_phase_story_swarm_semantics() -> None:
    text = _read("content/vbrief/vbrief.md")
    for token in (
        'kind = "epic"',
        'kind = "phase"',
        'kind = "story"',
        "plan.metadata.swarm",
        "Story vBRIEFs are the only valid inputs for concurrent swarm worker allocation.",
        "TrustLevel: internal",
        "plan.narratives.Description",
        "plan.narratives.ImplementationPlan",
        "parallel_safe",
        "file_scope_confidence",
        "As a <role>, I want <capability>, so that <outcome>.",
        "2-5 concrete acceptance criteria",
        "readiness = \"sequential\"",
        "vbrief/.eval/decompositions/",
        "temporary proposal artifact, not a vBRIEF",
        "MUST NOT leave decomposition draft JSON files at the workspace root",
        "Derive `<parent-slug>` from the parent vBRIEF filename",
        "default to `vbrief/pending/`",
    ):
        assert token in text


def test_swarm_skill_requires_readiness_before_allocation() -> None:
    text = _read("content/skills/deft-directive-swarm/SKILL.md")
    assert "task swarm:readiness -- vbrief/active/*.vbrief.json" in text
    assert "needs decomposition" in text
    assert "Allocate concurrent workers unless candidates are swarm-ready" in text
    assert "skills/deft-directive-decompose/SKILL.md" in text


def test_decompose_skill_exists_and_uses_deterministic_commands() -> None:
    text = _read("content/skills/deft-directive-decompose/SKILL.md")
    assert "task scope:decompose" in text
    assert "task swarm:readiness" in text
    assert "task swarm:readiness -- vbrief/pending/<child-story-1>.vbrief.json" in text
    assert "task swarm:readiness -- vbrief/active/*.vbrief.json" not in text
    assert "explicit approval" in text
    assert "Leave lifecycle promotion/activation to the existing approved flow" in text
    assert "parent `plan.items` as input signals only" in text
    assert "As a <role>, I want <capability>, so that <outcome>." in text
    assert "ImplementationPlan" in text
    assert "2-5 concrete acceptance criteria" in text
    assert "to refine from parent scope" in text
    assert "temporary proposal artifact, not a vBRIEF" in text
    assert "vbrief/.eval/decompositions/ip001-auth.json" in text
    assert "Derive `<parent-slug>` from the parent vBRIEF filename" in text
    assert "Agents MUST NOT leave decomposition draft JSON files at the workspace root" in text
    assert "defaulting to `vbrief/pending/`" in text


def test_decomposition_docs_do_not_teach_root_draft_paths() -> None:
    for path in (
        "content/skills/deft-directive-decompose/SKILL.md",
        "content/strategies/speckit.md",
        "content/vbrief/vbrief.md",
        "scripts/scope_decompose.py",
        "scripts/triage_help.py",
    ):
        text = _read(path)
        assert "--draft decomposition.json" not in text
        assert "--draft draft.json" not in text
        assert "--draft <decomposition.json>" not in text
        assert "--draft <draft.json>" not in text


def test_make_spec_no_longer_teaches_stale_planitem_patterns() -> None:
    text = _read("content/templates/make-spec.md")
    assert 'vBRIEFInfo": { "version": "0.6" }' in text
    assert "Nested children within a PlanItem MUST use `items`" in text
    assert "Use deprecated `subItems` for new content" in text
    assert '"subItems"' not in text
    assert "rendered PRD export" in text
    assert "rendered PRD/SPEC files are exports" in text
