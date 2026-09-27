export {
  type DetectedScopeLimit,
  detectScopeLimitPhrase,
  extractRequirementLines,
} from "./detect.js";
export { inventoryDefaultSurfaces } from "./inventory.js";
export { SCOPE_LIMIT_PHRASES } from "./lexicon.js";
export {
  applyCeilingToBrief,
  readCeilingFromBrief,
  seedOperatorScopeCeiling,
} from "./seed.js";
export { evaluateUntraceableSurfaces } from "./surface-check.js";
export {
  OPERATOR_SCOPE_CEILING_ARTIFACT_REL,
  OPERATOR_SCOPE_CEILING_PLAN_KEY,
  OPERATOR_SCOPE_CEILING_SCHEMA,
  type OperatorScopeCeiling,
  type SeedCeilingResult,
  type ShippedSurface,
  type ShippedSurfaceKind,
  SURFACES_NOT_CHECKED_REMEDIATION,
  UNTRACEABLE_SURFACE_REMEDIATION,
  type UntraceableSurface,
  type UntraceableSurfaceCheckResult,
} from "./types.js";
