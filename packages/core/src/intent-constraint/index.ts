export { newFacts, uncoveredDeltas } from "./diff.js";
export {
  type EvaluateOptions,
  type EvaluateResult,
  evaluateIntentConstraint,
  resolveMergeBase,
} from "./evaluate.js";
export {
  extractConstraintFacts,
  extractSurface,
  isProductionSourcePath,
  surfaceSnapshot,
} from "./extract.js";
export {
  buildIntentConstraintRecord,
  computeContractDigest,
  extractIntentConstraintFromPlan,
  intentConstraintDir,
  intentConstraintRecordPath,
  intentConstraintRecordRel,
  parseIntentConstraintContract,
  parseIntentConstraintRecord,
  writeIntentConstraintRecord,
} from "./mint.js";
export {
  FACT_KINDS,
  type FactKind,
  INTENT_CONSTRAINT_DIR,
  INTENT_CONSTRAINT_PLAN_KEY,
  INTENT_CONSTRAINT_RECORD_SCHEMA,
  INTENT_CONSTRAINT_REMEDIATION,
  type IntentConstraintFinding,
  type IntentConstraintRecord,
  type MintConstraint,
  REJECTION_SCOPES,
  type RejectionScope,
  type SurfaceSnapshot,
} from "./types.js";
