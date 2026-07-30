/**
 * pr:finish-loop — grant-gated PR watch until CLEAN (#871 Wave 5).
 *
 * - Polls via pr:watch until CLEAN / NEW_P0_P1 / terminal error
 * - NEW_P0_P1 → exit ACTION_REQUIRED (address path is agent-orchestrated)
 * - CLEAN + requireHumanMerge → halt with require-human-merge (do not force bot merge)
 * - CLEAN + bot merge allowed + --merge → optional wait-mergeable-and-merge
 * - Missing grants → fail closed BLOCKED
 */

import { evaluateAgentMerge } from "../policy/require-human-merge.js";
import {
  EXIT_CLEAN,
  EXIT_NEW_P0_P1,
  EXIT_TERMINAL_ERROR,
  VERDICT_CLEAN,
  VERDICT_NEW_P0_P1,
} from "../pr-watch/constants.js";
import type { WatchOptions, WatchResult } from "../pr-watch/types.js";
import { watch } from "../pr-watch/watch.js";
import { evaluateFinishLoopGrant } from "./grant-gate.js";
import { appendFinishLoopProgress, makeProgressLine } from "./progress.js";
import {
  EXIT_ACTION_REQUIRED,
  EXIT_BLOCKED,
  EXIT_OK,
  type PrFinishLoopResult,
} from "./types.js";

export interface PrFinishLoopOptions {
  readonly projectRoot: string;
  readonly prNumber: number;
  readonly repo?: string | null;
  readonly maxWaitMinutes?: number;
  readonly pollSeconds?: number;
  readonly oneShot?: boolean;
  /** Attempt merge when CLEAN and policy allows (default false). */
  readonly merge?: boolean;
  readonly skipGrantGate?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: Date;
  /** Inject watch for tests. */
  readonly watchFn?: (
    prNumber: number,
    repo: string | null,
    options?: WatchOptions,
  ) => WatchResult;
  /** Inject merge cascade for tests; returns exit code. */
  readonly mergeFn?: (prNumber: number, repo: string | null) => number;
  readonly agentMergeFn?: typeof evaluateAgentMerge;
  readonly writeProgress?: boolean;
  readonly iteration?: number;
}

export function runPrFinishLoop(options: PrFinishLoopOptions): PrFinishLoopResult {
  const projectRoot = options.projectRoot;
  const prNumber = options.prNumber;
  const iteration = options.iteration ?? 0;
  const writeProgress = options.writeProgress !== false;

  const log = (
    phase: "gate" | "pr-watch" | "address" | "merge" | "halt",
    haltReason: PrFinishLoopResult["haltReason"] | null,
    message: string,
    extra?: Record<string, unknown>,
  ): void => {
    if (!writeProgress) return;
    appendFinishLoopProgress(
      projectRoot,
      makeProgressLine({
        phase,
        iteration,
        haltReason,
        message,
        prNumber,
        grantId: null,
        queueCount: null,
        exitCode: null,
        extra,
      }),
    );
  };

  // --- Grant gate ---
  if (options.skipGrantGate !== true) {
    const gate = evaluateFinishLoopGrant({
      projectRoot,
      env: options.env,
      now: options.now,
    });
    if (!gate.allowed) {
      const message = `BLOCKED pr:finish-loop: ${gate.reason}`;
      log("gate", "grant-deny", message, { code: gate.code });
      if (writeProgress) {
        appendFinishLoopProgress(
          projectRoot,
          makeProgressLine({
            phase: "halt",
            iteration,
            haltReason:
              gate.code === "authz-grant-expired" ? "grant-expired" : "grant-missing",
            message,
            prNumber,
            grantId: gate.grantId,
            queueCount: null,
            exitCode: EXIT_BLOCKED,
          }),
        );
      }
      return {
        exitCode: EXIT_BLOCKED,
        haltReason: gate.code === "authz-grant-expired" ? "grant-expired" : "grant-missing",
        message,
        prNumber,
        watchVerdict: null,
        mergeAttempted: false,
        mergeSkippedReason: null,
        grantId: gate.grantId,
      };
    }
    log("gate", null, `grant ok: ${gate.reason}`, { grantId: gate.grantId });
  }

  // --- pr:watch ---
  const watchFn = options.watchFn ?? watch;
  const repo = options.repo ?? process.env.GH_REPO ?? null;
  let watchResult: WatchResult;
  try {
    watchResult = watchFn(prNumber, repo, {
      maxWaitMinutes: options.maxWaitMinutes,
      pollSeconds: options.pollSeconds,
      oneShot: options.oneShot === true,
    });
  } catch (err) {
    const message = `pr:finish-loop watch error: ${err instanceof Error ? err.message : String(err)}`;
    log("pr-watch", "error", message);
    return {
      exitCode: EXIT_BLOCKED,
      haltReason: "error",
      message,
      prNumber,
      watchVerdict: null,
      mergeAttempted: false,
      mergeSkippedReason: null,
      grantId: null,
    };
  }

  const verdict = watchResult.verdict;
  log("pr-watch", null, `pr:watch verdict=${verdict}`, {
    exitCode: watchResult.exitCode,
  });

  if (watchResult.exitCode === EXIT_NEW_P0_P1 || verdict === VERDICT_NEW_P0_P1) {
    const message =
      `pr:finish-loop ACTION_REQUIRED: NEW_P0_P1 on PR #${prNumber}. ` +
      "Address path is agent-orchestrated: fix findings, push, re-run " +
      "`task pr:finish-loop -- <N>` (or review-cycle skill).";
    log("address", "address-findings", message);
    return {
      exitCode: EXIT_ACTION_REQUIRED,
      haltReason: "address-findings",
      message,
      prNumber,
      watchVerdict: verdict,
      mergeAttempted: false,
      mergeSkippedReason: null,
      grantId: null,
    };
  }

  if (watchResult.exitCode !== EXIT_CLEAN && verdict !== VERDICT_CLEAN) {
    const message =
      `pr:finish-loop BLOCKED: watch exit=${watchResult.exitCode} verdict=${verdict}` +
      (watchResult.probe.error !== null ? ` error=${watchResult.probe.error}` : "");
    log("halt", "error", message);
    return {
      exitCode: EXIT_BLOCKED,
      haltReason: "error",
      message,
      prNumber,
      watchVerdict: verdict,
      mergeAttempted: false,
      mergeSkippedReason: null,
      grantId: null,
    };
  }

  // CLEAN path
  if (options.merge !== true) {
    const message =
      `pr:finish-loop CLEAN on PR #${prNumber}. Merge not requested ` +
      "(pass --merge to attempt when policy allows). " +
      "When plan.policy.requireHumanMerge is true, a human must merge.";
    log("halt", "clean", message);
    return {
      exitCode: EXIT_OK,
      haltReason: "clean",
      message,
      prNumber,
      watchVerdict: VERDICT_CLEAN,
      mergeAttempted: false,
      mergeSkippedReason: "merge-not-requested",
      grantId: null,
    };
  }

  // Respect requireHumanMerge — never force bot merge
  const agentMergeFn = options.agentMergeFn ?? evaluateAgentMerge;
  const hm = agentMergeFn(projectRoot);
  if (!hm.allowed) {
    const message =
      `pr:finish-loop CLEAN on PR #${prNumber} but merge blocked by human-merge gate: ` +
      `${hm.message} Human action required: merge in GitHub UI or ` +
      "`deft policy:allow-bot-merge -- --confirm` / DEFT_ALLOW_BOT_MERGE=1.";
    log("merge", "require-human-merge", message);
    return {
      exitCode: EXIT_ACTION_REQUIRED,
      haltReason: "require-human-merge",
      message,
      prNumber,
      watchVerdict: VERDICT_CLEAN,
      mergeAttempted: false,
      mergeSkippedReason: "require-human-merge",
      grantId: null,
    };
  }

  // Optional merge when policy allows
  if (options.mergeFn !== undefined) {
    const rc = options.mergeFn(prNumber, repo);
    if (rc === 0) {
      const message = `pr:finish-loop MERGED PR #${prNumber}`;
      log("merge", "merged", message);
      return {
        exitCode: EXIT_OK,
        haltReason: "merged",
        message,
        prNumber,
        watchVerdict: VERDICT_CLEAN,
        mergeAttempted: true,
        mergeSkippedReason: null,
        grantId: null,
      };
    }
    const message = `pr:finish-loop merge attempt failed exit=${rc} for PR #${prNumber}`;
    log("merge", "error", message);
    return {
      exitCode: EXIT_BLOCKED,
      haltReason: "error",
      message,
      prNumber,
      watchVerdict: VERDICT_CLEAN,
      mergeAttempted: true,
      mergeSkippedReason: null,
      grantId: null,
    };
  }

  // Documented agent/orchestration path when mergeFn not injected:
  // real cascade is task pr:wait-mergeable-and-merge (not inlined here to
  // keep unit tests free of gh).
  const message =
    `pr:finish-loop CLEAN on PR #${prNumber}; bot merge allowed by policy. ` +
    "Run `task pr:wait-mergeable-and-merge -- <N>` to complete merge cascade, " +
    "or pass an injected mergeFn in automation.";
  log("merge", "clean", message);
  return {
    exitCode: EXIT_OK,
    haltReason: "clean",
    message,
    prNumber,
    watchVerdict: VERDICT_CLEAN,
    mergeAttempted: false,
    mergeSkippedReason: "merge-cascade-documented",
    grantId: null,
  };
}

// silence unused EXIT_TERMINAL_ERROR import if tree-shaken — keep for docs parity
void EXIT_TERMINAL_ERROR;
