/**
 * class-checks package surface (#4980 / #3145 class).
 */

export {
  type ClassCheckFinding,
  type ClassCheckKind,
  type ClassCheckOptions,
  type ClassCheckResult,
  contentMarksTestOnly,
  evaluateClassChecks,
  type ParseClassChecksFromProjectDefinitionResult,
  parseClassChecksFromProjectDefinition,
  resolveClassCheckBaseRef,
  scanTestIdentityInInfra,
} from "./evaluate.js";
export {
  type ClassChecksPolicy,
  type ClassChecksPolicyLoad,
  DEFAULT_PROTECTED_GLOBS,
  DEFAULT_TEST_MARKERS,
  defaultClassChecksPolicy,
  isClassChecksPolicyLoadError,
  loadClassChecksPolicy,
} from "./policy.js";
