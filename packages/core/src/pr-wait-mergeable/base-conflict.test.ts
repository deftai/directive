import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT_NEW_P0_P1, VERDICT_NEW_P0_P1 } from "../pr-watch/constants.js";
import {
  type BaseConflictRead,
  type BaseConflictReadFn,
  formatBaseConflictError,
  isBaseConflict,
  isBaseConflictTrigger,
  OUTCOME_BASE_CONFLICT,
  readBaseConflictState,
} from "./base-conflict.js";
import { waitMergeableAndMerge } from "./cascade.js";
import { EXIT_MERGED, EXIT_TIMEOUT_OR_ESCALATION } from "./constants.js";
import { runWaitMergeable } from "./main.js";
import type { MergeFn, MonitorFn } from "./types.js";

const REPO = "deftai/directive";
const PR = 6467;
const HEAD = "a".repeat(40);

const ABSENT_PAYLOAD = {
  monitor_result: "ABSENT-REQUIRED",
  monitor_absent_required: ["Merge gate (task check)"],
};
const CAP_PAYLOAD = { monitor_result: "CAP-REACHED", polls: 30 };
const CLEAN_PAYLOAD = {
  monitor_result: "CLEAN",
  polls: 1,
  readiness: { head_sha: HEAD, merge_ready: true, failures: [], via: "primary" },
};

const TODAY_ABSENT_ERROR = "monitor exited 4 (outcome=absent-required)";

function monitor(rc: number, payload: Record<string, unknown>): MonitorFn {
  return () => [rc, JSON.stringify(payload, null, 2), ""];
}

function counted(read: BaseConflictRead): BaseConflictReadFn & { count: number } {
  const fn = ((_n: number, _r: string) => {
    fn.count += 1;
    return read;
  }) as BaseConflictReadFn & { count: number };
  fn.count = 0;
  return fn;
}

function mergeSpy(): MergeFn & { calls: unknown[] } {
  const fn = ((n: number, r: string | null, o?: unknown) => {
    fn.calls.push([n, r, o]);
    return [0, "merged", ""] as const;
  }) as MergeFn & { calls: unknown[] };
  fn.calls = [];
  return fn;
}

const dirty = (baseRef: string | null = "master"): BaseConflictRead => ({
  mergeableState: "dirty",
  baseRef,
  error: null,
});

function run(
  monitorFn: MonitorFn,
  readFn: BaseConflictReadFn | undefined,
  extra: Record<string, unknown> = {},
) {
  return waitMergeableAndMerge(PR, REPO, {
    capMinutes: 5,
    protected: [],
    monitorFn,
    mergeFn: mergeSpy(),
    skipHumanMergeGate: true,
    skipMergeApprovalHeadGate: true,
    fetchPrHeadShaFn: () => HEAD,
    umbrellaReconcileFn: null,
    baseConflictReadFn: readFn,
    ...extra,
  });
}

describe("readBaseConflictState (#6467 item 2)", () => {
  it("takes mergeable_state and base.ref from one pulls/<N> response", () => {
    const calls: string[][] = [];
    const read = readBaseConflictState(PR, REPO, (cmd) => {
      calls.push([...cmd]);
      return {
        returncode: 0,
        stdout: JSON.stringify({ mergeable_state: "dirty", base: { ref: "master" } }),
        stderr: "",
      };
    });
    expect(calls).toEqual([["gh", "api", `repos/${REPO}/pulls/${PR}`]]);
    expect(read).toEqual({ mergeableState: "dirty", baseRef: "master", error: null });
    expect(isBaseConflict(read)).toBe(true);
  });

  it("returns nulls for a missing state and base", () => {
    const read = readBaseConflictState(PR, REPO, () => ({
      returncode: 0,
      stdout: JSON.stringify({ mergeable_state: null }),
      stderr: "",
    }));
    expect(read).toEqual({ mergeableState: null, baseRef: null, error: null });
    expect(isBaseConflict(read)).toBe(false);
  });

  it("reports a failed call as an error", () => {
    const read = readBaseConflictState(PR, REPO, () => ({
      returncode: 1,
      stdout: "",
      stderr: "HTTP 502\n",
    }));
    expect(read.error).toBe(`gh api pulls/${PR} failed: HTTP 502`);
    expect(isBaseConflict(read)).toBe(false);
  });

  it("reports a body that is not JSON or not an object as an error", () => {
    const notJson = readBaseConflictState(PR, REPO, () => ({
      returncode: 0,
      stdout: "<html>",
      stderr: "",
    }));
    expect(notJson.error).toBe(`pulls/${PR} is not JSON`);
    const notObject = readBaseConflictState(PR, REPO, () => ({
      returncode: 0,
      stdout: "[]",
      stderr: "",
    }));
    expect(notObject.error).toBe(`pulls/${PR} is not an object`);
  });

  it("does not count an error read as a conflict even with a dirty state", () => {
    expect(isBaseConflict({ mergeableState: "dirty", baseRef: null, error: "x" })).toBe(false);
  });

  it("triggers only on absent-required and cap-reached", () => {
    expect(isBaseConflictTrigger("absent-required")).toBe(true);
    expect(isBaseConflictTrigger("cap-reached")).toBe(true);
    for (const o of ["clean", "new-p0-p1", "pr-closed", "config-error", "merged-by-sibling"]) {
      expect(isBaseConflictTrigger(o)).toBe(false);
    }
  });

  it("formats the error text of Bound item 3", () => {
    expect(formatBaseConflictError(PR, "master", "absent-required")).toBe(
      `PR #${PR} conflicts with its base branch \`master\` (GitHub mergeable_state=dirty). ` +
        "Required checks do not run on a conflicted PR, so they did not appear. " +
        "Fix: merge or rebase `master` into the PR branch, resolve the conflicts, push, " +
        "then run task pr:wait-mergeable-and-merge again. Replaces monitor outcome: absent-required.",
    );
  });
});

describe("waitMergeableAndMerge base-conflict (#6467)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clause.7: absent-required + dirty on master reports base-conflict with the checks sentence and fix", () => {
    const readFn = counted(dirty("master"));
    const result = run(monitor(4, ABSENT_PAYLOAD), readFn);
    expect(result.outcome).toBe(OUTCOME_BASE_CONFLICT);
    expect(result.exitCode).toBe(EXIT_TIMEOUT_OR_ESCALATION);
    expect(result.error).toContain(`PR #${PR} conflicts with its base branch \`master\``);
    expect(result.error).toContain("Required checks do not run on a conflicted PR");
    expect(result.error).toContain("Fix: merge or rebase `master` into the PR branch");
    expect(result.error).toContain("Replaces monitor outcome: absent-required.");
    expect(result.monitorResult).toMatchObject(ABSENT_PAYLOAD);
    expect(readFn.count).toBe(1);
  });

  it("clause.8: cap-reached + dirty reports base-conflict without the checks sentence", () => {
    const readFn = counted(dirty("master"));
    const result = run(monitor(1, CAP_PAYLOAD), readFn);
    expect(result.outcome).toBe(OUTCOME_BASE_CONFLICT);
    expect(result.exitCode).toBe(EXIT_TIMEOUT_OR_ESCALATION);
    expect(result.error).toContain("conflicts with its base branch");
    expect(result.error).toContain("Fix: merge or rebase");
    expect(result.error).not.toContain("Required checks do not run");
    expect(result.error).toContain("Replaces monitor outcome: cap-reached.");
    expect(readFn.count).toBe(1);
  });

  it("clause.9: absent-required + blocked keeps absent-required and today's text", () => {
    const readFn = counted({ mergeableState: "blocked", baseRef: "master", error: null });
    const result = run(monitor(4, ABSENT_PAYLOAD), readFn);
    expect(result.outcome).toBe("absent-required");
    expect(result.exitCode).toBe(EXIT_TIMEOUT_OR_ESCALATION);
    expect(result.error).toBe(TODAY_ABSENT_ERROR);
    expect(readFn.count).toBe(1);
  });

  it("clause.10: a failed, unknown, null or thrown read keeps absent-required and today's text", () => {
    const reads: BaseConflictRead[] = [
      { mergeableState: null, baseRef: null, error: "gh api pulls/6467 failed: HTTP 502" },
      { mergeableState: "unknown", baseRef: "master", error: null },
      { mergeableState: null, baseRef: "master", error: null },
    ];
    for (const read of reads) {
      const result = run(monitor(4, ABSENT_PAYLOAD), counted(read));
      expect(result.outcome).toBe("absent-required");
      expect(result.error).toBe(TODAY_ABSENT_ERROR);
    }
    const thrown = run(monitor(4, ABSENT_PAYLOAD), () => {
      throw new Error("network down");
    });
    expect(thrown.outcome).toBe("absent-required");
    expect(thrown.error).toBe(TODAY_ABSENT_ERROR);
  });

  it("clause.11: dirty with no base.ref says its base branch and still names the fix", () => {
    const result = run(monitor(4, ABSENT_PAYLOAD), counted(dirty(null)));
    expect(result.outcome).toBe(OUTCOME_BASE_CONFLICT);
    expect(result.error).toContain(
      `PR #${PR} conflicts with its base branch (GitHub mergeable_state=dirty).`,
    );
    expect(result.error).toContain("Fix: merge or rebase the base branch into the PR branch");
  });

  it("clause.12: a clean monitor result makes no conflict read", () => {
    const readFn = counted(dirty());
    const mergeFn = mergeSpy();
    const result = run(monitor(0, CLEAN_PAYLOAD), readFn, { mergeFn });
    expect(result.exitCode).toBe(EXIT_MERGED);
    expect(readFn.count).toBe(0);
    expect(mergeFn.calls).toHaveLength(1);
  });

  it("clause.13: a SHA-matched new-p0-p1 probe keeps new-p0-p1 and makes no conflict read", () => {
    const readFn = counted(dirty());
    let monitorCalls = 0;
    const result = run(
      () => {
        monitorCalls += 1;
        return [4, JSON.stringify(ABSENT_PAYLOAD), ""];
      },
      readFn,
      { watchFn: () => ({ exitCode: EXIT_NEW_P0_P1, verdict: VERDICT_NEW_P0_P1 }) },
    );
    expect(result.outcome).toBe("new-p0-p1");
    expect(readFn.count).toBe(0);
    expect(monitorCalls).toBe(0);
  });

  it("clause.14: in merge-queue mode a dirty absent-required PR is reported and never enqueued", () => {
    const readFn = counted(dirty("master"));
    const mergeFn = mergeSpy();
    const result = run(monitor(4, ABSENT_PAYLOAD), readFn, {
      mergeFn,
      mergeQueueDetectFn: () => ({ status: "queue", branch: "master" }) as const,
      semanticGreenFn: () => {
        throw new Error("semantic-green must not run in queue mode");
      },
    });
    expect(result.outcome).toBe(OUTCOME_BASE_CONFLICT);
    expect(result.exitCode).toBe(EXIT_TIMEOUT_OR_ESCALATION);
    expect(mergeFn.calls).toEqual([]);
    expect(readFn.count).toBe(1);
  });

  it("clause.15: --json prints one JSON document with outcome base-conflict and the error", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = runWaitMergeable([String(PR), "--repo", REPO, "--cap-minutes", "5", "--json"], {
      monitorFn: monitor(4, ABSENT_PAYLOAD),
      mergeFn: mergeSpy(),
      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      fetchPrHeadShaFn: () => HEAD,
      umbrellaReconcileFn: null,
      baseConflictReadFn: counted(dirty("master")),
    });
    expect(code).toBe(EXIT_TIMEOUT_OR_ESCALATION);
    expect(stdout.mock.calls).toHaveLength(1);
    const payload = JSON.parse(String(stdout.mock.calls[0]?.[0] ?? "")) as Record<string, unknown>;
    expect(payload.outcome).toBe(OUTCOME_BASE_CONFLICT);
    expect(payload.exit_code).toBe(EXIT_TIMEOUT_OR_ESCALATION);
    expect(String(payload.error)).toContain("conflicts with its base branch `master`");
  });

  it("text output names the outcome and the error", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = runWaitMergeable([String(PR), "--repo", REPO, "--cap-minutes", "5"], {
      monitorFn: monitor(4, ABSENT_PAYLOAD),
      mergeFn: mergeSpy(),
      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      fetchPrHeadShaFn: () => HEAD,
      umbrellaReconcileFn: null,
      baseConflictReadFn: counted(dirty("master")),
    });
    expect(code).toBe(EXIT_TIMEOUT_OR_ESCALATION);
    const text = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(text).toContain("result: TIMEOUT-OR-ESCALATION");
    expect(text).toContain("outcome: base-conflict");
    expect(text).toContain("error:   PR #6467 conflicts with its base branch `master`");
  });

  it("skips the read under the test-harness convention when no read function is injected", () => {
    const result = run(monitor(4, ABSENT_PAYLOAD), undefined);
    expect(result.outcome).toBe("absent-required");
    expect(result.error).toBe(TODAY_ABSENT_ERROR);
  });
});
