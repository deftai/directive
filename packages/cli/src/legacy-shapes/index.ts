/**
 * L2 historical shape seam — thin detect → survey shape_id → recovery decision.
 * Bookends call once; L0 convert/OVPR paths stay unchanged.
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
