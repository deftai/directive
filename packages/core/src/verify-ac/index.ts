/**
 * Product-oracle gate integrity for verify:ac (#3322).
 *
 * Extends #3156: a red product verification may not be self-adjudicated
 * by editing the comparison. Deterministic surface is the flagged event.
 */

export {
  type EvaluateProductOracleIntegrityOptions,
  evaluateProductOracleIntegrity,
  mergeOracleVerdict,
  type OracleIntegrityResultFields,
  type ProductOracleIntegrityVerdict,
} from "./evaluate.js";
export {
  type FlaggedMethodChangePass,
  flagPassAfterFailFromJsonl,
  flagPassAfterFailWithMethodChange,
  readVerificationAttempts,
  unresolvedMethodChangePasses,
  type VerificationAttempt,
} from "./flag.js";
