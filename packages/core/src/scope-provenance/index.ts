/**
 * scope-provenance package surface (#3145).
 */

export {
  APPROVED_SCOPE_DIR,
  type ApprovedScopeRecord,
  approvedScopeDir,
  approvedScopeRecordPath,
  buildApprovedScopeRecord,
  computeFileScopeDigest,
  computeTextDigest,
  extractFileScope,
  extractPlanId,
  isHumanApprovalStamp,
  listApprovedScopeRecords,
  normalizeFileScope,
  readApprovedScopeRecord,
  scopeExpansion,
  writeApprovedScopeRecord,
} from "./digest.js";
export {
  evaluateOneScopeProvenance,
  evaluateScopeProvenance,
  type ScopeProvenanceFinding,
  type ScopeProvenanceOptions,
  type ScopeProvenanceResult,
  type ScopeProvenanceViolationKind,
} from "./evaluate.js";
