/**
 * L2 historical shape seam — thin detect → survey shape_id → recovery decision.
 * WAVE3-V2: convert-via-removals lean; bookends refuse interim until 3f.
 * Removal step implementations live in packages/runtime/src/removal-steps/ (AC3.1).
 */
export {
  resolveInstallShape,
  type ShapeResolution,
} from "./detect.js";
export {
  DECISION_BY_SHAPE_ID,
  decisionForShapeId,
  type RecoveryDecision,
  type SurveyShapeId,
} from "./registry.js";
export {
  formatShapeRecoveryMessage,
  isL2RefusalDecision,
} from "./messages.js";
