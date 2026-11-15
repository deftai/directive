import { describe, expect, it } from "vitest";
import { resumeMergeQueueRead, waitMergeableAndMerge } from "./cascade.js";
import {
  EXIT_CONFIG_ERROR,
  EXIT_MERGED,
  EXIT_QUEUE_PENDING,
  EXIT_TIMEOUT_OR_ESCALATION,
} from "./constants.js";
import {
  classifyQueueRead,
  detectMergeQueue,
  fetchPrBaseRef,
  formatResumeCommand,
  MERGE_QUEUE_GRAPHQL_FLOOR,
  parseQueueState,
  probeGraphqlRemaining,
  type QueueRead,
  type QueueReadFn,
  type QueueRunGhFn,
  queueResultToDict,
  readQueueState,
  rulesRequireMergeQueue,
} from "./merge-queue.js";
import type { SemanticGreenFn } from "./semantic-green.js";
import type { MergeFn, MonitorFn } from "./types.js";

const REPO = "deftai/directive";
const HEAD = "a".repeat(40);
const NEW_HEAD = "b".repeat(40);
const GROUP_COMMIT = "c".repeat(40);
const SINCE = "2026-11-15T10:00:00.000Z";
const BEFORE = "2026-11-15T09:59:00Z";
const AFTER1 = "2026-11-15T10:01:00Z";
const AFTER2 = "2026-11-15T10:02:00Z";
const AFTER3 = "2026-11-15T10:03:00Z";

type Node = Record<string, unknown>;

/** Recorded GraphQL response shape (measurement 6863745290). */
function graphqlResponse(pr: {
  headRefOid: string;
  merged?: boolean;
  mergeCommit?: string | null;
  entry?: { state: string; position: number } | null;
  autoMerge?: boolean;
  nodes?: Node[];
}): Record<string, unknown> {
  return {
    data: {
      repository: {
        pullRequest: {
          headRefOid: pr.headRefOid,
          merged: pr.merged ?? false,
          mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null,
          mergeQueueEntry: pr.entry ?? null,
          autoMergeRequest: pr.autoMerge ? { enabledAt: AFTER1 } : null,
          timelineItems: { nodes: pr.nodes ?? [] },
        },
      },
    },
  };
}

function readOf(response: Record<string, unknown>): QueueRead {
  const read = parseQueueState(response);
  if (read === null) throw new Error("fixture did not parse");
  return read;
}

const removed = (createdAt: string, reason: string | null): Node => ({
  __typename: "RemovedFromMergeQueueEvent",
  createdAt,
  reason,
});
const added = (createdAt: string): Node => ({ __typename: "AddedToMergeQueueEvent", createdAt });
const disabled = (createdAt: string, reasonCode: string | null): Node => ({
  __typename: "AutoMergeDisabledEvent",
  createdAt,
  reasonCode,
});

describe("classifyQueueRead: six results, head first (#6295 item 4)", () => {
  it("merged: merge whose timeline also holds a removed-from-queue event with reason merged", () => {
    const r = classifyQueueRead(
      readOf(
        graphqlResponse({
          headRefOid: HEAD,
          merged: true,
          mergeCommit: GROUP_COMMIT,
          nodes: [added(AFTER1), removed(AFTER2, "merged")],
        }),
      ),
      HEAD,
      SINCE,
    );
    expect(r.kind).toBe("merged");
    expect(r.mergeCommitSha).toBe(GROUP_COMMIT);
  });

  it("head-changed: dequeue, new head, re-queue, merge read with the old expected head", () => {
    const r = classifyQueueRead(
      readOf(
        graphqlResponse({
          headRefOid: NEW_HEAD,
          merged: true,
          mergeCommit: GROUP_COMMIT,
          nodes: [
            added(AFTER1),
            removed(AFTER1, "manually_removed"),
            added(AFTER2),
            removed(AFTER3, "merged"),
          ],
        }),
      ),
      HEAD,
      SINCE,
    );
    expect(r.kind).toBe("head-changed");
    expect(r.actualHead).toBe(NEW_HEAD);
    expect(r.mergeCommitSha).toBe(GROUP_COMMIT);
  });

  it("head-changed without a merge carries no merge commit", () => {
    const r = classifyQueueRead(readOf(graphqlResponse({ headRefOid: NEW_HEAD })), HEAD, SINCE);
    expect(r.kind).toBe("head-changed");
    expect(r.mergeCommitSha).toBeNull();
  });

  it("queued: entry present", () => {
    const r = classifyQueueRead(
      readOf(
        graphqlResponse({
          headRefOid: HEAD,
          entry: { state: "AWAITING_CHECKS", position: 2 },
          nodes: [added(AFTER1)],
        }),
      ),
      HEAD,
      SINCE,
    );
    expect(r.kind).toBe("queued");
    expect(r.queueState).toBe("AWAITING_CHECKS");
    expect(r.queuePosition).toBe(2);
  });

  it("awaiting-admission: auto-merge request present, no entry", () => {
    const r = classifyQueueRead(
      readOf(graphqlResponse({ headRefOid: HEAD, autoMerge: true })),
      HEAD,
      SINCE,
    );
    expect(r.kind).toBe("awaiting-admission");
  });

  it("removed: timeout removal with reason checks_timed_out", () => {
    const r = classifyQueueRead(
      readOf(
        graphqlResponse({
          headRefOid: HEAD,
          nodes: [added(AFTER1), removed(AFTER2, "checks_timed_out")],
        }),
      ),
      HEAD,
      SINCE,
    );
    expect(r.kind).toBe("removed");
    expect(r.removalReason).toBe("checks_timed_out");
  });

  it("removed: reason may be empty", () => {
    const r = classifyQueueRead(
      readOf(graphqlResponse({ headRefOid: HEAD, nodes: [removed(AFTER2, null)] })),
      HEAD,
      SINCE,
    );
    expect(r.kind).toBe("removed");
    expect(r.removalReason).toBe("");
  });

  it("inactive: cancelled auto-merge before admission", () => {
    const r = classifyQueueRead(
      readOf(graphqlResponse({ headRefOid: HEAD, nodes: [disabled(AFTER1, "manually_disabled")] })),
      HEAD,
      SINCE,
    );
    expect(r.kind).toBe("inactive");
    expect(r.autoMergeDisabledReason).toBe("manually_disabled");
  });

  it("inactive: removals before the recorded time do not count", () => {
    const r = classifyQueueRead(
      readOf(graphqlResponse({ headRefOid: HEAD, nodes: [removed(BEFORE, "checks_timed_out")] })),
      HEAD,
      SINCE,
    );
    expect(r.kind).toBe("inactive");
    expect(r.autoMergeDisabledReason).toBeNull();
    expect(r.events).toEqual([]);
  });

  it("order: merged wins over a present entry; queued wins over auto-merge", () => {
    expect(
      classifyQueueRead(
        readOf(
          graphqlResponse({
            headRefOid: HEAD,
            merged: true,
            mergeCommit: GROUP_COMMIT,
            entry: { state: "MERGEABLE", position: 1 },
          }),
        ),
        HEAD,
        SINCE,
      ).kind,
    ).toBe("merged");
    expect(
      classifyQueueRead(
        readOf(
          graphqlResponse({
            headRefOid: HEAD,
            entry: { state: "QUEUED", position: 1 },
            autoMerge: true,
          }),
        ),
        HEAD,
        SINCE,
      ).kind,
    ).toBe("queued");
  });

  it("matches an abbreviated expected head and treats an unreadable head as changed", () => {
    expect(
      classifyQueueRead(readOf(graphqlResponse({ headRefOid: HEAD })), HEAD.slice(0, 12), SINCE)
        .kind,
    ).toBe("inactive");
    const noHead: QueueRead = {
      headSha: null,
      merged: false,
      mergeCommitSha: null,
      queueEntry: null,
      autoMergeRequested: false,
      events: [],
    };
    expect(classifyQueueRead(noHead, HEAD, SINCE).kind).toBe("head-changed");
  });

  it("serialises to the --json shape with the resume command", () => {
    const r = classifyQueueRead(
      readOf(graphqlResponse({ headRefOid: HEAD, nodes: [removed(AFTER2, "checks_timed_out")] })),
      HEAD,
      SINCE,
    );
    const resume = formatResumeCommand(7, REPO, HEAD, SINCE);
    expect(resume).toBe(
      `task pr:wait-mergeable-and-merge -- 7 --repo ${REPO} --resume --expect-head ${HEAD} --since ${SINCE}`,
    );
    expect(queueResultToDict(r, resume)).toMatchObject({
      result: "removed",
      removal_reason: "checks_timed_out",
      resume_command: resume,
      events: [
        { type: "RemovedFromMergeQueueEvent", created_at: AFTER2, reason: "checks_timed_out" },
      ],
    });
  });
});

describe("parseQueueState", () => {
  it("returns null without a pullRequest and skips malformed nodes", () => {
    expect(parseQueueState({ data: { repository: null } })).toBeNull();
    expect(parseQueueState("x")).toBeNull();
    const read = parseQueueState(
      graphqlResponse({
        headRefOid: HEAD,
        entry: { state: "QUEUED", position: "x" as unknown as number },
        nodes: [{ __typename: "AddedToMergeQueueEvent" }, null as unknown as Node],
      }),
    );
    expect(read?.events).toEqual([]);
    expect(read?.queueEntry).toEqual({ state: "QUEUED", position: null });
  });
});

function scriptedGh(table: Record<string, { returncode: number; stdout: string }>): {
  fn: QueueRunGhFn;
  calls: string[][];
} {
  const calls: string[][] = [];
  const fn: QueueRunGhFn = (cmd) => {
    calls.push([...cmd]);
    const key = cmd.slice(2).join(" ");
    for (const [prefix, r] of Object.entries(table)) {
      if (key.startsWith(prefix)) return { ...r, stderr: r.returncode === 0 ? "" : "boom" };
    }
    throw new Error(`unexpected gh ${key}`);
  };
  return { fn, calls };
}

describe("detectMergeQueue (branch rules REST)", () => {
  it("detects a merge_queue rule on the PR base branch", () => {
    const gh = scriptedGh({
      [`repos/${REPO}/pulls/5`]: {
        returncode: 0,
        stdout: JSON.stringify({ base: { ref: "master" } }),
      },
      [`repos/${REPO}/rules/branches/master`]: {
        returncode: 0,
        stdout: JSON.stringify([{ type: "pull_request" }, { type: "merge_queue" }]),
      },
    });
    expect(detectMergeQueue(5, REPO, null, gh.fn)).toEqual({ status: "queue", branch: "master" });
  });

  it("reports none when the rules carry no merge_queue, using an explicit branch without a PR", () => {
    const gh = scriptedGh({
      [`repos/${REPO}/rules/branches/main`]: { returncode: 0, stdout: "[]" },
    });
    expect(detectMergeQueue(null, REPO, "main", gh.fn)).toEqual({
      status: "none",
      branch: "main",
    });
    expect(gh.calls).toHaveLength(1);
  });

  it("always reads the PR's live base and rejects a conflicting --base-branch (Greptile P1)", () => {
    const gh = scriptedGh({
      [`repos/${REPO}/pulls/5`]: {
        returncode: 0,
        stdout: JSON.stringify({ base: { ref: "master" } }),
      },
      [`repos/${REPO}/rules/branches/master`]: {
        returncode: 0,
        stdout: JSON.stringify([{ type: "merge_queue" }]),
      },
      [`repos/${REPO}/rules/branches/side`]: { returncode: 0, stdout: "[]" },
    });
    const conflict = detectMergeQueue(5, REPO, "side", gh.fn);
    expect(conflict.status).toBe("error");
    expect(gh.calls.some((c) => c.join(" ").includes("rules/branches/side"))).toBe(false);
    expect(detectMergeQueue(5, REPO, "master", gh.fn)).toEqual({
      status: "queue",
      branch: "master",
    });
  });

  it("uses the repository default branch without a PR or override", () => {
    const gh = scriptedGh({
      [`repos/${REPO}/rules`]: { returncode: 0, stdout: "[]" },
      [`repos/${REPO}`]: { returncode: 0, stdout: JSON.stringify({ default_branch: "trunk" }) },
    });
    expect(detectMergeQueue(null, REPO, null, gh.fn)).toEqual({ status: "none", branch: "trunk" });
    const bad = scriptedGh({ [`repos/${REPO}`]: { returncode: 1, stdout: "" } });
    expect(detectMergeQueue(null, REPO, null, bad.fn).status).toBe("error");
  });

  it("fails closed on read errors and non-array payloads", () => {
    expect(
      detectMergeQueue(
        5,
        REPO,
        null,
        scriptedGh({ [`repos/${REPO}/pulls/5`]: { returncode: 1, stdout: "" } }).fn,
      ).status,
    ).toBe("error");
    expect(
      detectMergeQueue(
        null,
        REPO,
        "master",
        scriptedGh({ [`repos/${REPO}/rules/branches/master`]: { returncode: 1, stdout: "" } }).fn,
      ).status,
    ).toBe("error");
    expect(
      detectMergeQueue(
        null,
        REPO,
        "master",
        scriptedGh({ [`repos/${REPO}/rules/branches/master`]: { returncode: 0, stdout: "{}" } }).fn,
      ).status,
    ).toBe("error");
    expect(rulesRequireMergeQueue("nope")).toBeNull();
    expect(
      fetchPrBaseRef(
        5,
        REPO,
        scriptedGh({ [`repos/${REPO}/pulls/5`]: { returncode: 0, stdout: "{}" } }).fn,
      ).ref,
    ).toBeNull();
  });
});

describe("readQueueState (#954 GraphQL floor)", () => {
  const rate = (remaining: number) => ({
    returncode: 0,
    stdout: JSON.stringify({ resources: { graphql: { remaining } } }),
  });

  it("refuses the GraphQL read below the floor", () => {
    const gh = scriptedGh({ rate_limit: rate(MERGE_QUEUE_GRAPHQL_FLOOR - 1) });
    expect(readQueueState(5, REPO, gh.fn).status).toBe("rate-limited");
    expect(gh.calls.some((c) => c.includes("graphql"))).toBe(false);
  });

  it("reads the PR state with plain gh above the floor", () => {
    const gh = scriptedGh({
      rate_limit: rate(4000),
      graphql: { returncode: 0, stdout: JSON.stringify(graphqlResponse({ headRefOid: HEAD })) },
    });
    const r = readQueueState(5, REPO, gh.fn);
    expect(r.status).toBe("ok");
    const graphqlCall = gh.calls.find((c) => c.includes("graphql")) ?? [];
    expect(graphqlCall).toContain("owner=deftai");
    expect(graphqlCall).toContain("name=directive");
    expect(graphqlCall).toContain("number=5");
  });

  it("reports read errors, bad payloads and bad repo slugs", () => {
    expect(
      readQueueState(
        5,
        REPO,
        scriptedGh({ rate_limit: rate(4000), graphql: { returncode: 1, stdout: "" } }).fn,
      ).status,
    ).toBe("error");
    expect(
      readQueueState(
        5,
        REPO,
        scriptedGh({ rate_limit: rate(4000), graphql: { returncode: 0, stdout: "{}" } }).fn,
      ).status,
    ).toBe("error");
    expect(readQueueState(5, "nope", scriptedGh({}).fn).status).toBe("error");
    expect(
      probeGraphqlRemaining(scriptedGh({ rate_limit: { returncode: 1, stdout: "" } }).fn),
    ).toBeNull();
  });
});

// ---- cascade: queue mode -------------------------------------------------

function cleanMonitor(): MonitorFn {
  const payload = {
    monitor_result: "CLEAN",
    polls: 1,
    readiness: { head_sha: HEAD, merge_ready: true, failures: [], via: "primary" },
  };
  return () => [0, JSON.stringify(payload), ""];
}

function recordingMerge(rc = 0, stderr = ""): MergeFn & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const fn = ((n: number, r: string | null, o?: unknown) => {
    calls.push([n, r, o]);
    return [rc, "", stderr] as const;
  }) as MergeFn & { calls: unknown[][] };
  fn.calls = calls;
  return fn;
}

function reads(...responses: Record<string, unknown>[]): QueueReadFn & { count: number } {
  let i = 0;
  const fn = (() => {
    const response = responses[Math.min(i, responses.length - 1)] as Record<string, unknown>;
    i += 1;
    fn.count = i;
    return { status: "ok", read: readOf(response) } as const;
  }) as QueueReadFn & { count: number };
  fn.count = 0;
  return fn;
}

const throwingSemanticGreen: SemanticGreenFn = () => {
  throw new Error("semantic-green (stale-base / master gate) must not run in queue mode");
};

function queueBase(overrides: Record<string, unknown> = {}) {
  return {
    capMinutes: 1,
    protected: [] as number[],
    skipHumanMergeGate: true,
    skipMergeApprovalHeadGate: true,
    monitorFn: cleanMonitor(),
    fetchPrHeadShaFn: () => HEAD,
    semanticGreenFn: throwingSemanticGreen,
    mergeQueueDetectFn: () => ({ status: "queue", branch: "master" }) as const,
    nowFn: () => new Date(SINCE),
    ...overrides,
  };
}

describe("waitMergeableAndMerge in queue mode (#6295 items 4, 5, 9)", () => {
  it("enqueues without --admin, skips the stale-base and master-gate waits, reports queued", () => {
    const mergeFn = recordingMerge();
    const reconciled: string[] = [];
    const result = waitMergeableAndMerge(5, REPO, {
      ...queueBase(),
      mergeFn,
      queueReadFn: reads(
        graphqlResponse({ headRefOid: HEAD, entry: { state: "AWAITING_CHECKS", position: 1 } }),
      ),
      umbrellaReconcileFn: (_root, repo) => reconciled.push(repo),
    });
    expect(mergeFn.calls).toEqual([[5, REPO, { matchHeadCommit: HEAD, queueMode: true }]]);
    expect(result.outcome).toBe("queued");
    expect(result.exitCode).toBe(EXIT_QUEUE_PENDING);
    expect(result.mergeQueue?.resume_command).toContain(`--expect-head ${HEAD} --since ${SINCE}`);
    expect(result.error).toContain("Resume:");
    expect(reconciled).toEqual([]);
  });

  it("merged on the first read runs reconciliation once", () => {
    const reconciled: string[] = [];
    const result = waitMergeableAndMerge(5, REPO, {
      ...queueBase(),
      mergeFn: recordingMerge(),
      queueReadFn: reads(
        graphqlResponse({ headRefOid: HEAD, merged: true, mergeCommit: GROUP_COMMIT }),
      ),
      umbrellaReconcileFn: (_root, repo) => reconciled.push(repo),
    });
    expect(result.outcome).toBe("merged");
    expect(result.exitCode).toBe(EXIT_MERGED);
    expect(result.mergeQueue?.merge_commit_sha).toBe(GROUP_COMMIT);
    expect(result.error).toBeNull();
    expect(reconciled).toEqual([REPO]);
  });

  it("enqueue failure is reported without an --admin retry", () => {
    const mergeFn = recordingMerge(1, "Auto merge is not allowed for this repository");
    const result = waitMergeableAndMerge(5, REPO, {
      ...queueBase(),
      mergeFn,
      queueReadFn: () => {
        throw new Error("must not read after a failed enqueue");
      },
    });
    expect(result.outcome).toBe("enqueue-failed");
    expect(result.exitCode).toBe(EXIT_TIMEOUT_OR_ESCALATION);
    expect(result.error).toContain("No --admin fallback");
    expect(mergeFn.calls).toHaveLength(1);
  });

  it("an OS-layer enqueue failure is a config error", () => {
    const result = waitMergeableAndMerge(5, REPO, {
      ...queueBase(),
      mergeFn: recordingMerge(-1),
    });
    expect(result.outcome).toBe("config-error");
    expect(result.exitCode).toBe(EXIT_CONFIG_ERROR);
  });

  it("a queue detection error fails closed before any merge call", () => {
    const mergeFn = recordingMerge();
    const result = waitMergeableAndMerge(5, REPO, {
      ...queueBase({ mergeQueueDetectFn: () => ({ status: "error", message: "HTTP 502" }) }),
      mergeFn,
    });
    expect(result.outcome).toBe("merge-queue-detect-failed");
    expect(result.exitCode).toBe(EXIT_CONFIG_ERROR);
    expect(result.error).toContain("never falls back to --admin");
    expect(mergeFn.calls).toEqual([]);
  });

  it("refuses to enqueue an unpinned head", () => {
    const mergeFn = recordingMerge();
    const result = waitMergeableAndMerge(5, REPO, {
      ...queueBase({
        fetchPrHeadShaFn: () => null,
        monitorFn: () => [0, '{"monitor_result":"CLEAN"}', ""],
      }),
      mergeFn,
    });
    expect(result.outcome).toBe("config-error");
    expect(mergeFn.calls).toEqual([]);
  });

  it("a rate-limited read returns the resume command, exit 2", () => {
    const result = waitMergeableAndMerge(5, REPO, {
      ...queueBase(),
      mergeFn: recordingMerge(),
      queueReadFn: () => ({ status: "rate-limited", message: "GraphQL bucket has 12 points left" }),
    });
    expect(result.outcome).toBe("queue-read-unavailable");
    expect(result.exitCode).toBe(EXIT_CONFIG_ERROR);
    expect(result.error).toContain("--resume --expect-head");
  });

  it("no-queue repositories keep today's path: semantic-green runs and merge is direct", () => {
    const mergeFn = recordingMerge();
    let semanticCalls = 0;
    const result = waitMergeableAndMerge(5, REPO, {
      ...queueBase({
        mergeQueueDetectFn: () => ({ status: "none", branch: "master" }) as const,
        semanticGreenFn: (() => {
          semanticCalls += 1;
          return { ok: true, outcome: null, exitCode: null, error: null, payload: {} };
        }) as unknown as SemanticGreenFn,
      }),
      mergeFn,
      umbrellaReconcileFn: null,
    });
    expect(result.outcome).toBe("merged");
    expect(semanticCalls).toBe(2);
    expect(mergeFn.calls).toEqual([[5, REPO, { matchHeadCommit: HEAD }]]);
  });
});

describe("--resume (#6295 item 4)", () => {
  it("merged runs reconciliation, and a second resume does not break it", () => {
    const reconciled: string[] = [];
    const readFn = reads(
      graphqlResponse({ headRefOid: HEAD, merged: true, mergeCommit: GROUP_COMMIT }),
    );
    const opts = {
      expectHead: HEAD,
      since: SINCE,
      projectRoot: "/tmp/p",
      queueReadFn: readFn,
      umbrellaReconcileFn: (_root: string, repo: string) => {
        reconciled.push(repo);
      },
    };
    const first = resumeMergeQueueRead(5, REPO, opts);
    const second = resumeMergeQueueRead(5, REPO, opts);
    expect(first.outcome).toBe("merged");
    expect(second.outcome).toBe("merged");
    expect(second.exitCode).toBe(EXIT_MERGED);
    expect(reconciled).toEqual([REPO, REPO]);
  });

  it("head-changed carries the merge commit and runs no reconciliation", () => {
    const reconciled: string[] = [];
    const result = resumeMergeQueueRead(5, REPO, {
      expectHead: HEAD,
      since: SINCE,
      queueReadFn: reads(
        graphqlResponse({ headRefOid: NEW_HEAD, merged: true, mergeCommit: GROUP_COMMIT }),
      ),
      umbrellaReconcileFn: (_root, repo) => {
        reconciled.push(repo);
      },
    });
    expect(result.outcome).toBe("head-changed");
    expect(result.exitCode).toBe(EXIT_TIMEOUT_OR_ESCALATION);
    expect(result.mergeQueue?.merge_commit_sha).toBe(GROUP_COMMIT);
    expect(reconciled).toEqual([]);
  });

  it("reports removed with its reason and inactive with the disabled reason code", () => {
    const removedResult = resumeMergeQueueRead(5, REPO, {
      expectHead: HEAD,
      since: SINCE,
      queueReadFn: reads(
        graphqlResponse({ headRefOid: HEAD, nodes: [removed(AFTER2, "checks_timed_out")] }),
      ),
      umbrellaReconcileFn: null,
    });
    expect(removedResult.outcome).toBe("removed");
    expect(removedResult.error).toContain("reason=checks_timed_out");
    const emptyReason = resumeMergeQueueRead(5, REPO, {
      expectHead: HEAD,
      since: SINCE,
      queueReadFn: reads(graphqlResponse({ headRefOid: HEAD, nodes: [removed(AFTER2, null)] })),
      umbrellaReconcileFn: null,
    });
    expect(emptyReason.error).toContain("reason=(none given)");
    const inactive = resumeMergeQueueRead(5, REPO, {
      expectHead: HEAD,
      since: SINCE,
      queueReadFn: reads(
        graphqlResponse({ headRefOid: HEAD, nodes: [disabled(AFTER1, "manually_disabled")] }),
      ),
      umbrellaReconcileFn: null,
    });
    expect(inactive.outcome).toBe("inactive");
    expect(inactive.error).toContain("auto-merge disabled: manually_disabled");
    const awaiting = resumeMergeQueueRead(5, REPO, {
      expectHead: HEAD,
      since: SINCE,
      queueReadFn: reads(graphqlResponse({ headRefOid: HEAD, autoMerge: true })),
    });
    expect(awaiting.outcome).toBe("awaiting-admission");
    expect(awaiting.exitCode).toBe(EXIT_QUEUE_PENDING);
  });
});
