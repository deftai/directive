/**
 * Wave 3 L2 shape registry — survey shape_id → recovery decision.
 * WAVE3-V2: pre-latest-legacy shapes lean convert-via-removals (composed
 * removal steps in runtime + L0 arrival). Bookends may still refuse until 3f.
 * L0 stays sacred. See specs/5490-wave3-v2-unified-clarifications.md C1–C3.
 */

export type RecoveryDecision =
  | "l0-current"
  | "l0-latest-legacy-convert"
  | "convert-via-removals"
  | "uninstall-reinstall"
  | "unsupported-honest";

/** Survey shape_ids wired in 3b+ (and known L0). */
export type SurveyShapeId =
  | "ovpr-runtime-pin"
  | "npm-hybrid-pin-copied-core"
  | "vendored-core-go"
  | "go-tarball-deft-root"
  | "submodule-deft"
  | "orphan-deft-version";

/**
 * WAVE3-V2 lean: convert-via-removals for surveyed L2 layouts (pending 3f fixtures).
 * Latest-legacy stays L0 convert (2f); OVPR stays L0 current.
 * uninstall-reinstall remains in the enum for interim messaging / unsupported paths.
 */
export const DECISION_BY_SHAPE_ID: Readonly<Record<SurveyShapeId, RecoveryDecision>> = {
  "ovpr-runtime-pin": "l0-current",
  "npm-hybrid-pin-copied-core": "l0-latest-legacy-convert",
  "vendored-core-go": "convert-via-removals",
  "go-tarball-deft-root": "convert-via-removals",
  "submodule-deft": "convert-via-removals",
  "orphan-deft-version": "convert-via-removals",
};

export function decisionForShapeId(shapeId: SurveyShapeId): RecoveryDecision {
  return DECISION_BY_SHAPE_ID[shapeId];
}
