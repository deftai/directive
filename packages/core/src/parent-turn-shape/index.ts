/**
 * Parent turn-shape hard-stop (FC14 / #3131).
 *
 * Machine-checkable gate so soft skill prose is not the sole mitigation for
 * the OpenClaw parent text-repetition hang after leaf announce.
 */

export {
  countRepeatedUnitsInBlob,
  DEFAULT_MAX_IDENTICAL_WITHOUT_TOOL,
  evaluateParentTurnShape,
  isNearIdentical,
  isTextRepetitionHang,
  normalizeTurnText,
  PARENT_TURN_FAIL_FC14,
  type ParentTurnEvent,
  type ParentTurnFailClass,
  type ParentTurnShapeInput,
  type ParentTurnShapeResult,
  splitTextUnits,
} from "./evaluate.js";
