/**
 * test-boundary package surface (#3145).
 */

export {
  evaluateTestBoundary,
  isRecognizedTestBasename,
  matchesRootGlob,
  matchesTestFilePattern,
  matchPolicyGlob,
  type TestBoundaryFinding,
  type TestBoundaryOptions,
  type TestBoundaryResult,
  type TestBoundaryViolationKind,
} from "./evaluate.js";
export {
  DEFAULT_FIXTURE_ROOTS,
  DEFAULT_SOURCE_ROOTS,
  DEFAULT_TEST_FILE_PATTERNS,
  DEFAULT_TEST_ROOTS,
  defaultTestBoundaryPolicy,
  FRAMEWORK_SELF_ALLOW,
  loadTestBoundaryPolicy,
  type TestBoundaryAllowEntry,
  type TestBoundaryPolicy,
} from "./policy.js";
