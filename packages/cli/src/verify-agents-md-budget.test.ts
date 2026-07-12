import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-agents-md-budget.js";

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
  lines.push("<!-- deft:managed-section v3 sha=abc refreshed=x session=y -->");
  for (let i = 0; i < managed - 2; i += 1) {
    lines.push(`managed ${i}`);
  }
  lines.push("<!-- /deft:managed-section -->");
  return lines.join("\n");
}

function buildRepo(options: { plan?: Record<string, unknown>; agents?: string }): string {
  const root = mkdtempSync(join(tmpdir(), "deft-cli-agents-budget-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  if (options.plan !== undefined) {
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
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

describe("parseArgs", () => {
  it("parses defaults", () => {
    expect(parseArgs([])).toMatchObject({ projectRoot: ".", quiet: false });
  });

  it("parses flags and = form", () => {
    expect(parseArgs(["--project-root", "/root", "--quiet"])).toMatchObject({
      projectRoot: "/root",
      quiet: true,
    });
    expect(parseArgs(["--project-root=/tmp/x"]).projectRoot).toBe("/tmp/x");
  });

  it("errors on unknown flags and missing values", () => {
    expect(parseArgs(["--bogus"]).error).toBeDefined();
    expect(parseArgs(["--project-root"]).error).toBeDefined();
  });
});

describe("run", () => {
  const plan = { policy: { agentsMdBudget: { managedMaxLines: 5, unmanagedMaxLines: 10 } } };

  it("returns 0 at the seeded baseline", () => {
    const root = buildRepo({ plan, agents: agentsWith(10, 5) });
    expect(silentRun(["--project-root", root])).toBe(0);
  });

  it("returns 1 when a region grows past its ratchet", () => {
    const root = buildRepo({ plan, agents: agentsWith(20, 5) });
    expect(silentRun(["--project-root", root])).toBe(1);
  });

  it("returns 2 for a malformed budget field", () => {
    const root = buildRepo({
      plan: { policy: { agentsMdBudget: { managedMaxLines: "bad", unmanagedMaxLines: 10 } } },
      agents: agentsWith(10, 5),
    });
    expect(silentRun(["--project-root", root])).toBe(2);
  });

  it("returns 2 for bad args", () => {
    expect(silentRun(["--bogus"])).toBe(2);
  });

  it("suppresses stdout when --quiet at baseline", () => {
    const root = buildRepo({ plan, agents: agentsWith(10, 5) });
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(run(["--project-root", root, "--quiet"])).toBe(0);
      expect(out.mock.calls.length).toBe(0);
      // Absolute advisory may still write to stderr on this repo's large managed section.
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  it("writes north-star note to stderr when absoluteMaxBytes is unset and over north-star", () => {
    const markerOpen = "<!-- deft:managed-section v3 sha=abc refreshed=x session=y -->";
    const markerClose = "<!-- /deft:managed-section -->";
    const fill = "x".repeat(9000);
    const agents = ["unmanaged", markerOpen, fill, markerClose].join("\n");
    const root = buildRepo({
      plan: { policy: { agentsMdBudget: { managedMaxLines: 500, unmanagedMaxLines: 500 } } },
      agents,
    });
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(run(["--project-root", root])).toBe(0);
      const stderrText = err.mock.calls.map((c) => String(c[0])).join("");
      expect(stderrText).toContain("absolute budget advisory");
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  it("returns 1 when absoluteMaxBytes is set and the managed section grows", () => {
    const markerOpen = "<!-- deft:managed-section v3 sha=abc refreshed=x session=y -->";
    const markerClose = "<!-- /deft:managed-section -->";
    const fill = "x".repeat(9000);
    const agents = ["unmanaged", markerOpen, fill, markerClose].join("\n");
    const root = buildRepo({
      plan: {
        policy: {
          agentsMdBudget: {
            managedMaxLines: 500,
            unmanagedMaxLines: 500,
            absoluteMaxBytes: 8000,
          },
        },
      },
      agents,
    });
    expect(silentRun(["--project-root", root])).toBe(1);
  });
});
