/**
 * Product-first done-gate (#3284).
 *
 * acceptance.commands schema, verify:ac evaluation, check-mode composition
 * (AC-first, hygiene advisory under pressure, rapid=AC-only).
 */

export {
  attachPlanAcceptance,
  buildAcceptanceFromIntakeCapture,
  readPlanAcceptance,
  stampAcceptanceFromLiteralCapture,
  validatePlanAcceptance,
} from "./acceptance.js";
export {
  applyProductFirstGateMode,
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
  type EvaluateVerifyAcOptions,
  evaluateVerifyAcFromPath,
  evaluateVerifyAcFromPlan,
  isVerifyAcRequiredAtCeremonyDepth,
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
