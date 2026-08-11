import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchCachedTaskCheck } from "./cached-orchestrator.js";

describe("degraded skip report in check (#3282)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits 0 with skip report when task is missing (all gates skipped)", () => {
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const started: string[] = [];
    const code = dispatchCachedTaskCheck("/fw", "/fw", {
      noCache: true,
      emitRunSummary: false,
      preflight: {
        status: "degraded",
        ok: false,
        degraded: true,
        findings: [
          {
            tool: "task",
            present: false,
            cause: "go-task binary not found on PATH",
            remedy: "Install go-task",
          },
        ],
        lines: ["[deft preflight] toolchain status: degraded"],
        skipGateIds: [
          "verify:branch",
          "verify:encoding",
          "verify:cache-fresh",
          "verify:orphan-active",
          "verify:license-sync",
          "verify:contract-drift",
          "toolchain:check",
          "verify:stubs",
          "verify:links",
          "verify:rule-ownership",
          "verify:biome-config",
          "verify:content-manifest",
          "verify:skill-external-fetch-gate",
          "verify:cursor-tier1",
          "verify:openclaw-tier1",
          "verify:go-freeze",
          "verify:bridge-drift",
          "verify:forward-coverage",
          "verify:test-boundary",
          "verify:scope-provenance",
          "verify:consumer-check-contract",
          "verify:vbrief-conformance",
          "verify:destructive-gh-verbs",
          "verify:scm-boundary",
          "verify:xbrief-drift",
          "verify:no-task-runtime",
          "verify:pack-drift",
          "verify:wip-cap",
          "verify:agents-md-budget",
          "verify:eval-health-relocation",
          "verify:eval-triggers-relocation",
          "vbrief:validate",
          "codebase:validate-structure",
          "verify:codebase-map-fresh",
          "verify-strategy-output",
          "ts:check-lane",
          "doctor",
          "toolchain:check-consumer",
        ],
      },
      onGateStart: (id) => started.push(id),
      gateSpawnFn: () => {
        throw new Error("gates must not run when fully degraded");
      },
    });
    expect(code).toBe(0);
    expect(started).toEqual([]);
    const msg = errWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(msg).toMatch(/degraded mode/);
    expect(msg).toMatch(/skipped \d+ gate/);
    expect(msg).toMatch(/go-task binary not found/);
  });

  it("prints named cause when a gate fails", () => {
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = dispatchCachedTaskCheck("/fw-named", "/fw-named", {
      noCache: true,
      emitRunSummary: false,
      preflight: null,
      gateSpawnFn: (gateId) => {
        if (gateId === "verify:branch") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "branch protection refused default branch\n",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(code).toBe(1);
    const msg = errWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(msg).toMatch(/gate verify:branch failed/);
    expect(msg).toMatch(/cause:/);
    expect(msg).toMatch(/remedy:/);
  });
});
