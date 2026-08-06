/**
 * Delivery-attempt ledger and pre-dispatch circuit breaker (#3143).
 *
 * Durable attempt state for autonomous delivery / operational-acceptance
 * loops. Enforcement is mechanical — not prompt-only dual-stop defaults (#2442).
 */

/** Schema version for on-disk unit ledgers. */
export const DELIVERY_ATTEMPT_SCHEMA_VERSION = 1 as const;

/** Default ledger directory under project root. */
export const DELIVERY_ATTEMPT_DIR = ".deft/delivery-attempts";

export const ATTEMPT_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "blocked",
] as const;

export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const ATTEMPT_TRIGGERS = ["automatic", "manual", "retry", "resume", "override"] as const;

export type AttemptTrigger = (typeof ATTEMPT_TRIGGERS)[number];

export const RETRYABILITY = ["transient", "deterministic", "unknown"] as const;

export type Retryability = (typeof RETRYABILITY)[number];

export const MATERIAL_DELTA_KINDS = [
  "code",
  "configuration",
  "evidence",
  "external-state",
  "stage",
  "none",
  "unrelated",
] as const;

export type MaterialDeltaKind = (typeof MATERIAL_DELTA_KINDS)[number];

/** Pre-dispatch decision codes from issue #3143 expected behavior. */
export const PRE_DISPATCH_DECISIONS = [
  "ALLOW_FIRST_ATTEMPT",
  "ALLOW_TRANSIENT_RETRY",
  "ALLOW_MATERIAL_PROGRESS",
  "ALLOW_OVERRIDE",
  "ALLOW_RESUME",
  "DENY_DUPLICATE_ACTIVE",
  "BLOCK_NON_RETRYABLE",
  "BLOCK_NO_MATERIAL_PROGRESS",
  "BLOCK_REPEATED_UNKNOWN",
  "BLOCK_ATTEMPT_BUDGET",
  "BLOCK_ELAPSED_BUDGET",
  "BLOCK_TOOL_OR_TOKEN_BUDGET",
] as const;

export type PreDispatchDecision = (typeof PRE_DISPATCH_DECISIONS)[number];

export function isAllowDecision(decision: PreDispatchDecision): boolean {
  return decision.startsWith("ALLOW_");
}

export function isBlockDecision(decision: PreDispatchDecision): boolean {
  return decision.startsWith("BLOCK_");
}

export function isDenyDecision(decision: PreDispatchDecision): boolean {
  return decision.startsWith("DENY_");
}

/** Normalized failure identity (no secrets / raw logs). */
export interface FailureInfo {
  readonly stage: string;
  readonly code: string | null;
  /** Stable redacted digest of stage + code + normalized message class. */
  readonly fingerprint: string;
  readonly retryability: Retryability;
  /** Optional invariant / resource class implicated by the failure. */
  readonly resourceClass?: string | null;
}

/** One material-delta claim attached to an attempt or revision. */
export interface MaterialDeltaClaim {
  readonly kind: MaterialDeltaKind;
  /**
   * Resource / component classes the delta addresses (matched against
   * failure.resourceClass or fingerprint stages for relevance).
   */
  readonly addresses: readonly string[];
  /** Source revision the delta was observed for (source-bound evidence). */
  readonly sourceRevision: string;
  readonly note?: string | null;
}

/** Single attempt row in a unit ledger. */
export interface DeliveryAttemptRecord {
  readonly attemptId: string;
  readonly sourceRevision: string;
  readonly trigger: AttemptTrigger;
  readonly status: AttemptStatus;
  readonly failure: FailureInfo | null;
  readonly materialDelta: readonly MaterialDeltaClaim[];
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly elapsedSeconds: number;
  readonly toolCallCount: number;
  /** Host token usage when exposed; null when telemetry unavailable. */
  readonly hostTokenCount: number | null;
  readonly workerId: string | null;
  /** External run id for interrupted-run reconciliation. */
  readonly externalRunId: string | null;
}

/** Audited operator override — does not erase history. */
export interface OperatorOverride {
  readonly overrideId: string;
  readonly actor: string;
  readonly rationale: string;
  readonly recordedAt: string;
  /** Bounded: permits this many additional automatic attempts. */
  readonly allowedAttempts: number;
  readonly expiresAt: string | null;
  readonly remainingAttempts: number;
}

/** Resume condition that re-enables automatic dispatch. */
export interface ResumeCondition {
  readonly kind: "material-delta" | "external-state" | "operator-override" | "monitor-wake";
  readonly description: string;
  readonly satisfied: boolean;
}

/**
 * Durable unit ledger keyed by scopeId + targetId + workflowId.
 * Survives worker replacement, session restart, compaction, and new revisions.
 */
export interface DeliveryUnitLedger {
  readonly schemaVersion: typeof DELIVERY_ATTEMPT_SCHEMA_VERSION;
  readonly scopeId: string;
  readonly targetId: string;
  readonly workflowId: string;
  readonly phaseId: string;
  readonly attempts: readonly DeliveryAttemptRecord[];
  /** Aggregate failed dispatch count in this delivery/acceptance phase. */
  readonly failedAttemptCount: number;
  /** Per-fingerprint identical-failure counts (carry across revisions). */
  readonly sameFailureCounts: Readonly<Record<string, number>>;
  /** Cumulative elapsed seconds across attempts in this phase. */
  readonly totalElapsedSeconds: number;
  readonly totalToolCallCount: number;
  readonly totalHostTokenCount: number | null;
  readonly lastFailure: FailureInfo | null;
  readonly lastMaterialDelta: readonly MaterialDeltaClaim[];
  readonly lastSourceRevision: string | null;
  readonly blockedDecision: PreDispatchDecision | null;
  readonly resumeCondition: ResumeCondition | null;
  readonly override: OperatorOverride | null;
  readonly updatedAt: string;
}

/** Conservative autonomous-delivery defaults from issue #3143. */
export interface DeliveryBudgetPolicy {
  /** Max queued+running attempts per unit (default 1). */
  readonly maxActiveAttempts: number;
  /** Max automatic retries after a transient failure (default 1). */
  readonly maxTransientRetries: number;
  /**
   * Identical unknown failures without material progress that block
   * (default 2 → second identical unknown blocks).
   */
  readonly maxUnknownWithoutProgress: number;
  /** Failed dispatches in one phase before BLOCK_ATTEMPT_BUDGET (default 3). */
  readonly maxFailedAttempts: number;
  /** Hard wall-clock budget in seconds (default 3600). */
  readonly maxElapsedSeconds: number;
  /** Hard tool-call budget (default 500). */
  readonly maxToolCalls: number;
  /**
   * Host token budget when telemetry is available; null = do not enforce
   * token budget (elapsed/tool-call still apply).
   */
  readonly maxHostTokens: number | null;
  /**
   * When true, deterministic failures never get automatic retry without
   * relevant material delta (default true).
   */
  readonly blockDeterministicWithoutDelta: boolean;
}

export const DEFAULT_DELIVERY_BUDGET_POLICY: DeliveryBudgetPolicy = {
  maxActiveAttempts: 1,
  maxTransientRetries: 1,
  maxUnknownWithoutProgress: 2,
  maxFailedAttempts: 3,
  maxElapsedSeconds: 3600,
  maxToolCalls: 500,
  maxHostTokens: null,
  blockDeterministicWithoutDelta: true,
};

/** Input for a pre-dispatch evaluation. */
export interface PreDispatchInput {
  readonly scopeId: string;
  readonly targetId: string;
  readonly workflowId: string;
  readonly phaseId?: string;
  readonly sourceRevision: string;
  readonly trigger: AttemptTrigger;
  /** Optional predicted / prior failure class for same-fingerprint checks. */
  readonly anticipatedFailure?: FailureInfo | null;
  /** Material delta claimed for this dispatch relative to last failure. */
  readonly materialDelta?: readonly MaterialDeltaClaim[];
  /** Current cumulative usage when re-entering after a partial run. */
  readonly usage?: {
    readonly elapsedSeconds?: number;
    readonly toolCallCount?: number;
    readonly hostTokenCount?: number | null;
  };
  readonly policy?: Partial<DeliveryBudgetPolicy>;
  /** ISO now override for tests. */
  readonly now?: string;
}

/** Structured decision event for observability (#3143 Observability). */
export interface PreDispatchDecisionEvent {
  readonly decision: "allow" | "deny" | "block" | "escalate";
  readonly reasonCode: PreDispatchDecision;
  readonly retryability: Retryability | null;
  readonly failureFingerprint: string | null;
  readonly attemptCount: number;
  readonly failedAttemptCount: number;
  readonly sameFailureCount: number;
  readonly materialDeltaClassification: MaterialDeltaKind | "none";
  readonly resumeCondition: ResumeCondition | null;
  readonly overrideId: string | null;
  readonly scopeId: string;
  readonly targetId: string;
  readonly workflowId: string;
  readonly sourceRevision: string;
}

export interface PreDispatchResult {
  readonly decision: PreDispatchDecision;
  readonly allowed: boolean;
  readonly reason: string;
  readonly event: PreDispatchDecisionEvent;
  readonly handoff: TerminalHandoff | null;
  /** Suggested next attempt id when allowed (caller may override). */
  readonly nextAttemptId: string | null;
}

/** Terminal handoff contract when the circuit breaker blocks. */
export interface TerminalHandoff {
  readonly schemaVersion: 1;
  readonly scopeId: string;
  readonly targetId: string;
  readonly workflowId: string;
  readonly lastSourceRevision: string | null;
  readonly failure: FailureInfo | null;
  readonly totalAttempts: number;
  readonly failedAttemptCount: number;
  readonly sameFailureCount: number;
  readonly elapsedSeconds: number;
  readonly toolCallCount: number;
  readonly hostTokenCount: number | null;
  readonly lastMaterialDelta: readonly MaterialDeltaClaim[];
  readonly denyReason: PreDispatchDecision;
  readonly nextSafeAction: string;
  readonly resumeCondition: ResumeCondition;
  readonly overridePermitted: boolean;
  readonly recordedAt: string;
}

export function deliveryUnitKey(scopeId: string, targetId: string, workflowId: string): string {
  return `${scopeId}\u001f${targetId}\u001f${workflowId}`;
}

export function utcIso(now?: Date | string): string {
  if (typeof now === "string" && now.length > 0) {
    return now.endsWith("Z") ? now.replace(/\.\d{3}Z$/, "Z") : now;
  }
  const dt = now instanceof Date ? now : new Date();
  return dt.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function mergePolicy(partial?: Partial<DeliveryBudgetPolicy>): DeliveryBudgetPolicy {
  return { ...DEFAULT_DELIVERY_BUDGET_POLICY, ...partial };
}
