export type { EvaluateOptions, EvaluateResult } from "./evaluate.js";
export {
  ACTIVATE_HINT,
  ACTIVE_FOLDER,
  ELIGIBLE_LIFECYCLE_DIRS,
  ELIGIBLE_STATUS,
  emitJson,
  evaluate,
  formatActivateHint,
  PREFLIGHT_USAGE_HINT,
} from "./evaluate.js";
export type { IntendedPlacement, IntendedPlacementResult } from "./intended-placement.js";
export {
  emptyIntendedPlacement,
  evaluateIntendedPlacement,
  INTENDED_PLACEMENT_MISSING_HINT,
  INTENDED_PLACEMENT_OVER_TRIGGER_HINT,
  INTENDED_PLACEMENT_SCHEMA,
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
