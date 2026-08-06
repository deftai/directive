/**
 * Pre-dispatch gate for delivery-attempt circuit breaker (#3143).
 *
 * Loads durable unit state and returns a single deterministic decision
 * before every delivery dispatch or retry.
 */

import { buildTerminalHandoff, nextSafeActionFor } from "./handoff.js";
import { activeAttempts, newAttemptId } from "./ledger.js";
import { evaluateMaterialProgress } from "./material-delta.js";
import type {
  DeliveryBudgetPolicy,
  DeliveryUnitLedger,
  PreDispatchDecision,
  PreDispatchDecisionEvent,
  PreDispatchInput,
  PreDispatchResult,
  ResumeCondition,
  Retryability,
} from "./types.js";
import { isAllowDecision, mergePolicy, utcIso } from "./types.js";

function decisionClass(code: PreDispatchDecision): PreDispatchDecisionEvent["decision"] {
  if (code.startsWith("ALLOW_")) return "allow";
  if (code.startsWith("DENY_")) return "deny";
  if (code.startsWith("BLOCK_")) return "block";
  return "escalate";
}

function buildEvent(
  input: PreDispatchInput,
  ledger: DeliveryUnitLedger,
  reasonCode: PreDispatchDecision,
  opts: {
    readonly retryability: Retryability | null;
    readonly fingerprint: string | null;
    readonly sameFailureCount: number;
    readonly materialClass: PreDispatchDecisionEvent["materialDeltaClassification"];
    readonly resume: ResumeCondition | null;
  },
): PreDispatchDecisionEvent {
  return {
    decision: decisionClass(reasonCode),
    reasonCode,
    retryability: opts.retryability,
    failureFingerprint: opts.fingerprint,
    attemptCount: ledger.attempts.length,
    failedAttemptCount: ledger.failedAttemptCount,
    sameFailureCount: opts.sameFailureCount,
    materialDeltaClassification: opts.materialClass,
    resumeCondition: opts.resume,
    overrideId: ledger.override?.overrideId ?? null,
    scopeId: input.scopeId,
    targetId: input.targetId,
    workflowId: input.workflowId,
    sourceRevision: input.sourceRevision,
  };
}

function result(
  input: PreDispatchInput,
  ledger: DeliveryUnitLedger,
  decision: PreDispatchDecision,
  reason: string,
  opts: {
    readonly retryability: Retryability | null;
    readonly fingerprint: string | null;
    readonly sameFailureCount: number;
    readonly materialClass: PreDispatchDecisionEvent["materialDeltaClassification"];
    readonly resume: ResumeCondition | null;
    readonly handoffLedger?: DeliveryUnitLedger;
  },
): PreDispatchResult {
  const event = buildEvent(input, ledger, decision, opts);
  const allowed = isAllowDecision(decision);
  const handoff =
    !allowed && decision.startsWith("BLOCK_")
      ? buildTerminalHandoff({
          ledger: opts.handoffLedger ?? ledger,
          decision,
          now: input.now,
        })
      : null;
  return {
    decision,
    allowed,
    reason,
    event,
    handoff,
    nextAttemptId: allowed ? newAttemptId() : null,
  };
}

function overrideUsable(ledger: DeliveryUnitLedger, nowIso: string): boolean {
  const o = ledger.override;
  if (o === null) return false;
  if (o.remainingAttempts <= 0) return false;
  if (o.expiresAt !== null && o.expiresAt < nowIso) return false;
  return true;
}

/**
 * Evaluate whether a delivery dispatch may proceed.
 *
 * Pure w.r.t. the provided ledger snapshot — callers load/save durability.
 */
export function evaluatePreDispatch(
  ledger: DeliveryUnitLedger,
  input: PreDispatchInput,
): PreDispatchResult {
  const policy: DeliveryBudgetPolicy = mergePolicy(input.policy);
  const now = utcIso(input.now);
  const anticipated = input.anticipatedFailure ?? ledger.lastFailure;
  const fingerprint = anticipated?.fingerprint ?? null;
  const sameFailureCount = fingerprint !== null ? (ledger.sameFailureCounts[fingerprint] ?? 0) : 0;
  const progress = evaluateMaterialProgress({
    claims: input.materialDelta,
    failure: anticipated,
    evaluatedRevision: input.sourceRevision,
  });

  // --- Usage budgets (elapsed / tool / token) ---
  const elapsed = ledger.totalElapsedSeconds + (input.usage?.elapsedSeconds ?? 0);
  const tools = ledger.totalToolCallCount + (input.usage?.toolCallCount ?? 0);
  const tokensFromUsage = input.usage?.hostTokenCount;
  const tokens =
    tokensFromUsage !== undefined && tokensFromUsage !== null
      ? (ledger.totalHostTokenCount ?? 0) + tokensFromUsage
      : ledger.totalHostTokenCount;

  if (elapsed >= policy.maxElapsedSeconds) {
    const resume: ResumeCondition = {
      kind: "operator-override",
      description: "elapsed budget exhausted; operator override or phase reset required",
      satisfied: false,
    };
    return result(input, ledger, "BLOCK_ELAPSED_BUDGET", "elapsed-time budget exhausted", {
      retryability: anticipated?.retryability ?? null,
      fingerprint,
      sameFailureCount,
      materialClass: progress.classification,
      resume,
      handoffLedger: {
        ...ledger,
        resumeCondition: resume,
        blockedDecision: "BLOCK_ELAPSED_BUDGET",
      },
    });
  }

  if (tools >= policy.maxToolCalls) {
    const resume: ResumeCondition = {
      kind: "operator-override",
      description: "tool-call budget exhausted; operator override or phase reset required",
      satisfied: false,
    };
    return result(input, ledger, "BLOCK_TOOL_OR_TOKEN_BUDGET", "tool-call budget exhausted", {
      retryability: anticipated?.retryability ?? null,
      fingerprint,
      sameFailureCount,
      materialClass: progress.classification,
      resume,
      handoffLedger: {
        ...ledger,
        resumeCondition: resume,
        blockedDecision: "BLOCK_TOOL_OR_TOKEN_BUDGET",
      },
    });
  }

  // Token budget only when policy sets maxHostTokens AND we have token telemetry.
  if (policy.maxHostTokens !== null && tokens !== null && tokens >= policy.maxHostTokens) {
    const resume: ResumeCondition = {
      kind: "operator-override",
      description: "host token budget exhausted; operator override or phase reset required",
      satisfied: false,
    };
    return result(input, ledger, "BLOCK_TOOL_OR_TOKEN_BUDGET", "host token budget exhausted", {
      retryability: anticipated?.retryability ?? null,
      fingerprint,
      sameFailureCount,
      materialClass: progress.classification,
      resume,
      handoffLedger: {
        ...ledger,
        resumeCondition: resume,
        blockedDecision: "BLOCK_TOOL_OR_TOKEN_BUDGET",
      },
    });
  }

  // --- Duplicate active ---
  const active = activeAttempts(ledger);
  if (active.length >= policy.maxActiveAttempts) {
    return result(
      input,
      ledger,
      "DENY_DUPLICATE_ACTIVE",
      `active attempt already exists (${active.map((a) => a.attemptId).join(", ")})`,
      {
        retryability: anticipated?.retryability ?? null,
        fingerprint,
        sameFailureCount,
        materialClass: progress.classification,
        resume: ledger.resumeCondition,
      },
    );
  }

  // --- Operator override (bounded, audited) ---
  if (overrideUsable(ledger, now)) {
    return result(
      input,
      ledger,
      "ALLOW_OVERRIDE",
      "audited operator override permits next attempt",
      {
        retryability: anticipated?.retryability ?? null,
        fingerprint,
        sameFailureCount,
        materialClass: progress.classification,
        resume: ledger.resumeCondition,
      },
    );
  }

  // --- Resume when condition satisfied ---
  if (ledger.resumeCondition?.satisfied && (input.trigger === "resume" || progress.isMaterial)) {
    return result(input, ledger, "ALLOW_RESUME", "resume condition satisfied", {
      retryability: anticipated?.retryability ?? null,
      fingerprint,
      sameFailureCount,
      materialClass: progress.classification,
      resume: ledger.resumeCondition,
    });
  }

  // --- Prior block without satisfied resume / override ---
  if (ledger.blockedDecision !== null) {
    if (!progress.isMaterial && !overrideUsable(ledger, now)) {
      const resume =
        ledger.resumeCondition ??
        ({
          kind: "material-delta",
          description: nextSafeActionFor(ledger.blockedDecision),
          satisfied: false,
        } satisfies ResumeCondition);
      return result(
        input,
        ledger,
        ledger.blockedDecision,
        "unit remains blocked from prior decision",
        {
          retryability: anticipated?.retryability ?? null,
          fingerprint,
          sameFailureCount,
          materialClass: progress.classification,
          resume,
          handoffLedger: ledger,
        },
      );
    }
  }

  // --- Aggregate failed-attempt budget ---
  if (ledger.failedAttemptCount >= policy.maxFailedAttempts && !progress.isMaterial) {
    const resume: ResumeCondition = {
      kind: "material-delta",
      description: "attempt budget exhausted; require relevant material delta or operator override",
      satisfied: false,
    };
    return result(input, ledger, "BLOCK_ATTEMPT_BUDGET", "failed-attempt budget exhausted", {
      retryability: anticipated?.retryability ?? null,
      fingerprint,
      sameFailureCount,
      materialClass: progress.classification,
      resume,
      handoffLedger: {
        ...ledger,
        resumeCondition: resume,
        blockedDecision: "BLOCK_ATTEMPT_BUDGET",
      },
    });
  }

  // --- First attempt / recovered unit (last failure cleared on success) ---
  if (ledger.attempts.length === 0) {
    return result(input, ledger, "ALLOW_FIRST_ATTEMPT", "no prior attempts for this unit", {
      retryability: null,
      fingerprint: null,
      sameFailureCount: 0,
      materialClass: progress.classification,
      resume: null,
    });
  }
  if (ledger.lastFailure === null && (anticipated === null || anticipated === undefined)) {
    return result(input, ledger, "ALLOW_FIRST_ATTEMPT", "no open failure identity for this unit", {
      retryability: null,
      fingerprint: null,
      sameFailureCount: 0,
      materialClass: progress.classification,
      resume: null,
    });
  }

  // --- Material progress opens a new evaluated attempt ---
  if (progress.isMaterial) {
    // Still respect aggregate attempt budget unless progress resets effective path.
    // Issue: relevant corrective delta allows one new evaluated attempt even after
    // same-failure history — but not after hard attempt budget without override.
    // Interpretation: material progress allows retry unless maxFailedAttempts already
    // hit AND no override. Spec case 4: "allows one new evaluated attempt".
    // Spec case 5: unrelated does not reset. Spec case 3: same failure still exhausts.
    // So material progress allows unless we're over maxFailedAttempts *and* this would
    // exceed by continuing a thrash — allow when material, block only at hard elapsed/tool.
    if (ledger.failedAttemptCount >= policy.maxFailedAttempts) {
      // Adjacent stage advancement still records progress without erasing phase budget
      // when budget already exhausted — require override for further automatic dispatch.
      // But case 8 says stage advancement records progress without erasing aggregate budget
      // — meaning counters stay, but dispatch may still be allowed if under budget.
      // When at budget, block.
      const resume: ResumeCondition = {
        kind: "operator-override",
        description: "phase attempt budget exhausted despite material progress; override required",
        satisfied: false,
      };
      return result(input, ledger, "BLOCK_ATTEMPT_BUDGET", "attempt budget exhausted (phase)", {
        retryability: anticipated?.retryability ?? null,
        fingerprint,
        sameFailureCount,
        materialClass: progress.classification,
        resume,
        handoffLedger: {
          ...ledger,
          resumeCondition: resume,
          blockedDecision: "BLOCK_ATTEMPT_BUDGET",
        },
      });
    }
    return result(input, ledger, "ALLOW_MATERIAL_PROGRESS", progress.reason, {
      retryability: anticipated?.retryability ?? null,
      fingerprint,
      sameFailureCount,
      materialClass: progress.classification,
      resume: null,
    });
  }

  // --- No material progress: classify by last/anticipated failure ---
  const retryability = anticipated?.retryability ?? "unknown";

  if (retryability === "deterministic" && policy.blockDeterministicWithoutDelta) {
    // First occurrence after a failure: sameFailureCount is count of completed
    // identical failures. Any completed deterministic failure without delta blocks.
    if (sameFailureCount >= 1 || ledger.failedAttemptCount >= 1) {
      const resume: ResumeCondition = {
        kind: "material-delta",
        description:
          "deterministic failure requires relevant material delta before automatic retry",
        satisfied: false,
      };
      const decision: PreDispatchDecision =
        sameFailureCount >= 1 ? "BLOCK_NO_MATERIAL_PROGRESS" : "BLOCK_NON_RETRYABLE";
      return result(
        input,
        ledger,
        decision,
        "deterministic failure without relevant material delta",
        {
          retryability,
          fingerprint,
          sameFailureCount,
          materialClass: progress.classification,
          resume,
          handoffLedger: {
            ...ledger,
            resumeCondition: resume,
            blockedDecision: decision,
          },
        },
      );
    }
  }

  if (retryability === "transient") {
    // Count transient failures with same fingerprint (or any last transient).
    const transientFails = ledger.attempts.filter(
      (a) =>
        a.status === "failed" &&
        a.failure !== null &&
        a.failure.retryability === "transient" &&
        (fingerprint === null || a.failure.fingerprint === fingerprint),
    ).length;
    // maxTransientRetries = max automatic retries after a transient failure
    // (1 failure → allow 1 retry when maxTransientRetries is 1).
    if (transientFails <= policy.maxTransientRetries) {
      return result(
        input,
        ledger,
        "ALLOW_TRANSIENT_RETRY",
        `transient retry ${transientFails}/${policy.maxTransientRetries}`,
        {
          retryability,
          fingerprint,
          sameFailureCount,
          materialClass: progress.classification,
          resume: null,
        },
      );
    }
    const resume: ResumeCondition = {
      kind: "material-delta",
      description: "transient retry allowance exhausted; require material change or override",
      satisfied: false,
    };
    return result(
      input,
      ledger,
      "BLOCK_NO_MATERIAL_PROGRESS",
      "transient retry allowance exhausted without recovery",
      {
        retryability,
        fingerprint,
        sameFailureCount,
        materialClass: progress.classification,
        resume,
        handoffLedger: {
          ...ledger,
          resumeCondition: resume,
          blockedDecision: "BLOCK_NO_MATERIAL_PROGRESS",
        },
      },
    );
  }

  // unknown
  if (sameFailureCount >= policy.maxUnknownWithoutProgress) {
    const resume: ResumeCondition = {
      kind: "material-delta",
      description: "repeated unknown failure without material progress",
      satisfied: false,
    };
    return result(
      input,
      ledger,
      "BLOCK_REPEATED_UNKNOWN",
      `identical unknown failure count ${sameFailureCount} >= ${policy.maxUnknownWithoutProgress}`,
      {
        retryability,
        fingerprint,
        sameFailureCount,
        materialClass: progress.classification,
        resume,
        handoffLedger: {
          ...ledger,
          resumeCondition: resume,
          blockedDecision: "BLOCK_REPEATED_UNKNOWN",
        },
      },
    );
  }

  // First unknown after one failure: allow only if we have zero sameFailureCount
  // (shouldn't happen if we failed once) — after first unknown fail, count is 1;
  // threshold 2 means second identical unknown blocks, so one more attempt is allowed
  // when sameFailureCount is 1? Spec: "Two identical unknown failures without material
  // progress produce BLOCK_REPEATED_UNKNOWN". So after 2 completed identical unknowns,
  // next dispatch blocks. When sameFailureCount is 1, we can allow one more attempt.
  if (sameFailureCount < policy.maxUnknownWithoutProgress && ledger.failedAttemptCount > 0) {
    if (ledger.failedAttemptCount >= policy.maxFailedAttempts) {
      const resume: ResumeCondition = {
        kind: "material-delta",
        description: "attempt budget exhausted",
        satisfied: false,
      };
      return result(input, ledger, "BLOCK_ATTEMPT_BUDGET", "failed-attempt budget exhausted", {
        retryability,
        fingerprint,
        sameFailureCount,
        materialClass: progress.classification,
        resume,
        handoffLedger: {
          ...ledger,
          resumeCondition: resume,
          blockedDecision: "BLOCK_ATTEMPT_BUDGET",
        },
      });
    }
    // Allow another attempt toward the unknown threshold (e.g. second try after first unknown).
    return result(
      input,
      ledger,
      "ALLOW_TRANSIENT_RETRY",
      `unknown failure under threshold (${sameFailureCount}/${policy.maxUnknownWithoutProgress})`,
      {
        retryability,
        fingerprint,
        sameFailureCount,
        materialClass: progress.classification,
        resume: null,
      },
    );
  }

  // Fallback first path
  return result(input, ledger, "ALLOW_FIRST_ATTEMPT", "default first-path allow", {
    retryability: anticipated?.retryability ?? null,
    fingerprint,
    sameFailureCount,
    materialClass: progress.classification,
    resume: null,
  });
}

/**
 * Convenience: evaluate against ledger, and if blocked, return handoff suitable
 * for persistence via markBlocked + saveUnitLedger.
 */
export function evaluateAndPrepareBlock(
  ledger: DeliveryUnitLedger,
  input: PreDispatchInput,
): {
  readonly evaluation: PreDispatchResult;
  readonly ledger: DeliveryUnitLedger;
} {
  const evaluation = evaluatePreDispatch(ledger, input);
  if (!evaluation.allowed && evaluation.handoff !== null) {
    return {
      evaluation,
      ledger: {
        ...ledger,
        blockedDecision: evaluation.decision,
        resumeCondition: evaluation.handoff.resumeCondition,
        updatedAt: utcIso(input.now),
      },
    };
  }
  return { evaluation, ledger };
}
