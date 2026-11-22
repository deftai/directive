import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunGhFn } from "../pr-merge-readiness/types.js";
import type { WaitMergeableResult } from "../pr-wait-mergeable/types.js";
import { EXIT_OK, EXIT_VIOLATION } from "./constants.js";
import {
  failedCheckName,
  isFailedCheckRemoval,
  type MergeWatchOutcome,
  type PreviousEnqueue,
  previousEnqueueOf,
  type QueueOutcome,
  queueOutcomeOf,
  type ReleaseMergeSeams,
  readMergeQueueEntries,
  readOriginTip,
  rerunFailedRequiredChecks,
  runMergePhase,
} from "./run-merge.js";
import {
  newReleaseRunRecord,
  type ReleaseRunRecord,
  readReleaseRunRecord,
  writeReleaseRunRecord,
} from "./run-record.js";

const V = "1.2.0";
const B = "b".repeat(40);
const OTHER = "e".repeat(40);
const HEAD = "h".repeat(40);
const NOW = new Date("2026-11-22T02:00:00Z");
const PR = 77;

function baseRecord(): ReleaseRunRecord {
  return {
    ...newReleaseRunRecord({
      version: V,
      repo: "o/r",
      baseBranch: "master",
      expires: "2026-11-22T06:00:00Z",
      promoteLatest: false,
      summary: null,
      ciReuseAtReadiness: null,
      now: NOW,
    }),
    cutBase: B,
    pr: PR,
  };
}

const clean: MergeWatchOutcome = { verdict: "CLEAN", headSha: HEAD, failedChecks: [] };
const blocked: MergeWatchOutcome = {
  verdict: "CI_BLOCKED",
  headSha: HEAD,
  failedChecks: ["Merge gate (task check) (failure)"],
};

interface Run {
  readonly code: number;
  readonly calls: string[];
  readonly lines: string[];
  readonly record: ReleaseRunRecord;
}

/** Drive the merge phase with scripted watch verdicts and queue outcomes. */
function drive(
  opts: {
    record?: ReleaseRunRecord;
    watches?: MergeWatchOutcome[];
    tip?: string;
    queue?: number[];
    outcomes?: QueueOutcome[];
    previous?: PreviousEnqueue[];
    tips?: string[];
    rerunOk?: boolean;
    root?: string;
  } = {},
): Run {
  let record = opts.record ?? baseRecord();
  const calls: string[] = [];
  const lines: string[] = [];
  const watches = [...(opts.watches ?? [clean])];
  const outcomes = [...(opts.outcomes ?? [{ kind: "merged" } as QueueOutcome])];
  const previous = [...(opts.previous ?? [])];
  const tips = [...(opts.tips ?? [])];
  const seams: ReleaseMergeSeams = {
    watch: () => {
      calls.push("pr:watch");
      return watches.shift() ?? clean;
    },
    readTip: () => {
      calls.push("read tip");
      return { ok: true, sha: tips.shift() ?? opts.tip ?? B };
    },
    readQueue: () => {
      calls.push("read queue");
      const prs = opts.queue ?? [];
      return { ok: true, prs, total: prs.length };
    },
    rerunFailedChecks: (_r, sha, failed) => {
      calls.push(`rerun ${sha.slice(0, 4)} ${failed.join(",")}`);
      return opts.rerunOk === false ? { ok: false, reason: "no run" } : { ok: true, runIds: ["9"] };
    },
    enqueueAndWait: (_p, _r, _root, beforeEnqueue) => {
      calls.push("pr:wait-mergeable-and-merge --wait");
      // The engine calls the boundary reads right before its enqueue.
      const refused = beforeEnqueue(HEAD);
      if (refused !== null) return { kind: "other", detail: `enqueue-failed: ${refused}` };
      return outcomes.shift() ?? { kind: "merged" };
    },
    readPrevious: (_p, _r, _root, head, since) => {
      calls.push(`read previous ${head.slice(0, 4)} ${since}`);
      return previous.shift() ?? { kind: "never-enqueued" };
    },
    waitQueued: (_p, _r, _root, head, since) => {
      calls.push(`wait queued ${head.slice(0, 4)} ${since}`);
      return outcomes.shift() ?? { kind: "merged" };
    },
  };
  const code = runMergePhase(
    {
      projectRoot: opts.root ?? "/p",
      record: () => record,
      save: (patch) => {
        record = { ...record, ...patch };
        if (opts.root !== undefined) writeReleaseRunRecord(opts.root, record);
      },
      line: (s) => lines.push(s),
      now: () => NOW,
    },
    seams,
  );
  return { code, calls, lines, record };
}

describe("release:run merge phase (#6877)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("clause 2: waits with `pr:watch` until CLEAN, then runs `pr:wait-mergeable-and-merge --wait`", () => {
    const run = drive();
    expect(run.code).toBe(EXIT_OK);
    expect(run.calls).toEqual([
      "pr:watch",
      "read tip",
      "read queue",
      "pr:wait-mergeable-and-merge --wait",
      "read tip",
      "read queue",
    ]);
    expect(run.record.enqueue).toEqual({ head: HEAD, since: NOW.toISOString() });
    expect(run.lines.at(-1)).toContain("merged");
  });

  it("clause 2: a review finding on the release PR stops the run before any enqueue", () => {
    const run = drive({ watches: [{ verdict: "NEW_P0_P1", headSha: HEAD, failedChecks: [] }] });
    expect(run.code).toBe(EXIT_VIOLATION);
    expect(run.calls).toEqual(["pr:watch"]);
    expect(run.lines.at(-1)).toContain("review finding");
  });

  it("clause 2: any other pr:watch verdict stops and names --resume", () => {
    const run = drive({ watches: [{ verdict: "TIMEOUT", headSha: HEAD, failedChecks: [] }] });
    expect(run.code).toBe(EXIT_VIOLATION);
    expect(run.lines.at(-1)).toContain("--resume");
  });

  it("an already merged release PR is done without an enqueue", () => {
    const run = drive({ watches: [{ verdict: "MERGED", headSha: HEAD, failedChecks: [] }] });
    expect(run.code).toBe(EXIT_OK);
    expect(run.calls).toEqual(["pr:watch"]);
  });

  it("clause 3: given an origin tip that is not B, it does not enqueue and stops", () => {
    const run = drive({ tip: OTHER });
    expect(run.code).toBe(EXIT_VIOLATION);
    expect(run.calls).not.toContain("pr:wait-mergeable-and-merge --wait");
    expect(run.lines.at(-1)).toContain("not the cut base");
    expect(run.lines.at(-1)).toContain("not enqueued");
  });

  it("clause 3: given a non-empty merge queue, it does not enqueue and stops", () => {
    const run = drive({ queue: [12, 13] });
    expect(run.code).toBe(EXIT_VIOLATION);
    expect(run.calls).not.toContain("pr:wait-mergeable-and-merge --wait");
    expect(run.lines.at(-1)).toContain("#12, #13");
  });

  it("clause 1: unreadable tip or queue means no enqueue", () => {
    for (const seam of ["readTip", "readQueue"] as const) {
      let record = baseRecord();
      const calls: string[] = [];
      const code = runMergePhase(
        {
          projectRoot: "/p",
          record: () => record,
          save: (patch) => {
            record = { ...record, ...patch };
          },
          line: () => {},
          now: () => NOW,
        },
        {
          watch: () => clean,
          readTip: () =>
            seam === "readTip" ? { ok: false, reason: "down" } : { ok: true, sha: B },
          readQueue: () => ({ ok: false, reason: "down" }),
          enqueueAndWait: () => {
            calls.push("enqueue");
            return { kind: "merged" };
          },
        },
      );
      expect(code).toBe(EXIT_VIOLATION);
      expect(calls).toEqual([]);
    }
  });

  it("clause 1: after an ejection for a failed check it re-enqueues only under the same reads", () => {
    const run = drive({
      outcomes: [{ kind: "ejected", reason: "FAILED_CHECKS" }, { kind: "merged" }],
    });
    expect(run.code).toBe(EXIT_OK);
    expect(run.calls).toEqual([
      "pr:watch",
      "read tip",
      "read queue",
      "pr:wait-mergeable-and-merge --wait",
      "read tip",
      "read queue",
      "pr:watch",
      "read tip",
      "read queue",
      "pr:wait-mergeable-and-merge --wait",
      "read tip",
      "read queue",
    ]);
    expect(run.record.retries.failedCheck).toBe(1);
  });

  it("clause 1: after an ejection a moved tip stops the re-enqueue", () => {
    let tipReads = 0;
    let record = baseRecord();
    const calls: string[] = [];
    const code = runMergePhase(
      {
        projectRoot: "/p",
        record: () => record,
        save: (patch) => {
          record = { ...record, ...patch };
        },
        line: () => {},
        now: () => NOW,
      },
      {
        watch: () => clean,
        readTip: () => {
          tipReads += 1;
          // Early and boundary reads of the first pass see B; the re-enqueue sees a moved tip.
          return { ok: true, sha: tipReads <= 2 ? B : OTHER };
        },
        readQueue: () => ({ ok: true, prs: [], total: 0 }),
        enqueueAndWait: (_p, _r, _root, beforeEnqueue) => {
          const refused = beforeEnqueue(HEAD);
          calls.push(refused === null ? "enqueue" : "refused");
          return refused === null
            ? { kind: "ejected", reason: "failed checks" }
            : { kind: "other", detail: refused };
        },
      },
    );
    expect(code).toBe(EXIT_VIOLATION);
    expect(calls).toEqual(["enqueue"]);
  });

  it("an ejection that is not a failed check (a conflict) stops without a re-run", () => {
    const run = drive({ outcomes: [{ kind: "ejected", reason: "merge conflict" }] });
    expect(run.code).toBe(EXIT_VIOLATION);
    expect(run.record.retries.failedCheck).toBe(0);
  });

  it("waits on the release PR when an earlier pass already enqueued it", () => {
    const record = { ...baseRecord(), enqueue: { head: HEAD, since: "2026-11-22T01:59:00Z" } };
    const run = drive({ record, queue: [PR], previous: [{ kind: "queued" }] });
    expect(run.code).toBe(EXIT_OK);
    expect(run.calls.slice(-2)).toEqual([
      "read previous hhhh 2026-11-22T01:59:00Z",
      "wait queued hhhh 2026-11-22T01:59:00Z",
    ]);
    expect(run.calls).not.toContain("pr:wait-mergeable-and-merge --wait");
  });

  it("clause 1: the reads run again at the enqueue call; a tip that moved meanwhile is not enqueued", () => {
    const run = drive({ tips: [B, OTHER] });
    expect(run.code).toBe(EXIT_VIOLATION);
    expect(run.record.enqueue).toBeNull();
    expect(run.lines.at(-1)).toContain("not the cut base");
  });

  it("clause 1: a PR queued during the engine's wait stops the enqueue at the boundary", () => {
    let queueReads = 0;
    let record = baseRecord();
    const code = runMergePhase(
      {
        projectRoot: "/p",
        record: () => record,
        save: (patch) => {
          record = { ...record, ...patch };
        },
        line: () => {},
        now: () => NOW,
      },
      {
        watch: () => clean,
        readTip: () => ({ ok: true, sha: B }),
        readQueue: () => {
          queueReads += 1;
          return queueReads === 1
            ? { ok: true, prs: [], total: 0 }
            : { ok: true, prs: [41], total: 1 };
        },
        enqueueAndWait: (_p, _r, _root, beforeEnqueue) => {
          const refused = beforeEnqueue(HEAD);
          return refused === null ? { kind: "merged" } : { kind: "other", detail: refused };
        },
      },
    );
    expect(code).toBe(EXIT_VIOLATION);
    expect(record.enqueue).toBeNull();
  });

  it("on --resume a recorded enqueue that merged is done", () => {
    const record = { ...baseRecord(), enqueue: { head: HEAD, since: "2026-11-22T01:59:00Z" } };
    const run = drive({ record, previous: [{ kind: "merged" }] });
    expect(run.code).toBe(EXIT_OK);
    expect(run.calls).not.toContain("pr:wait-mergeable-and-merge --wait");
  });

  it("on --resume a recorded enqueue removed by hand stops without a new enqueue", () => {
    const record = { ...baseRecord(), enqueue: { head: HEAD, since: "2026-11-22T01:59:00Z" } };
    const run = drive({ record, previous: [{ kind: "ejected", reason: "MANUAL" }] });
    expect(run.code).toBe(EXIT_VIOLATION);
    expect(run.calls).not.toContain("pr:wait-mergeable-and-merge --wait");
    expect(run.record.retries.failedCheck).toBe(0);
  });

  it("clause 6: on --resume a failed-check ejection during the gap uses the run's one re-run", () => {
    const record = { ...baseRecord(), enqueue: { head: HEAD, since: "2026-11-22T01:59:00Z" } };
    const run = drive({ record, previous: [{ kind: "ejected", reason: "FAILED_CHECKS" }] });
    expect(run.code).toBe(EXIT_OK);
    expect(run.record.retries.failedCheck).toBe(1);
    expect(run.calls.filter((c) => c === "pr:wait-mergeable-and-merge --wait")).toHaveLength(1);
    const spent = drive({
      record: { ...record, retries: { failedCheck: 1 } },
      previous: [{ kind: "ejected", reason: "FAILED_CHECKS" }],
    });
    expect(spent.code).toBe(EXIT_VIOLATION);
    expect(spent.calls).not.toContain("pr:wait-mergeable-and-merge --wait");
  });

  it("on --resume a recorded enqueue that never entered the queue is enqueued again", () => {
    const record = { ...baseRecord(), enqueue: { head: HEAD, since: "2026-11-22T01:59:00Z" } };
    const run = drive({ record, previous: [{ kind: "never-enqueued" }] });
    expect(run.code).toBe(EXIT_OK);
    expect(run.calls).toContain("pr:wait-mergeable-and-merge --wait");
    expect(run.record.enqueue).toEqual({ head: HEAD, since: NOW.toISOString() });
  });

  it("on --resume an unreadable recorded enqueue stops", () => {
    const record = { ...baseRecord(), enqueue: { head: HEAD, since: "2026-11-22T01:59:00Z" } };
    const run = drive({ record, previous: [{ kind: "other", detail: "queue-read-unavailable" }] });
    expect(run.code).toBe(EXIT_VIOLATION);
    expect(run.calls).not.toContain("pr:wait-mergeable-and-merge --wait");
  });

  it("stops when the release PR is queued but the run recorded no enqueue", () => {
    const run = drive({ queue: [PR] });
    expect(run.code).toBe(EXIT_VIOLATION);
    expect(run.lines.at(-1)).toContain("recorded no enqueue");
  });

  it("clause 6: a required check that fails once is re-run once", () => {
    const run = drive({ watches: [blocked, clean] });
    expect(run.code).toBe(EXIT_OK);
    expect(run.calls.slice(0, 3)).toEqual([
      "pr:watch",
      "rerun hhhh Merge gate (task check) (failure)",
      "pr:watch",
    ]);
    expect(run.record.retries.failedCheck).toBe(1);
  });

  it("clause 6: a second failure stops the run without another re-run", () => {
    const run = drive({ watches: [blocked, blocked] });
    expect(run.code).toBe(EXIT_VIOLATION);
    expect(run.calls.filter((c) => c.startsWith("rerun"))).toHaveLength(1);
    expect(run.lines.at(-1)).toContain("without another re-run");
  });

  it("clause 6: a failed check after an ejection re-run is the second failure", () => {
    const run = drive({
      watches: [clean, blocked],
      outcomes: [{ kind: "ejected", reason: "failed checks" }],
    });
    expect(run.code).toBe(EXIT_VIOLATION);
    expect(run.calls.filter((c) => c.startsWith("rerun"))).toHaveLength(0);
  });

  it("clause 6: the count is in the run record, and after `--resume` a second failure stops", () => {
    const root = mkdtempSync(join(tmpdir(), "w6877-merge-"));
    dirs.push(root);
    writeReleaseRunRecord(root, baseRecord());
    const first = drive({
      root,
      watches: [blocked, { verdict: "TIMEOUT", headSha: HEAD, failedChecks: [] }],
    });
    expect(first.code).toBe(EXIT_VIOLATION);
    const saved = readReleaseRunRecord(root, V);
    expect(saved.kind).toBe("ok");
    if (saved.kind !== "ok") return;
    expect(saved.record.retries.failedCheck).toBe(1);
    // --resume reads the record back; the count is not reset.
    const resumed = drive({ root, record: saved.record, watches: [blocked] });
    expect(resumed.code).toBe(EXIT_VIOLATION);
    expect(resumed.calls).toEqual(["pr:watch"]);
    expect(resumed.lines.at(-1)).toContain("re-runs used: 1");
  });

  it("stops when the failed check cannot be re-run, with the re-run spent", () => {
    const run = drive({ watches: [blocked], rerunOk: false });
    expect(run.code).toBe(EXIT_VIOLATION);
    expect(run.record.retries.failedCheck).toBe(1);
  });

  it("stops when the run record has no PR number", () => {
    const run = drive({ record: { ...baseRecord(), pr: null } });
    expect(run.code).toBe(EXIT_VIOLATION);
    expect(run.calls).toEqual([]);
  });
});

describe("merge phase helpers (#6877)", () => {
  const gh = (answers: Record<string, { returncode: number; stdout: string; stderr?: string }>) => {
    const calls: string[][] = [];
    const fn: RunGhFn = (cmd) => {
      calls.push([...cmd]);
      for (const [key, value] of Object.entries(answers)) {
        if (cmd.join(" ").includes(key)) return { stderr: "", ...value };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
    return { fn, calls };
  };

  it("names a failed check and classifies queue removals", () => {
    expect(failedCheckName("Merge gate (task check) (failure)")).toBe("Merge gate (task check)");
    expect(isFailedCheckRemoval("FAILED_CHECKS")).toBe(true);
    expect(isFailedCheckRemoval("checks_timed_out")).toBe(true);
    expect(isFailedCheckRemoval("CI failed")).toBe(true);
    expect(isFailedCheckRemoval("MERGE_CONFLICT")).toBe(false);
    expect(isFailedCheckRemoval("manually removed")).toBe(false);
    expect(isFailedCheckRemoval("")).toBe(false);
  });

  it("maps wait-mergeable results to merged, ejected and other", () => {
    const base = {
      prNumber: PR,
      repo: "o/r",
      monitorResult: {},
      protectedCheck: {},
      semanticGreen: {},
      mergeStdout: "",
      mergeStderr: "",
      error: null,
    };
    const result = (r: Partial<WaitMergeableResult>): WaitMergeableResult =>
      ({ ...base, outcome: "x", exitCode: 1, ...r }) as WaitMergeableResult;
    expect(queueOutcomeOf(result({ exitCode: 0, outcome: "merged" }))).toEqual({ kind: "merged" });
    expect(
      queueOutcomeOf(
        result({ mergeQueue: { result: "removed", removal_reason: "failed checks" } }),
      ),
    ).toEqual({ kind: "ejected", reason: "failed checks" });
    expect(queueOutcomeOf(result({ outcome: "queued", error: "cap" }))).toEqual({
      kind: "other",
      detail: "queued: cap",
    });
    expect(previousEnqueueOf(result({ exitCode: 0, outcome: "merged" }))).toEqual({
      kind: "merged",
    });
    expect(previousEnqueueOf(result({ outcome: "queued" }))).toEqual({ kind: "queued" });
    expect(previousEnqueueOf(result({ outcome: "awaiting-admission" }))).toEqual({
      kind: "queued",
    });
    expect(previousEnqueueOf(result({ outcome: "inactive" }))).toEqual({ kind: "never-enqueued" });
    expect(
      previousEnqueueOf(
        result({ outcome: "removed", mergeQueue: { result: "removed", removal_reason: "x" } }),
      ),
    ).toEqual({ kind: "ejected", reason: "x" });
    expect(previousEnqueueOf(result({ outcome: "head-changed" })).kind).toBe("other");
  });

  it("reads the live origin tip with git ls-remote", () => {
    const seams = {
      spawnText: (_c: string, a: readonly string[]) => ({
        status: 0,
        stdout: a.includes("ls-remote") ? `${B}\trefs/heads/master\n` : "",
        stderr: "",
      }),
    };
    expect(readOriginTip("master", "/p", seams)).toEqual({ ok: true, sha: B });
    expect(
      readOriginTip("master", "/p", { spawnText: () => ({ status: 0, stdout: "", stderr: "" }) })
        .ok,
    ).toBe(false);
    expect(
      readOriginTip("master", "/p", { spawnText: () => ({ status: 2, stdout: "", stderr: "x" }) })
        .ok,
    ).toBe(false);
  });

  it("reads the merge queue entries after the rate-limit probe", () => {
    const rate = {
      returncode: 0,
      stdout: JSON.stringify({ resources: { graphql: { remaining: 4000 } } }),
    };
    const entries = (nodes: unknown[]) => ({
      returncode: 0,
      stdout: JSON.stringify({
        data: { repository: { mergeQueue: { entries: { totalCount: nodes.length, nodes } } } },
      }),
    });
    const empty = gh({ rate_limit: rate, graphql: entries([]) });
    expect(readMergeQueueEntries("o/r", "master", empty.fn)).toEqual({
      ok: true,
      prs: [],
      total: 0,
    });
    const busy = gh({ rate_limit: rate, graphql: entries([{ pullRequest: { number: 5 } }]) });
    expect(readMergeQueueEntries("o/r", "master", busy.fn)).toEqual({
      ok: true,
      prs: [5],
      total: 1,
    });
    const noQueue = gh({
      rate_limit: rate,
      graphql: {
        returncode: 0,
        stdout: JSON.stringify({ data: { repository: { mergeQueue: null } } }),
      },
    });
    expect(readMergeQueueEntries("o/r", "master", noQueue.fn)).toEqual({
      ok: true,
      prs: [],
      total: 0,
    });
    const low = gh({
      rate_limit: {
        returncode: 0,
        stdout: JSON.stringify({ resources: { graphql: { remaining: 3 } } }),
      },
    });
    expect(readMergeQueueEntries("o/r", "master", low.fn).ok).toBe(false);
    expect(low.calls.some((c) => c.includes("graphql"))).toBe(false);
    expect(readMergeQueueEntries("bad", "master", empty.fn).ok).toBe(false);
    const broken = gh({ rate_limit: rate, graphql: { returncode: 0, stdout: "nope" } });
    expect(readMergeQueueEntries("o/r", "master", broken.fn).ok).toBe(false);
  });

  it("re-runs the Actions runs behind the failed required checks", () => {
    const runs = {
      returncode: 0,
      stdout: JSON.stringify({
        check_runs: [
          {
            name: "Merge gate (task check)",
            details_url: "https://github.com/o/r/actions/runs/123/job/9",
          },
          { name: "Other", details_url: "https://github.com/o/r/actions/runs/456/job/1" },
        ],
      }),
    };
    const live = gh({ "check-runs": runs, "run rerun": { returncode: 0, stdout: "" } });
    expect(
      rerunFailedRequiredChecks("o/r", HEAD, ["Merge gate (task check) (failure)"], live.fn),
    ).toEqual({ ok: true, runIds: ["123"] });
    expect(live.calls.at(-1)).toEqual(["gh", "run", "rerun", "123", "--failed", "--repo", "o/r"]);
    expect(rerunFailedRequiredChecks("o/r", HEAD, ["Missing (failure)"], live.fn).ok).toBe(false);
    expect(rerunFailedRequiredChecks("o/r", HEAD, [], live.fn).ok).toBe(false);
    const refused = gh({
      "check-runs": runs,
      "run rerun": { returncode: 1, stdout: "", stderr: "no" },
    });
    expect(
      rerunFailedRequiredChecks("o/r", HEAD, ["Merge gate (task check) (failure)"], refused.fn).ok,
    ).toBe(false);
  });
});
