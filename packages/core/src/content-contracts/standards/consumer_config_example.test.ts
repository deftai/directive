import { describe, expect, it } from "vitest";
import { validateTriageAutoClassifyOnPlan } from "../../triage/classify/index.js";
import {
  validateTriageScopeIgnoresOnPlan,
  validateTriageScopeOnPlan,
} from "../../triage/scope/validate.js";
import {
  validateTriageRankingLabelsOnPlan,
  validateWipCapOnPlan,
} from "../../vbrief-validate/plan-hooks.js";
import { isFile, loadJson, readText } from "./_helpers.js";

const docText = readText("docs/example-project-definition.md");
const mainText = readText("main.md");
const projectDefinition = loadJson("vbrief/PROJECT-DEFINITION.vbrief.json") as Record<
  string,
  unknown
>;
const policy = (projectDefinition.plan as Record<string, unknown>).policy as Record<
  string,
  unknown
>;

describe("test_consumer_config_example.py", () => {
  it("test_doc_file_exists", () => {
    expect(isFile("docs/example-project-definition.md")).toBe(true);
  });

  for (const pattern of [
    /^#\s+Example PROJECT-DEFINITION/m,
    /^##\s+1\.\s+Empty template/m,
    /^##\s+2\.\s+Deft's filled-in version/m,
    /^##\s+3\.\s+Side-by-side annotation column/m,
    /^##\s+4\.\s+Closing note:\s*clone-and-edit/m,
  ]) {
    it(`test_doc_carries_required_sections ${pattern}`, () => {
      expect(pattern.test(docText)).toBe(true);
    });
  }

  it("test_doc_carries_per_primitive_annotation_subsections", () => {
    for (const subsection of [
      /^###\s+triageScope/m,
      /^###\s+triageRankingLabels/m,
      /^###\s+triageAutoClassify/m,
      /^###\s+triageScopeIgnores/m,
    ]) {
      expect(subsection.test(docText)).toBe(true);
    }
  });

  for (const label of ["blocks-merge", "breaking-change", "status:superseded-pending"]) {
    it(`test_doc_annotates_required_labels ${label}`, () => {
      expect(docText).toContain(label);
    });
  }

  it("test_doc_distinguishes_deft_specific_from_common_convention", () => {
    expect(docText).toContain("deft-specific");
    expect(docText).toContain("common convention");
  });

  it("test_doc_closes_with_clone_and_edit_pointer", () => {
    const closing = docText.split("## 4. Closing note").pop() ?? "";
    expect(closing).toContain("PROJECT-DEFINITION.vbrief.json");
    expect(closing.toLowerCase()).toContain("label");
  });

  it("test_policy_carries_four_typed_arrays", () => {
    for (const key of [
      "triageScope",
      "triageRankingLabels",
      "triageAutoClassify",
      "triageScopeIgnores",
    ]) {
      expect(policy).toHaveProperty(key);
      expect(Array.isArray(policy[key])).toBe(true);
      expect((policy[key] as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it("test_policy_omits_wip_cap", () => {
    expect(policy).not.toHaveProperty("wipCap");
  });

  it("test_triage_scope_carries_deft_labels_and_milestone_rule", () => {
    const rules = policy.triageScope as Array<Record<string, unknown>>;
    const labelRule = rules.find((r) => r.rule === "labels");
    expect(labelRule).toBeTruthy();
    const anyOf = (labelRule?.["any-of"] as string[]) ?? [];
    for (const required of [
      "enhancement",
      "epic",
      "meta",
      "skills",
      "adoption-blocker",
      "blocks-merge",
      "blocks-release-tag",
    ]) {
      expect(anyOf).toContain(required);
    }
    const milestoneRule = rules.find((r) => r.rule === "milestone");
    expect(milestoneRule?.["is-open"]).toBe(true);
  });

  it("test_triage_ranking_labels_in_declared_priority_order", () => {
    expect(policy.triageRankingLabels).toEqual([
      "blocks-merge",
      "blocks-release-tag",
      "adoption-blocker",
      "breaking-change",
      "urgent",
      "bug",
    ]);
  });

  it("test_triage_auto_classify_carries_canonical_rules", () => {
    const rules = policy.triageAutoClassify as Array<Record<string, unknown>>;
    const byFirstLabel: Record<string, Record<string, unknown>> = {};
    for (const r of rules) {
      const labels = ((r.match as Record<string, unknown>)?.labels as Record<string, unknown>)?.[
        "any-of"
      ] as string[] | undefined;
      if (labels?.[0]) byFirstLabel[labels[0]] = r;
    }
    expect(byFirstLabel["status:superseded-pending"]?.action).toBe("defer");
    expect(byFirstLabel.rfc?.action).toBe("defer");
    expect(byFirstLabel.wontfix?.action).toBe("defer");
    expect(byFirstLabel.duplicate?.action).toBe("archive");
    expect(byFirstLabel["fixed-pending-merge"]?.action).toBe("defer");
    expect(byFirstLabel["fixed-pending-merge"]?.["resume-on"]).toBe("<linked-PR>:merged");
  });

  it("test_triage_scope_ignores_silences_wontfix_and_duplicate", () => {
    const entries = policy.triageScopeIgnores as Array<Record<string, unknown>>;
    const ignored = new Set(entries.map((e) => e.label).filter(Boolean));
    expect(ignored.has("wontfix")).toBe(true);
    expect(ignored.has("duplicate")).toBe(true);
  });

  const fp = "vbrief/PROJECT-DEFINITION.vbrief.json";
  it("test_triage_scope_passes_d12_validator", () => {
    expect(validateTriageScopeOnPlan(projectDefinition.plan, fp)).toEqual([]);
  });
  it("test_triage_ranking_labels_passes_d11_validator", () => {
    expect(validateTriageRankingLabelsOnPlan(projectDefinition.plan, fp)).toEqual([]);
  });
  it("test_triage_auto_classify_passes_d10_validator", () => {
    expect(validateTriageAutoClassifyOnPlan(projectDefinition.plan, fp)).toEqual([]);
  });
  it("test_triage_scope_ignores_passes_d14_d14c_validator", () => {
    expect(validateTriageScopeIgnoresOnPlan(projectDefinition.plan, fp)).toEqual([]);
  });
  it("test_wip_cap_passes_d4_validator_when_omitted", () => {
    expect(validateWipCapOnPlan(projectDefinition.plan, fp)).toEqual([]);
  });

  it("test_main_taskfile_include_uses_resolvable_deft_namespace", () => {
    const section = mainText.slice(
      mainText.indexOf("### Publishing deft tasks in your project root"),
      mainText.indexOf("### What migration produces"),
    );
    expect(section).toContain("task deft:migrate:vbrief");
    expect(section).toContain("task -t ./.deft/core/Taskfile.yml migrate:vbrief");
  });

  it("test_main_preferred_workflow_uses_namespaced_consumer_tasks", () => {
    const section = mainText.slice(
      mainText.indexOf("## Preferred Workflow: Tasks + Skills Together"),
      mainText.indexOf("## Continuous Improvement"),
    );
    for (const marker of [
      "task deft:issue:ingest",
      "task deft:reconcile:issues",
      "task deft:scope:{promote,activate,complete,cancel,restore,block,unblock}",
      "task deft:roadmap:render",
      "task deft:project:render",
    ]) {
      expect(section).toContain(marker);
    }
  });
});
