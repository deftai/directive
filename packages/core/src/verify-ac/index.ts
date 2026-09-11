/**
 * Product-oracle gate integrity for verify:ac (#3322).
 *
 * Extends #3156: a red product verification may not be self-adjudicated
 * by editing the comparison. Deterministic surface is the flagged event.
 */

export {
  type AcceptanceClause,
  type AcceptanceClauseReading,
  bindClausesToDeclaredScope,
  type ClauseBindFailure,
  type ClauseDerivationSources,
  type ClauseFileScopeBindResult,
  type ClauseOutcome,
  type ClauseWalkOptions,
  type ClauseWalkReport,
  type ClauseWalkResult,
  collectDeclaredAcceptanceNarrativeSurface,
  collectPlanItemAcceptanceSurface,
  countAdjudicableClauses,
  countUnverifiedAdjudicableClauses,
  DECLARED_ACCEPTANCE_NARRATIVE_KEYS,
  type DeclaredAcceptanceNarrativeSurface,
  deriveAcceptanceClauses,
  formatClauseWalkMessage,
  formatZeroClauseAcceptanceShapedNotice,
  isDeclaredArtifactPath,
  isScratchArtifactPath,
  readAcceptanceClauses,
  readDeclaredArtifactScope,
  serializeAcceptanceClauses,
  stampDerivedClausesOnAcceptance,
  walkAcceptanceClauses,
} from "./clauses.js";
export {
  type EvaluateProductOracleIntegrityOptions,
  emitVerifyAcAttempts,
  evaluateProductOracleIntegrity,
  mergeOracleVerdict,
  methodFingerprintForWalk,
  type OracleIntegrityResultFields,
  type ProductOracleIntegrityVerdict,
  VERIFY_AC_CHECK_ID_PREFIX,
  verifyAcCheckId,
} from "./evaluate.js";
export {
  commandCountFromFingerprint,
  type FlaggedMethodChangePass,
  flagPassAfterFailFromJsonl,
  flagPassAfterFailWithMethodChange,
  readVerificationAttempts,
  unresolvedMethodChangePasses,
  type VerificationAttempt,
} from "./flag.js";
