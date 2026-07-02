import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { countRegions, evaluate } from "./evaluate.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function writeProjectDefinition(root: string, plan: Record<string, unknown>): void {
  const dir = join(root, "vbrief");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: { title: "T", status: "running", items: [], ...plan },
    }),
    "utf8",
  );
}

/** Build an AGENTS.md with `unmanaged` leading lines then a managed block of `managed` lines. */
function agentsWith(unmanaged: number, managed: number): string {
  const lines: string[] = [];
  for (let i = 0; i < unmanaged; i += 1) {
    lines.push(`unmanaged line ${i}`);
  }
  if (managed > 0) {
    lines.push("<!-- deft:managed-section v3 sha=abc refreshed=x session=y -->");
    for (let i = 0; i < managed - 2; i += 1) {
      lines.push(`managed line ${i}`);
    }
    lines.push("<!-- /deft:managed-section -->");
  }
  return lines.join("\n");
}

function makeRepo(options: { plan?: Record<string, unknown>; agents?: string }): string {
  const root = mkdtempSync(join(tmpdir(), "deft-agents-budget-"));
  temps.push(root);
  mkdirSync(join(root, "vbrief"), { recursive: true });
  if (options.plan !== undefined) {
    writeProjectDefinition(root, options.plan);
  }
  if (options.agents !== undefined) {
    writeFileSync(join(root, "AGENTS.md"), options.agents, "utf8");
  }
  return root;
}

describe("countRegions", () => {
  it("splits managed and unmanaged line counts", () => {
    const result = countRegions(agentsWith(10, 5));
    expect("counts" in result).toBe(true);
    if ("counts" in result) {
      expect(result.counts).toEqual({ total: 15, managed: 5, unmanaged: 10 });
    }
  });

  it("treats a file with no markers as entirely unmanaged", () => {
    const result = countRegions("a\nb\nc");
    expect("counts" in result).toBe(true);
    if ("counts" in result) {
      expect(result.counts).toEqual({ total: 3, managed: 0, unmanaged: 3 });
    }
  });

  it("ignores a trailing final newline", () => {
    const result = countRegions("a\nb\n");
    if ("counts" in result) {
      expect(result.counts.total).toBe(2);
    }
  });

  it("errors when only an open marker is present (malformed)", () => {
    const text = "x\n<!-- deft:managed-section v3 -->\nmanaged";
    const result = countRegions(text);
    expect("error" in result).toBe(true);
  });

  it("errors when only a close marker is present (malformed)", () => {
    const text = "x\n<!-- /deft:managed-section -->\ny";
    const result = countRegions(text);
    expect("error" in result).toBe(true);
  });

  it("errors when a second open marker is present (duplicate)", () => {
    const text = [
      "x",
      "<!-- deft:managed-section v3 -->",
      "managed",
      "<!-- /deft:managed-section -->",
      "<!-- deft:managed-section v3 -->",
      "second block",
    ].join("\n");
    const result = countRegions(text);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("malformed");
    }
  });

  it("errors when a second close marker is present (duplicate)", () => {
    const text = [
      "x",
      "<!-- deft:managed-section v3 -->",
      "managed",
      "<!-- /deft:managed-section -->",
      "<!-- /deft:managed-section -->",
    ].join("\n");
    const result = countRegions(text);
    expect("error" in result).toBe(true);
  });
});

describe("evaluate", () => {
  const budgetPlan = { policy: { agentsMdBudget: { managedMaxLines: 5, unmanagedMaxLines: 10 } } };

  it("returns exit 0 at the seeded baseline (ratchet ships green)", () => {
    const root = makeRepo({ plan: budgetPlan, agents: agentsWith(10, 5) });
    const result = evaluate(root);
    expect(result.code).toBe(0);
    expect(result.stream).toBe("stdout");
    expect(result.message).toContain("managed 5/5, unmanaged 10/10");
  });

  it("returns exit 1 when the managed region grows past its ratchet", () => {
    const root = makeRepo({ plan: budgetPlan, agents: agentsWith(10, 6) });
    const result = evaluate(root);
    expect(result.code).toBe(1);
    expect(result.stream).toBe("stderr");
    expect(result.message).toContain("managed region:   6/5");
    expect(result.message).toContain("map, not a manual");
  });

  it("returns exit 1 when the unmanaged region grows past its ratchet", () => {
    const root = makeRepo({ plan: budgetPlan, agents: agentsWith(11, 5) });
    const result = evaluate(root);
    expect(result.code).toBe(1);
    expect(result.message).toContain("unmanaged region: 11/10");
  });

  it("passes after a reduction re-seeds a tighter budget (ratchet lowers)", () => {
    // File reduced to managed 3 / unmanaged 6; budget lowered to match.
    const plan = { policy: { agentsMdBudget: { managedMaxLines: 3, unmanagedMaxLines: 6 } } };
    const root = makeRepo({ plan, agents: agentsWith(6, 3) });
    expect(evaluate(root).code).toBe(0);
  });

  it("warns (exit 0) when no budget is configured", () => {
    const root = makeRepo({ plan: { title: "T" }, agents: agentsWith(10, 5) });
    const result = evaluate(root);
    expect(result.code).toBe(0);
    expect(result.stream).toBe("stderr");
    expect(result.message).toContain("no plan.policy.agentsMdBudget configured");
  });

  it("suppresses the unset-budget warning when quiet", () => {
    const root = makeRepo({ plan: { title: "T" }, agents: agentsWith(10, 5) });
    expect(evaluate(root, { quiet: true })).toEqual({ code: 0, message: "", stream: "none" });
  });

  it("returns exit 2 when AGENTS.md exists but cannot be read (is a directory)", () => {
    const root = makeRepo({ plan: budgetPlan });
    mkdirSync(join(root, "AGENTS.md"), { recursive: true });
    const result = evaluate(root);
    expect(result.code).toBe(2);
    expect(result.message).toContain("cannot be read");
  });

  it("returns exit 2 for a malformed budget field", () => {
    const plan = { policy: { agentsMdBudget: { managedMaxLines: -1, unmanagedMaxLines: 10 } } };
    const root = makeRepo({ plan, agents: agentsWith(10, 5) });
    const result = evaluate(root);
    expect(result.code).toBe(2);
    expect(result.message).toContain("must be a non-negative integer");
  });

  it("returns exit 2 when AGENTS.md is missing", () => {
    const root = makeRepo({ plan: budgetPlan });
    const result = evaluate(root);
    expect(result.code).toBe(2);
    expect(result.message).toContain("AGENTS.md not found");
  });

  it("returns exit 2 when managed markers are malformed", () => {
    const root = makeRepo({
      plan: budgetPlan,
      agents: "x\n<!-- deft:managed-section v3 -->\nno close here",
    });
    const result = evaluate(root);
    expect(result.code).toBe(2);
    expect(result.message).toContain("malformed");
  });

  it("suppresses the success banner when quiet", () => {
    const root = makeRepo({ plan: budgetPlan, agents: agentsWith(10, 5) });
    expect(evaluate(root, { quiet: true })).toEqual({ code: 0, message: "", stream: "none" });
  });

  it("still emits the refusal when quiet and over budget", () => {
    const root = makeRepo({ plan: budgetPlan, agents: agentsWith(20, 5) });
    const result = evaluate(root, { quiet: true });
    expect(result.code).toBe(1);
  });
});

describe("agents-md-budget index re-exports", () => {
  it("exports evaluate from the barrel", async () => {
    const mod = await import("./index.js");
    expect(typeof mod.evaluate).toBe("function");
  });
});
