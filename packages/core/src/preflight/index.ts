export type { Verdict } from "../preflight-gh/classifier.js";
export {
  classifyCommand,
  DEFAULT_BRANCHES,
  ENV_BYPASS,
  evaluateCommand,
  runSelfTest,
  SELF_TEST_CASES,
  tokensFromString,
} from "../preflight-gh/classifier.js";
export type { EvaluatePrePushOptions, PrePushRef } from "../preflight-gh/pre-push.js";
export { evaluatePrePush, parsePrePushStdin } from "../preflight-gh/pre-push.js";
export type { EvaluateOptions, EvaluateResult } from "./evaluate.js";
export {
  ACTIVATE_HINT,
  ACTIVE_FOLDER,
  ELIGIBLE_LIFECYCLE_DIRS,
  ELIGIBLE_STATUS,
  emitJson,
  evaluate,
  formatActivateHint,
  formatOriginFreshnessHint,
  formatOriginPreflightUsage,
  PREFLIGHT_USAGE_HINT,
} from "./evaluate.js";
export type {
  IntendedPlacement,
  IntendedPlacementResult,
  ParsedIntendedPlacement,
} from "./intended-placement.js";
export {
  emptyIntendedPlacement,
  evaluateIntendedPlacement,
  INTENDED_PLACEMENT_GRANDFATHER_HINT,
  INTENDED_PLACEMENT_MISSING_HINT,
  INTENDED_PLACEMENT_OVER_TRIGGER_HINT,
  INTENDED_PLACEMENT_SCHEMA,
  parseIntendedPlacement,
  readIntendedPlacement,
  stampIntendedPlacement,
} from "./intended-placement.js";
export type {
  ProjectInvariantsGateOptions,
  ProjectInvariantsGateResult,
} from "./project-invariants-gate.js";
export {
  evaluateProjectInvariantsGate,
  PROJECT_INVARIANT_REMEDIATION,
  resolveProjectRootForInvariants,
} from "./project-invariants-gate.js";
