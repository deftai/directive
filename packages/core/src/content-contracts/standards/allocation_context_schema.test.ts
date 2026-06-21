import { describe, expect, it } from "vitest";
import { isFile, readText } from "./_helpers.js";

const TEMPLATE = "templates/agent-prompt-preamble.md";
const FROZEN_FIELDS = [
  "dispatch_kind",
  "allocation_plan_id",
  "batching_rationale",
  "cohort_vbriefs",
  "operator_approval_evidence",
] as const;
const templateText = readText(TEMPLATE);

function allocationSection(text: string): string {
  const m = text.match(/^##\s+.*Allocation context.*$/m);
  if (!m || m.index === undefined) {
    throw new Error("missing Allocation context section");
  }
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  const nxt = rest.match(/^##\s+/m);
  return rest.slice(0, nxt ? nxt.index : rest.length);
}

describe("test_allocation_context_schema.py", () => {
  it("test_template_exists", () => {
    expect(isFile(TEMPLATE)).toBe(true);
  });
  it("test_allocation_context_heading_present", () => {
    expect(/^##\s+.*Allocation context/m.test(templateText)).toBe(true);
  });
  it("test_section_references_1378", () => {
    expect(templateText).toContain("#1378");
  });
  for (const field of FROZEN_FIELDS) {
    it(`test_all_five_fields_documented ${field}`, () => {
      expect(templateText).toContain(field);
    });
  }
  it("test_fields_documented_in_frozen_order", () => {
    const section = allocationSection(templateText);
    const positions = FROZEN_FIELDS.map((field) => section.indexOf(field));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
  it("test_dispatch_kind_enumerates_both_values", () => {
    expect(templateText).toContain("solo");
    expect(templateText).toContain("swarm-cohort");
  });
  it("test_recognition_contract_sentence_present", () => {
    expect(templateText).toContain("Recognition contract");
    expect(templateText).toContain("NON-NULL");
    expect(templateText).toContain("#1371");
    expect(
      /dispatch_kind:\s*swarm-cohort.*NON-NULL.*allocation_plan_id.*batching_rationale/is.test(
        templateText,
      ),
    ).toBe(true);
    expect(templateText.includes("consent-token") || templateText.includes("consent token")).toBe(
      true,
    );
  });
  it("test_absent_section_falls_back_to_1371_prose", () => {
    expect(templateText).toContain("ABSENT");
    expect(/ABSENT.*fall back to the #1371 prose carve-out/is.test(templateText)).toBe(true);
  });
  it("test_worked_example_present", () => {
    expect(templateText).toContain("Worked example");
    expect(templateText).toContain("## Allocation context");
    expect(templateText).toContain("dispatch_kind: swarm-cohort");
    expect(templateText).toContain("- allocation_plan_id: orchestrator-run-");
    expect(templateText).toContain("- batching_rationale: ");
    expect(templateText).toContain("- cohort_vbriefs: [");
    expect(templateText).toContain("- operator_approval_evidence: ");
  });
  it("test_worked_example_lists_full_cohort", () => {
    const m = templateText.match(/- cohort_vbriefs: \[(.+?)\]/s);
    expect(m).not.toBeNull();
    const entries = (m?.[1] ?? "").split(",").filter((e) => e.includes(".vbrief.json"));
    expect(entries.length).toBeGreaterThanOrEqual(2);
  });
});
