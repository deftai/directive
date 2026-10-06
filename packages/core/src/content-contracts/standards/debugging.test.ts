import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadLedger,
  validateLedger,
  validationOk,
} from "../../orchestration/verify-investigation.js";
import { validateVbriefSchema } from "../../vbrief-validate/index.js";
import { isFile, readText, resolveContentPath } from "./_helpers.js";

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length > 0) {
    const root = scratch.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

/** Filled forensic ledger subject for 0.8 schema + close-gate loader (#5195). */
function filledInvestigationFixture(): Record<string, unknown> {
  return {
    xBRIEFInfo: {
      version: "0.8",
      description: "Filled forensic investigation fixture (#5195)",
    },
    plan: {
      id: "fixture.investigation.5195",
      title: "Filled forensic ledger for deposit close-gate",
      status: "completed",
      narratives: {
        Problem: "symptom",
        Hypothesis: "leading theory",
        Observation: "evidence",
        Outcome: "mechanism",
      },
      items: [
        {
          id: "branch.traps",
          title: "Popularity traps",
          status: "failed",
          items: [
            {
              id: "claim.trap.concurrency.B1",
              title: "Resource saturation during anchor window",
              status: "failed",
              metadata: {
                "x-claim": {
                  evidenceRefs: ["EV-1"],
                  ruledOutReason: "no saturation in window",
                  requiredEvidence: "metrics",
                  prediction: "saturation if concurrency",
                },
              },
            },
          ],
        },
        {
          id: "branch.slowness",
          title: "Why wall clock was high",
          status: "completed",
          items: [
            {
              id: "claim.slow.embed",
              title: "Embed fleet saturated",
              status: "completed",
              metadata: {
                "x-claim": {
                  evidenceRefs: ["EV-1"],
                  requiredEvidence: "embed wait telemetry",
                  prediction: "queue wait explains wall clock",
                },
              },
            },
          ],
        },
        {
          id: "branch.terminal",
          title: "How the session ended",
          status: "completed",
          items: [],
        },
      ],
      edges: [
        {
          from: "claim.trap.concurrency.B1",
          to: "branch.traps",
          type: "invalidates",
        },
      ],
      references: [
        {
          id: "EV-1",
          type: "x-xbrief/evidence",
          title: "embed wait log line",
          uri: "file://logs/embed.txt",
        },
      ],
      metadata: {
        "x-investigation": {
          profile: "forensic-research-v1",
          domain: "code-debug",
          wave: 4,
          anchor: {},
          agents: {},
          wavesCompleted: { "1": true, "2": true, "3": true, "4": true },
          chatEmbargo: false,
          validatorPassedAt: "2026-10-06T00:00:00Z",
        },
      },
    },
  };
}

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
      const text = readText("skills/deft-directive-debug/SKILL.md");
      expect(text).toContain("skills/deft-directive-debug/templates/investigation.xbrief.json");
      expect(text).toContain("skills/deft-directive-debug/references/outcome-template.md");
      expect(text).toContain("thin xBRIEF 0.8 profile");
      expect(text).not.toContain(
        "docs/reference/forensic-research/templates/investigation.xbrief.json",
      );
      expect(text).not.toContain("sub-agents per");
      expect(isFile("skills/deft-directive-debug/templates/investigation.xbrief.json")).toBe(true);
      expect(isFile("skills/deft-directive-debug/references/outcome-template.md")).toBe(true);
    });
    it("test_filled_investigation_fixture_passes_0_8_and_close_gate", () => {
      const fixture = filledInvestigationFixture();
      expect(validateVbriefSchema(fixture, "filled-investigation.xbrief.json")).toEqual([]);
      const dir = mkdtempSync(join(tmpdir(), "deft-inv-5195-"));
      scratch.push(dir);
      const ledgerPath = join(dir, "investigation.xbrief.json");
      writeFileSync(ledgerPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
      const loaded = loadLedger(ledgerPath);
      expect(validationOk(validateLedger(loaded))).toBe(true);
      const scaffold = JSON.parse(
        readText("skills/deft-directive-debug/templates/investigation.xbrief.json"),
      ) as Record<string, unknown>;
      expect(validateVbriefSchema(scaffold, "investigation.xbrief.json").length).toBeGreaterThan(0);
      expect(
        resolveContentPath("skills/deft-directive-debug/templates/investigation.xbrief.json"),
      ).toContain("content");
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
    // #838: skill routing moved from AGENTS.md / the agents-entry template to the
    // REFERENCES.md Skills Index (unified Level-0 index for skills + docs).
    it("test_references_md_routing", () => {
      const text = readText("REFERENCES.md");
      expect(text).toContain("skills/deft-directive-debug/SKILL.md");
      expect(text).toContain("debug");
      expect(text).toContain("root cause");
    });
  });
});
