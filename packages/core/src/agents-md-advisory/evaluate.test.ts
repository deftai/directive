import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluate } from "./evaluate.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function writeProjectDefinition(root: string, plan: Record<string, unknown>): void {
  const dir = join(root, "xbrief");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
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
  const root = mkdtempSync(join(tmpdir(), "deft-agents-advisory-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(join(root, "xbrief", "seed.xbrief.json"), "{}", { encoding: "utf8" });
  if (options.plan !== undefined) {
    writeProjectDefinition(root, options.plan);
  }
  if (options.agents !== undefined) {
    writeFileSync(join(root, "AGENTS.md"), options.agents, "utf8");
  }
  return root;
}

const softPlan = (n: number) => ({ policy: { agentsMdAdvisory: { unmanagedSoftMaxLines: n } } });

describe("agents-md-advisory evaluate (advisory posture)", () => {
  it("is silent-friendly and exits 0 when the unmanaged region is within budget", () => {
    const root = makeRepo({ plan: softPlan(10), agents: agentsWith(8, 30) });
    const result = evaluate(root);
    expect(result.code).toBe(0);
    expect(result.over).toBe(false);
    expect(result.stream).toBe("stdout");
    expect(result.message).toContain("within soft budget");
    expect(result.source).toBe("typed");
  });

  it("EXCLUDES the managed section from the count (managed size never triggers)", () => {
    // 8 unmanaged, but a huge 100-line managed block. Budget is 10 unmanaged.
    const root = makeRepo({ plan: softPlan(10), agents: agentsWith(8, 100) });
    const result = evaluate(root);
    expect(result.over).toBe(false);
    expect(result.code).toBe(0);
    expect(result.counts?.unmanaged).toBe(8);
    expect(result.counts?.managed).toBe(100);
  });

  it("emits an advisory message but STILL EXITS 0 when over the soft budget", () => {
    const root = makeRepo({ plan: softPlan(10), agents: agentsWith(25, 5) });
    const result = evaluate(root);
    expect(result.code).toBe(0); // never fail-closes in advisory posture
    expect(result.over).toBe(true);
    expect(result.stream).toBe("stderr");
    expect(result.message).toContain("advisory only");
    expect(result.message).toContain("plan.policy.agentsMdAdvisory.unmanagedSoftMaxLines");
  });

  it("is silenced when the operator raises the soft budget (configurable-raise honored)", () => {
    const agents = agentsWith(25, 5);
    const strict = evaluate(makeRepo({ plan: softPlan(10), agents }));
    expect(strict.over).toBe(true);
    const raised = evaluate(makeRepo({ plan: softPlan(100), agents }));
    expect(raised.over).toBe(false);
    expect(raised.code).toBe(0);
  });

  it("uses the generous default (300) when no advisory field is configured", () => {
    const root = makeRepo({ plan: { title: "T" }, agents: agentsWith(50, 20) });
    const result = evaluate(root);
    expect(result.softMaxLines).toBe(300);
    expect(result.over).toBe(false);
    expect(result.source).toBe("default");
  });

  it("degrades to the generous default (never fails) on a malformed advisory field", () => {
    const plan = { policy: { agentsMdAdvisory: { unmanagedSoftMaxLines: -5 } } };
    const root = makeRepo({ plan, agents: agentsWith(50, 20) });
    const result = evaluate(root);
    expect(result.code).toBe(0);
    expect(result.softMaxLines).toBe(300);
    expect(result.source).toBe("default-on-error");
  });

  it("stays silent (exit 0, no message) when quiet and within budget", () => {
    const root = makeRepo({ plan: softPlan(10), agents: agentsWith(3, 5) });
    const result = evaluate(root, { quiet: true });
    expect(result.code).toBe(0);
    expect(result.message).toBe("");
    expect(result.stream).toBe("none");
  });

  it("exits 0 and skips gracefully when AGENTS.md is missing", () => {
    const root = makeRepo({ plan: softPlan(10) });
    const result = evaluate(root);
    expect(result.code).toBe(0);
    expect(result.counts).toBeNull();
    expect(result.message).toContain("no AGENTS.md found");
  });

  it("exits 0 when the managed markers are malformed (advisory never fails)", () => {
    const root = makeRepo({
      plan: softPlan(10),
      agents: "x\n<!-- deft:managed-section v3 -->\nno close here",
    });
    const result = evaluate(root);
    expect(result.code).toBe(0);
    expect(result.counts).toBeNull();
  });
});

describe("agents-md-advisory evaluate (--enforce opt-in)", () => {
  it("exits 1 when over budget under --enforce (hard cap)", () => {
    const root = makeRepo({ plan: softPlan(10), agents: agentsWith(25, 5) });
    const result = evaluate(root, { enforce: true });
    expect(result.code).toBe(1);
    expect(result.over).toBe(true);
    expect(result.message).toContain("over the enforced cap");
  });

  it("exits 0 when within budget under --enforce", () => {
    const root = makeRepo({ plan: softPlan(10), agents: agentsWith(5, 5) });
    expect(evaluate(root, { enforce: true }).code).toBe(0);
  });

  it("exits 2 on a config problem (missing AGENTS.md) under --enforce", () => {
    const root = makeRepo({ plan: softPlan(10) });
    const result = evaluate(root, { enforce: true });
    expect(result.code).toBe(2);
    expect(result.message).toContain("no AGENTS.md found");
  });

  it("exits 2 on malformed markers under --enforce", () => {
    const root = makeRepo({
      plan: softPlan(10),
      agents: "x\n<!-- deft:managed-section v3 -->\nno close",
    });
    expect(evaluate(root, { enforce: true }).code).toBe(2);
  });
});

describe("agents-md-advisory index re-exports", () => {
  it("exports evaluate from the barrel", async () => {
    const mod = await import("./index.js");
    expect(typeof mod.evaluate).toBe("function");
  });
});
