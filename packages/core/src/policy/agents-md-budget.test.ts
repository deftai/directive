import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveAgentsMdBudget } from "./agents-md-budget.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

/** Create a temp project root; optionally write a PROJECT-DEFINITION with the given raw JSON text. */
function makeRepo(raw?: string): string {
  const root = mkdtempSync(join(tmpdir(), "deft-agents-budget-policy-"));
  temps.push(root);
  if (raw !== undefined) {
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), raw, "utf8");
  }
  return root;
}

/** Serialize a plan object into a minimal valid PROJECT-DEFINITION envelope. */
function withPlan(plan: unknown): string {
  return JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan });
}

describe("resolveAgentsMdBudget", () => {
  it("returns default-on-error when PROJECT-DEFINITION is absent", () => {
    const result = resolveAgentsMdBudget(makeRepo());
    expect(result.source).toBe("default-on-error");
    expect(result.budget).toBeNull();
    expect(result.error).toContain("PROJECT-DEFINITION not found");
  });

  it("returns default-on-error when PROJECT-DEFINITION is not valid JSON", () => {
    const result = resolveAgentsMdBudget(makeRepo("{ not json"));
    expect(result.source).toBe("default-on-error");
    expect(result.error).toContain("not valid JSON");
  });

  it("returns default-on-error when plan is not an object", () => {
    const result = resolveAgentsMdBudget(makeRepo(withPlan("nope")));
    expect(result.source).toBe("default-on-error");
    expect(result.error).toContain("'plan' is not an object");
  });

  it("returns unset when the plan has no policy block", () => {
    const result = resolveAgentsMdBudget(makeRepo(withPlan({ title: "T" })));
    expect(result.source).toBe("unset");
    expect(result.budget).toBeNull();
    expect(result.error).toBeNull();
  });

  it("returns unset when the policy block omits agentsMdBudget", () => {
    const result = resolveAgentsMdBudget(
      makeRepo(withPlan({ policy: { allowDirectCommitsToMaster: false } })),
    );
    expect(result.source).toBe("unset");
  });

  it("returns unset when the policy block is not an object", () => {
    const result = resolveAgentsMdBudget(makeRepo(withPlan({ policy: "nope" })));
    expect(result.source).toBe("unset");
  });

  it("returns default-on-error when agentsMdBudget is a string", () => {
    const result = resolveAgentsMdBudget(
      makeRepo(withPlan({ policy: { agentsMdBudget: "nope" } })),
    );
    expect(result.source).toBe("default-on-error");
    expect(result.error).toContain("must be an object with managedMaxLines and unmanagedMaxLines");
    expect(result.error).toContain("got str");
  });

  it("returns default-on-error when agentsMdBudget is an array", () => {
    const result = resolveAgentsMdBudget(makeRepo(withPlan({ policy: { agentsMdBudget: [] } })));
    expect(result.source).toBe("default-on-error");
    expect(result.error).toContain("got list");
  });

  it("returns default-on-error when managedMaxLines is missing", () => {
    const result = resolveAgentsMdBudget(
      makeRepo(withPlan({ policy: { agentsMdBudget: { unmanagedMaxLines: 10 } } })),
    );
    expect(result.source).toBe("default-on-error");
    expect(result.error).toContain("managedMaxLines is required");
  });

  it("returns default-on-error when unmanagedMaxLines is missing", () => {
    const result = resolveAgentsMdBudget(
      makeRepo(withPlan({ policy: { agentsMdBudget: { managedMaxLines: 5 } } })),
    );
    expect(result.source).toBe("default-on-error");
    expect(result.error).toContain("unmanagedMaxLines is required");
  });

  it("returns default-on-error when a region value is a non-integer float", () => {
    const result = resolveAgentsMdBudget(
      makeRepo(
        withPlan({ policy: { agentsMdBudget: { managedMaxLines: 5.5, unmanagedMaxLines: 10 } } }),
      ),
    );
    expect(result.source).toBe("default-on-error");
    expect(result.error).toContain("must be a non-negative integer");
    expect(result.error).toContain("got float");
  });

  it("returns default-on-error when a region value is a string (reports str type)", () => {
    const result = resolveAgentsMdBudget(
      makeRepo(
        withPlan({ policy: { agentsMdBudget: { managedMaxLines: "5", unmanagedMaxLines: 10 } } }),
      ),
    );
    expect(result.source).toBe("default-on-error");
    expect(result.error).toContain("got str ('5')");
  });

  it("returns default-on-error when a region value is negative", () => {
    const result = resolveAgentsMdBudget(
      makeRepo(
        withPlan({ policy: { agentsMdBudget: { managedMaxLines: 5, unmanagedMaxLines: -1 } } }),
      ),
    );
    expect(result.source).toBe("default-on-error");
    expect(result.error).toContain("must be a non-negative integer");
  });

  it("resolves a typed budget when both regions are valid non-negative integers", () => {
    const result = resolveAgentsMdBudget(
      makeRepo(
        withPlan({ policy: { agentsMdBudget: { managedMaxLines: 223, unmanagedMaxLines: 347 } } }),
      ),
    );
    expect(result.source).toBe("typed");
    expect(result.error).toBeNull();
    expect(result.budget).toEqual({ managedMaxLines: 223, unmanagedMaxLines: 347 });
  });

  it("reads the namespaced x-directive/policy block", () => {
    const result = resolveAgentsMdBudget(
      makeRepo(
        withPlan({
          "x-directive/policy": { agentsMdBudget: { managedMaxLines: 1, unmanagedMaxLines: 2 } },
        }),
      ),
    );
    expect(result.source).toBe("typed");
    expect(result.budget).toEqual({ managedMaxLines: 1, unmanagedMaxLines: 2 });
  });
});
