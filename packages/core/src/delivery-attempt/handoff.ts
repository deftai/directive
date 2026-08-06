/**
 * Terminal handoff contract for blocked delivery attempts (#3143).
 *
 * Persisted before the worker exits so a successor cannot restart an
 * exhausted loop. Excludes raw secret-bearing logs.
 */

import type {
  DeliveryUnitLedger,
  PreDispatchDecision,
  ResumeCondition,
  TerminalHandoff,
} from "./types.js";
import { utcIso } from "./types.js";

export function nextSafeActionFor(decision: PreDispatchDecision): string {
  switch (decision) {
    case "DENY_DUPLICATE_ACTIVE":
      return "Wait for the active attempt to finish or cancel it; do not start a duplicate dispatch.";
    case "BLOCK_NON_RETRYABLE":
      return "Fix the deterministic configuration/schema/permission failure, record a relevant material delta, then resume.";
    case "BLOCK_NO_MATERIAL_PROGRESS":
      return "Change code/config/evidence that addresses the failing invariant, or record an audited operator override.";
    case "BLOCK_REPEATED_UNKNOWN":
      return "Investigate the unknown failure class with fresh evidence; do not auto-retry until a material delta or override is recorded.";
    case "BLOCK_ATTEMPT_BUDGET":
      return "Phase attempt budget exhausted. Rescope, abandon, or record a bounded operator override with rationale.";
    case "BLOCK_ELAPSED_BUDGET":
      return "Elapsed-time budget exhausted. Suspend-and-wake monitoring preferred over polling; override only with audit.";
    case "BLOCK_TOOL_OR_TOKEN_BUDGET":
      return "Tool-call or token budget exhausted. Halt automatic dispatch; operator decides override or abandon.";
    default:
      return "Halt automatic re-dispatch; review ledger and decide next human action.";
  }
}

export function defaultResumeFor(decision: PreDispatchDecision): ResumeCondition {
  if (decision === "DENY_DUPLICATE_ACTIVE") {
    return {
      kind: "monitor-wake",
      description: "active attempt reaches a terminal status",
      satisfied: false,
    };
  }
  if (decision === "BLOCK_ELAPSED_BUDGET" || decision === "BLOCK_TOOL_OR_TOKEN_BUDGET") {
    return {
      kind: "operator-override",
      description: "audited operator override or phase budget reset",
      satisfied: false,
    };
  }
  return {
    kind: "material-delta",
    description: nextSafeActionFor(decision),
    satisfied: false,
  };
}

export function buildTerminalHandoff(options: {
  readonly ledger: DeliveryUnitLedger;
  readonly decision: PreDispatchDecision;
  readonly now?: string;
  readonly overridePermitted?: boolean;
}): TerminalHandoff {
  const { ledger, decision } = options;
  const fingerprint = ledger.lastFailure?.fingerprint ?? null;
  const sameFailureCount = fingerprint !== null ? (ledger.sameFailureCounts[fingerprint] ?? 0) : 0;
  const resume = ledger.resumeCondition ?? defaultResumeFor(decision);

  return {
    schemaVersion: 1,
    scopeId: ledger.scopeId,
    targetId: ledger.targetId,
    workflowId: ledger.workflowId,
    lastSourceRevision: ledger.lastSourceRevision,
    failure: ledger.lastFailure,
    totalAttempts: ledger.attempts.length,
    failedAttemptCount: ledger.failedAttemptCount,
    sameFailureCount,
    elapsedSeconds: ledger.totalElapsedSeconds,
    toolCallCount: ledger.totalToolCallCount,
    hostTokenCount: ledger.totalHostTokenCount,
    lastMaterialDelta: ledger.lastMaterialDelta,
    denyReason: decision,
    nextSafeAction: nextSafeActionFor(decision),
    resumeCondition: resume,
    overridePermitted: options.overridePermitted !== false,
    recordedAt: utcIso(options.now),
  };
}

/**
 * Human-readable halt report (operator-visible). No secret fields.
 */
export function formatHandoffReport(handoff: TerminalHandoff): string {
  const lines = [
    "BLOCKED: delivery-attempt circuit breaker (#3143)",
    `scope=${handoff.scopeId} target=${handoff.targetId} workflow=${handoff.workflowId}`,
    `revision=${handoff.lastSourceRevision ?? "n/a"}`,
    `decision=${handoff.denyReason}`,
    `attempts=${handoff.totalAttempts} failed=${handoff.failedAttemptCount} sameFailure=${handoff.sameFailureCount}`,
    `elapsedSeconds=${handoff.elapsedSeconds} toolCalls=${handoff.toolCallCount} hostTokens=${handoff.hostTokenCount ?? "n/a"}`,
  ];
  if (handoff.failure) {
    lines.push(
      `failure.stage=${handoff.failure.stage} code=${handoff.failure.code ?? "n/a"} retryability=${handoff.failure.retryability}`,
      `failure.fingerprint=${handoff.failure.fingerprint}`,
    );
  }
  lines.push(
    `materialDelta=${handoff.lastMaterialDelta.map((d) => d.kind).join(",") || "none"}`,
    `nextSafeAction=${handoff.nextSafeAction}`,
    `resume=${handoff.resumeCondition.kind}: ${handoff.resumeCondition.description}`,
    `overridePermitted=${handoff.overridePermitted}`,
  );
  return lines.join("\n");
}

/**
 * Strip any accidental secret-like keys from a handoff-shaped object before persist.
 * Defense in depth — ledger fields are already structured.
 */
export function redactHandoffForPersist(handoff: TerminalHandoff): TerminalHandoff {
  // TerminalHandoff has no free-form log fields; return as-is for type stability.
  // Callers must not attach raw logs to this object.
  return handoff;
}
