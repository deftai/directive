import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

const VALID_TYPES = new Set(["preparatory", "spec-generating"]);

function parseReadmeTable(): Array<Record<string, string>> {
  const text = readText("strategies/README.md");
  const rows: Array<Record<string, string>> = [];
  let inTable = false;
  let headers: string[] = [];
  for (const line of text.split("\n")) {
    const stripped = line.trim();
    if (!stripped.startsWith("|")) {
      if (inTable) break;
      continue;
    }
    const cells = stripped
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
    if (!inTable) {
      headers = cells.map((h) => h.toLowerCase());
      inTable = true;
      continue;
    }
    if (cells.every((c) => [...c].every((ch) => "- :".includes(ch)))) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

describe("test_strategy_chaining.py", () => {
  describe("TestInterviewGateSections", () => {
    const text = readText("strategies/interview.md");
    it("test_chaining_gate_section_exists", () => {
      expect(text).toContain("## Chaining Gate");
    });
    it("test_acceptance_gate_section_exists", () => {
      expect(text).toContain("## Acceptance Gate");
    });
    it("test_chaining_gate_before_sizing_gate", () => {
      expect(text.indexOf("## Chaining Gate")).toBeLessThan(text.indexOf("## Sizing Gate"));
    });
    it("test_acceptance_gate_after_transition_criteria", () => {
      expect(text.lastIndexOf("### Transition Criteria")).toBeLessThan(
        text.indexOf("## Acceptance Gate"),
      );
    });
  });

  describe("TestReadmeTypeColumn", () => {
    const rows = parseReadmeTable();
    it("test_type_column_exists", () => {
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]).toHaveProperty("type");
    });
    it("test_all_rows_have_valid_type", () => {
      for (const row of rows) {
        expect(VALID_TYPES.has(row.type ?? "")).toBe(true);
      }
    });
    it("test_known_preparatory_strategies", () => {
      for (const row of rows) {
        const m = (row.strategy ?? "").match(/\[([^\]]+)\]/);
        const name = m?.[1] ?? row.strategy ?? "";
        if (["map.md", "discuss.md", "research.md"].includes(name)) {
          expect(row.type).toBe("preparatory");
        }
      }
    });
    it("test_known_spec_generating_strategies", () => {
      for (const row of rows) {
        const m = (row.strategy ?? "").match(/\[([^\]]+)\]/);
        const name = m?.[1] ?? row.strategy ?? "";
        if (["interview.md", "yolo.md", "speckit.md"].includes(name)) {
          expect(row.type).toBe("spec-generating");
        }
      }
    });
  });

  for (const filename of ["map.md", "research.md", "discuss.md", "probe.md"]) {
    it(`test_preparatory_strategy_references_chaining_gate ${filename}`, () => {
      const text = readText(`strategies/${filename}`);
      expect(
        text.includes("## Then: Chaining Gate") ||
          (text.includes("### Chained Mode") && text.toLowerCase().includes("chaining gate")),
      ).toBe(true);
    });
  }
  for (const filename of ["interview.md", "yolo.md", "speckit.md"]) {
    it(`test_spec_generating_strategy_no_then_chaining_gate ${filename}`, () => {
      expect(readText(`strategies/${filename}`)).not.toContain("## Then: Chaining Gate");
    });
  }

  describe("TestVbriefSchemaDocumentation", () => {
    const text = readText("vbrief/vbrief.md");
    it("test_completed_strategies_documented", () => {
      expect(text).toContain("completedStrategies");
    });
    it("test_artifacts_field_documented", () => {
      expect(text).toContain("Strategy Chaining Fields");
    });
    it("test_run_count_documented", () => {
      expect(text).toContain("runCount");
    });
  });

  describe("TestYoloV020OutputShape", () => {
    it("test_yolo_md_emits_v020_output_shape", () => {
      const text = readText("strategies/yolo.md");
      expect(text).toContain("v0.20 Output Shape (s3-migrate-yolo / #1166)");
      expect(text).toContain("task project:render");
      expect(text).toContain("PROJECT-DEFINITION.vbrief.json");
      expect(
        text.includes("vbrief/proposed/YYYY-MM-DD-") ||
          text.toLowerCase().includes("date-prefixed"),
      ).toBe(true);
      expect(text).toContain("Never emit `vbrief/specification.vbrief.json`");
      expect(text).toContain("artifact-guards.md");
      expect(text).toContain("Pre-Cutover Detection Guard");
    });
  });

  describe("TestProbeMechanicalGuard", () => {
    const text = readText("strategies/probe.md");
    it("test_probe_strategy_documents_mechanical_guard_module", () => {
      expect(text).toContain("scripts/probe_session.py");
      expect(
        text.includes("Mechanical guard") || text.toLowerCase().includes("mechanical guard"),
      ).toBe(true);
    });
    it("test_probe_strategy_documents_interrogate_complete_states", () => {
      expect(text).toContain("interrogate");
      expect(text).toContain("complete");
      expect(text).toContain(".deft/probe-session.json");
    });
    it("test_probe_strategy_documents_guard_commands", () => {
      expect(text).toContain("guard-artifact");
      expect(text).toContain("guard-plan-registration");
      expect(text).toContain("completedStrategies.probe");
    });
    it("test_probe_strategy_documents_recovery_path", () => {
      expect(text.includes("Recovery") || text.toLowerCase().includes("recovery")).toBe(true);
      expect(text).toContain("probe_session.py complete");
      expect(text.toLowerCase()).toContain("transition criteria");
    });
  });
});
