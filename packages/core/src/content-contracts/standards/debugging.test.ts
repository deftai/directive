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

const DEPOSITED_INVESTIGATION_TEMPLATE =
  "skills/deft-directive-debug/templates/investigation.xbrief.json";

/** Load the deposited scaffold (empty id/title) for schema + fill-from-template tests. */
function depositedInvestigationScaffold(): Record<string, unknown> {
  return JSON.parse(readText(DEPOSITED_INVESTIGATION_TEMPLATE)) as Record<string, unknown>;
}

/**
 * Fill a clone of the deposited investigation template so schema/close-gate
 * coverage tracks the shipped scaffold shape (#5195 Greptile).
 */
function filledInvestigationFixtureFromTemplate(): Record<string, unknown> {
  const fixture = structuredClone(depositedInvestigationScaffold()) as {
    xBRIEFInfo: Record<string, unknown>;
    plan: {
      id: string;
      title: string;
      status: string;
      narratives: Record<string, string>;
      items: Array<{
        id: string;
        title: string;
        status: string;
        items: Array<{
          id: string;
          title: string;
          status: string;
          metadata?: { "x-claim"?: Record<string, unknown> };
        }>;
      }>;
      edges: Array<Record<string, string>>;
      references: Array<Record<string, string>>;
      metadata: { "x-investigation": Record<string, unknown> };
    };
  };

  fixture.xBRIEFInfo.description = "Filled forensic investigation fixture (#5195)";
  fixture.plan.id = "fixture.investigation.5195";
  fixture.plan.title = "Filled forensic ledger for deposit close-gate";
  fixture.plan.status = "completed";
  fixture.plan.narratives = {
    Problem: "symptom",
    Hypothesis: "leading theory",
    Observation: "evidence",
    Outcome: "mechanism",
  };

  const traps = fixture.plan.items.find((b) => b.id === "branch.traps");
  if (!traps) throw new Error("deposited template missing branch.traps");
  traps.status = "failed";
  const concurrency = traps.items.find((c) => c.id === "claim.trap.concurrency.B1");
  if (!concurrency) throw new Error("deposited template missing claim.trap.concurrency.B1");
  concurrency.status = "failed";
  concurrency.metadata = {
    "x-claim": {
      ...(concurrency.metadata?.["x-claim"] ?? {}),
      evidenceRefs: ["EV-1"],
      ruledOutReason: "no saturation in window",
    },
  };
  // Drop unused scaffold sibling so the filled ledger stays minimal.
  traps.items = [concurrency];

  const slowness = fixture.plan.items.find((b) => b.id === "branch.slowness");
  if (!slowness) throw new Error("deposited template missing branch.slowness");
  slowness.status = "completed";
  slowness.items = [
    {
      id: "claim.slow.resource",
      title: "Resource pool saturated",
      status: "completed",
      metadata: {
        "x-claim": {
          evidenceRefs: ["EV-1"],
          requiredEvidence: "queue / wait telemetry",
          prediction: "queue wait explains wall clock",
        },
      },
    },
  ];

  const terminal = fixture.plan.items.find((b) => b.id === "branch.terminal");
  if (!terminal) throw new Error("deposited template missing branch.terminal");
  terminal.status = "completed";
  terminal.items = [];

  fixture.plan.edges = [
    {
      from: "claim.trap.concurrency.B1",
      to: "branch.traps",
      type: "invalidates",
    },
  ];
  fixture.plan.references = [
    {
      id: "EV-1",
      type: "x-xbrief/evidence",
      title: "resource wait log line",
      uri: "file://logs/resource.txt",
    },
  ];
  fixture.plan.metadata["x-investigation"] = {
    ...fixture.plan.metadata["x-investigation"],
    domain: "code-debug",
    wave: 4,
    wavesCompleted: { "1": true, "2": true, "3": true, "4": true },
    chatEmbargo: false,
    validatorPassedAt: "2026-10-06T00:00:00Z",
  };

  return fixture;
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
      const outcome = readText("skills/deft-directive-debug/references/outcome-template.md");
      expect(outcome).toContain("subject id");
      expect(outcome).toContain("Optional example (SLizard");
    });
    it("test_filled_investigation_fixture_passes_0_8_and_close_gate", () => {
      const scaffold = depositedInvestigationScaffold();
      expect(validateVbriefSchema(scaffold, "investigation.xbrief.json").length).toBeGreaterThan(0);
      expect(JSON.stringify(scaffold)).toContain("optional domain pack: trap.concurrency");
      expect(resolveContentPath(DEPOSITED_INVESTIGATION_TEMPLATE)).toContain("content");

      const fixture = filledInvestigationFixtureFromTemplate();
      expect(validateVbriefSchema(fixture, "filled-investigation.xbrief.json")).toEqual([]);
      const dir = mkdtempSync(join(tmpdir(), "deft-inv-5195-"));
      scratch.push(dir);
      const ledgerPath = join(dir, "investigation.xbrief.json");
      writeFileSync(ledgerPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
      const loaded = loadLedger(ledgerPath);
      expect(validationOk(validateLedger(loaded))).toBe(true);
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
