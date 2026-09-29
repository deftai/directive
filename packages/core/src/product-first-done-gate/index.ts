/**
 * Product-first done-gate (#3284).
 *
 * acceptance.commands schema, verify:ac evaluation, check-mode composition
 * (AC-first, hygiene advisory under pressure, rapid=AC-only).
 */

export type { AcServedFrom } from "../session/verify-ac-session-cache.js";
export {
  ADMITTED_SOURCE_DIGEST_KEY,
  ADMITTED_SOURCE_SENTENCES_KEY,
  attachPlanAcceptance,
  buildAcceptanceFromIntakeCapture,
  digestAdmittedSourceSentences,
  extractAdmittedSourceSentencesFromText,
  readAdmittedSourceDigest,
  readAdmittedSourceSentences,
  readPlanAcceptance,
  stampAcceptanceFromLiteralCapture,
  validatePlanAcceptance,
} from "./acceptance.js";
export {
  type AcceptanceGateProfileOptions,
  type AcceptancePredicate,
  type AcceptanceReaderProfile,
  type AcceptanceReading,
  type AcceptanceVerdict,
  clauseWalkBlocks,
  formatAcceptanceVerdict,
  formatPassLeadClauseCounts,
  listActiveLifecycleArtifacts,
  type ResolveSoftMissingAcTargetsOptions,
  relabelVerifyAcPassLead,
  resolveAcceptanceGateProfile,
  resolveAcceptanceVerdict,
  resolvedAcceptanceCommandCount,
  resolveSoftMissingAcTargets,
  type SoftMissingAcTargetResolution,
} from "./acceptance-resolver.js";
export {
  applyProductFirstGateMode,
  isCeilingCompositorGate,
  isHygieneGate,
  isProductAcGate,
  type ProductFirstCheckModeResolution,
  type ResolveProductFirstCheckModeInput,
  resolveProductFirstCheckMode,
} from "./check-mode.js";
export {
  EMPTY_AC_CAUSE,
  EMPTY_AC_OUTCOME,
  EMPTY_AC_REMEDY,
  formatSoftEmptyMessage,
  isEmptyAcResolution,
  isSoftEmptyAcText,
  projectHasSuiteFloor,
  type VerifyAcResolution,
} from "./empty-resolution.js";
export {
  ADMITTED_SOURCE_DIGEST_MISMATCH_CAUSE,
  ADMITTED_SOURCE_DIGEST_UNAVAILABLE_CAUSE,
  ADMITTED_SOURCE_IDENTITY_REMOVED_CAUSE,
  type EvaluateVerifyAcOptions,
  emitVerifyAcTerminalOutcome,
  evaluateVerifyAcFromPath,
  evaluateVerifyAcFromPlan,
  isVerifyAcRequiredAtCeremonyDepth,
  resolveOracleScopeKey,
  type VerifyAcResult,
} from "./evaluate.js";
export {
  type AcceptanceCommand,
  type AcSourceRung,
  ENV_CHECK_AC_ONLY,
  ENV_CHECK_MODE,
  ENV_HYGIENE_ADVISORY,
  HYGIENE_GATE_ID_PREFIXES,
  PLAN_ACCEPTANCE_KEY,
  type PlanAcceptance,
  PRODUCT_AC_GATE_ID,
  type ProductFirstCheckMode,
} from "./types.js";
