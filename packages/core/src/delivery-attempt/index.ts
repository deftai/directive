/**
 * Delivery-attempt material-progress circuit breaker (#3143).
 *
 * Deterministic pre-dispatch gate + durable unit ledger for autonomous
 * delivery and operational-acceptance loops. Implements the mechanical
 * enforcement surface for the delivery/acceptance subset of dual-stop (#2442).
 *
 * @see content/docs/delivery-attempt.md
 */

export {
  evaluateAndPrepareBlock,
  evaluatePreDispatch,
} from "./evaluate.js";
export {
  buildFailureInfo,
  computeFailureFingerprint,
  type FingerprintInput,
  inferRetryability,
  normalizeFailureMessage,
} from "./fingerprint.js";
export {
  buildTerminalHandoff,
  defaultResumeFor,
  formatHandoffReport,
  nextSafeActionFor,
  redactHandoffForPersist,
} from "./handoff.js";
export {
  activeAttempts,
  beginAttempt,
  clearBlockIfResumed,
  completeAttempt,
  deliveryAttemptsDir,
  emptyUnitLedger,
  hasActiveAttempt,
  listUnitLedgers,
  loadOrCreateUnitLedger,
  loadUnitLedger,
  MemoryLedgerStore,
  markBlocked,
  newAttemptId,
  parseUnitLedger,
  recordOperatorOverride,
  saveUnitLedger,
  unitLedgerFilename,
  unitLedgerPath,
} from "./ledger.js";
export {
  evaluateMaterialProgress,
  isRevisionChangeMaterial,
  type MaterialProgressResult,
} from "./material-delta.js";

export {
  ATTEMPT_STATUSES,
  ATTEMPT_TRIGGERS,
  type AttemptStatus,
  type AttemptTrigger,
  DEFAULT_DELIVERY_BUDGET_POLICY,
  DELIVERY_ATTEMPT_DIR,
  DELIVERY_ATTEMPT_SCHEMA_VERSION,
  type DeliveryAttemptRecord,
  type DeliveryBudgetPolicy,
  type DeliveryUnitLedger,
  deliveryUnitKey,
  type FailureInfo,
  isAllowDecision,
  isBlockDecision,
  isDenyDecision,
  MATERIAL_DELTA_KINDS,
  type MaterialDeltaClaim,
  type MaterialDeltaKind,
  mergePolicy,
  type OperatorOverride,
  PRE_DISPATCH_DECISIONS,
  type PreDispatchDecision,
  type PreDispatchDecisionEvent,
  type PreDispatchInput,
  type PreDispatchResult,
  RETRYABILITY,
  type ResumeCondition,
  type Retryability,
  type TerminalHandoff,
  utcIso,
} from "./types.js";
