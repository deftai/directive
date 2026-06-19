import { describe, expect, it } from "vitest";
import { waitMergeableAndMerge } from "./cascade.js";
import { EXIT_CONFIG_ERROR, EXIT_MERGED, EXIT_TIMEOUT_OR_ESCALATION } from "./constants.js";
import { toResultDict } from "./result.js";
import type { MergeFn, MonitorFn, ProtectedCheckFn } from "./types.js";

function makeProtectedFn(returncode: number, stdout = "", stderr = ""): ProtectedCheckFn {
  const calls: Array<readonly [number, string | null, readonly number[]]> = [];
  const fn: ProtectedCheckFn = (prNumber, repo, protectedIssues) => {
    calls.push([prNumber, repo, protectedIssues]);
    return [returncode, stdout, stderr];
  };
  (fn as { calls: typeof calls }).calls = calls;
  return fn;
}

function makeMonitorFn(
  returncode: number,
  payload: Record<string, unknown> | null,
  stderr = "",
): MonitorFn {
  const calls: Array<readonly [number, string, number]> = [];
  const stdout = payload !== null ? JSON.stringify(payload, null, 2) : "";
  const fn: MonitorFn = (prNumber, repo, capMinutes) => {
    calls.push([prNumber, repo, capMinutes]);
    return [returncode, stdout, stderr];
  };
  (fn as { calls: typeof calls }).calls = calls;
  return fn;
}

function makeMergeFn(returncode: number, stdout = "", stderr = ""): MergeFn {
  const calls: Array<readonly [number, string | null]> = [];
  const fn: MergeFn = (prNumber, repo) => {
    calls.push([prNumber, repo]);
    return [returncode, stdout, stderr];
  };
  (fn as { calls: typeof calls }).calls = calls;
  return fn;
}

function cleanMonitorPayload(prNumber = 1370): Record<string, unknown> {
  return {
    monitor_result: "CLEAN",
    polls: 1,
    readiness: {
      pr_number: prNumber,
      repo: "deftai/directive",
      head_sha: "a".repeat(40),
      verdict: {
        found: true,
        errored: false,
        last_reviewed_sha: "a".repeat(40),
        confidence: 5,
        p0_count: 0,
        p1_count: 0,
        p2_count: 0,
        raw_body_excerpt: "",
      },
      failures: [],
      merge_ready: true,
      via: "primary",
    },
  };
}

function capReachedPayload(): Record<string, unknown> {
  return {
    monitor_result: "CAP-REACHED",
    polls: 12,
    readiness: {
      merge_ready: false,
      via: "fallback2",
      failures: ["fallback2 is a coarse signal, not a CLEAN verdict ..."],
      partial_data: { pr_state: "open", merged: false },
    },
  };
}

function prMergedBySiblingPayload(): Record<string, unknown> {
  return {
    monitor_result: "PR-TERMINAL",
    polls: 3,
    readiness: {
      merge_ready: false,
      via: "fallback2",
      partial_data: { pr_state: "closed", merged: true },
    },
  };
}

function prClosedPayload(): Record<string, unknown> {
  return {
    monitor_result: "PR-TERMINAL",
    polls: 5,
    readiness: {
      merge_ready: false,
      via: "fallback2",
      partial_data: { pr_state: "closed", merged: false },
    },
  };
}

describe("waitMergeableAndMerge", () => {
  it("clean monitor triggers merge and exits zero", () => {
    const protectedFn = makeProtectedFn(0);
    const monitorFn = makeMonitorFn(0, cleanMonitorPayload(1370));
    const mergeFn = makeMergeFn(0, "merged via squash");

    const result = waitMergeableAndMerge(1370, "deftai/directive", {
      capMinutes: 30,
      protected: [],
      protectedFn,
      monitorFn,
      mergeFn,
    });

    expect(result.exitCode).toBe(EXIT_MERGED);
    expect(result.outcome).toBe("merged");
    expect((protectedFn as { calls: unknown[] }).calls).toEqual([]);
    expect((monitorFn as { calls: unknown[] }).calls).toEqual([[1370, "deftai/directive", 30]]);
    expect((mergeFn as { calls: unknown[] }).calls).toEqual([[1370, "deftai/directive"]]);
    expect(result.mergeStdout).toBe("merged via squash");
  });

  it("protected clean then clean monitor then merge", () => {
    const protectedFn = makeProtectedFn(0);
    const monitorFn = makeMonitorFn(0, cleanMonitorPayload(1371));
    const mergeFn = makeMergeFn(0);

    const result = waitMergeableAndMerge(1371, "deftai/directive", {
      capMinutes: 15,
      protected: [1119, 1140],
      protectedFn,
      monitorFn,
      mergeFn,
    });

    expect(result.exitCode).toBe(EXIT_MERGED);
    expect((protectedFn as { calls: unknown[] }).calls).toEqual([
      [1371, "deftai/directive", [1119, 1140]],
    ]);
    expect((monitorFn as { calls: unknown[] }).calls).toHaveLength(1);
    expect((mergeFn as { calls: unknown[] }).calls).toHaveLength(1);
  });

  it("monitor cap reached exits one without merging", () => {
    const mergeFn = makeMergeFn(0);
    const result = waitMergeableAndMerge(1370, "deftai/directive", {
      capMinutes: 30,
      protected: [],
      protectedFn: makeProtectedFn(0),
      monitorFn: makeMonitorFn(1, capReachedPayload()),
      mergeFn,
    });

    expect(result.exitCode).toBe(EXIT_TIMEOUT_OR_ESCALATION);
    expect(result.outcome).toBe("cap-reached");
    expect((mergeFn as { calls: unknown[] }).calls).toEqual([]);
    expect(result.monitorResult.monitor_result).toBe("CAP-REACHED");
  });

  it("pr closed without merge exits one", () => {
    const mergeFn = makeMergeFn(0);
    const result = waitMergeableAndMerge(1370, "deftai/directive", {
      capMinutes: 30,
      protected: [],
      protectedFn: makeProtectedFn(0),
      monitorFn: makeMonitorFn(3, prClosedPayload()),
      mergeFn,
    });

    expect(result.exitCode).toBe(EXIT_TIMEOUT_OR_ESCALATION);
    expect(result.outcome).toBe("pr-closed");
    expect((mergeFn as { calls: unknown[] }).calls).toEqual([]);
  });

  it("protected link exits one before monitor or merge", () => {
    const monitorFn = makeMonitorFn(0, cleanMonitorPayload());
    const mergeFn = makeMergeFn(0);
    const protectedFn = makeProtectedFn(
      1,
      "",
      "FAIL: PR has persistent links to protected issue(s): #1119",
    );

    const result = waitMergeableAndMerge(1370, "deftai/directive", {
      capMinutes: 30,
      protected: [1119],
      protectedFn,
      monitorFn,
      mergeFn,
    });

    expect(result.exitCode).toBe(EXIT_TIMEOUT_OR_ESCALATION);
    expect(result.outcome).toBe("protected-linked");
    expect((protectedFn as { calls: unknown[] }).calls).toEqual([
      [1370, "deftai/directive", [1119]],
    ]);
    expect((monitorFn as { calls: unknown[] }).calls).toEqual([]);
    expect((mergeFn as { calls: unknown[] }).calls).toEqual([]);
    expect(result.error).toContain("closingIssuesReferences");
    expect(result.protectedCheck.returncode).toBe(1);
  });

  it("monitor config error propagates to exit two", () => {
    const mergeFn = makeMergeFn(0);
    const result = waitMergeableAndMerge(1370, "deftai/directive", {
      capMinutes: 30,
      protected: [],
      protectedFn: makeProtectedFn(0),
      monitorFn: makeMonitorFn(2, { monitor_result: "CONFIG-ERROR" }),
      mergeFn,
    });

    expect(result.exitCode).toBe(EXIT_CONFIG_ERROR);
    expect(result.outcome).toBe("config-error");
    expect((mergeFn as { calls: unknown[] }).calls).toEqual([]);
  });

  it("protected check external error collapses to config error", () => {
    const monitorFn = makeMonitorFn(0, cleanMonitorPayload());
    const mergeFn = makeMergeFn(0);
    const result = waitMergeableAndMerge(1370, "deftai/directive", {
      capMinutes: 30,
      protected: [1119],
      protectedFn: makeProtectedFn(2, "", "Error: gh CLI not found."),
      monitorFn,
      mergeFn,
    });

    expect(result.exitCode).toBe(EXIT_CONFIG_ERROR);
    expect(result.outcome).toBe("config-error");
    expect((monitorFn as { calls: unknown[] }).calls).toEqual([]);
    expect((mergeFn as { calls: unknown[] }).calls).toEqual([]);
  });

  it("gh pr merge failure surfaces as exit one", () => {
    const result = waitMergeableAndMerge(1370, "deftai/directive", {
      capMinutes: 30,
      protected: [],
      protectedFn: makeProtectedFn(0),
      monitorFn: makeMonitorFn(0, cleanMonitorPayload()),
      mergeFn: makeMergeFn(1, "", "branch protection refused"),
    });

    expect(result.exitCode).toBe(EXIT_TIMEOUT_OR_ESCALATION);
    expect(result.outcome).toBe("merge-failed");
    expect(result.error).toContain("branch protection");
  });

  it("pr merged by sibling returns exit zero without error field", () => {
    const mergeFn = makeMergeFn(0);
    const result = waitMergeableAndMerge(1370, "deftai/directive", {
      capMinutes: 30,
      protected: [],
      protectedFn: makeProtectedFn(0),
      monitorFn: makeMonitorFn(3, prMergedBySiblingPayload()),
      mergeFn,
    });

    expect(result.exitCode).toBe(EXIT_MERGED);
    expect(result.outcome).toBe("merged-by-sibling");
    expect((mergeFn as { calls: unknown[] }).calls).toEqual([]);
    expect(result.error).toBeNull();
    expect(toResultDict(result).error).toBeUndefined();
  });

  it("gh missing at merge stage exits two", () => {
    const mergeFn = makeMergeFn(-1, "", "gh CLI not found. Install GitHub CLI.");
    const result = waitMergeableAndMerge(1370, "deftai/directive", {
      capMinutes: 30,
      protected: [],
      protectedFn: makeProtectedFn(0),
      monitorFn: makeMonitorFn(0, cleanMonitorPayload()),
      mergeFn,
    });

    expect(result.exitCode).toBe(EXIT_CONFIG_ERROR);
    expect(result.outcome).toBe("config-error");
    expect(result.error).toContain("gh pr merge wrapper failed at OS layer");
    expect(result.error).toContain("gh CLI not found");
  });

  it("includes monitor stderr tail in cap-reached error", () => {
    const result = waitMergeableAndMerge(1370, "deftai/directive", {
      capMinutes: 30,
      protected: [],
      protectedFn: makeProtectedFn(0),
      monitorFn: makeMonitorFn(1, capReachedPayload(), "poll stderr tail marker"),
      mergeFn: makeMergeFn(0),
    });

    expect(result.error).toContain("stderr tail:");
    expect(result.error).toContain("poll stderr tail marker");
  });
});

describe("toResultDict", () => {
  it("omits empty optional fields", () => {
    const dict = toResultDict({
      prNumber: 1,
      repo: "o/r",
      outcome: "merged-by-sibling",
      exitCode: 0,
      monitorResult: { monitor_result: "PR-TERMINAL" },
      protectedCheck: {},
      mergeStdout: "",
      mergeStderr: "",
      error: null,
    });
    expect(dict.error).toBeUndefined();
    expect(dict.merge_stdout).toBeUndefined();
  });
});
