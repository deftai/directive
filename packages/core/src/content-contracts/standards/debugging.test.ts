import { describe, expect, it } from "vitest";
import { isFile, readText } from "./_helpers.js";

describe("test_debugging.py", () => {
  describe("TestDebuggingStandard1621", () => {
    it("test_file_exists", () => {
      expect(isFile("coding/debugging.md")).toBe(true);
    });
    it("test_canonical_heading_present", () => {
      expect(readText("coding/debugging.md")).toContain(
        "# Debugging and Root-Cause Investigation (#1621)",
      );
    });
    it("test_iron_law_present", () => {
      const text = readText("coding/debugging.md").toLowerCase();
      expect(text).toContain("iron law");
      expect(text).toContain("no fixes without root-cause investigation first");
    });
    it("test_four_phases_present", () => {
      const text = readText("coding/debugging.md").toLowerCase();
      for (const phase of ["phase 1", "phase 2", "phase 3", "phase 4"])
        expect(text).toContain(phase);
    });
    it("test_three_fix_architecture_gate", () => {
      const text = readText("coding/debugging.md").toLowerCase();
      expect(
        text.includes("3-fix") || text.includes("three fix") || text.includes("fourth fix"),
      ).toBe(true);
      expect(text).toContain("architectural review");
    });
    it("test_evidence_discipline_rules", () => {
      const text = readText("coding/debugging.md").toLowerCase();
      expect(text).toContain("evidence before narrative");
      expect(text).toContain("config is not code");
      expect(text).toContain("tautolog");
    });
    it("test_fact_vs_hypothesis_labeling", () => {
      const text = readText("coding/debugging.md");
      expect(text).toContain("Fact");
      expect(text).toContain("Hypothesis");
      expect(text).toContain("#1580");
    });
    it("test_observability_gap_loop", () => {
      expect(readText("coding/debugging.md").toLowerCase()).toContain("observability");
    });
    it("test_rule_body_carries_must_token", () => {
      expect(/^- ! /m.test(readText("coding/debugging.md"))).toBe(true);
    });
    it("test_rule_body_carries_must_not_token", () => {
      expect(readText("coding/debugging.md")).toContain("⊗");
    });
  });
  describe("TestCodingMdCrossReference1621", () => {
    it("test_cross_reference_section_present", () => {
      const text = readText("coding/coding.md");
      expect(text).toContain("## Debugging and Root-Cause Investigation (#1621)");
      expect(text).toContain("debugging.md");
    });
    it("test_anti_pattern_cross_reference", () => {
      const m = readText("coding/coding.md").match(/## Anti-Patterns\s*(.*)$/s);
      expect(m).not.toBeNull();
      expect(m?.[1] ?? "").toContain("#1621");
    });
  });
  describe("TestLessonsCrossReference1621", () => {
    it("test_lessons_md_cross_reference", () => {
      expect(readText("meta/lessons.md")).toContain("#1621");
    });
  });
  describe("TestDebugSkill1621", () => {
    it("test_skill_exists", () => {
      expect(isFile("skills/deft-directive-debug/SKILL.md")).toBe(true);
    });
    it("test_skill_frontmatter_name", () => {
      const text = readText("skills/deft-directive-debug/SKILL.md");
      expect(text.startsWith("---")).toBe(true);
      expect(text).toContain("name: deft-directive-debug");
    });
    it("test_skill_rfc2119_legend", () => {
      expect(readText("skills/deft-directive-debug/SKILL.md")).toContain("!=MUST, ~=SHOULD");
    });
    it("test_skill_iron_law", () => {
      const text = readText("skills/deft-directive-debug/SKILL.md").toLowerCase();
      expect(text).toContain("iron law");
      expect(text).toContain("embargo");
    });
    it("test_skill_references_close_gate", () => {
      expect(readText("skills/deft-directive-debug/SKILL.md")).toContain(
        "task verify:investigation",
      );
    });
    it("test_skill_references_coding_standard", () => {
      expect(readText("skills/deft-directive-debug/SKILL.md")).toContain("coding/debugging.md");
    });
    it("test_skill_references_vendored_design", () => {
      expect(readText("skills/deft-directive-debug/SKILL.md")).toContain(
        "docs/reference/forensic-research/",
      );
    });
    it("test_skill_falsification_waves", () => {
      const text = readText("skills/deft-directive-debug/SKILL.md").toLowerCase();
      expect(text).toContain("falsif");
      expect(text).toContain("red-team");
    });
    it("test_skill_completion_gate", () => {
      const text = readText("skills/deft-directive-debug/SKILL.md");
      expect(text).toContain("Skill Completion Gate");
      expect(text).toContain("exiting skill");
    });
    it("test_thin_pointer_exists", () => {
      const text = readText(".agents/skills/deft-directive-debug/SKILL.md");
      expect(text).toContain("skills/deft-directive-debug/SKILL.md");
    });
  });
  describe("TestDebugSkillRouting1621", () => {
    it("test_agents_md_routing", () => {
      const text = readText("AGENTS.md");
      expect(text).toContain("skills/deft-directive-debug/SKILL.md");
      expect(text).toContain("debug");
      expect(text).toContain("root cause");
    });
    it("test_template_routing", () => {
      expect(readText("templates/agents-entry.md")).toContain(
        ".deft/core/skills/deft-directive-debug/SKILL.md",
      );
    });
  });
});
