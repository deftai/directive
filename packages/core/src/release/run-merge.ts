/**
 * The merge phase of `deft release:run` (#6877, S4 of #6845; bound lean
 * 7032154033 items 7 and 8).
 *
 * Built-in waits: the run waits on the release PR in-process with the
 * `pr:watch` engine until CLEAN, then runs the `pr:wait-mergeable-and-merge
 * --wait` engine, which enqueues the PR and waits on the queue.
 *
 * Enqueue reads, no hold: before every enqueue the run reads the origin tip
 * (it must still be the cut base B) and the merge queue (it must be empty).
 * Otherwise it stops without enqueueing. The reads run once before the merge
 * engine starts and again at its enqueue call, after the engine's own waits
 * and gates, so the enqueue never rests on an old read. They do not hold
 * other merges; a PR that still lands first is caught by the finish step,
 * which refuses unless the sole parent of M is B (#6875). An enqueue the run
 * recorded is read back before any new one: merged is done, still queued is
 * waited on, a removal is judged like an ejection, and only a PR that never
 * entered the queue is enqueued again.
 *
 * One re-run per run: a failed required check (pr:watch CI_BLOCKED) or a queue
 * ejection for a failed check uses the run's single re-run, kept in the run
 * record so `--resume` never resets it. A failed check is re-run with
 * `gh run rerun --failed`; an ejection is re-enqueued under the same reads. A
 * second failure or a review finding (NEW_P0_P1) stops the run.
 */
import { defaultRunGh } from "../pr-merge-readiness/gh.js";
import type { RunGhFn } from "../pr-merge-readiness/types.js";
import { resumeMergeQueueRead, waitMergeableAndMerge } from "../pr-wait-mergeable/cascade.js";
import { parseWaitMergeableArgs } from "../pr-wait-mergeable/main.js";
import {
  MERGE_QUEUE_GRAPHQL_FLOOR,
  probeGraphqlRemaining,
} from "../pr-wait-mergeable/merge-queue.js";
import type { WaitMergeableResult } from "../pr-wait-mergeable/types.js";
import { runGhMerge } from "../pr-wait-mergeable/wrappers.js";
import {
  VERDICT_CI_BLOCKED,
  VERDICT_CLEAN,
  VERDICT_MERGED,
  VERDICT_NEW_P0_P1,
} from "../pr-watch/constants.js";
import {
  reportWaitHeartbeatWrite,
  startWaitHeartbeatRefresher,
  WAIT_HEARTBEAT_REFRESH_SECONDS,
  writePrWatchWaitHeartbeat,
} from "../pr-watch/main.js";
import { watch } from "../pr-watch/watch.js";
import { EXIT_OK, EXIT_VIOLATION } from "./constants.js";
import { runGit } from "./git.js";
import type { ReleaseRunRecord } from "./run-record.js";
import type { ReleaseSeams } from "./types.js";

/** What the merge phase needs from one `pr:watch` wait. */
export interface MergeWatchOutcome {
  readonly verdict: string;
  readonly headSha: string | null;
  /** Failed required checks, as `name (conclusion)`. */
  readonly failedChecks: readonly string[];
}

export type ReadResult<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly reason: string };

/** The result of an enqueue-and-wait, or of a wait on a PR already queued. */
export type QueueOutcome =
  | { readonly kind: "merged" }
  | { readonly kind: "ejected"; readonly reason: string }
  | { readonly kind: "other"; readonly detail: string };

/** One read of an enqueue the run recorded earlier (its head and time). */
export type PreviousEnqueue =
  | QueueOutcome
  | { readonly kind: "queued" }
  | { readonly kind: "never-enqueued" };

/**
 * Called by the merge engine right before it enqueues, with the head it pins.
 * Returns null when the enqueue may go ahead, else the reason it may not.
 */
export type BeforeEnqueue = (head: string | null) => string | null;

export interface ReleaseMergeSeams {
  readonly watch?: (pr: number, repo: string, projectRoot: string) => MergeWatchOutcome;
  readonly readTip?: (
    repo: string,
    baseBranch: string,
    projectRoot: string,
  ) => ReadResult<{ readonly sha: string }>;
  readonly readQueue?: (
    repo: string,
    baseBranch: string,
  ) => ReadResult<{ readonly prs: readonly number[]; readonly total: number }>;
  readonly rerunFailedChecks?: (
    repo: string,
    headSha: string,
    failedChecks: readonly string[],
  ) => ReadResult<{ readonly runIds: readonly string[] }>;
  readonly enqueueAndWait?: (
    pr: number,
    repo: string,
    projectRoot: string,
    beforeEnqueue: BeforeEnqueue,
  ) => QueueOutcome;
  readonly readPrevious?: (
    pr: number,
    repo: string,
    projectRoot: string,
    expectHead: string,
    since: string,
  ) => PreviousEnqueue;
  readonly waitQueued?: (
    pr: number,
    repo: string,
    projectRoot: string,
    expectHead: string,
    since: string,
  ) => QueueOutcome;
  readonly release?: ReleaseSeams;
  readonly runGh?: RunGhFn;
}

export interface MergePhaseContext {
  readonly projectRoot: string;
  readonly record: () => ReleaseRunRecord;
  readonly save: (patch: Partial<ReleaseRunRecord>) => void;
  readonly line: (status: string) => void;
  readonly now: () => Date;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The check name of a `name (conclusion)` entry. */
export function failedCheckName(entry: string): string {
  return entry.replace(/\s*\([^()]*\)\s*$/, "").trim();
}

/**
 * A queue removal GitHub attributes to checks (failed, errored or timed out).
 * A conflict, a manual removal or no reason is not a failed check.
 */
export function isFailedCheckRemoval(reason: string): boolean {
  const r = reason.toLowerCase();
  if (r.includes("conflict")) return false;
  return /fail|error|check|timed[\s_-]?out|\bci\b/.test(r);
}

/** Map a wait-mergeable result onto merged / ejected / other. */
export function queueOutcomeOf(result: WaitMergeableResult): QueueOutcome {
  if (result.exitCode === EXIT_OK) return { kind: "merged" };
  const queue = asRecord(result.mergeQueue);
  if (queue?.result === "removed") {
    const reason = typeof queue.removal_reason === "string" ? queue.removal_reason : "";
    return { kind: "ejected", reason };
  }
  const detail = [result.outcome, result.error ?? ""].filter((p) => p.length > 0).join(": ");
  return { kind: "other", detail: detail.length > 0 ? detail : `exit ${String(result.exitCode)}` };
}

/**
 * Keep the PR's wait heartbeat live around an in-process wait, as the
 * `pr:watch` and `pr:wait-mergeable-and-merge` CLIs do around theirs, so
 * review-monitor reads see the release PR's wait as armed; terminal on exit.
 */
function withWaitHeartbeat<T>(projectRoot: string, pr: number, wait: string, fn: () => T): T {
  const parentId = "release-run";
  const sink = (text: string): void => {
    process.stderr.write(text.replace(/^pr_watch:/, "release_run:"));
  };
  reportWaitHeartbeatWrite(
    writePrWatchWaitHeartbeat(projectRoot, pr, {
      phase: "polling",
      parentId,
      lastMessage: `release:run ${wait} running`,
    }),
    sink,
  );
  const refresher = startWaitHeartbeatRefresher(projectRoot, pr, {
    parentId,
    lastMessage: `release:run ${wait} running`,
    intervalSeconds: WAIT_HEARTBEAT_REFRESH_SECONDS,
  });
  try {
    return fn();
  } finally {
    refresher.stop();
    reportWaitHeartbeatWrite(
      writePrWatchWaitHeartbeat(projectRoot, pr, {
        phase: "terminal",
        terminalState: "exited",
        parentId,
        lastMessage: `release:run ${wait} exited`,
      }),
      sink,
    );
  }
}

function defaultWatch(runGh: RunGhFn) {
  return (pr: number, repo: string, projectRoot: string): MergeWatchOutcome => {
    const result = withWaitHeartbeat(projectRoot, pr, "pr:watch", () =>
      watch(pr, repo, { projectRoot, runGh }),
    );
    return {
      verdict: result.verdict,
      headSha: result.probe.headSha,
      failedChecks: result.probe.ciFailedChecks,
    };
  };
}

/** The live origin tip of the delivery branch (`git ls-remote`, never the fetched ref). */
export function readOriginTip(
  baseBranch: string,
  projectRoot: string,
  seams: ReleaseSeams = {},
): ReadResult<{ readonly sha: string }> {
  const ref = `refs/heads/${baseBranch}`;
  const r = runGit(projectRoot, ["ls-remote", "origin", ref], seams);
  if (r.status !== 0)
    return { ok: false, reason: `git ls-remote origin ${ref}: ${r.stderr.trim()}` };
  for (const row of r.stdout.split(/\r?\n/)) {
    const [sha, name] = row.trim().split(/\s+/);
    if (name === ref && sha !== undefined && sha.length > 0) return { ok: true, sha };
  }
  return { ok: false, reason: `origin has no ${ref}` };
}

const QUEUE_ENTRIES_QUERY =
  "query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name)" +
  "{mergeQueue(branch:$branch){entries(first:100){totalCount nodes{pullRequest{number}}}}}}";

/** The merge-queue entries of the delivery branch (one GraphQL read, #954 floor first). */
export function readMergeQueueEntries(
  repo: string,
  baseBranch: string,
  runGh: RunGhFn,
): ReadResult<{ readonly prs: readonly number[]; readonly total: number }> {
  const [owner, name] = repo.split("/");
  if (owner === undefined || name === undefined || owner.length === 0 || name.length === 0) {
    return { ok: false, reason: `repo must be OWNER/NAME, got ${JSON.stringify(repo)}` };
  }
  const remaining = probeGraphqlRemaining(runGh);
  if (remaining !== null && remaining < MERGE_QUEUE_GRAPHQL_FLOOR) {
    return {
      ok: false,
      reason: `GraphQL bucket has ${String(remaining)} points left (below the #954 floor); queue not read`,
    };
  }
  const r = runGh([
    "gh",
    "api",
    "graphql",
    "-f",
    `query=${QUEUE_ENTRIES_QUERY}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-f",
    `branch=${baseBranch}`,
  ]);
  if (r.returncode !== 0)
    return { ok: false, reason: `merge queue read failed: ${r.stderr.trim()}` };
  let data: unknown;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    return { ok: false, reason: "merge queue read returned no JSON" };
  }
  const repository = asRecord(asRecord(asRecord(data)?.data)?.repository);
  if (repository === null) return { ok: false, reason: "merge queue read had no repository" };
  const queue = asRecord(repository.mergeQueue);
  // No queue on the branch: nothing is queued.
  if (queue === null) return { ok: true, prs: [], total: 0 };
  const entries = asRecord(queue.entries);
  const nodes = Array.isArray(entries?.nodes) ? entries.nodes : [];
  const prs: number[] = [];
  for (const node of nodes) {
    const n = asRecord(asRecord(node)?.pullRequest)?.number;
    if (typeof n !== "number")
      return { ok: false, reason: "merge queue entry without a PR number" };
    prs.push(n);
  }
  const total = typeof entries?.totalCount === "number" ? entries.totalCount : prs.length;
  return { ok: true, prs, total };
}

/**
 * Re-run the Actions runs behind the failed required checks on `headSha`
 * (`gh run rerun <id> --failed`, REST). Refuses when no failed check maps to a run.
 */
export function rerunFailedRequiredChecks(
  repo: string,
  headSha: string,
  failedChecks: readonly string[],
  runGh: RunGhFn,
): ReadResult<{ readonly runIds: readonly string[] }> {
  const names = new Set(failedChecks.map(failedCheckName));
  if (names.size === 0) return { ok: false, reason: "pr:watch named no failed check" };
  // Every page: one compact { name, details_url } object per line.
  const list = runGh([
    "gh",
    "api",
    "--paginate",
    `repos/${repo}/commits/${headSha}/check-runs?per_page=100`,
    "--jq",
    ".check_runs[] | {name, details_url} | @json",
  ]);
  if (list.returncode !== 0) {
    return { ok: false, reason: `check-runs read failed: ${list.stderr.trim()}` };
  }
  const ids = new Set<string>();
  for (const row of list.stdout.split(/\r?\n/)) {
    if (row.trim().length === 0) continue;
    let rec: Record<string, unknown> | null;
    try {
      rec = asRecord(JSON.parse(row));
    } catch {
      return { ok: false, reason: "check-runs read returned a line that is not JSON" };
    }
    if (rec === null || typeof rec.name !== "string" || !names.has(rec.name)) continue;
    const match = /\/actions\/runs\/(\d+)/.exec(String(rec.details_url ?? ""));
    if (match?.[1] !== undefined) ids.add(match[1]);
  }
  if (ids.size === 0) {
    return {
      ok: false,
      reason: `no Actions run found for the failed checks: ${[...names].join(", ")}`,
    };
  }
  for (const id of ids) {
    const r = runGh(["gh", "run", "rerun", id, "--failed", "--repo", repo]);
    if (r.returncode !== 0) {
      return { ok: false, reason: `gh run rerun ${id} --failed: ${r.stderr.trim()}` };
    }
  }
  return { ok: true, runIds: [...ids] };
}

function defaultEnqueueAndWait(
  pr: number,
  repo: string,
  projectRoot: string,
  beforeEnqueue: BeforeEnqueue,
): QueueOutcome {
  // The CLI's own --cap-minutes default, read from its parser.
  const args = parseWaitMergeableArgs([String(pr), "--repo", repo, "--wait"]);
  const result = withWaitHeartbeat(projectRoot, pr, "pr:wait-mergeable-and-merge", () =>
    waitMergeableAndMerge(pr, repo, {
      capMinutes: args.capMinutes,
      protected: [],
      projectRoot,
      wait: true,
      // The enqueue reads run again here, at the enqueue call itself.
      mergeFn: (n, r, options) => {
        const refused = beforeEnqueue(options?.matchHeadCommit ?? null);
        if (refused !== null) return [1, "", `release:run enqueue reads: ${refused}; not enqueued`];
        return runGhMerge(n, r, options);
      },
    }),
  );
  return queueOutcomeOf(result);
}

/** Map one queue read of a recorded enqueue onto {@link PreviousEnqueue}. */
export function previousEnqueueOf(result: WaitMergeableResult): PreviousEnqueue {
  const kind = result.outcome;
  if (kind === "merged") return { kind: "merged" };
  if (kind === "queued" || kind === "awaiting-admission") return { kind: "queued" };
  // No queue entry and no removal since the recorded time: it never entered the queue.
  if (kind === "inactive") return { kind: "never-enqueued" };
  return queueOutcomeOf(result);
}

function defaultReadPrevious(
  pr: number,
  repo: string,
  projectRoot: string,
  expectHead: string,
  since: string,
): PreviousEnqueue {
  return previousEnqueueOf(resumeMergeQueueRead(pr, repo, { expectHead, since, projectRoot }));
}

function defaultWaitQueued(
  pr: number,
  repo: string,
  projectRoot: string,
  expectHead: string,
  since: string,
): QueueOutcome {
  const args = parseWaitMergeableArgs([String(pr), "--repo", repo, "--wait"]);
  const result = withWaitHeartbeat(projectRoot, pr, "merge queue wait", () =>
    resumeMergeQueueRead(pr, repo, {
      expectHead,
      since,
      projectRoot,
      wait: { capMinutes: args.capMinutes },
    }),
  );
  return queueOutcomeOf(result);
}

/**
 * Run the merge phase. Returns EXIT_OK once the release PR merged, else
 * EXIT_VIOLATION with the reason on the phase line; `--resume` repeats it.
 */
export function runMergePhase(ctx: MergePhaseContext, seams: ReleaseMergeSeams = {}): number {
  const first = ctx.record();
  const pr = first.pr;
  const cutBase = first.cutBase;
  if (pr === null || cutBase === null) {
    ctx.line("FAIL (the run record has no PR number or cut base)");
    return EXIT_VIOLATION;
  }
  const { repo, baseBranch } = first;
  const runGh = seams.runGh ?? defaultRunGh;
  const watchPr = seams.watch ?? defaultWatch(runGh);
  const readTip =
    seams.readTip ??
    ((_r: string, base: string, root: string) => readOriginTip(base, root, seams.release ?? {}));
  const readQueue =
    seams.readQueue ?? ((r: string, base: string) => readMergeQueueEntries(r, base, runGh));
  const rerun =
    seams.rerunFailedChecks ??
    ((r: string, sha: string, failed: readonly string[]) =>
      rerunFailedRequiredChecks(r, sha, failed, runGh));
  const enqueueAndWait = seams.enqueueAndWait ?? defaultEnqueueAndWait;
  const readPrevious = seams.readPrevious ?? defaultReadPrevious;
  const waitQueued = seams.waitQueued ?? defaultWaitQueued;

  /** The enqueue reads: the live origin tip against B, then the merge-queue entries. */
  const enqueueReads = (): {
    readonly refused: string | null;
    readonly queuedPrs: readonly number[];
    readonly queuedTotal: number;
  } => {
    const none = { queuedPrs: [], queuedTotal: 0 };
    const tip = readTip(repo, baseBranch, ctx.projectRoot);
    if (!tip.ok) return { ...none, refused: `cannot read the origin tip: ${tip.reason}` };
    if (tip.sha.toLowerCase() !== cutBase.toLowerCase()) {
      return {
        ...none,
        refused:
          `origin/${baseBranch} is ${tip.sha.slice(0, 12)}, ` +
          `not the cut base B=${cutBase.slice(0, 12)}`,
      };
    }
    const queue = readQueue(repo, baseBranch);
    if (!queue.ok) return { ...none, refused: `cannot read the merge queue: ${queue.reason}` };
    return {
      refused: null,
      queuedPrs: queue.prs,
      queuedTotal: Math.max(queue.total, queue.prs.length),
    };
  };

  /** Spend the run's one re-run, or stop when it is spent. True when spent now. */
  const spendRerun = (what: string): boolean => {
    const used = ctx.record().retries.failedCheck;
    if (used > 0) {
      ctx.line(
        `FAIL (${what} after the run's one re-run (re-runs used: ${String(used)}); ` +
          "the run stops without another re-run)",
      );
      return false;
    }
    // Recorded before the re-run starts, so a crash cannot grant a second one.
    ctx.save({ retries: { failedCheck: used + 1 } });
    return true;
  };

  /** Merged → OK; ejected for a failed check → re-run once (null = loop again). */
  const settle = (outcome: QueueOutcome): number | null => {
    if (outcome.kind === "merged") {
      ctx.line(`OK (release PR #${String(pr)} merged)`);
      return EXIT_OK;
    }
    if (outcome.kind === "ejected") {
      const reason = outcome.reason === "" ? "(none given)" : outcome.reason;
      if (!isFailedCheckRemoval(outcome.reason)) {
        ctx.line(`FAIL (release PR #${String(pr)} left the merge queue: ${reason})`);
        return EXIT_VIOLATION;
      }
      if (!spendRerun(`a queue ejection for a failed check (${reason})`)) return EXIT_VIOLATION;
      // This enqueue is judged; the re-enqueue records its own.
      ctx.save({ enqueue: null });
      ctx.line(
        `RE-RUN (queue ejection for a failed check: ${reason}; re-enqueue under the same reads)`,
      );
      return null;
    }
    ctx.line(`FAIL (pr:wait-mergeable-and-merge --wait: ${outcome.detail})`);
    return EXIT_VIOLATION;
  };

  // Each pass either returns or spends the single re-run, so at most two passes run.
  for (;;) {
    const watched = watchPr(pr, repo, ctx.projectRoot);
    if (watched.verdict === VERDICT_MERGED) {
      ctx.line(`OK (release PR #${String(pr)} already merged)`);
      return EXIT_OK;
    }
    if (watched.verdict === VERDICT_NEW_P0_P1) {
      ctx.line(`FAIL (pr:watch ${String(pr)}: a review finding on the release PR; the run stops)`);
      return EXIT_VIOLATION;
    }
    if (watched.verdict === VERDICT_CI_BLOCKED) {
      const failed = watched.failedChecks.join(", ") || "(unnamed)";
      if (!spendRerun(`a required check failed (${failed})`)) return EXIT_VIOLATION;
      if (watched.headSha === null) {
        ctx.line("FAIL (pr:watch reported no head SHA; cannot re-run the failed check)");
        return EXIT_VIOLATION;
      }
      const done = rerun(repo, watched.headSha, watched.failedChecks);
      if (!done.ok) {
        ctx.line(`FAIL (re-run of the failed check: ${done.reason})`);
        return EXIT_VIOLATION;
      }
      ctx.line(`RE-RUN (failed check ${failed}; runs ${done.runIds.join(", ")}; waiting again)`);
      continue;
    }
    if (watched.verdict !== VERDICT_CLEAN) {
      ctx.line(
        `FAIL (pr:watch ${String(pr)} ended ${watched.verdict}; resume with --resume to wait again)`,
      );
      return EXIT_VIOLATION;
    }

    // Enqueue reads: the origin tip must still be B and the merge queue empty.
    const early = enqueueReads();
    if (early.refused !== null) {
      ctx.line(`FAIL (${early.refused}; not enqueued)`);
      return EXIT_VIOLATION;
    }

    // An enqueue recorded by an earlier pass or run is read back before any new one.
    const recorded = ctx.record().enqueue;
    if (recorded !== null) {
      const previous = readPrevious(pr, repo, ctx.projectRoot, recorded.head, recorded.since);
      if (previous.kind === "queued") {
        ctx.line(`WAIT (release PR #${String(pr)} is still in the merge queue)`);
        const settled = settle(
          waitQueued(pr, repo, ctx.projectRoot, recorded.head, recorded.since),
        );
        if (settled !== null) return settled;
        continue;
      }
      if (previous.kind !== "never-enqueued") {
        const settled = settle(previous);
        if (settled !== null) return settled;
        continue;
      }
      // It never entered the queue: the recorded enqueue did not happen.
      ctx.save({ enqueue: null });
    }
    if (early.queuedPrs.includes(pr)) {
      ctx.line(
        `FAIL (release PR #${String(pr)} is in the merge queue but the run recorded no enqueue)`,
      );
      return EXIT_VIOLATION;
    }
    if (early.queuedTotal > 0) {
      const named = early.queuedPrs.map((n) => `#${String(n)}`).join(", ");
      ctx.line(`FAIL (merge queue is not empty: ${named}; not enqueued)`);
      return EXIT_VIOLATION;
    }

    ctx.line("ENQUEUE (origin tip is B and the merge queue is empty; read again at the enqueue)");
    const settled = settle(
      enqueueAndWait(pr, repo, ctx.projectRoot, (head) => {
        const boundary = enqueueReads();
        if (boundary.refused !== null) return boundary.refused;
        if (boundary.queuedTotal > 0) {
          const named = boundary.queuedPrs.map((n) => `#${String(n)}`).join(", ");
          return `merge queue is not empty: ${named}`;
        }
        if (head === null) return "the merge engine named no head to pin";
        ctx.save({ enqueue: { head, since: ctx.now().toISOString() } });
        return null;
      }),
    );
    if (settled !== null) return settled;
  }
}
