import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

/** Port of tests/content/test_story_start_gate.py (#1838 #1530) */

function _read(rel_path: string) {
  return readRepoFile(rel_path);
}

describe("test_story_start_gate", () => {
  it("agents_template_contains_story_start_dirty_tree_guard", () => {
    const text = readRepoFile("templates/agents-entry.md");
    expect(text).toContain("### Story Start Gate");
    expect(text).toContain("git status --short --branch");
    expect(text).toContain("deft scope:promote -- <path>");
    expect(text).toContain("current branch");
    expect(text).toContain("modified/untracked files");
    expect(text).toContain("commit existing work");
    expect(text).toContain("stash existing work");
    expect(text).toContain("include existing work in the current story");
    expect(text).toContain("unrelated dirty work");
    expect(text).toContain("deft scope:activate -- <path>");
    expect(text).toContain("deft vbrief:preflight -- <active-story-path>");
    expect(text).toContain("deft scope:complete -- <active-story-path>");
  });
  it("agents_md_contains_story_start_lifecycle_guard", () => {
    const text = readRepoFile("AGENTS.md");
    expect(text).toContain("### Story Start Gate");
    expect(text).toContain("git status --short --branch");
    expect(text).toContain("current branch");
    expect(text).toContain("modified/untracked files");
    expect(text).toContain("commit existing work");
    expect(text).toContain("stash existing work");
    expect(text).toContain("include existing work in the current story");
    expect(text).toContain("unrelated dirty work");
    expect(text).toContain("task scope:promote -- <path>");
    expect(text).toContain("task scope:activate -- <path>");
    expect(text).toContain("task vbrief:preflight -- <active-story-path>");
    expect(text).toContain("task scope:complete -- <active-story-path>");
  });
  it("build_skill_requires_dirty_work_prompt_before_implementation", () => {
    const text = readRepoFile("skills/deft-directive-build/SKILL.md");
    expect(text).toContain("git status --short --branch");
    expect(text).toContain("current branch");
    expect(text).toContain("modified/untracked files");
    expect(text).toContain("commit existing work");
    expect(text).toContain("stash existing work");
    expect(text).toContain("include existing work in the current story");
    expect(text).toContain("unrelated dirty work");
  });
  it("build_skill_requires_canonical_activation_before_preflight", () => {
    const text = readRepoFile("skills/deft-directive-build/SKILL.md");
    expect(text).toContain("task scope:promote -- <path>");
    expect(text).toContain("task scope:activate -- <path>");
    expect(text).toContain("task vbrief:preflight -- <active-story-path>");
  });
  it("build_skill_defaults_to_one_story_and_checkpoint_commits", () => {
    const text = readRepoFile("skills/deft-directive-build/SKILL.md");
    expect(text).toContain("One story is the default implementation unit");
    expect(text).toContain("one story per branch/PR");
    expect(text).toContain("checkpoint commit after each completed story");
  });
  it("build_skill_requires_scope_completion", () => {
    const text = readRepoFile("skills/deft-directive-build/SKILL.md");
    expect(text).toContain("task scope:complete -- <active-story-path>");
  });
  it("swarm_skill_requires_approval_before_multi_story_batching", () => {
    const text = readRepoFile("skills/deft-directive-swarm/SKILL.md");
    expect(text).toContain("only after explicit operator approval or an approved allocation plan");
    expect(text).toContain("record the batching rationale");
  });
  it("build_skill_recognizes_swarm_cohort_consent", () => {
    const text = readRepoFile("skills/deft-directive-build/SKILL.md");
    expect(text).toContain("Swarm-cohort dispatch carve-out");
    expect(text).toContain("approved Phase 5 allocation plan");
    expect(text).toContain("(#954)");
  });
  it("build_skill_handles_inter_story_dirty_tree", () => {
    const text = readRepoFile("skills/deft-directive-build/SKILL.md");
    expect(text).toContain("Within a cohort, between stories");
    expect(text).toContain("checkpoint-commit it and proceed");
    expect(text).toContain("FIRST story-start of a fresh branch");
  });
  it("agents_md_and_template_carry_swarm_carve_out", () => {
    for (const rel_path of ["AGENTS.md", "templates/agents-entry.md"]) {
      const text = readRepoFile(rel_path);
      expect(text).toContain("swarm cohort dispatch");
      expect(text).toContain("approved Phase 5 allocation plan");
      expect(text).toContain("(#954)");
      expect(text).toContain("checkpoint-commit it and proceed");
    }
  });
});
