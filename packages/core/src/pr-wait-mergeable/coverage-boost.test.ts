import { describe, expect, it, vi } from "vitest";
import { waitMergeableAndMerge } from "./cascade.js";
import { classifyMonitorOutcome, parseMonitorPayload } from "./classify.js";
import { EXIT_CONFIG_ERROR } from "./constants.js";
import { parseWaitMergeableArgs, runWaitMergeable } from "./main.js";
import { makeResult, toResultDict } from "./result.js";
import type { MonitorFn } from "./types.js";

describe("coverage boost", () => {
  it("parseWaitMergeableArgs handles flag errors", () => {
    expect(parseWaitMergeableArgs(["1370", "--repo"]).error).toContain("--repo");
    expect(parseWaitMergeableArgs(["1370", "--cap-minutes"]).error).toContain("--cap-minutes");
    expect(parseWaitMergeableArgs(["1370", "--protected"]).error).toContain("--protected");
    expect(parseWaitMergeableArgs(["1370", "--repo", "o/r", "--nope"]).error).toContain(
      "unrecognized",
    );
    expect(parseWaitMergeableArgs(["1370", "--repo", "o/r", "extra"]).error).toContain(
      "unrecognized",
    );
    expect(parseWaitMergeableArgs(["abc", "--repo", "o/r"]).error).toContain("invalid PR");
    expect(parseWaitMergeableArgs(["1370", "--cap-minutes=bad"]).error).toContain(
      "invalid --cap-minutes",
    );
    expect(parseWaitMergeableArgs(["1370", "--repo=o/r", "--protected=1"]).prNumber).toBe(1370);
    expect(parseWaitMergeableArgs(["1370", "--repo", "o/r", "--base-branch"]).error).toContain(
      "--base-branch",
    );
    expect(
      parseWaitMergeableArgs(["1370", "--repo", "o/r", "--cascade", "--require-master-ci-green"])
        .cascadeMode,
    ).toBe(true);
  });

  it("classifyMonitorOutcome handles malformed readiness", () => {
    expect(classifyMonitorOutcome(3, { readiness: "bad" })[0]).toBe("pr-closed");
    expect(classifyMonitorOutcome(3, { readiness: { partial_data: "bad" } })[0]).toBe("pr-closed");
  });

  it("monitor error without stderr uses short message", () => {
    const monitorFn: MonitorFn = () => [1, JSON.stringify({ monitor_result: "CAP-REACHED" }), ""];
    const result = waitMergeableAndMerge(1, "o/r", {
      capMinutes: 1,
      protected: [],
      monitorFn,

      skipHumanMergeGate: true,
    });
    expect(result.error).toBe("monitor exited 1 (outcome=cap-reached)");
  });

  it("merge failure without stderr uses short message", () => {
    const result = waitMergeableAndMerge(1, "o/r", {
      capMinutes: 1,
      protected: [],
      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      monitorFn: () => [
        0,
        JSON.stringify({
          monitor_result: "CLEAN",
          readiness: { merge_ready: true, via: "primary" },
        }),
        "",
      ],
      mergeFn: () => [2, "", ""],
    });
    expect(result.error).toBe("gh pr merge exited 2");
  });

  it("merge rc -1 without stderr uses default config error", () => {
    const result = waitMergeableAndMerge(1, "o/r", {
      capMinutes: 1,
      protected: [],
      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      monitorFn: () => [
        0,
        JSON.stringify({
          monitor_result: "CLEAN",
          readiness: { merge_ready: true, via: "primary" },
        }),
        "",
      ],
      mergeFn: () => [-1, "", ""],
    });
    expect(result.error).toBe("gh pr merge wrapper failed at OS layer (rc=-1).");
  });

  it("toResultDict includes semantic_green when set", () => {
    const dict = toResultDict(
      makeResult({
        prNumber: 1,
        repo: "o/r",
        outcome: "semantic-stale-base",
        exitCode: 1,
        semanticGreen: { pr_base_sha: "a", target_head_sha: "b" },
        error: "stale",
      }),
    );
    expect(dict.semantic_green).toEqual({ pr_base_sha: "a", target_head_sha: "b" });
  });

  it("toResultDict includes merge_stderr when set", () => {
    const dict = toResultDict(
      makeResult({
        prNumber: 1,
        repo: "o/r",
        outcome: "merged",
        exitCode: 0,
        mergeStderr: "warn",
        error: null,
      }),
    );
    expect(dict.merge_stderr).toBe("warn");
  });

  it("human output includes merge stdout lines", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    runWaitMergeable(["1", "--repo", "o/r"], {
      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      monitorFn: () => [
        0,
        JSON.stringify({
          monitor_result: "CLEAN",
          readiness: { merge_ready: true, via: "primary" },
        }),
        "",
      ],
      mergeFn: () => [0, "line1\nline2", ""],
    });
    const out = String(stdout.mock.calls.map((c) => c[0]).join(""));
    expect(out).toContain("merge stdout:");
    expect(out).toContain("line1");
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it("parse error from argv maps to config exit", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(runWaitMergeable(["1", "--repo", "o/r", "--cap-minutes", "nope"])).toBe(
      EXIT_CONFIG_ERROR,
    );
    stderr.mockRestore();
  });

  it("toResultDict includes protected_check and merge_stdout", () => {
    const dict = toResultDict(
      makeResult({
        prNumber: 1,
        repo: "o/r",
        outcome: "merged",
        exitCode: 0,
        protectedCheck: { returncode: 0 },
        mergeStdout: "done",
        error: null,
      }),
    );
    expect(dict.protected_check).toEqual({ returncode: 0 });
    expect(dict.merge_stdout).toBe("done");
  });

  it("parseWaitMergeableArgs accepts protected list and repo equals form", () => {
    const parsed = parseWaitMergeableArgs([
      "42",
      "--repo=o/r",
      "--protected=1,2,3",
      "--cap-minutes=5",
    ]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.prNumber).toBe(42);
    expect(parsed.protectedValues).toEqual(["1,2,3"]);
    expect(parsed.capMinutes).toBe(5);
  });

  it("classifyMonitorOutcome handles cap-reached and merged-by-sibling", () => {
    expect(classifyMonitorOutcome(1, { monitor_result: "CAP-REACHED" })[0]).toBe("cap-reached");
    expect(classifyMonitorOutcome(1, {})[0]).toBe("config-error");
    expect(classifyMonitorOutcome(2, {})[0]).toBe("config-error");
    expect(classifyMonitorOutcome(3, { readiness: { partial_data: { merged: true } } })[0]).toBe(
      "merged-by-sibling",
    );
    expect(classifyMonitorOutcome(99, {})[0]).toBe("config-error");
  });

  it("waitMergeableAndMerge surfaces protected check config errors", () => {
    const result = waitMergeableAndMerge(1, "o/r", {
      capMinutes: 1,
      protected: [1119],
      protectedFn: () => [2, "", "protected boom"],

      skipHumanMergeGate: true,
    });
    expect(result.outcome).toBe("config-error");
    expect(result.error).toContain("protected boom");
  });

  it("parseMonitorPayload tolerates empty and invalid stdout", () => {
    expect(parseMonitorPayload("")).toEqual({});
    expect(parseMonitorPayload("not-json")).toEqual({});
    expect(parseMonitorPayload("[1,2,3]")).toEqual({});
    expect(parseMonitorPayload('{"monitor_result":"CLEAN"}').monitor_result).toBe("CLEAN");
  });
});
