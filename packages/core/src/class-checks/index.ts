/**
 * class-checks package surface (#4980 / #3145 class).
 */

export {
  evaluateClassChecks,
  resolveClassCheckBaseRef,
  scanTestIdentityInInfra,
  type ClassCheckFinding,
  type ClassCheckKind,
  type ClassCheckOptions,
  type ClassCheckResult,
} from "./evaluate.js";
export {
  DEFAULT_PROTECTED_GLOBS,
  DEFAULT_TEST_MARKERS,
  defaultClassChecksPolicy,
  loadClassChecksPolicy,
  type ClassChecksPolicy,
} from "./policy.js";
