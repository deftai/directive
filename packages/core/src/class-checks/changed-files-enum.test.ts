import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultTestBoundaryPolicy } from "../test-boundary/policy.js";
import { defaultClassChecksPolicy } from "./policy.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

import { evaluateClassChecks } from "./evaluate.js";

function gitOk(stdout = ""): { status: number; stdout: string; error?: undefined } {
  return { status: 0, stdout, error: undefined };
}

function gitStatus(
  status: number,
  stdout = "",
): { status: number; stdout: string; error?: undefined } {
  return { status, stdout, error: undefined };
}

function baseOpts() {
  return {
    baseRef: "origin/master",
    baseTestBoundaryPolicy: {
      ...defaultTestBoundaryPolicy("warn"),
      allow: [],
      source: "defaults" as const,
    },
    classChecksPolicy: defaultClassChecksPolicy(),
    fileContents: new Map<string, string>(),
  };
}

describe("changedFilesVsBase enumeration failures (#4980)", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  function mockHealthyUntil(
    failAt: "diff-range" | "diff-head" | "ls-files" | "spawn-diff" | "signal-diff",
  ) {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      const a = args ?? [];
      if (a[0] === "rev-parse" && a.includes("--is-inside-work-tree")) {
        return gitOk("true\n");
      }
      if (a[0] === "rev-parse" && a.includes("--verify")) {
        return gitOk("");
      }
      if (a[0] === "diff" && a.includes("--name-only") && a.some((x) => x.includes("..."))) {
        if (failAt === "diff-range") return gitStatus(128);
        if (failAt === "spawn-diff") {
          return {
            status: null,
            stdout: "",
            error: Object.assign(new Error("spawn git EIO"), { code: "EIO" }),
          };
        }
        if (failAt === "signal-diff") {
          return {
            status: null,
            signal: "SIGTERM",
            stdout: "",
            error: undefined,
          };
        }
        return gitOk("src/ok.ts\n");
      }
      if (a[0] === "diff" && a.includes("--name-only") && a.includes("HEAD")) {
        if (failAt === "diff-head") return gitStatus(1);
        return gitOk("");
      }
      if (a[0] === "ls-files") {
        if (failAt === "ls-files") return gitStatus(2);
        return gitOk("");
      }
      return gitOk("");
    });
  }

  it("returns exit 2 when git diff range enumeration fails", () => {
    mockHealthyUntil("diff-range");
    const result = evaluateClassChecks("/tmp/proj", baseOpts());
    expect(result.exitCode).toBe(2);
    expect(result.findings).toHaveLength(0);
    expect(result.message).toMatch(/git failed/i);
    expect(result.message).toMatch(/diff --name-only/);
  });

  it("returns exit 2 when git diff HEAD enumeration fails", () => {
    mockHealthyUntil("diff-head");
    const result = evaluateClassChecks("/tmp/proj", baseOpts());
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/git failed/i);
    expect(result.message).toMatch(/diff --name-only HEAD/);
  });

  it("returns exit 2 when git ls-files enumeration fails", () => {
    mockHealthyUntil("ls-files");
    const result = evaluateClassChecks("/tmp/proj", baseOpts());
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/git failed/i);
    expect(result.message).toMatch(/ls-files/);
  });

  it("returns exit 2 when git spawn errors during enumeration", () => {
    mockHealthyUntil("spawn-diff");
    const result = evaluateClassChecks("/tmp/proj", baseOpts());
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/git failed/i);
  });

  it("returns exit 2 when git is signal-killed during enumeration", () => {
    mockHealthyUntil("signal-diff");
    const result = evaluateClassChecks("/tmp/proj", baseOpts());
    expect(result.exitCode).toBe(2);
    expect(result.findings).toHaveLength(0);
    expect(result.message).toMatch(/git failed/i);
    expect(result.message).toMatch(/killed by signal SIGTERM/i);
    expect(result.message).not.toMatch(/clean \(0 changed/);
  });

  it("does not treat a failed enumeration as a clean empty change set", () => {
    mockHealthyUntil("diff-range");
    const result = evaluateClassChecks("/tmp/proj", baseOpts());
    expect(result.exitCode).not.toBe(0);
    expect(result.message).not.toMatch(/clean \(0 changed/);
  });
});
