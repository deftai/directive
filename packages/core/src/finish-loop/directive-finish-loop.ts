/**
 * directive:finish-loop — outer walk-away cascade (#871 Wave 5).
 *
 * 1. Gate on finish-loop human-origin grant (or DEFT_ALLOW_FINISH_LOOP)
 * 2. Scan xbrief queue (active/pending)
 * 3. Append progress JSONL each iteration
 * 4. When --pr supplied, run pr:finish-loop
 * 5. Implementation steps are agent-owned: CLI emits AGENT_STEP and exits
 *    ACTION_REQUIRED so a live agent continues; full autonomous coding is
 *    not inlined in the Taskfile.
 *
 * Halt: empty queue | grant expiry/deny | max iterations | gate deny
 */

import { evaluateFinishLoopGrant } from "./grant-gate.js";
import { type PrFinishLoopOptions, runPrFinishLoop } from "./pr-finish-loop.js";
import { appendFinishLoopProgress, finishLoopProgressPath, makeProgressLine } from "./progress.js";
import { scanFinishLoopQueue } from "./queue.js";
import {
  type DirectiveFinishLoopResult,
  EXIT_ACTION_REQUIRED,
  EXIT_BLOCKED,
  EXIT_OK,
  type FinishLoopHaltReason,
} from "./types.js";

export const DEFAULT_MAX_ITERATIONS = 20;

export interface DirectiveFinishLoopOptions {
  readonly projectRoot: string;
  /** Optional PR number to shepherd via pr:finish-loop this iteration. */
  readonly prNumber?: number | null;
  readonly repo?: string | null;
  readonly maxIterations?: number;
  readonly maxWaitMinutes?: number;
  readonly pollSeconds?: number;
  readonly oneShot?: boolean;
  readonly merge?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: Date;
  readonly skipGrantGate?: boolean;
  /** Inject for tests. */
  readonly scanQueueFn?: typeof scanFinishLoopQueue;
  readonly prFinishLoopFn?: (opts: PrFinishLoopOptions) => ReturnType<typeof runPrFinishLoop>;
  readonly writeProgress?: boolean;
}

export function runDirectiveFinishLoop(
  options: DirectiveFinishLoopOptions,
): DirectiveFinishLoopResult {
  const projectRoot = options.projectRoot;
  const progressPath = finishLoopProgressPath(projectRoot);
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const writeProgress = options.writeProgress !== false;
  const scan = options.scanQueueFn ?? scanFinishLoopQueue;
  const prLoop = options.prFinishLoopFn ?? runPrFinishLoop;

  const progress = (
    phase: "gate" | "queue-scan" | "implement" | "pr-watch" | "merge" | "halt",
    iteration: number,
    haltReason: FinishLoopHaltReason | null,
    message: string,
    fields: {
      grantId?: string | null;
      queueCount?: number | null;
      exitCode?: number | null;
      prNumber?: number | null;
      extra?: Record<string, unknown>;
    } = {},
  ): void => {
    if (!writeProgress) return;
    appendFinishLoopProgress(
      projectRoot,
      makeProgressLine({
        phase,
        iteration,
        haltReason,
        message,
        prNumber: fields.prNumber ?? options.prNumber ?? null,
        grantId: fields.grantId ?? null,
        queueCount: fields.queueCount ?? null,
        exitCode: fields.exitCode ?? null,
        extra: fields.extra,
      }),
    );
  };

  // --- Gate ---
  let grantId: string | null = null;
  if (options.skipGrantGate !== true) {
    const gate = evaluateFinishLoopGrant({
      projectRoot,
      env: options.env,
      now: options.now,
    });
    if (!gate.allowed) {
      const haltReason: FinishLoopHaltReason =
        gate.code === "authz-grant-expired" ? "grant-expired" : "grant-missing";
      const message = `BLOCKED directive:finish-loop: ${gate.reason}`;
      progress("gate", 0, haltReason, message, {
        grantId: gate.grantId,
        exitCode: EXIT_BLOCKED,
      });
      return {
        exitCode: EXIT_BLOCKED,
        haltReason,
        message,
        iterations: 0,
        queueCount: 0,
        grantId: gate.grantId,
        progressPath,
      };
    }
    grantId = gate.grantId;
    progress("gate", 0, null, `grant ok: ${gate.reason}`, { grantId });
  }

  let lastQueueCount = 0;
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    // Re-check grant each iteration (expiry mid-loop)
    if (options.skipGrantGate !== true) {
      const gate = evaluateFinishLoopGrant({
        projectRoot,
        env: options.env,
        now: options.now,
      });
      if (!gate.allowed) {
        const haltReason: FinishLoopHaltReason =
          gate.code === "authz-grant-expired" ? "grant-expired" : "grant-deny";
        const message = `BLOCKED directive:finish-loop mid-loop: ${gate.reason}`;
        progress("halt", iteration, haltReason, message, {
          grantId: gate.grantId,
          exitCode: EXIT_BLOCKED,
          queueCount: lastQueueCount,
        });
        return {
          exitCode: EXIT_BLOCKED,
          haltReason,
          message,
          iterations: iteration,
          queueCount: lastQueueCount,
          grantId: gate.grantId,
          progressPath,
        };
      }
      grantId = gate.grantId;
    }

    const queue = scan(projectRoot);
    lastQueueCount = queue.length;
    progress("queue-scan", iteration, null, `queue count=${queue.length}`, {
      grantId,
      queueCount: queue.length,
    });

    if (queue.length === 0 && (options.prNumber === null || options.prNumber === undefined)) {
      const message =
        "directive:finish-loop complete: empty scope queue (no active/pending xBRIEF work).";
      progress("halt", iteration, "empty-queue", message, {
        grantId,
        queueCount: 0,
        exitCode: EXIT_OK,
      });
      return {
        exitCode: EXIT_OK,
        haltReason: "empty-queue",
        message,
        iterations: iteration,
        queueCount: 0,
        grantId,
        progressPath,
      };
    }

    // Optional PR shepherd
    if (options.prNumber !== null && options.prNumber !== undefined) {
      const prResult = prLoop({
        projectRoot,
        prNumber: options.prNumber,
        repo: options.repo,
        maxWaitMinutes: options.maxWaitMinutes,
        pollSeconds: options.pollSeconds,
        oneShot: options.oneShot,
        merge: options.merge,
        skipGrantGate: true, // already gated
        env: options.env,
        now: options.now,
        writeProgress,
        iteration,
      });
      progress("pr-watch", iteration, prResult.haltReason, prResult.message, {
        grantId,
        queueCount: queue.length,
        exitCode: prResult.exitCode,
        prNumber: options.prNumber,
      });

      if (prResult.haltReason === "address-findings") {
        return {
          exitCode: EXIT_ACTION_REQUIRED,
          haltReason: "address-findings",
          message: prResult.message,
          iterations: iteration,
          queueCount: queue.length,
          grantId,
          progressPath,
        };
      }
      if (prResult.haltReason === "require-human-merge") {
        return {
          exitCode: EXIT_ACTION_REQUIRED,
          haltReason: "require-human-merge",
          message: prResult.message,
          iterations: iteration,
          queueCount: queue.length,
          grantId,
          progressPath,
        };
      }
      if (prResult.exitCode === EXIT_BLOCKED) {
        return {
          exitCode: EXIT_BLOCKED,
          haltReason: prResult.haltReason,
          message: prResult.message,
          iterations: iteration,
          queueCount: queue.length,
          grantId,
          progressPath,
        };
      }
      // CLEAN / MERGED with empty queue → done
      if (queue.length === 0) {
        const message = `directive:finish-loop done after PR #${options.prNumber}: ${prResult.haltReason}`;
        progress("halt", iteration, prResult.haltReason, message, {
          grantId,
          queueCount: 0,
          exitCode: EXIT_OK,
          prNumber: options.prNumber,
        });
        return {
          exitCode: EXIT_OK,
          haltReason: prResult.haltReason,
          message,
          iterations: iteration,
          queueCount: 0,
          grantId,
          progressPath,
        };
      }
    }

    // Agent-owned implement step when queue non-empty
    if (queue.length > 0) {
      const top = queue[0];
      const message =
        `AGENT_STEP directive:finish-loop iteration=${iteration}: ` +
        `${queue.length} scope item(s) remain (next: ${top?.name ?? "?"}). ` +
        "Implementation is agent-orchestrated: promote/activate story, implement, " +
        "open PR, then re-run `task directive:finish-loop` / `task pr:finish-loop -- <N>`. " +
        "Gates already verified finish-loop grant for edit/push/pr/merge.";
      progress("implement", iteration, "agent-implement", message, {
        grantId,
        queueCount: queue.length,
        exitCode: EXIT_ACTION_REQUIRED,
        extra: { nextPath: top?.path },
      });
      return {
        exitCode: EXIT_ACTION_REQUIRED,
        haltReason: "agent-implement",
        message,
        iterations: iteration,
        queueCount: queue.length,
        grantId,
        progressPath,
      };
    }
  }

  const message =
    `directive:finish-loop halted: max iterations (${maxIterations}) reached ` +
    `with queueCount=${lastQueueCount}.`;
  progress("halt", maxIterations, "max-iterations", message, {
    grantId,
    queueCount: lastQueueCount,
    exitCode: EXIT_BLOCKED,
  });
  return {
    exitCode: EXIT_BLOCKED,
    haltReason: "max-iterations",
    message,
    iterations: maxIterations,
    queueCount: lastQueueCount,
    grantId,
    progressPath,
  };
}
