import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  reportMergeQueueState,
  resumeMergeQueueRead,
  sleepSecondsSync,
  waitMergeableAndMerge,
} from "./cascade.js";
import {
  EXIT_CONFIG_ERROR,
  EXIT_MERGED,
  EXIT_QUEUE_PENDING,
  EXIT_TIMEOUT_OR_ESCALATION,
  MERGE_QUEUE_WAIT_MAX_FAILED_READS,
  MERGE_QUEUE_WAIT_POLL_SECONDS,
} from "./constants.js";
import type { QueueRead, QueueReadFn, QueueReadResult } from "./merge-queue.js";
import { toResultDict } from "./result.js";
import type { SemanticGreenResult } from "./semantic-green.js";
import type { CloseoutAttestableFn, MergeFn, MonitorFn, ProtectedCheckFn } from "./types.js";

function makeCloseoutFn(returncode: number, stderr = ""): CloseoutAttestableFn {
  const calls: Array<readonly [number, string | null, string]> = [];
  const fn: CloseoutAttestableFn = (prNumber, repo, projectRoot) => {
    calls.push([prNumber, repo, projectRoot]);
    return [returncode, "", stderr];
  };
  (fn as { calls: typeof calls }).calls = calls;
  return fn;
}

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
  const calls: Array<
    readonly [number, string | null, { readonly matchHeadCommit?: string | null } | undefined]
  > = [];
  const fn: MergeFn = (prNumber, repo, mergeOpts) => {
    calls.push([prNumber, repo, mergeOpts]);
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
    const umbrellaCalls: Array<[string, string]> = [];

    const result = waitMergeableAndMerge(1370, "deftai/directive", {
      capMinutes: 30,
      protected: [],
      protectedFn,
      monitorFn,
      mergeFn,
      umbrellaReconcileFn: (root, repo) => {
        umbrellaCalls.push([root, repo]);
      },
      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      fetchPrHeadShaFn: () => "a".repeat(40),
    });

    expect(result.exitCode).toBe(EXIT_MERGED);
    expect(result.outcome).toBe("merged");
    expect((protectedFn as { calls: unknown[] }).calls).toEqual([]);
    expect((monitorFn as { calls: unknown[] }).calls).toEqual([[1370, "deftai/directive", 30]]);
    expect((mergeFn as { calls: unknown[] }).calls).toEqual([
      [1370, "deftai/directive", { matchHeadCommit: "a".repeat(40) }],
    ]);
    expect(result.mergeStdout).toBe("merged via squash");
    // Post-merge umbrella reconcile fires after successful merge (#1649).
    expect(umbrellaCalls).toHaveLength(1);
    expect(umbrellaCalls[0]?.[1]).toBe("deftai/directive");
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

      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      fetchPrHeadShaFn: () => "a".repeat(40),
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

      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      fetchPrHeadShaFn: () => "a".repeat(40),
    });

    expect(result.exitCode).toBe(EXIT_TIMEOUT_OR_ESCALATION);
    expect(result.outcome).toBe("cap-reached");
    expect((mergeFn as { calls: unknown[] }).calls).toEqual([]);
    expect(result.monitorResult.monitor_result).toBe("CAP-REACHED");
  });

  it("monitor MODULE_NOT_FOUND exit 1 is config-error not cap-reached (#2673)", () => {
    const mergeFn = makeMergeFn(0);
    const result = waitMergeableAndMerge(1370, "deftai/directive", {
      capMinutes: 30,
      protected: [],
      protectedFn: makeProtectedFn(0),
      monitorFn: makeMonitorFn(1, null, "Error: Cannot find module '/tmp/missing/pr-monitor.js'"),
      mergeFn,

      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      fetchPrHeadShaFn: () => "a".repeat(40),
    });

    expect(result.exitCode).toBe(EXIT_CONFIG_ERROR);
    expect(result.outcome).toBe("config-error");
    expect((mergeFn as { calls: unknown[] }).calls).toEqual([]);
    expect(result.error).toContain("Cannot find module");
  });

  it("missing monitor script rc 2 is config-error (#2673)", () => {
    const mergeFn = makeMergeFn(0);
    const result = waitMergeableAndMerge(1370, "deftai/directive", {
      capMinutes: 30,
      protected: [],
      protectedFn: makeProtectedFn(0),
      monitorFn: makeMonitorFn(2, null, "monitor script not found: /tmp/missing/pr-monitor.js"),
      mergeFn,

      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      fetchPrHeadShaFn: () => "a".repeat(40),
    });

    expect(result.exitCode).toBe(EXIT_CONFIG_ERROR);
    expect(result.outcome).toBe("config-error");
    expect((mergeFn as { calls: unknown[] }).calls).toEqual([]);
  });

  it("pr closed without merge exits one", () => {
    const mergeFn = makeMergeFn(0);
    const result = waitMergeableAndMerge(1370, "deftai/directive", {
      capMinutes: 30,
      protected: [],
      protectedFn: makeProtectedFn(0),
      monitorFn: makeMonitorFn(3, prClosedPayload()),
      mergeFn,

      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      fetchPrHeadShaFn: () => "a".repeat(40),
    });

    expect(result.exitCode).toBe(EXIT_TIMEOUT_OR_ESCALATION);
    expect(result.outcome).toBe("pr-closed");
    expect((mergeFn as { calls: unknown[] }).calls).toEqual([]);
  });

  it("module-not-found on protected check is config error not protected-linked (#2667)", () => {
    const monitorFn = makeMonitorFn(0, cleanMonitorPayload());
    const mergeFn = makeMergeFn(0);
    const protectedFn = makeProtectedFn(
      1,
      "",
      "Error: Cannot find module '/tmp/missing/pr-protected-issues.js'",
    );

    const result = waitMergeableAndMerge(1370, "deftai/directive", {
      capMinutes: 30,
      protected: [1119],
      protectedFn,
      monitorFn,
      mergeFn,

      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      fetchPrHeadShaFn: () => "a".repeat(40),
    });

    expect(result.exitCode).toBe(EXIT_CONFIG_ERROR);
    expect(result.outcome).toBe("config-error");
    expect((monitorFn as { calls: unknown[] }).calls).toEqual([]);
    expect((mergeFn as { calls: unknown[] }).calls).toEqual([]);
    expect(result.error).toContain("protected-issue check exited 1");
  });

  it("MODULE_NOT_FOUND stderr with exit 1 is config error (#2667)", () => {
    const monitorFn = makeMonitorFn(0, cleanMonitorPayload());
    const mergeFn = makeMergeFn(0);
    const protectedFn = makeProtectedFn(
      1,
      "",
      "node:internal/modules/cjs/loader:1143\n  throw err;\n  ^\n\nError: Cannot find module",
    );

    const result = waitMergeableAndMerge(1370, "deftai/directive", {
      capMinutes: 30,
      protected: [1119],
      protectedFn,
      monitorFn,
      mergeFn,

      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      fetchPrHeadShaFn: () => "a".repeat(40),
    });

    expect(result.exitCode).toBe(EXIT_CONFIG_ERROR);
    expect(result.outcome).toBe("config-error");
    expect((monitorFn as { calls: unknown[] }).calls).toEqual([]);
  });

  it("missing protected script rc 2 is config error (#2667)", () => {
    const monitorFn = makeMonitorFn(0, cleanMonitorPayload());
    const mergeFn = makeMergeFn(0);
    const protectedFn = makeProtectedFn(
      2,
      "",
      "protected-check script not found: /tmp/missing/pr-protected-issues.js",
    );

    const result = waitMergeableAndMerge(1370, "deftai/directive", {
      capMinutes: 30,
      protected: [1119],
      protectedFn,
      monitorFn,
      mergeFn,

      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      fetchPrHeadShaFn: () => "a".repeat(40),
    });

    expect(result.exitCode).toBe(EXIT_CONFIG_ERROR);
    expect(result.outcome).toBe("config-error");
    expect((monitorFn as { calls: unknown[] }).calls).toEqual([]);
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

      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      fetchPrHeadShaFn: () => "a".repeat(40),
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
    // #6069: skipHumanMergeGate belongs on waitMergeableAndMerge options — nesting it
    // inside the monitor payload left live approval/head gates on; under suite load
    // gh api could block past the 20s vitest timeout before the fake monitor ran.
    const mergeFn = makeMergeFn(0);
    const result = waitMergeableAndMerge(1370, "deftai/directive", {
      capMinutes: 30,
      protected: [],
      protectedFn: makeProtectedFn(0),
      monitorFn: makeMonitorFn(2, { monitor_result: "CONFIG-ERROR" }),
      mergeFn,
      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      fetchPrHeadShaFn: () => "a".repeat(40),
      umbrellaReconcileFn: null,
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

      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      fetchPrHeadShaFn: () => "a".repeat(40),
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

      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      fetchPrHeadShaFn: () => "a".repeat(40),
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

      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      fetchPrHeadShaFn: () => "a".repeat(40),
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

      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      fetchPrHeadShaFn: () => "a".repeat(40),
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

      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      fetchPrHeadShaFn: () => "a".repeat(40),
    });

    expect(result.error).toContain("stderr tail:");
    expect(result.error).toContain("poll stderr tail marker");
  });

  it("stale head-bound plan:approved blocks merge and skips mergeFn (#3235)", () => {
    const mergeFn = makeMergeFn(0, "should not merge");
    let disableCalled = false;
    const result = waitMergeableAndMerge(525, "3Ci-Consulting/runbound", {
      capMinutes: 10,
      protected: [],
      protectedFn: makeProtectedFn(0),
      monitorFn: makeMonitorFn(0, cleanMonitorPayload(525)),
      mergeFn,
      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: false,
      projectRoot: process.cwd(),
      fetchPrHeadShaFn: () => "a".repeat(40),
      mergeApprovalHeadFn: (input) => {
        expect(input.prNumber).toBe(525);
        expect(input.currentHeadSha).toBe("a".repeat(40));
        disableCalled = true;
        return {
          status: "stale",
          allowed: false,
          approved_head_sha: "b".repeat(40),
          current_head_sha: "a".repeat(40),
          pr_number: 525,
          require_human_merge: true,
          auto_merge_disabled: true,
          message: "stale approval #3235",
          recovery: "re-approve with --head-sha",
        };
      },
      umbrellaReconcileFn: null,
    });

    expect(result.exitCode).toBe(EXIT_CONFIG_ERROR);
    expect(result.outcome).toBe("stale-merge-approval");
    expect(result.error).toContain("#3235");
    expect(result.error).toContain("re-approve");
    expect((mergeFn as { calls: unknown[] }).calls).toEqual([]);
    expect(disableCalled).toBe(true);
  });

  it("matching head-bound approval allows merge with match-head-commit (#3235)", () => {
    const mergeFn = makeMergeFn(0, "merged");
    const head = "a".repeat(40);
    const result = waitMergeableAndMerge(100, "deftai/directive", {
      capMinutes: 10,
      protected: [],
      protectedFn: makeProtectedFn(0),
      monitorFn: makeMonitorFn(0, cleanMonitorPayload(100)),
      mergeFn,
      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: false,
      fetchPrHeadShaFn: () => head,
      mergeApprovalHeadFn: () => ({
        status: "ok",
        allowed: true,
        approved_head_sha: head,
        current_head_sha: head,
        pr_number: 100,
        require_human_merge: false,
        auto_merge_disabled: null,
        message: "ok",
        recovery: null,
      }),
      umbrellaReconcileFn: null,
    });

    expect(result.exitCode).toBe(EXIT_MERGED);
    expect(result.outcome).toBe("merged");
    expect((mergeFn as { calls: unknown[] }).calls).toEqual([
      [100, "deftai/directive", { matchHeadCommit: head }],
    ]);
  });

  it("cascade semantic-stale-base blocks before monitor or merge (#2385)", () => {
    const monitorFn = makeMonitorFn(0, cleanMonitorPayload());
    const mergeFn = makeMergeFn(0);
    const semanticGreenFn = (): SemanticGreenResult => ({
      ok: false,
      outcome: "semantic-stale-base",
      exitCode: EXIT_TIMEOUT_OR_ESCALATION,
      error: "PR base SHA is behind the current target branch HEAD",
      payload: {
        pr_base_sha: "a".repeat(40),
        target_branch: "master",
        target_head_sha: "b".repeat(40),
        master_ci: {},
      },
    });

    const result = waitMergeableAndMerge(2379, "deftai/directive", {
      capMinutes: 30,
      protected: [],
      cascadeMode: true,
      protectedFn: makeProtectedFn(0),
      monitorFn,
      mergeFn,
      semanticGreenFn,

      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      fetchPrHeadShaFn: () => "a".repeat(40),
    });

    expect(result.exitCode).toBe(EXIT_TIMEOUT_OR_ESCALATION);
    expect(result.outcome).toBe("semantic-stale-base");
    expect((monitorFn as { calls: unknown[] }).calls).toEqual([]);
    expect((mergeFn as { calls: unknown[] }).calls).toEqual([]);
    expect(result.error).toContain("behind the current target branch HEAD");
  });

  it("cascade path surfaces master-merge-gate-red and does not merge (#6071)", () => {
    const monitorFn = makeMonitorFn(0, cleanMonitorPayload());
    const mergeFn = makeMergeFn(0);
    const semanticGreenFn = (): SemanticGreenResult => ({
      ok: false,
      outcome: "master-merge-gate-red",
      exitCode: EXIT_TIMEOUT_OR_ESCALATION,
      error: "Merge gate (task check) is completed/failure on tip",
      payload: {
        pr_base_sha: "a".repeat(40),
        target_branch: "master",
        target_head_sha: "b".repeat(40),
        master_ci: {},
        named_merge_gate: { disposition: "red" },
      },
    });

    const result = waitMergeableAndMerge(2379, "deftai/directive", {
      capMinutes: 30,
      protected: [],
      cascadeMode: true,
      protectedFn: makeProtectedFn(0),
      monitorFn,
      mergeFn,
      semanticGreenFn,
      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      fetchPrHeadShaFn: () => "a".repeat(40),
    });

    expect(result.exitCode).toBe(EXIT_TIMEOUT_OR_ESCALATION);
    expect(result.outcome).toBe("master-merge-gate-red");
    expect((monitorFn as { calls: unknown[] }).calls).toEqual([]);
    expect((mergeFn as { calls: unknown[] }).calls).toEqual([]);
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
      semanticGreen: {},
      mergeStdout: "",
      mergeStderr: "",
      error: null,
    });
    expect(dict.error).toBeUndefined();
    expect(dict.merge_stdout).toBeUndefined();
  });
});

describe("closeout attestability gate before merge (#3781)", () => {
  const base = {
    capMinutes: 30,
    protected: [] as number[],
    skipHumanMergeGate: true,
    skipMergeApprovalHeadGate: true,
    skipCloseoutAttestableGate: false,
    fetchPrHeadShaFn: () => "a".repeat(40),
    umbrellaReconcileFn: null,
  };

  it("refuses the merge when the PR closes an issue whose brief is unattested", () => {
    const mergeFn = makeMergeFn(0);
    const closeoutFn = makeCloseoutFn(1, "PR #3786 closes #3609, leaving 5 unattested criteria");

    const result = waitMergeableAndMerge(3786, "deftai/directive", {
      ...base,
      monitorFn: makeMonitorFn(0, cleanMonitorPayload(3786)),
      mergeFn,
      closeoutAttestableFn: closeoutFn,
      projectRoot: "/tmp/worktree",
    });

    expect(result.exitCode).toBe(EXIT_TIMEOUT_OR_ESCALATION);
    expect(result.outcome).toBe("closeout-unattested");
    expect(result.error).toContain("5 unattested criteria");
    expect((mergeFn as { calls: unknown[] }).calls).toEqual([]);
    expect((closeoutFn as { calls: unknown[] }).calls).toEqual([
      [3786, "deftai/directive", "/tmp/worktree"],
    ]);
  });

  it("treats a failed closing-reference lookup as a config error, not a pass", () => {
    const mergeFn = makeMergeFn(0);

    const result = waitMergeableAndMerge(3786, "deftai/directive", {
      ...base,
      monitorFn: makeMonitorFn(0, cleanMonitorPayload(3786)),
      mergeFn,
      closeoutAttestableFn: makeCloseoutFn(2, "could not read closing-issue references"),
    });

    expect(result.exitCode).toBe(EXIT_CONFIG_ERROR);
    expect(result.outcome).toBe("config-error");
    expect((mergeFn as { calls: unknown[] }).calls).toEqual([]);
  });

  it("merges when the closeout gate is clean", () => {
    const mergeFn = makeMergeFn(0, "merged via squash");

    const result = waitMergeableAndMerge(3786, "deftai/directive", {
      ...base,
      monitorFn: makeMonitorFn(0, cleanMonitorPayload(3786)),
      mergeFn,
      closeoutAttestableFn: makeCloseoutFn(0),
    });

    expect(result.exitCode).toBe(EXIT_MERGED);
    expect((mergeFn as { calls: unknown[] }).calls).toHaveLength(1);
  });

  it("skips the gate when the harness skips the human-merge gate", () => {
    const closeoutFn = makeCloseoutFn(1, "should never run");
    const mergeFn = makeMergeFn(0);

    const result = waitMergeableAndMerge(3786, "deftai/directive", {
      capMinutes: 30,
      protected: [],
      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      fetchPrHeadShaFn: () => "a".repeat(40),
      umbrellaReconcileFn: null,
      monitorFn: makeMonitorFn(0, cleanMonitorPayload(3786)),
      mergeFn,
      closeoutAttestableFn: closeoutFn,
    });

    expect(result.exitCode).toBe(EXIT_MERGED);
    expect((closeoutFn as { calls: unknown[] }).calls).toEqual([]);
  });

  it("halts on SHA-matched NEW_P0_P1 in one probe without calling the monitor (#4628)", () => {
    const monitorFn = makeMonitorFn(0, cleanMonitorPayload(1370));
    const mergeFn = makeMergeFn(0);
    const result = waitMergeableAndMerge(1370, "deftai/directive", {
      capMinutes: 30,
      protected: [],
      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      fetchPrHeadShaFn: () => "a".repeat(40),
      umbrellaReconcileFn: null,
      monitorFn,
      mergeFn,
      watchFn: () => ({ exitCode: 1, verdict: "NEW_P0_P1" }),
    });
    expect(result.exitCode).toBe(EXIT_TIMEOUT_OR_ESCALATION);
    expect(result.outcome).toBe("new-p0-p1");
    expect((monitorFn as { calls: unknown[] }).calls).toEqual([]);
    expect((mergeFn as { calls: unknown[] }).calls).toEqual([]);
    expect(result.error).toContain("one probe, no cap wait");
  });

  it("keeps waiting when one-shot watch is not NEW_P0_P1 (#4628)", () => {
    const monitorFn = makeMonitorFn(0, cleanMonitorPayload(1370));
    const mergeFn = makeMergeFn(0);
    const result = waitMergeableAndMerge(1370, "deftai/directive", {
      capMinutes: 30,
      protected: [],
      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      fetchPrHeadShaFn: () => "a".repeat(40),
      umbrellaReconcileFn: null,
      monitorFn,
      mergeFn,
      watchFn: () => ({ exitCode: 2, verdict: "PENDING" }),
    });
    expect(result.exitCode).toBe(EXIT_MERGED);
    expect((monitorFn as { calls: unknown[] }).calls).toHaveLength(1);
    expect((mergeFn as { calls: unknown[] }).calls).toHaveLength(1);
  });
});

// ---- merge-queue --wait (#6423) --------------------------------------------

const Q_REPO = "deftai/directive";
const Q_HEAD = "a".repeat(40);
const Q_NEW_HEAD = "b".repeat(40);
const Q_GROUP_COMMIT = "c".repeat(40);
const Q_SINCE = "2026-11-17T01:00:00.000Z";
const Q_AFTER = "2026-11-17T01:05:00Z";
const POLL_MS = MERGE_QUEUE_WAIT_POLL_SECONDS * 1000;

function queueRead(overrides: Partial<QueueRead> = {}): QueueRead {
  return {
    headSha: Q_HEAD,
    merged: false,
    mergeCommitSha: null,
    queueEntry: null,
    autoMergeRequested: false,
    events: [],
    ...overrides,
  };
}

const QUEUED = queueRead({ queueEntry: { state: "QUEUED", position: 2 } });
const AWAITING = queueRead({ autoMergeRequested: true });
const MERGED = queueRead({ merged: true, mergeCommitSha: Q_GROUP_COMMIT });
const REMOVED = queueRead({
  events: [{ type: "RemovedFromMergeQueueEvent", createdAt: Q_AFTER, reason: "CI failed" }],
});
const FAILED: QueueReadResult = { status: "error", message: "queue state read failed: 502" };
const FLOOR: QueueReadResult = {
  status: "rate-limited",
  message: "GraphQL bucket has 12 points left (< 500, #954)",
};

/** Fake clock and sleep: reads take no time; sleep advances the clock. */
function fakeTime(sleepOverrunMs = 0) {
  const clock = { ms: 0, sleeps: [] as number[], readTimes: [] as number[] };
  return {
    clock,
    clockMsFn: () => clock.ms,
    sleepFn: (seconds: number) => {
      clock.sleeps.push(seconds);
      clock.ms += seconds * 1000 + sleepOverrunMs;
    },
  };
}

/** Queue reader that plays the given reads in order (last one repeats). */
function playReads(
  time: ReturnType<typeof fakeTime>,
  ...steps: Array<QueueRead | QueueReadResult>
): QueueReadFn & { count: number } {
  const fn = (() => {
    const step = steps[Math.min(fn.count, steps.length - 1)] as QueueRead | QueueReadResult;
    fn.count += 1;
    time.clock.readTimes.push(time.clock.ms);
    return "status" in step ? step : ({ status: "ok", read: step } as const);
  }) as QueueReadFn & { count: number };
  fn.count = 0;
  return fn;
}

function resumeWait(
  time: ReturnType<typeof fakeTime>,
  readFn: QueueReadFn,
  capMinutes: number,
  reconciled: string[] = [],
) {
  return resumeMergeQueueRead(5, Q_REPO, {
    expectHead: Q_HEAD,
    since: Q_SINCE,
    projectRoot: "/tmp/unused",
    queueReadFn: readFn,
    umbrellaReconcileFn: (_root, repo) => reconciled.push(repo),
    wait: { capMinutes, sleepFn: time.sleepFn, clockMsFn: time.clockMsFn },
  });
}

describe("merge-queue --wait (#6423)", () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stderr.mockRestore();
  });

  it("waits through queued reads until merged; exits 0 and reconciles once (AC 1)", () => {
    const time = fakeTime();
    const reconciled: string[] = [];
    const readFn = playReads(time, QUEUED, AWAITING, MERGED);
    const result = resumeWait(time, readFn, 60, reconciled);
    expect(result.exitCode).toBe(EXIT_MERGED);
    expect(result.outcome).toBe("merged");
    expect(result.mergeQueue?.wait_stop_reason).toBe("result");
    expect(result.mergeQueue?.merge_commit_sha).toBe(Q_GROUP_COMMIT);
    expect(reconciled).toEqual([Q_REPO]);
    expect(readFn.count).toBe(3);
    expect(time.clock.sleeps).toEqual([
      MERGE_QUEUE_WAIT_POLL_SECONDS,
      MERGE_QUEUE_WAIT_POLL_SECONDS,
    ]);
    expect(time.clock.readTimes).toEqual([0, POLL_MS, 2 * POLL_MS]);
    const progress = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(progress).toContain("queue wait: queued; next read in 60s");
    expect(progress).toContain("queue wait: awaiting-admission; next read in 60s");
  });

  it("a removal ends the wait with exit 1 and GitHub's reason (AC 2)", () => {
    const time = fakeTime();
    const reconciled: string[] = [];
    const result = resumeWait(time, playReads(time, QUEUED, REMOVED), 60, reconciled);
    expect(result.exitCode).toBe(EXIT_TIMEOUT_OR_ESCALATION);
    expect(result.outcome).toBe("removed");
    expect(result.mergeQueue?.removal_reason).toBe("CI failed");
    expect(result.error).toContain("reason=CI failed");
    expect(result.mergeQueue?.wait_stop_reason).toBe("result");
    expect(reconciled).toEqual([]);
  });

  it("a changed head ends the wait with head-changed and no reconciliation (AC 3)", () => {
    const time = fakeTime();
    const reconciled: string[] = [];
    const headMoved = queueRead({
      headSha: Q_NEW_HEAD,
      merged: true,
      mergeCommitSha: Q_GROUP_COMMIT,
    });
    const result = resumeWait(time, playReads(time, QUEUED, headMoved), 60, reconciled);
    expect(result.exitCode).toBe(EXIT_TIMEOUT_OR_ESCALATION);
    expect(result.outcome).toBe("head-changed");
    expect(result.mergeQueue?.wait_stop_reason).toBe("result");
    expect(reconciled).toEqual([]);
  });

  it("an inactive PR ends the wait with exit 1", () => {
    const time = fakeTime();
    const result = resumeWait(time, playReads(time, QUEUED, queueRead()), 60);
    expect(result.exitCode).toBe(EXIT_TIMEOUT_OR_ESCALATION);
    expect(result.outcome).toBe("inactive");
  });

  it("stays queued to the cap: exit 3, resume command, stop reason cap, no read after the deadline (AC 4, item 3)", () => {
    const time = fakeTime();
    const readFn = playReads(time, QUEUED);
    const result = resumeWait(time, readFn, 3);
    const deadline = 3 * 60_000;
    expect(result.exitCode).toBe(EXIT_QUEUE_PENDING);
    expect(result.outcome).toBe("queued");
    expect(result.mergeQueue?.wait_stop_reason).toBe("cap");
    expect(result.mergeQueue?.resume_command).toContain(
      `--resume --expect-head ${Q_HEAD} --since ${Q_SINCE}`,
    );
    expect(result.mergeQueue?.resume_command).not.toContain("--wait");
    expect(result.error).toContain("Resume:");
    expect(time.clock.readTimes).toEqual([0, POLL_MS, 2 * POLL_MS, 3 * POLL_MS]);
    expect(Math.max(...time.clock.readTimes)).toBeLessThanOrEqual(deadline);
    expect(time.clock.ms).toBeLessThanOrEqual(deadline);
  });

  it("a cap shorter than the interval makes one read and no sleep", () => {
    const time = fakeTime();
    const readFn = playReads(time, QUEUED);
    const result = resumeWait(time, readFn, 0.5);
    expect(result.exitCode).toBe(EXIT_QUEUE_PENDING);
    expect(result.mergeQueue?.wait_stop_reason).toBe("cap");
    expect(readFn.count).toBe(1);
    expect(time.clock.sleeps).toEqual([]);
  });

  it("a sleep that overruns the deadline starts no further read", () => {
    const time = fakeTime(30_000);
    const readFn = playReads(time, QUEUED);
    const result = resumeWait(time, readFn, 1.25);
    expect(result.exitCode).toBe(EXIT_QUEUE_PENDING);
    expect(result.mergeQueue?.wait_stop_reason).toBe("cap");
    expect(readFn.count).toBe(1);
  });

  it("a failed latest attempt at the cap exits 2 with its error, not the earlier pending read (AC 5)", () => {
    const time = fakeTime();
    const result = resumeWait(time, playReads(time, QUEUED, FAILED), 1);
    expect(result.exitCode).toBe(EXIT_CONFIG_ERROR);
    expect(result.outcome).toBe("queue-read-unavailable");
    expect(result.error).toContain("queue state read failed: 502");
    expect(result.error).toContain("Resume: task pr:wait-mergeable-and-merge -- 5");
    expect(result.mergeQueue?.resume_command).toContain("--resume");
    expect(result.mergeQueue?.result).toBeUndefined();
    expect(result.mergeQueue?.queue_state).toBeUndefined();
    expect(result.mergeQueue?.wait_stop_reason).toBe("cap");
  });

  it("three failed reads in a row end the wait early with read-unavailable (AC 6, item 4)", () => {
    const time = fakeTime();
    const readFn = playReads(time, FLOOR, FAILED, FAILED, QUEUED);
    const result = resumeWait(time, readFn, 60);
    expect(result.exitCode).toBe(EXIT_CONFIG_ERROR);
    expect(result.mergeQueue?.wait_stop_reason).toBe("read-unavailable");
    expect(readFn.count).toBe(MERGE_QUEUE_WAIT_MAX_FAILED_READS);
    expect(result.error).toContain("queue state read failed");
    const progress = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(progress).toContain("read unavailable (2 of 3 in a row)");
  });

  it("a successful read resets the failed-read count (AC 7)", () => {
    const time = fakeTime();
    const readFn = playReads(time, FAILED, FAILED, QUEUED, FAILED, FAILED, MERGED);
    const result = resumeWait(time, readFn, 60);
    expect(result.exitCode).toBe(EXIT_MERGED);
    expect(result.mergeQueue?.wait_stop_reason).toBe("result");
    expect(readFn.count).toBe(6);
  });

  it("a first read that is not pending returns at once with the live clock and sleep", () => {
    const reconciled: string[] = [];
    const result = resumeMergeQueueRead(5, Q_REPO, {
      expectHead: Q_HEAD,
      since: Q_SINCE,
      projectRoot: "/tmp/unused",
      queueReadFn: () => ({ status: "ok", read: MERGED }),
      umbrellaReconcileFn: (_root, repo) => reconciled.push(repo),
      wait: { capMinutes: 60 },
    });
    expect(result.exitCode).toBe(EXIT_MERGED);
    expect(result.mergeQueue?.wait_stop_reason).toBe("result");
    expect(reconciled).toEqual([Q_REPO]);
  });

  it("without --wait the read happens once and carries no stop reason (AC 9, item 6)", () => {
    const time = fakeTime();
    const readFn = playReads(time, QUEUED, MERGED);
    const result = resumeMergeQueueRead(5, Q_REPO, {
      expectHead: Q_HEAD,
      since: Q_SINCE,
      projectRoot: "/tmp/unused",
      queueReadFn: readFn,
      umbrellaReconcileFn: null,
    });
    expect(result.exitCode).toBe(EXIT_QUEUE_PENDING);
    expect(readFn.count).toBe(1);
    expect(result.mergeQueue).not.toHaveProperty("wait_stop_reason");
    const failed = reportMergeQueueState({
      prNumber: 5,
      repo: Q_REPO,
      expectHead: Q_HEAD,
      since: Q_SINCE,
      projectRoot: "/tmp/unused",
      queueReadFn: () => FAILED,
    });
    expect(failed.exitCode).toBe(EXIT_CONFIG_ERROR);
    expect(failed.mergeQueue).not.toHaveProperty("wait_stop_reason");
  });

  it("the first call in queue mode with --wait waits after enqueue (AC 8)", () => {
    const time = fakeTime();
    const readFn = playReads(time, QUEUED, QUEUED, MERGED);
    const merges: unknown[] = [];
    const reconciled: string[] = [];
    const result = waitMergeableAndMerge(5, Q_REPO, {
      capMinutes: 30,
      protected: [],
      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      monitorFn: () => [
        0,
        JSON.stringify({
          monitor_result: "CLEAN",
          polls: 1,
          readiness: { head_sha: Q_HEAD, merge_ready: true, failures: [], via: "primary" },
        }),
        "",
      ],
      fetchPrHeadShaFn: () => Q_HEAD,
      semanticGreenFn: () => {
        throw new Error("semantic-green must not run in queue mode");
      },
      mergeQueueDetectFn: () => ({ status: "queue", branch: "master" }) as const,
      nowFn: () => new Date(Q_SINCE),
      mergeFn: (n, r, o) => {
        merges.push([n, r, o]);
        return [0, "", ""];
      },
      queueReadFn: readFn,
      umbrellaReconcileFn: (_root, repo) => reconciled.push(repo),
      wait: true,
      queueWaitSleepFn: time.sleepFn,
      queueWaitClockMsFn: time.clockMsFn,
    });
    expect(merges).toEqual([[5, Q_REPO, { matchHeadCommit: Q_HEAD, queueMode: true }]]);
    expect(result.exitCode).toBe(EXIT_MERGED);
    expect(result.mergeQueue?.wait_stop_reason).toBe("result");
    expect(readFn.count).toBe(3);
    expect(reconciled).toEqual([Q_REPO]);
    expect(result.monitorResult).toMatchObject({ monitor_result: "CLEAN" });
  });

  it("sleepSecondsSync blocks for the given time and returns at once for zero", () => {
    const start = Date.now();
    sleepSecondsSync(0);
    sleepSecondsSync(0.02);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});
