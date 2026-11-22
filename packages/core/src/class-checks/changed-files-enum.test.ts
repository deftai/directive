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
    failAt:
      | "diff-range"
      | "no-merge-base"
      | "merge-base-spawn"
      | "ls-files"
      | "spawn-diff"
      | "signal-diff",
  ) {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      const a = args ?? [];
      if (a[0] === "rev-parse" && a.includes("--is-inside-work-tree")) {
        return gitOk("true\n");
      }
      if (a[0] === "rev-parse" && a.includes("--verify")) {
        return gitOk("");
      }
      if (a[0] === "merge-base") {
        if (failAt === "no-merge-base") return gitStatus(1);
        if (failAt === "merge-base-spawn") {
          return {
            status: null,
            stdout: "",
            error: Object.assign(new Error("spawn git EIO"), { code: "EIO" }),
          };
        }
        return gitOk("mbsha\n");
      }
      if (a[0] === "diff" && a.includes("--name-only")) {
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

  it("diffs the working tree against the merge base, not a range (#6336)", () => {
    mockHealthyUntil("ls-files");
    evaluateClassChecks("/tmp/proj", baseOpts());
    const diffCalls = spawnSyncMock.mock.calls
      .map((call) => (call[1] as string[]) ?? [])
      .filter((a) => a[0] === "diff");
    expect(diffCalls).toEqual([["diff", "--name-only", "mbsha"]]);
  });

  it("falls back to the base ref when there is no merge base (#6336)", () => {
    mockHealthyUntil("no-merge-base");
    const result = evaluateClassChecks("/tmp/proj", baseOpts());
    const diffCalls = spawnSyncMock.mock.calls
      .map((call) => (call[1] as string[]) ?? [])
      .filter((a) => a[0] === "diff");
    expect(diffCalls.filter((a) => a[1] === "--name-only")).toEqual([
      ["diff", "--name-only", "origin/master"],
    ]);
    // #7077: class 2 added lines come from one -U0 diff against the same base.
    expect(diffCalls.filter((a) => a[1] === "-U0")).toEqual([
      [
        "diff",
        "-U0",
        "--no-renames",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "origin/master",
        "--",
        "src/ok.ts",
      ],
    ]);
    expect(result.exitCode).not.toBe(2);
  });

  it("returns exit 2 when the merge-base spawn fails (#6336)", () => {
    mockHealthyUntil("merge-base-spawn");
    const result = evaluateClassChecks("/tmp/proj", baseOpts());
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/git failed/i);
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
