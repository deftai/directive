"""Content tests for the story implementation start gate.

These tests pin the operator-consent and lifecycle boundaries that keep a
story build from swallowing unrelated dirty work or silently batching multiple
stories into one branch.
"""

from __future__ import annotations

from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def _read(rel_path: str) -> str:
    return (_REPO_ROOT / rel_path).read_text(encoding="utf-8")


def test_agents_template_contains_story_start_dirty_tree_guard() -> None:
    text = _read("content/templates/agents-entry.md")
    assert "### Story Start Gate" in text
    assert "git status --short --branch" in text
    assert "deft scope:promote -- <path>" in text
    assert "current branch" in text
    assert "modified/untracked files" in text
    assert "commit existing work" in text
    assert "stash existing work" in text
    assert "include existing work in the current story" in text
    assert "unrelated dirty work" in text
    assert "deft scope:activate -- <path>" in text
    assert "deft vbrief:preflight -- <active-story-path>" in text
    assert "deft scope:complete -- <active-story-path>" in text


def test_agents_md_contains_story_start_lifecycle_guard() -> None:
    text = _read("AGENTS.md")
    assert "### Story Start Gate" in text
    assert "git status --short --branch" in text
    assert "current branch" in text
    assert "modified/untracked files" in text
    assert "commit existing work" in text
    assert "stash existing work" in text
    assert "include existing work in the current story" in text
    assert "unrelated dirty work" in text
    assert "task scope:promote -- <path>" in text
    assert "task scope:activate -- <path>" in text
    assert "task vbrief:preflight -- <active-story-path>" in text
    assert "task scope:complete -- <active-story-path>" in text


def test_build_skill_requires_dirty_work_prompt_before_implementation() -> None:
    text = _read("content/skills/deft-directive-build/SKILL.md")
    assert "git status --short --branch" in text
    assert "current branch" in text
    assert "modified/untracked files" in text
    assert "commit existing work" in text
    assert "stash existing work" in text
    assert "include existing work in the current story" in text
    assert "unrelated dirty work" in text


def test_build_skill_requires_canonical_activation_before_preflight() -> None:
    text = _read("content/skills/deft-directive-build/SKILL.md")
    assert "task scope:promote -- <path>" in text
    assert "task scope:activate -- <path>" in text
    assert "task vbrief:preflight -- <active-story-path>" in text


def test_build_skill_defaults_to_one_story_and_checkpoint_commits() -> None:
    text = _read("content/skills/deft-directive-build/SKILL.md")
    assert "One story is the default implementation unit" in text
    assert "one story per branch/PR" in text
    assert "checkpoint commit after each completed story" in text


def test_build_skill_requires_scope_completion() -> None:
    text = _read("content/skills/deft-directive-build/SKILL.md")
    assert "task scope:complete -- <active-story-path>" in text


def test_swarm_skill_requires_approval_before_multi_story_batching() -> None:
    text = _read("content/skills/deft-directive-swarm/SKILL.md")
    assert "only after explicit operator approval or an approved allocation plan" in text
    assert "record the batching rationale" in text


def test_build_skill_recognizes_swarm_cohort_consent() -> None:
    text = _read("content/skills/deft-directive-build/SKILL.md")
    assert "Swarm-cohort dispatch carve-out" in text
    assert "approved Phase 5 allocation plan" in text
    assert "(#954)" in text


def test_build_skill_handles_inter_story_dirty_tree() -> None:
    text = _read("content/skills/deft-directive-build/SKILL.md")
    assert "Within a cohort, between stories" in text
    assert "checkpoint-commit it and proceed" in text
    assert "FIRST story-start of a fresh branch" in text


def test_agents_md_and_template_carry_swarm_carve_out() -> None:
    for rel_path in ("AGENTS.md", "content/templates/agents-entry.md"):
        text = _read(rel_path)
        assert "swarm cohort dispatch" in text
        assert "approved Phase 5 allocation plan" in text
        assert "(#954)" in text
        assert "checkpoint-commit it and proceed" in text
