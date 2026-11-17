import { evaluateIntentCeilingFromEnv } from "../policy/intent-ceiling.js";
import {
  disablePullRequestAutoMerge,
  type EnforceMergeApprovalHeadInput,
  enforceMergeApprovalHead,
  fetchPrHeadShaRest,
  type MergeApprovalHeadResult,
} from "../policy/merge-approval-head.js";
import {
  type AgentMergeEvaluateResult,
  evaluateAgentMerge,
} from "../policy/require-human-merge.js";
import { EXIT_NEW_P0_P1, VERDICT_NEW_P0_P1 } from "../pr-watch/constants.js";
import { watch } from "../pr-watch/watch.js";
import { reconcileUmbrellas, renderUmbrellasReport } from "../vbrief-reconcile/umbrellas.js";
import { classifyMonitorOutcome, parseMonitorPayload } from "./classify.js";
import {
  EXIT_CONFIG_ERROR,
  EXIT_MERGED,
  EXIT_QUEUE_PENDING,
  EXIT_TIMEOUT_OR_ESCALATION,
  MERGE_QUEUE_WAIT_MAX_FAILED_READS,
  MERGE_QUEUE_WAIT_POLL_SECONDS,
  type QueueWaitStopReason,
} from "./constants.js";
import {
  classifyQueueRead,
  detectMergeQueue,
  formatResumeCommand,
  type MergeQueueDetectFn,
  type QueueReadFn,
  type QueueResult,
  type QueueResultKind,
  queueResultToDict,
  readQueueState,
} from "./merge-queue.js";
import { makeResult } from "./result.js";
import { evaluateSemanticGreen, type SemanticGreenFn } from "./semantic-green.js";
import type {
  CloseoutAttestableFn,
  MergeFn,
  MonitorFn,
  ProtectedCheckFn,
  WaitMergeableResult,
} from "./types.js";
import {
  runCloseoutAttestableCheck,
  runGhMerge,
  runMonitor,
  runProtectedCheck,
} from "./wrappers.js";

/** Node module-not-found / missing script — not a protected-issue overlap (#2667). */
function isProtectedCheckConfigFailure(stderr: string): boolean {
  const tail = stderr.trim();
  return (
    tail.includes("MODULE_NOT_FOUND") ||
    tail.includes("Cannot find module") ||
    tail.includes("protected-check script not found:")
  );
}

/** Post-merge umbrella checklist + current-shape refresh (#1649). */
export type UmbrellaReconcileFn = (projectRoot: string, repo: string) => void;

function defaultPostMergeUmbrellaReconcile(projectRoot: string, repo: string): void {
  const [, umOutcome] = reconcileUmbrellas(projectRoot, { repo });
  if (umOutcome.changed.length > 0 || umOutcome.errors.length > 0) {
    process.stderr.write(`${renderUmbrellasReport(umOutcome)}\n`);
  }
}

/** In-process pr:watch seam for the waiter NEW_P0_P1 probe (#4628). */
export type WaitMergeableWatchFn = (
  prNumber: number,
  repo: string | null,
  options: { readonly oneShot: boolean; readonly projectRoot?: string | null },
) => { readonly exitCode: number; readonly verdict: string };

export interface WaitMergeableOptions {
  readonly protectedFn?: ProtectedCheckFn;
  readonly monitorFn?: MonitorFn;
  readonly mergeFn?: MergeFn;
  readonly semanticGreenFn?: SemanticGreenFn;
  /** Enable merge-cascade semantic-green gate (#2385). */
  readonly cascadeMode?: boolean;
  /** After a prior cascade merge, require target-branch CI green at HEAD. */
  readonly requireMasterCiGreen?: boolean;
  /** Target branch override for stale-base comparison (defaults to PR base.ref). */
  readonly baseBranch?: string | null;
  /**
   * Project root for human-merge + intent-ceiling preflight (#1193).
   * Defaults to process.cwd(). Pass explicitly in tests.
   */
  readonly projectRoot?: string;
  /** Inject agent-merge evaluator (unit tests). */
  readonly agentMergeFn?: (projectRoot: string) => AgentMergeEvaluateResult;
  /** When true, skip human-merge / intent preflight (tests only). */
  readonly skipHumanMergeGate?: boolean;
  /**
   * When true, skip head-bound plan:approved gate (#3235).
   * Default: same as skipHumanMergeGate (test harnesses that skip human-merge
   * also skip head-binding unless they opt in with skipMergeApprovalHeadGate=false).
   */
  readonly skipMergeApprovalHeadGate?: boolean;
  /** Inject head-bound approval enforcer (unit tests). */
  readonly mergeApprovalHeadFn?: (input: EnforceMergeApprovalHeadInput) => MergeApprovalHeadResult;
  /**
   * When true, skip the merge-time closeout attestability gate (#3781).
   * Default: same as skipHumanMergeGate, matching the head-gate convention —
   * test harnesses that skip human-merge also skip this unless they opt in.
   */
  readonly skipCloseoutAttestableGate?: boolean;
  /** Inject the closeout attestability gate (unit tests). */
  readonly closeoutAttestableFn?: CloseoutAttestableFn;
  /** Inject PR HEAD fetch (unit tests; defaults to REST `pulls/<N>`). */
  readonly fetchPrHeadShaFn?: (prNumber: number, repo: string | null) => string | null;
  /**
   * Post-merge umbrella reconcile (#1649). Defaults to live reconcileUmbrellas.
   * Pass `null` to skip (unit tests that inject mergeFn must pass null so they
   * never mutate real GitHub current-shape comments from the worktree cwd).
   */
  readonly umbrellaReconcileFn?: UmbrellaReconcileFn | null;
  /**
   * In-process SHA-matched pr:watch one-shot (#4628). Inject in tests.
   * Live default is watch() from pr-watch. Skipped when skipHumanMergeGate
   * is true and watchFn is omitted (test harness convention).
   */
  readonly watchFn?: WaitMergeableWatchFn;
  /**
   * Skip always-on named Merge gate (#6071). Test harnesses that set
   * skipHumanMergeGate without injecting semanticGreenFn inherit skip
   * (same convention as head/closeout gates). Production must not set this.
   */
  readonly skipNamedMergeGate?: boolean;
  /**
   * Merge-queue detection (#6295). Live default reads branch rules REST. Skipped
   * (treated as no queue) when omitted under the test-harness convention
   * (skipHumanMergeGate or VITEST), like watchFn.
   */
  readonly mergeQueueDetectFn?: MergeQueueDetectFn;
  /** Post-enqueue PR read (#6295). Live default is readQueueState (GraphQL, #954 floor). */
  readonly queueReadFn?: QueueReadFn;
  /** Clock seam for the recorded enqueue time (#6295). */
  readonly nowFn?: () => Date;
  /** `--wait` (#6423): repeat the read after enqueue until it is no longer pending. */
  readonly wait?: boolean;
  /** Sleep seam for `--wait` (#6423); defaults to a blocking sleep. */
  readonly queueWaitSleepFn?: QueueWaitSleepFn;
  /** Clock seam (epoch ms) for the `--wait` deadline (#6423); defaults to Date.now. */
  readonly queueWaitClockMsFn?: () => number;
}

/** Blocking sleep used between `--wait` queue reads (#6423). */
export type QueueWaitSleepFn = (seconds: number) => void;

/**
 * Synchronous sleep: the verb runs synchronously, and its heartbeat refresher
 * lives on a worker thread, so blocking this thread keeps the heartbeat fresh.
 */
export function sleepSecondsSync(seconds: number): void {
  const ms = Math.max(0, Math.trunc(seconds * 1000));
  if (ms === 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function resolveUmbrellaFn(
  umbrellaReconcileFn: UmbrellaReconcileFn | null | undefined,
): UmbrellaReconcileFn | null {
  // null = skip; undefined = live default (skipped under VITEST unless injected).
  if (umbrellaReconcileFn === null) return null;
  if (umbrellaReconcileFn !== undefined) return umbrellaReconcileFn;
  return process.env.VITEST === "true" ? null : defaultPostMergeUmbrellaReconcile;
}

function runPostMergeReconcile(
  umbrellaFn: UmbrellaReconcileFn | null,
  projectRoot: string,
  repo: string,
): void {
  // Best-effort umbrella checklist + current-shape refresh after child merge (#1649).
  // Failures must not flip a successful merge into an error exit. Safe to repeat.
  if (umbrellaFn === null) return;
  try {
    umbrellaFn(projectRoot, repo);
  } catch {
    /* best-effort; merge remains authoritative */
  }
}

const QUEUE_EXIT: Readonly<Record<QueueResultKind, number>> = {
  "head-changed": EXIT_TIMEOUT_OR_ESCALATION,
  merged: EXIT_MERGED,
  queued: EXIT_QUEUE_PENDING,
  "awaiting-admission": EXIT_QUEUE_PENDING,
  removed: EXIT_TIMEOUT_OR_ESCALATION,
  inactive: EXIT_TIMEOUT_OR_ESCALATION,
};

const QUEUE_NOTE: Readonly<Record<QueueResultKind, string | null>> = {
  "head-changed":
    "PR head differs from the head this session queued; not reported as this session's merge, " +
    "no reconciliation ran.",
  merged: null,
  queued: "PR is in the merge queue; not merged yet.",
  "awaiting-admission": "Auto-merge is armed; GitHub admits the PR once required checks pass.",
  removed: "PR left the merge queue without merging.",
  inactive: "PR is not queued and auto-merge is not armed.",
};

export interface QueueReportInput {
  readonly prNumber: number;
  readonly repo: string;
  readonly expectHead: string;
  readonly since: string;
  readonly projectRoot: string;
  readonly queueReadFn?: QueueReadFn;
  readonly umbrellaReconcileFn?: UmbrellaReconcileFn | null;
  readonly monitorResult?: Record<string, unknown>;
  readonly protectedCheck?: Record<string, unknown>;
  readonly mergeStdout?: string;
  readonly mergeStderr?: string;
}

/** One queue read: a classified result, or the reason the read was unavailable. */
type QueueAttempt =
  | { readonly ok: true; readonly result: QueueResult }
  | { readonly ok: false; readonly message: string };

function attemptQueueRead(input: QueueReportInput): QueueAttempt {
  const readFn = input.queueReadFn ?? ((n: number, r: string) => readQueueState(n, r));
  const read = readFn(input.prNumber, input.repo);
  if (read.status !== "ok") {
    return { ok: false, message: read.message };
  }
  return { ok: true, result: classifyQueueRead(read.read, input.expectHead, input.since) };
}

function isPendingAttempt(attempt: QueueAttempt): boolean {
  return (
    attempt.ok && (attempt.result.kind === "queued" || attempt.result.kind === "awaiting-admission")
  );
}

/**
 * Report one queue attempt. `stopReason` is set only under `--wait` (#6423
 * item 6); a one-read result carries no stop-reason field.
 */
function reportQueueAttempt(
  input: QueueReportInput,
  attempt: QueueAttempt,
  stopReason: QueueWaitStopReason | null,
): WaitMergeableResult {
  const { prNumber, repo, expectHead, since } = input;
  const resume = formatResumeCommand(prNumber, repo, expectHead, since);
  const stop = stopReason === null ? {} : { wait_stop_reason: stopReason };
  if (!attempt.ok) {
    return makeResult({
      prNumber,
      repo,
      outcome: "queue-read-unavailable",
      exitCode: EXIT_CONFIG_ERROR,
      monitorResult: input.monitorResult,
      protectedCheck: input.protectedCheck,
      mergeQueue: { resume_command: resume, expected_head: expectHead, since, ...stop },
      mergeStdout: input.mergeStdout,
      mergeStderr: input.mergeStderr,
      error: `${attempt.message}\nResume: ${resume}`,
    });
  }
  const result = attempt.result;
  if (result.kind === "merged") {
    runPostMergeReconcile(resolveUmbrellaFn(input.umbrellaReconcileFn), input.projectRoot, repo);
  }
  const note = QUEUE_NOTE[result.kind];
  const detail =
    result.kind === "removed"
      ? ` reason=${result.removalReason === "" ? "(none given)" : result.removalReason}`
      : result.kind === "inactive" && result.autoMergeDisabledReason !== null
        ? ` auto-merge disabled: ${result.autoMergeDisabledReason}`
        : "";
  return makeResult({
    prNumber,
    repo,
    outcome: result.kind,
    exitCode: QUEUE_EXIT[result.kind],
    monitorResult: input.monitorResult,
    protectedCheck: input.protectedCheck,
    mergeQueue: { ...queueResultToDict(result, resume), ...stop },
    mergeStdout: input.mergeStdout,
    mergeStderr: input.mergeStderr,
    error: note === null ? null : `${note}${detail}\nResume: ${resume}`,
  });
}

/**
 * Read the PR once and report exactly one queue result (#6295 item 4). On
 * `merged` run today's post-merge reconciliation; `head-changed` never does.
 */
export function reportMergeQueueState(input: QueueReportInput): WaitMergeableResult {
  return reportQueueAttempt(input, attemptQueueRead(input), null);
}

export interface QueueWaitOptions {
  /** `--cap-minutes`: the one deadline is the start of the wait plus this (#6423 item 3). */
  readonly capMinutes: number;
  readonly sleepFn?: QueueWaitSleepFn;
  readonly clockMsFn?: () => number;
}

/**
 * `--wait` (#6423): repeat today's queue read while it is pending. Ends on the
 * first other result, after {@link MERGE_QUEUE_WAIT_MAX_FAILED_READS} failed
 * reads in a row, or at the one deadline, where the latest attempt decides.
 * No sleep ends after the deadline and no read starts after it.
 */
export function waitMergeQueueState(
  input: QueueReportInput,
  wait: QueueWaitOptions,
): WaitMergeableResult {
  const clock = wait.clockMsFn ?? Date.now;
  const sleep = wait.sleepFn ?? sleepSecondsSync;
  const deadlineMs = clock() + wait.capMinutes * 60_000;
  let failedReads = 0;
  for (;;) {
    const attempt = attemptQueueRead(input);
    if (attempt.ok && !isPendingAttempt(attempt)) {
      return reportQueueAttempt(input, attempt, "result");
    }
    failedReads = attempt.ok ? 0 : failedReads + 1;
    if (failedReads >= MERGE_QUEUE_WAIT_MAX_FAILED_READS) {
      return reportQueueAttempt(input, attempt, "read-unavailable");
    }
    if (clock() + MERGE_QUEUE_WAIT_POLL_SECONDS * 1000 > deadlineMs) {
      return reportQueueAttempt(input, attempt, "cap");
    }
    const state = attempt.ok
      ? attempt.result.kind
      : `read unavailable (${failedReads} of ${MERGE_QUEUE_WAIT_MAX_FAILED_READS} in a row)`;
    process.stderr.write(
      `[pr_wait_mergeable] PR #${input.prNumber} queue wait: ${state}; ` +
        `next read in ${MERGE_QUEUE_WAIT_POLL_SECONDS}s\n`,
    );
    sleep(MERGE_QUEUE_WAIT_POLL_SECONDS);
    if (clock() > deadlineMs) {
      return reportQueueAttempt(input, attempt, "cap");
    }
  }
}

/** `--resume --expect-head <sha> --since <time>`: repeat the read from any session (#6295). */
export function resumeMergeQueueRead(
  prNumber: number,
  repo: string,
  options: {
    readonly expectHead: string;
    readonly since: string;
    readonly projectRoot?: string;
    readonly queueReadFn?: QueueReadFn;
    readonly umbrellaReconcileFn?: UmbrellaReconcileFn | null;
    /** `--wait` (#6423): wait under these options instead of one read. */
    readonly wait?: QueueWaitOptions;
  },
): WaitMergeableResult {
  const input: QueueReportInput = {
    prNumber,
    repo,
    expectHead: options.expectHead,
    since: options.since,
    projectRoot: options.projectRoot ?? process.cwd(),
    queueReadFn: options.queueReadFn,
    umbrellaReconcileFn: options.umbrellaReconcileFn,
  };
  return options.wait === undefined
    ? reportMergeQueueState(input)
    : waitMergeQueueState(input, options.wait);
}

/** Run protected-check -> wait -> merge cascade (#1369). */
export function waitMergeableAndMerge(
  prNumber: number,
  repo: string,
  options: {
    readonly capMinutes: number;
    readonly protected: readonly number[];
  } & WaitMergeableOptions,
): WaitMergeableResult {
  const protectedFn = options.protectedFn ?? runProtectedCheck;
  const monitorFn = options.monitorFn ?? runMonitor;
  const mergeFn = options.mergeFn ?? runGhMerge;
  const semanticGreenFn = options.semanticGreenFn ?? evaluateSemanticGreen;
  const protectedIssues = options.protected;
  const projectRoot = options.projectRoot ?? process.cwd();

  // #1193 surface (1): refuse agent merge when requireHumanMerge is true,
  // and refuse when slash-command intent ceiling does not authorize merge.
  if (options.skipHumanMergeGate !== true) {
    const intent = evaluateIntentCeilingFromEnv("merge");
    if (!intent.allowed) {
      return makeResult({
        prNumber,
        repo,
        outcome: "config-error",
        exitCode: EXIT_CONFIG_ERROR,
        error: intent.reason,
      });
    }
    // #3235: revoke stale head-bound approval / auto-merge even when human-merge
    // will refuse the bot merge — otherwise auto-merge can land a later HEAD.
    if (options.skipMergeApprovalHeadGate !== true) {
      const headGateFn = options.mergeApprovalHeadFn ?? enforceMergeApprovalHead;
      const earlyHead = headGateFn({
        prNumber,
        repo,
        projectRoot,
        currentHeadSha: null,
        fetchHeadShaFn: fetchPrHeadShaRest,
        disableAutoMergeOnDeny: true,
      });
      if (!earlyHead.allowed) {
        const parts = [earlyHead.message];
        if (earlyHead.recovery !== null) {
          parts.push("", earlyHead.recovery);
        }
        return makeResult({
          prNumber,
          repo,
          outcome: "stale-merge-approval",
          exitCode: EXIT_CONFIG_ERROR,
          error: parts.join("\n"),
        });
      }
    }
    const agentMergeFn = options.agentMergeFn ?? evaluateAgentMerge;
    const hm = agentMergeFn(projectRoot);
    if (!hm.allowed) {
      return makeResult({
        prNumber,
        repo,
        outcome: "config-error",
        exitCode: EXIT_CONFIG_ERROR,
        error: hm.message,
      });
    }
  }

  let protectedCheckPayload: Record<string, unknown> = {};

  if (protectedIssues.length > 0) {
    const [prcRc, prcStdout, prcStderr] = protectedFn(prNumber, repo, protectedIssues);
    protectedCheckPayload = {
      returncode: prcRc,
      stdout: prcStdout,
      stderr: prcStderr,
      protected: [...protectedIssues],
    };

    if (prcRc === 1 && !isProtectedCheckConfigFailure(prcStderr)) {
      return makeResult({
        prNumber,
        repo,
        outcome: "protected-linked",
        exitCode: EXIT_TIMEOUT_OR_ESCALATION,
        protectedCheck: protectedCheckPayload,
        error:
          "PR has a persistent closingIssuesReferences link to a " +
          "protected issue (#701). Unlink via the PR's Development " +
          "sidebar before re-running.",
      });
    }

    if (prcRc !== 0) {
      return makeResult({
        prNumber,
        repo,
        outcome: "config-error",
        exitCode: EXIT_CONFIG_ERROR,
        protectedCheck: protectedCheckPayload,
        error:
          `protected-issue check exited ${prcRc} (config error). ` + `stderr: ${prcStderr.trim()}`,
      });
    }
  }

  // #6295: detect a required merge queue on the delivery branch. A read error
  // fails closed; it never falls back to a direct --admin merge.
  let queueMode = false;
  const skipQueueDetect =
    options.mergeQueueDetectFn === undefined &&
    (options.skipHumanMergeGate === true || process.env.VITEST === "true");
  if (!skipQueueDetect) {
    const detect = options.mergeQueueDetectFn ?? detectMergeQueue;
    const detection = detect(prNumber, repo, options.baseBranch ?? null);
    if (detection.status === "error") {
      return makeResult({
        prNumber,
        repo,
        outcome: "merge-queue-detect-failed",
        exitCode: EXIT_CONFIG_ERROR,
        protectedCheck: protectedCheckPayload,
        error:
          `could not read the delivery branch rules: ${detection.message}. ` +
          "Refusing to merge: Directive never falls back to --admin when queue mode is unknown (#6295).",
      });
    }
    queueMode = detection.status === "queue";
  }

  // Queue mode deletes the up-to-date requirement (stale-base refusal) and the
  // #6071 master Merge gate waits: the queue re-qualifies each group (#6295 item 5).
  const skipNamedMergeGate =
    queueMode ||
    options.skipNamedMergeGate === true ||
    (options.skipHumanMergeGate === true && options.semanticGreenFn === undefined);
  if (!queueMode) {
    const semanticGreen = semanticGreenFn(prNumber, repo, {
      cascadeMode: options.cascadeMode,
      requireMasterCiGreen: options.requireMasterCiGreen,
      baseBranch: options.baseBranch,
      skipNamedMergeGate,
      projectRoot,
    });
    if (!semanticGreen.ok) {
      return makeResult({
        prNumber,
        repo,
        outcome: semanticGreen.outcome ?? "semantic-green-blocked",
        exitCode: semanticGreen.exitCode ?? EXIT_TIMEOUT_OR_ESCALATION,
        protectedCheck: protectedCheckPayload,
        semanticGreen: { ...semanticGreen.payload } as Record<string, unknown>,
        error: semanticGreen.error,
      });
    }
  }

  let watchProbe: { readonly exitCode: number; readonly verdict: string } | null = null;
  const skipWatchProbe =
    options.watchFn === undefined &&
    (options.skipHumanMergeGate === true || process.env.VITEST === "true");
  if (!skipWatchProbe) {
    const watchFn = options.watchFn ?? watch;
    try {
      watchProbe = watchFn(prNumber, repo, { oneShot: true, projectRoot });
    } catch {
      watchProbe = null;
    }
  }
  if (
    watchProbe !== null &&
    (watchProbe.exitCode === EXIT_NEW_P0_P1 || watchProbe.verdict === VERDICT_NEW_P0_P1)
  ) {
    const [p1Outcome, p1Exit] = classifyMonitorOutcome(1, { monitor_result: "NEW_P0_P1" });
    return makeResult({
      prNumber,
      repo,
      outcome: p1Outcome,
      exitCode: p1Exit,
      error:
        "SHA-matched Greptile NEW_P0_P1 on PR #" +
        String(prNumber) +
        " (one probe, no cap wait). Address findings, push, then re-run task pr:wait-mergeable-and-merge.",
    });
  }

  const [monRc, monStdout, monStderr] = monitorFn(prNumber, repo, options.capMinutes, {
    projectRoot,
  });
  const monitorPayload = parseMonitorPayload(monStdout);
  const [outcome, monitorExit] = classifyMonitorOutcome(monRc, monitorPayload);

  if (outcome !== "clean") {
    const errorPayload =
      monitorExit === EXIT_MERGED
        ? null
        : monStderr.trim().length > 0
          ? `monitor exited ${monRc} (outcome=${outcome}). stderr tail: ${monStderr.trim().slice(-200)}`
          : `monitor exited ${monRc} (outcome=${outcome})`;

    return makeResult({
      prNumber,
      repo,
      outcome,
      exitCode: monitorExit,
      monitorResult: monitorPayload,
      protectedCheck: protectedCheckPayload,
      error: errorPayload,
    });
  }

  // #3235: head-bound plan:approved — refuse merge when approval is stale vs
  // current HEAD; best-effort disable auto-merge + recovery instructions.
  // Re-read live HEAD immediately before merge (TOCTOU / Greptile P1) and pin
  // `gh pr merge --match-head-commit` to that exact SHA.
  // Default skip when human-merge gate is skipped (unit-test harness convention).
  const skipHeadGate =
    options.skipMergeApprovalHeadGate === true ||
    (options.skipMergeApprovalHeadGate === undefined && options.skipHumanMergeGate === true);
  let matchHeadCommit: string | null = null;
  if (!skipHeadGate) {
    const readiness =
      typeof monitorPayload.readiness === "object" &&
      monitorPayload.readiness !== null &&
      !Array.isArray(monitorPayload.readiness)
        ? (monitorPayload.readiness as Record<string, unknown>)
        : {};
    const headFromMonitor =
      typeof readiness.head_sha === "string"
        ? readiness.head_sha
        : typeof monitorPayload.head_sha === "string"
          ? monitorPayload.head_sha
          : null;
    const headGateFn = options.mergeApprovalHeadFn ?? enforceMergeApprovalHead;
    const fetchHead = options.fetchPrHeadShaFn ?? fetchPrHeadShaRest;
    // Live HEAD only — never authorize against a stale monitor snapshot when
    // the REST read fails (would pin A while GitHub head is B).
    const liveHead = fetchHead(prNumber, repo);
    if (liveHead === null || liveHead.trim() === "") {
      disablePullRequestAutoMerge(prNumber, repo);
      return makeResult({
        prNumber,
        repo,
        outcome: "stale-merge-approval",
        exitCode: EXIT_CONFIG_ERROR,
        monitorResult: monitorPayload,
        protectedCheck: protectedCheckPayload,
        error:
          `❌ merge-approval-head (#3235): cannot read live PR HEAD for #${prNumber}` +
          (headFromMonitor !== null ? ` (monitor had ${headFromMonitor.slice(0, 12)})` : "") +
          "; refusing merge and disabling auto-merge (fail closed).",
      });
    }
    const headGate = headGateFn({
      prNumber,
      repo,
      projectRoot,
      currentHeadSha: liveHead,
      disableAutoMergeOnDeny: true,
    });
    if (!headGate.allowed) {
      const parts = [headGate.message];
      if (headGate.recovery !== null) {
        parts.push("", headGate.recovery);
      }
      return makeResult({
        prNumber,
        repo,
        outcome: "stale-merge-approval",
        exitCode: EXIT_CONFIG_ERROR,
        monitorResult: monitorPayload,
        protectedCheck: protectedCheckPayload,
        error: parts.join("\n"),
      });
    }
    matchHeadCommit = liveHead;
  } else {
    // Gate skipped: still prefer a live HEAD pin when available.
    const fetchHead = options.fetchPrHeadShaFn ?? fetchPrHeadShaRest;
    matchHeadCommit = fetchHead(prNumber, repo);
    if (matchHeadCommit === null) {
      const readiness =
        typeof monitorPayload.readiness === "object" &&
        monitorPayload.readiness !== null &&
        !Array.isArray(monitorPayload.readiness)
          ? (monitorPayload.readiness as Record<string, unknown>)
          : {};
      if (typeof readiness.head_sha === "string") {
        matchHeadCommit = readiness.head_sha;
      } else if (typeof monitorPayload.head_sha === "string") {
        matchHeadCommit = monitorPayload.head_sha;
      }
    }
  }

  // #3781 / #3875: last gate before the merge call (route-table invoker). A PR may
  // leave a brief unattested; it may not merge one whose issue it closes in the
  // same act. Keyed on the PR's closing references, so it fires even when the
  // brief is not in the branch diff. Evaluator asserts HEAD == PR head first.
  const skipCloseoutGate =
    options.skipCloseoutAttestableGate === true ||
    (options.skipCloseoutAttestableGate === undefined && options.skipHumanMergeGate === true);
  if (!skipCloseoutGate) {
    const closeoutFn = options.closeoutAttestableFn ?? runCloseoutAttestableCheck;
    const [coRc, , coStderr] = closeoutFn(prNumber, repo, projectRoot);
    if (coRc !== 0) {
      return makeResult({
        prNumber,
        repo,
        outcome: coRc === 1 ? "closeout-unattested" : "config-error",
        exitCode: coRc === 1 ? EXIT_TIMEOUT_OR_ESCALATION : EXIT_CONFIG_ERROR,
        monitorResult: monitorPayload,
        protectedCheck: protectedCheckPayload,
        error: coStderr.trim(),
      });
    }
  }

  // #6071: re-read named Merge gate after the wait, immediately before mergeFn,
  // so master tip churn during monitorFn cannot land an ordinary PR on a red tip.
  if (!skipNamedMergeGate) {
    const recheckGreen = semanticGreenFn(prNumber, repo, {
      cascadeMode: options.cascadeMode,
      requireMasterCiGreen: options.requireMasterCiGreen,
      baseBranch: options.baseBranch,
      skipNamedMergeGate: false,
      projectRoot,
    });
    if (!recheckGreen.ok) {
      return makeResult({
        prNumber,
        repo,
        outcome: recheckGreen.outcome ?? "semantic-green-blocked",
        exitCode: recheckGreen.exitCode ?? EXIT_TIMEOUT_OR_ESCALATION,
        monitorResult: monitorPayload,
        protectedCheck: protectedCheckPayload,
        semanticGreen: { ...recheckGreen.payload } as Record<string, unknown>,
        error: recheckGreen.error,
      });
    }
  }

  if (queueMode) {
    if (matchHeadCommit === null || matchHeadCommit.trim().length === 0) {
      return makeResult({
        prNumber,
        repo,
        outcome: "config-error",
        exitCode: EXIT_CONFIG_ERROR,
        monitorResult: monitorPayload,
        protectedCheck: protectedCheckPayload,
        error: `cannot read PR #${prNumber} head SHA; refusing to enqueue an unpinned head (#6295).`,
      });
    }
    const expectHead = matchHeadCommit.trim();
    const since = (options.nowFn ?? (() => new Date()))().toISOString();
    const [qRc, qStdout, qStderr] = mergeFn(prNumber, repo, {
      matchHeadCommit: expectHead,
      queueMode: true,
    });
    if (qRc !== 0) {
      if (options.skipMergeApprovalHeadGate !== true) {
        disablePullRequestAutoMerge(prNumber, repo);
      }
      const tail = qStderr.trim();
      return makeResult({
        prNumber,
        repo,
        outcome: qRc === -1 ? "config-error" : "enqueue-failed",
        exitCode: qRc === -1 ? EXIT_CONFIG_ERROR : EXIT_TIMEOUT_OR_ESCALATION,
        monitorResult: monitorPayload,
        protectedCheck: protectedCheckPayload,
        mergeStdout: qStdout,
        mergeStderr: qStderr,
        error:
          `gh pr merge (merge queue) exited ${qRc}` +
          (tail.length > 0 ? `. stderr: ${tail.slice(-200)}` : "") +
          ". No --admin fallback (#6295).",
      });
    }
    const reportInput: QueueReportInput = {
      prNumber,
      repo,
      expectHead,
      since,
      projectRoot,
      queueReadFn: options.queueReadFn,
      umbrellaReconcileFn: options.umbrellaReconcileFn,
      monitorResult: monitorPayload,
      protectedCheck: protectedCheckPayload,
      mergeStdout: qStdout,
      mergeStderr: qStderr,
    };
    // #6423: `--wait` repeats the read after enqueue; the deadline starts here.
    return options.wait === true
      ? waitMergeQueueState(reportInput, {
          capMinutes: options.capMinutes,
          sleepFn: options.queueWaitSleepFn,
          clockMsFn: options.queueWaitClockMsFn,
        })
      : reportMergeQueueState(reportInput);
  }

  const [mergeRc, mergeStdout, mergeStderr] = mergeFn(prNumber, repo, {
    matchHeadCommit,
  });

  // Pinned merge rejected (head advanced mid-call): revoke auto-merge so the
  // unapproved head cannot land later under retained GitHub auto-merge.
  if (mergeRc !== 0 && options.skipMergeApprovalHeadGate !== true) {
    disablePullRequestAutoMerge(prNumber, repo);
  }

  if (mergeRc === 0) {
    runPostMergeReconcile(resolveUmbrellaFn(options.umbrellaReconcileFn), projectRoot, repo);
    return makeResult({
      prNumber,
      repo,
      outcome: "merged",
      exitCode: EXIT_MERGED,
      monitorResult: monitorPayload,
      protectedCheck: protectedCheckPayload,
      mergeStdout,
      mergeStderr,
      error: null,
    });
  }

  if (mergeRc === -1) {
    const tail = mergeStderr.trim();
    return makeResult({
      prNumber,
      repo,
      outcome: "config-error",
      exitCode: EXIT_CONFIG_ERROR,
      monitorResult: monitorPayload,
      protectedCheck: protectedCheckPayload,
      mergeStdout,
      mergeStderr,
      error:
        tail.length > 0
          ? `gh pr merge wrapper failed at OS layer (rc=-1). stderr: ${tail.slice(-200)}`
          : "gh pr merge wrapper failed at OS layer (rc=-1).",
    });
  }

  const mergeTail = mergeStderr.trim();
  return makeResult({
    prNumber,
    repo,
    outcome: "merge-failed",
    exitCode: EXIT_TIMEOUT_OR_ESCALATION,
    monitorResult: monitorPayload,
    protectedCheck: protectedCheckPayload,
    mergeStdout,
    mergeStderr,
    error:
      mergeTail.length > 0
        ? `gh pr merge exited ${mergeRc}. stderr: ${mergeTail.slice(-200)}`
        : `gh pr merge exited ${mergeRc}`,
  });
}
