import { describe, expect, it } from "vitest";
import {
  ALLOWED_SKIP_REASONS,
  isAllowedSkip,
  PRE_PR_PHASES,
  RENDER_EXPORT_RULE,
  requiredPhases,
} from "./phases.js";

describe("pre-pr-controller phases (Limb 2)", () => {
  it("writes command-observable vs semantic kinds before implementation", () => {
    const command = PRE_PR_PHASES.filter((p) => p.kind === "command-observable").map((p) => p.id);
    const semantic = PRE_PR_PHASES.filter((p) => p.kind === "semantic").map((p) => p.id);
    expect(command).toEqual([
      "branch_policy",
      "plan_sequence",
      "lint_iteration",
      "coverage_headroom",
      "render_export",
      "merge_chokepoint",
    ]);
    expect(semantic).toEqual(["read", "write", "diff", "loop"]);
  });

  it("records one closed render/export rule in the workflow version", () => {
    const render = PRE_PR_PHASES.find((p) => p.id === "render_export");
    expect(render?.command).toBe(RENDER_EXPORT_RULE);
    expect(RENDER_EXPORT_RULE).toContain("never create missing exports");
    expect(RENDER_EXPORT_RULE).toContain("never hand-edit MAP.md");
  });

  it("names skill-prescribed branch, plan, lint, and merge-chokepoint commands", () => {
    const byId = Object.fromEntries(PRE_PR_PHASES.map((p) => [p.id, p]));
    expect(byId.branch_policy?.command).toBe("deft verify:branch");
    expect(byId.plan_sequence?.command).toBe("deft verify:plan-sequence");
    expect(byId.merge_chokepoint?.command).toBe("deft check");
    expect(byId.lint_iteration?.command).toContain("vitest run");
  });

  it("allows only closed skip reasons", () => {
    expect(isAllowedSkip("plan_sequence", ALLOWED_SKIP_REASONS.plan_sequence ?? "")).toBe(true);
    expect(isAllowedSkip("plan_sequence", "agent skipped")).toBe(false);
    expect(isAllowedSkip("merge_chokepoint", "busy")).toBe(false);
    expect(isAllowedSkip("plan_sequence", "")).toBe(false);
    expect(isAllowedSkip("plan_sequence", null)).toBe(false);
    expect(isAllowedSkip("coverage_headroom", ALLOWED_SKIP_REASONS.coverage_headroom ?? "")).toBe(
      true,
    );
    expect(isAllowedSkip("coverage_headroom", "changed-file audit")).toBe(false);
    expect(requiredPhases().every((p) => p.required)).toBe(true);
  });
});
