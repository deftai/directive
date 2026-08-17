/**
 * scope-provenance package surface (#3145).
 */

export { compareExtractedIntent } from "./compare-intent.js";
export {
  APPROVED_SCOPE_DIR,
  type ApprovedScopeRecord,
  approvedScopeDir,
  approvedScopeIntentPath,
  approvedScopeIntentRel,
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
  baseApprovalAuthorizesCurrent,
  evaluateOneScopeProvenance,
  evaluateScopeProvenance,
  parseApprovedScopeRecordRaw,
  resolveDefaultBaseRef,
  type ScopeProvenanceFinding,
  type ScopeProvenanceOptions,
  type ScopeProvenanceResult,
  type ScopeProvenanceViolationKind,
} from "./evaluate.js";
export {
  extractIntentFromPayload,
  extractIntentFromRaw,
  GITHUB_ISSUE_REF_TYPES,
  type IntentPreimage,
} from "./extract-intent.js";
export { computeIntentDigest, INTENT_DIGEST_ALGO } from "./intent-digest.js";
export { parseJsonRejectingDuplicateKeys } from "./json-tokenizer.js";
export { allKnownMachineLeaves, KNOWN_MACHINE_WRITERS } from "./known-machine.js";
export {
  mintApprovedScopeArtifacts,
  recoverApprovedScopePairs,
  recoverIncompleteApprovedScopePair,
} from "./mint-artifacts.js";
