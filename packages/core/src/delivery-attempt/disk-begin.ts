/**
 * Disk-safe begin under exclusive unit lock (#3143).
 *
 * Lives outside ledger.ts so it can import evaluatePreDispatch without a cycle
 * (evaluate → ledger helpers; disk-begin → evaluate + ledger).
 */

import { evaluatePreDispatch } from "./evaluate.js";
import {
  beginAttempt,
  completeAttempt,
  loadOrCreateUnitLedger,
  loadUnitLedger,
  markBlocked,
  saveUnitLedger,
  withUnitLock,
} from "./ledger.js";
import type {
  AttemptTrigger,
  DeliveryAttemptRecord,
  DeliveryBudgetPolicy,
  DeliveryUnitLedger,
  FailureInfo,
  MaterialDeltaClaim,
} from "./types.js";

export interface BeginAttemptOnDiskInput {
  readonly scopeId: string;
  readonly targetId: string;
  readonly workflowId: string;
  readonly phaseId?: string;
  readonly attemptId?: string;
  readonly sourceRevision: string;
  readonly trigger: AttemptTrigger;
  readonly status?: "queued" | "running";
  readonly workerId?: string | null;
  readonly externalRunId?: string | null;
  readonly materialDelta?: readonly MaterialDeltaClaim[];
  readonly anticipatedFailure?: FailureInfo | null;
  readonly now?: string;
  readonly policy?: Partial<DeliveryBudgetPolicy>;
}

/**
 * Exclusive lock + reload + full pre-dispatch re-evaluation + begin+save.
 * Prevents concurrent workers from racing past empty/active or blocked state.
 */
export function beginAttemptOnDisk(
  projectRoot: string,
  input: BeginAttemptOnDiskInput,
): { ledger: DeliveryUnitLedger; attempt: DeliveryAttemptRecord } {
  return withUnitLock(projectRoot, input.scopeId, input.targetId, input.workflowId, () => {
    const current = loadOrCreateUnitLedger(projectRoot, {
      scopeId: input.scopeId,
      targetId: input.targetId,
      workflowId: input.workflowId,
      phaseId: input.phaseId,
      now: input.now,
    });
    const decision = evaluatePreDispatch(current, {
      scopeId: input.scopeId,
      targetId: input.targetId,
      workflowId: input.workflowId,
      phaseId: input.phaseId,
      sourceRevision: input.sourceRevision,
      trigger: input.trigger,
      materialDelta: input.materialDelta,
      anticipatedFailure: input.anticipatedFailure,
      now: input.now,
      policy: input.policy,
    });
    if (!decision.allowed) {
      if (decision.handoff !== null) {
        const blocked = markBlocked(
          current,
          decision.decision,
          decision.handoff.resumeCondition,
          input.now,
        );
        saveUnitLedger(projectRoot, blocked);
      }
      throw new Error(`delivery-attempt ${decision.decision}: ${decision.reason}`);
    }
    const { ledger, attempt } = beginAttempt(current, {
      ...input,
      // Only burn override quota when the gate decision required it.
      consumeOverride: decision.decision === "ALLOW_OVERRIDE",
    });
    saveUnitLedger(projectRoot, ledger);
    return { ledger, attempt };
  });
}

export interface CompleteAttemptOnDiskInput {
  readonly scopeId: string;
  readonly targetId: string;
  readonly workflowId: string;
  readonly attemptId?: string;
  readonly externalRunId?: string | null;
  readonly status: "succeeded" | "failed" | "cancelled" | "blocked";
  readonly failure?: FailureInfo | null;
  readonly materialDelta?: readonly MaterialDeltaClaim[];
  readonly elapsedSeconds?: number;
  readonly toolCallCount?: number;
  readonly hostTokenCount?: number | null;
  readonly now?: string;
}

/**
 * Exclusive lock + reload + complete + save so completion cannot clobber a
 * concurrent begin write (#3143 Greptile race diagram).
 */
export function completeAttemptOnDisk(
  projectRoot: string,
  input: CompleteAttemptOnDiskInput,
): DeliveryUnitLedger {
  return withUnitLock(projectRoot, input.scopeId, input.targetId, input.workflowId, () => {
    const current =
      loadUnitLedger(projectRoot, input.scopeId, input.targetId, input.workflowId) ??
      loadOrCreateUnitLedger(projectRoot, {
        scopeId: input.scopeId,
        targetId: input.targetId,
        workflowId: input.workflowId,
        now: input.now,
      });
    const next = completeAttempt(current, input);
    saveUnitLedger(projectRoot, next);
    return next;
  });
}
