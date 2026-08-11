import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchCachedTaskCheck } from "./cached-orchestrator.js";

describe("degraded skip report in check (#3282)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits 2 (config) with skip report when task is missing — never green", () => {
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
        // Sentinel expands to the live gate composition (#3282).
        skipGateIds: ["*"],
      },
      onGateStart: (id) => started.push(id),
      gateSpawnFn: () => {
        throw new Error("gates must not run when fully degraded");
      },
    });
    expect(code).toBe(2);
    expect(started).toEqual([]);
    const msg = errWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(msg).toMatch(/degraded mode/);
    expect(msg).toMatch(/skipped \d+ gate/);
    expect(msg).toMatch(/go-task binary not found/);
    expect(msg).toMatch(/exit 2/);
    expect(msg).not.toMatch(/exit 0 \(degraded\)/);
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
