import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ABSOLUTE_MANAGED_MAX_BYTES,
  ABSOLUTE_MANAGED_MAX_TOKENS,
  countRegions,
  evaluate,
  extractManagedSection,
  measureManagedSection,
} from "./evaluate.js";

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
  const root = mkdtempSync(join(tmpdir(), "deft-agents-budget-"));
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

describe("extractManagedSection", () => {
  it("returns the managed span including markers", () => {
    const text = agentsWith(2, 4);
    const result = extractManagedSection(text);
    expect("section" in result).toBe(true);
    if ("section" in result) {
      expect(result.section).toContain("<!-- deft:managed-section");
      expect(result.section).toContain("<!-- /deft:managed-section -->");
    }
  });

  it("returns an empty section when no markers exist", () => {
    expect(extractManagedSection("a\nb\nc")).toEqual({ section: "" });
  });
});

describe("measureManagedSection", () => {
  it("reports bytes and estimated tokens for the managed span", () => {
    const text = agentsWith(0, 5);
    const result = measureManagedSection(text);
    expect("bytes" in result).toBe(true);
    if ("bytes" in result) {
      expect(result.bytes).toBeGreaterThan(0);
      expect(result.estimatedTokens).toBe(Math.ceil(result.bytes / 4));
    }
  });
});

describe("absolute managed-section budget", () => {
  const budgetPlan = {
    policy: { agentsMdBudget: { managedMaxLines: 500, unmanagedMaxLines: 500 } },
  };

  const budgetWithAbsolute = {
    policy: {
      agentsMdBudget: {
        managedMaxLines: 500,
        unmanagedMaxLines: 500,
        absoluteMaxBytes: 10_000,
      },
    },
  };

  /** Build a managed block whose UTF-8 body exceeds the 8192-byte north-star. */
  function agentsOverAbsolute(unmanaged: number, payloadBytes: number): string {
    const markerOpen = "<!-- deft:managed-section v3 sha=abc refreshed=x session=y -->";
    const markerClose = "<!-- /deft:managed-section -->";
    const overhead = Buffer.byteLength(`${markerOpen}\n${markerClose}`, "utf8");
    const fillLen = Math.max(0, payloadBytes - overhead);
    const fill = "x".repeat(fillLen);
    const lines: string[] = [];
    for (let i = 0; i < unmanaged; i += 1) {
      lines.push(`unmanaged ${i}`);
    }
    lines.push(markerOpen, fill, markerClose);
    return lines.join("\n");
  }

  it("emits advisory (exit 0) when absoluteMaxBytes is unset and section exceeds north-star", () => {
    const root = makeRepo({ plan: budgetPlan, agents: agentsOverAbsolute(5, 9000) });
    const result = evaluate(root);
    expect(result.code).toBe(0);
    expect(result.northStarMessage).toContain("absolute budget advisory");
    expect(result.northStarMessage).toContain("Advisory only");
    expect(result.northStarStream).toBe("stderr");
  });

  it("fail-closes when absoluteMaxBytes is set and the managed section grows past it", () => {
    const root = makeRepo({
      plan: {
        policy: {
          agentsMdBudget: { managedMaxLines: 500, unmanagedMaxLines: 500, absoluteMaxBytes: 8000 },
        },
      },
      agents: agentsOverAbsolute(5, 9000),
    });
    const result = evaluate(root);
    expect(result.code).toBe(1);
    expect(result.message).toContain("absolute byte ratchet");
    expect(result.northStarMessage).toContain("north-star");
  });

  it("passes at the seeded absolute ratchet and reports north-star distance", () => {
    const agents = agentsOverAbsolute(5, 9000);
    const measure = measureManagedSection(agents);
    expect("bytes" in measure).toBe(true);
    if (!("bytes" in measure)) return;
    const root = makeRepo({
      plan: {
        policy: {
          agentsMdBudget: {
            managedMaxLines: 500,
            unmanagedMaxLines: 500,
            absoluteMaxBytes: measure.bytes,
          },
        },
      },
      agents,
    });
    const result = evaluate(root);
    expect(result.code).toBe(0);
    expect(result.message).toContain(`absolute ${measure.bytes}/${measure.bytes} bytes`);
    expect(result.northStarMessage).toContain("north-star");
    expect(result.northStarMessage).toContain("tok over");
  });

  it("stays quiet on north-star note when the managed section is under budget", () => {
    const root = makeRepo({ plan: budgetPlan, agents: agentsWith(5, 5) });
    const result = evaluate(root);
    expect(result.code).toBe(0);
    expect(result.northStarMessage).toBeUndefined();
  });

  it("still fail-closes the relative ratchet when a region grows", () => {
    const tightPlan = { policy: { agentsMdBudget: { managedMaxLines: 5, unmanagedMaxLines: 10 } } };
    const root = makeRepo({ plan: tightPlan, agents: agentsWith(20, 5) });
    const result = evaluate(root);
    expect(result.code).toBe(1);
    expect(result.message).toContain("grew past its ratchet");
  });

  it("fail-closes in release-gate north-star mode without a waiver", () => {
    const agents = agentsOverAbsolute(5, 9000);
    const measure = measureManagedSection(agents);
    expect("bytes" in measure).toBe(true);
    if (!("bytes" in measure)) return;
    const root = makeRepo({
      plan: {
        policy: {
          agentsMdBudget: {
            managedMaxLines: 500,
            unmanagedMaxLines: 500,
            absoluteMaxBytes: measure.bytes,
          },
        },
      },
      agents,
    });
    const prev = process.env.DEFT_AGENTS_MD_BUDGET_ENFORCE_NORTH_STAR;
    const prevWaiver = process.env.DEFT_ALLOW_ABSOLUTE_BUDGET_WAIVER;
    process.env.DEFT_AGENTS_MD_BUDGET_ENFORCE_NORTH_STAR = "1";
    delete process.env.DEFT_ALLOW_ABSOLUTE_BUDGET_WAIVER;
    try {
      const result = evaluate(root);
      expect(result.code).toBe(1);
      expect(result.message).toContain("north-star ceiling");
    } finally {
      if (prev === undefined) delete process.env.DEFT_AGENTS_MD_BUDGET_ENFORCE_NORTH_STAR;
      else process.env.DEFT_AGENTS_MD_BUDGET_ENFORCE_NORTH_STAR = prev;
      if (prevWaiver === undefined) delete process.env.DEFT_ALLOW_ABSOLUTE_BUDGET_WAIVER;
      else process.env.DEFT_ALLOW_ABSOLUTE_BUDGET_WAIVER = prevWaiver;
    }
  });

  it("reports token-only north-star overage without negative byte deltas", () => {
    const markerOpen = "<!-- deft:managed-section v3 sha=abc refreshed=x session=y -->";
    const markerClose = "<!-- /deft:managed-section -->";
    const overhead = Buffer.byteLength(`${markerOpen}\n${markerClose}`, "utf8");
    const targetBytes = 8001;
    const fillLen = targetBytes - overhead;
    const agents = ["", markerOpen, "x".repeat(fillLen), markerClose].join("\n");
    const measure = measureManagedSection(agents);
    expect("bytes" in measure).toBe(true);
    if (!("bytes" in measure)) return;
    expect(measure.bytes).toBeLessThanOrEqual(ABSOLUTE_MANAGED_MAX_BYTES);
    expect(measure.estimatedTokens).toBeGreaterThan(ABSOLUTE_MANAGED_MAX_TOKENS);

    const root = makeRepo({
      plan: {
        policy: {
          agentsMdBudget: {
            managedMaxLines: 500,
            unmanagedMaxLines: 500,
            absoluteMaxBytes: measure.bytes,
          },
        },
      },
      agents,
    });
    const result = evaluate(root);
    expect(result.code).toBe(0);
    expect(result.northStarMessage).toMatch(/~\d+ tok over/);
    expect(result.northStarMessage).not.toContain("bytes over");
  });

  it("emits north-star note even when --quiet suppresses the success banner", () => {
    const root = makeRepo({ plan: budgetWithAbsolute, agents: agentsOverAbsolute(5, 9000) });
    const result = evaluate(root, { quiet: true });
    expect(result.code).toBe(0);
    expect(result.message).toBe("");
    expect(result.northStarMessage).toContain("north-star");
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
