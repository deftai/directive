from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def test_speckit_documents_phase_45() -> None:
    text = _read("strategies/speckit.md")
    assert "## Phase 4.5: Story Decomposition / Swarm Readiness" in text
    assert "task scope:decompose" in text
    assert "task swarm:readiness" in text
    assert "plan.metadata.swarm" in text


def test_vbrief_documents_epic_phase_story_swarm_semantics() -> None:
    text = _read("vbrief/vbrief.md")
    for token in (
        'kind = "epic"',
        'kind = "phase"',
        'kind = "story"',
        "plan.metadata.swarm",
        "Story vBRIEFs are the only valid inputs for concurrent swarm worker allocation.",
        "parallel_safe",
        "file_scope_confidence",
    ):
        assert token in text


def test_swarm_skill_requires_readiness_before_allocation() -> None:
    text = _read("skills/deft-directive-swarm/SKILL.md")
    assert "task swarm:readiness -- vbrief/active/*.vbrief.json" in text
    assert "needs decomposition" in text
    assert "Allocate concurrent workers unless candidates are swarm-ready" in text
    assert "skills/deft-directive-decompose/SKILL.md" in text


def test_decompose_skill_exists_and_uses_deterministic_commands() -> None:
    text = _read("skills/deft-directive-decompose/SKILL.md")
    assert "task scope:decompose" in text
    assert "task swarm:readiness" in text
    assert "explicit approval" in text
    assert "Leave lifecycle promotion/activation to the existing approved flow" in text


def test_make_spec_no_longer_teaches_stale_planitem_patterns() -> None:
    text = _read("templates/make-spec.md")
    assert 'vBRIEFInfo": { "version": "0.6" }' in text
    assert "Nested children within a PlanItem MUST use `items`" in text
    assert "Use deprecated `subItems` for new content" in text
    assert '"subItems"' not in text
    assert "rendered PRD export" in text
    assert "rendered PRD/SPEC files are exports" in text
