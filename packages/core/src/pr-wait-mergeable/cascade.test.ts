import { describe, expect, it } from "vitest";
import { waitMergeableAndMerge } from "./cascade.js";
import { EXIT_CONFIG_ERROR, EXIT_MERGED, EXIT_TIMEOUT_OR_ESCALATION } from "./constants.js";
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
    const mergeFn = makeMergeFn(0);
    const result = waitMergeableAndMerge(1370, "deftai/directive", {
      capMinutes: 30,
      protected: [],
      protectedFn: makeProtectedFn(0),
      monitorFn: makeMonitorFn(2, { monitor_result: "CONFIG-ERROR", skipHumanMergeGate: true }),
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
});
