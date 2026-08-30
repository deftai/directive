import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readRepoFile, readSwarmSkillSurface, repoPath } from "./helpers.js";

/** Port of tests/content/test_decomposition_readiness.py (#1838 #1530) */

function _read(path: string) {
  return readRepoFile(path);
}

describe("test_decomposition_readiness", () => {
  it("speckit_documents_phase_45", () => {
    const text = readRepoFile("strategies/speckit.md");
    expect(text).toContain("## Phase 4.5: Story Decomposition / Swarm Readiness");
    expect(text).toContain("task scope:decompose");
    expect(text).toContain("vbrief/.triage-cache/decompositions/ip001-auth.json");
    expect(text).toContain("temporary proposal artifact, not a vBRIEF");
    expect(text).toContain(
      "Agents MUST NOT leave decomposition draft JSON files at the workspace root",
    );
    expect(text).toContain("Derive `<parent-slug>` from the parent vBRIEF filename");
    expect(text).toContain("task swarm:readiness");
    expect(text).toContain("plan.metadata.swarm");
    expect(text).toContain("Parent `plan.items` are input signals, not automatic child stories");
    expect(text).toContain("plan.narratives.ImplementationPlan");
  });
  it("vbrief_documents_epic_phase_story_swarm_semantics", () => {
    const text = readRepoFile("vbrief/vbrief.md");
    for (const token of [
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
      'readiness = "sequential"',
      "vbrief/.triage-cache/decompositions/",
      "temporary proposal artifact, not a vBRIEF",
      "MUST NOT leave decomposition draft JSON files at the workspace root",
      "Derive `<parent-slug>` from the parent vBRIEF filename",
      "default to `vbrief/pending/`",
    ]) {
      expect(text).toContain(token);
    }
  });
  it("swarm_skill_requires_readiness_before_allocation", () => {
    const text = readSwarmSkillSurface();
    expect(text).toContain("task swarm:readiness -- xbrief/active/*.xbrief.json");
    expect(text).toContain("needs decomposition");
    expect(text).toContain("Allocate concurrent workers unless candidates are swarm-ready");
    expect(text).toContain("skills/deft-directive-decompose/SKILL.md");
  });
  it("decompose_skill_exists_and_uses_deterministic_commands", () => {
    const text = readRepoFile("skills/deft-directive-decompose/SKILL.md");
    expect(text).toContain("task scope:decompose");
    expect(text).toContain("task swarm:readiness");
    expect(text).toContain("task swarm:readiness -- xbrief/pending/<child-story-1>.xbrief.json");
    expect(text).not.toContain("task swarm:readiness -- xbrief/active/*.xbrief.json");
    expect(text).toContain("explicit approval");
    expect(text).toContain("Leave lifecycle promotion/activation to the existing approved flow");
    expect(text).toContain("parent `plan.items` as input signals only");
    expect(text).toContain("As a <role>, I want <capability>, so that <outcome>.");
    expect(text).toContain("ImplementationPlan");
    expect(text).toContain("2-5 concrete acceptance criteria");
    expect(text).toContain("to refine from parent scope");
    expect(text).toContain("temporary proposal artifact, not a xBRIEF");
    expect(text).toContain("xbrief/.triage-cache/decompositions/ip001-auth.json");
    expect(text).toContain("Derive `<parent-slug>` from the parent xBRIEF filename");
    expect(text).toContain(
      "Agents MUST NOT leave decomposition draft JSON files at the workspace root",
    );
    expect(text).toContain("defaulting to `xbrief/pending/`");
  });
  it("decomposition_docs_do_not_teach_root_draft_paths", () => {
    for (const path of [
      "skills/deft-directive-decompose/SKILL.md",
      "strategies/speckit.md",
      "vbrief/vbrief.md",
      "tasks/scope.yml",
      "packages/cli/src/triage-help.ts",
    ]) {
      const text =
        path.startsWith("packages/") || path.startsWith("tasks/")
          ? readFileSync(repoPath(path), "utf8")
          : readRepoFile(path);
      expect(text).not.toContain("--draft decomposition.json");
      expect(text).not.toContain("--draft draft.json");
      expect(text).not.toContain("--draft <decomposition.json>");
      expect(text).not.toContain("--draft <draft.json>");
    }
  });
  it("make_spec_no_longer_teaches_stale_planitem_patterns", () => {
    const text = readRepoFile("templates/make-spec.md");
    expect(text).toContain('xBRIEFInfo": { "version": "0.8" }');
    expect(text).toContain("Nested children within a PlanItem MUST use `items`");
    expect(text).toContain("Use deprecated `subItems` for new content");
    expect(text).not.toContain('"subItems"');
    expect(text).toContain("rendered PRD export");
    expect(text).toContain("rendered PRD/SPEC files are exports");
  });
});
