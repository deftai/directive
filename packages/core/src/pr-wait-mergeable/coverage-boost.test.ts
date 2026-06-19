import { describe, expect, it, vi } from "vitest";
import { waitMergeableAndMerge } from "./cascade.js";
import { classifyMonitorOutcome } from "./classify.js";
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
    });
    expect(result.error).toBe("monitor exited 1 (outcome=cap-reached)");
  });

  it("merge failure without stderr uses short message", () => {
    const result = waitMergeableAndMerge(1, "o/r", {
      capMinutes: 1,
      protected: [],
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
});
