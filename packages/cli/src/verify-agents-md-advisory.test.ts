import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-agents-md-advisory.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function agentsWith(unmanaged: number, managed: number): string {
  const lines: string[] = [];
  for (let i = 0; i < unmanaged; i += 1) {
    lines.push(`unmanaged ${i}`);
  }
  if (managed > 0) {
    lines.push("<!-- deft:managed-section v3 sha=abc refreshed=x session=y -->");
    for (let i = 0; i < managed - 2; i += 1) {
      lines.push(`managed ${i}`);
    }
    lines.push("<!-- /deft:managed-section -->");
  }
  return lines.join("\n");
}

function buildRepo(options: { plan?: Record<string, unknown>; agents?: string }): string {
  const root = mkdtempSync(join(tmpdir(), "deft-cli-agents-advisory-"));
  temps.push(root);
  mkdirSync(join(root, "vbrief"), { recursive: true });
  if (options.plan !== undefined) {
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "T", status: "running", items: [], ...options.plan },
      }),
      "utf8",
    );
  }
  if (options.agents !== undefined) {
    writeFileSync(join(root, "AGENTS.md"), options.agents, "utf8");
  }
  return root;
}

function silentRun(argv: string[]): number {
  const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    return run(argv);
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

const softPlan = (n: number) => ({ policy: { agentsMdAdvisory: { unmanagedSoftMaxLines: n } } });

describe("parseArgs", () => {
  it("parses defaults", () => {
    expect(parseArgs([])).toMatchObject({ projectRoot: ".", quiet: false, enforce: false });
  });

  it("parses flags and = form", () => {
    expect(parseArgs(["--project-root", "/root", "--quiet", "--enforce"])).toMatchObject({
      projectRoot: "/root",
      quiet: true,
      enforce: true,
    });
    expect(parseArgs(["--project-root=/tmp/x"]).projectRoot).toBe("/tmp/x");
  });

  it("errors on unknown flags and missing values", () => {
    expect(parseArgs(["--bogus"]).error).toBeDefined();
    expect(parseArgs(["--project-root"]).error).toBeDefined();
  });
});

describe("run (advisory posture)", () => {
  it("returns 0 when within the soft budget", () => {
    const root = buildRepo({ plan: softPlan(10), agents: agentsWith(5, 5) });
    expect(silentRun(["--project-root", root])).toBe(0);
  });

  it("returns 0 EVEN WHEN over budget (never fail-closes)", () => {
    const root = buildRepo({ plan: softPlan(10), agents: agentsWith(50, 5) });
    expect(silentRun(["--project-root", root])).toBe(0);
  });

  it("returns 0 when AGENTS.md is missing (advisory skip)", () => {
    const root = buildRepo({ plan: softPlan(10) });
    expect(silentRun(["--project-root", root])).toBe(0);
  });

  it("returns 2 for bad args", () => {
    expect(silentRun(["--bogus"])).toBe(2);
  });

  it("suppresses output when --quiet at baseline", () => {
    const root = buildRepo({ plan: softPlan(10), agents: agentsWith(3, 5) });
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(run(["--project-root", root, "--quiet"])).toBe(0);
      expect(out.mock.calls.length).toBe(0);
      expect(err.mock.calls.length).toBe(0);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});

describe("run (--enforce opt-in)", () => {
  it("returns 1 when over budget under --enforce", () => {
    const root = buildRepo({ plan: softPlan(10), agents: agentsWith(50, 5) });
    expect(silentRun(["--project-root", root, "--enforce"])).toBe(1);
  });

  it("returns 0 when within budget under --enforce", () => {
    const root = buildRepo({ plan: softPlan(10), agents: agentsWith(5, 5) });
    expect(silentRun(["--project-root", root, "--enforce"])).toBe(0);
  });
});
