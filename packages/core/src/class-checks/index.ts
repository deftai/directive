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
  parseClassChecksFromProjectDefinition,
  resolveClassCheckBaseRef,
  scanTestIdentityInInfra,
} from "./evaluate.js";
export {
  type ClassChecksPolicy,
  DEFAULT_PROTECTED_GLOBS,
  DEFAULT_TEST_MARKERS,
  defaultClassChecksPolicy,
  loadClassChecksPolicy,
} from "./policy.js";
