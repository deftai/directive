import { describe, expect, it } from "vitest";
import {
  PNPM_DEPENDENT_GATE_IDS,
  runToolchainPreflight,
  TASK_DEPENDENT_GATE_IDS,
  toolchainPreflightToDict,
} from "./toolchain-preflight.js";

describe("runToolchainPreflight (#3282)", () => {
  it("reports ok when task, pnpm, node, and git are present", () => {
    const result = runToolchainPreflight({
      which: (name) => `/bin/${name}`,
      exists: () => true,
      probeCliDist: false,
    });
    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.status).toBe("ok");
    expect(result.skipGateIds).toEqual([]);
    expect(result.lines.some((l) => l.includes("done-gate toolchain ready"))).toBe(true);
  });

  it("surfaces missing go-task with cause and remedy in one turn", () => {
    const result = runToolchainPreflight({
      which: (name) => (name === "task" ? null : `/bin/${name}`),
      exists: () => false,
      probeCliDist: false,
    });
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.status).toBe("degraded");
    const task = result.findings.find((f) => f.tool === "task");
    expect(task?.present).toBe(false);
    expect(task?.cause).toMatch(/go-task|PATH/i);
    expect(task?.remedy).toMatch(/taskfile\.dev|go-task/i);
    expect(result.lines.some((l) => l.includes("task: MISSING"))).toBe(true);
    expect(result.lines.some((l) => l.includes("cause:"))).toBe(true);
    expect(result.lines.some((l) => l.includes("remedy:"))).toBe(true);
    // Does not embed env values
    expect(result.lines.join("\n")).not.toMatch(/DEFT_[A-Z]+=/);
    for (const id of ["toolchain:check-consumer", "verify:branch", "doctor"]) {
      expect(result.skipGateIds).toContain(id);
    }
  });

  it("marks only pnpm-dependent gates when only pnpm is missing", () => {
    const result = runToolchainPreflight({
      which: (name) => (name === "pnpm" ? null : `/bin/${name}`),
      probeCliDist: false,
    });
    expect(result.degraded).toBe(true);
    for (const id of PNPM_DEPENDENT_GATE_IDS) {
      expect(result.skipGateIds).toContain(id);
    }
    expect(result.skipGateIds).not.toContain("verify:branch");
  });

  it("serializes without env values", () => {
    const result = runToolchainPreflight({
      which: () => null,
      probeCliDist: false,
    });
    const dict = toolchainPreflightToDict(result);
    expect(dict.status).toBe("degraded");
    expect(JSON.stringify(dict)).not.toMatch(/DEFT_[A-Z]+=/);
    expect(TASK_DEPENDENT_GATE_IDS.length).toBeGreaterThan(5);
  });

  it("probes CLI dist when no global deft and dist missing", () => {
    const result = runToolchainPreflight({
      frameworkRoot: "/tmp/fw-no-dist",
      which: (name) => (name === "deft" || name === "directive" ? null : `/bin/${name}`),
      exists: () => false,
      probeCliDist: true,
    });
    const cli = result.findings.find((f) => f.tool === "cli_dist");
    expect(cli?.present).toBe(false);
    expect(cli?.remedy).toMatch(/task build|@deftai\/directive/);
  });
});
