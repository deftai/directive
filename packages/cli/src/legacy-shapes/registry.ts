/**
 * Wave 3b L2 shape registry — survey shape_id → recovery decision.
 * Data-driven from specs/5490-wave3-historical-survey.md. L0 stays sacred.
 */

export type RecoveryDecision =
  | "l0-current"
  | "l0-latest-legacy-convert"
  | "uninstall-reinstall"
  | "unsupported-honest";

/** Survey shape_ids wired in 3b (and known L0). */
export type SurveyShapeId =
  | "ovpr-runtime-pin"
  | "npm-hybrid-pin-copied-core"
  | "vendored-core-go"
  | "go-tarball-deft-root"
  | "submodule-deft"
  | "orphan-deft-version";

/**
 * 3b lean decisions. Do not invent in-place convert for Go-era / vendored-core-go.
 * Latest-legacy stays L0 convert (2f); OVPR stays L0 current.
 */
export const DECISION_BY_SHAPE_ID: Readonly<Record<SurveyShapeId, RecoveryDecision>> = {
  "ovpr-runtime-pin": "l0-current",
  "npm-hybrid-pin-copied-core": "l0-latest-legacy-convert",
  "vendored-core-go": "uninstall-reinstall",
  "go-tarball-deft-root": "uninstall-reinstall",
  "submodule-deft": "uninstall-reinstall",
  "orphan-deft-version": "unsupported-honest",
};

export function decisionForShapeId(shapeId: SurveyShapeId): RecoveryDecision {
  return DECISION_BY_SHAPE_ID[shapeId];
}
