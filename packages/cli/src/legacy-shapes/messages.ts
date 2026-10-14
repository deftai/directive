/**
 * Recovery copy for L2 decisions.
 * WAVE3-V2: convert-via-removals is handled by upgrade/install (strategy → pin → setup).
 * Only unsupported-honest / residual uninstall-reinstall refuse at the bookend.
 */
import type { ShapeResolution } from "./detect.js";

export function formatShapeRecoveryMessage(
  shape: ShapeResolution,
  command: "upgrade" | "install",
): string {
  const evidence =
    shape.evidence.length > 0 ? ` Evidence: ${shape.evidence.join(", ")}.` : "";

  if (shape.decision === "uninstall-reinstall") {
    return (
      `directive ${command}: detected historical Directive layout ` +
      `'${shape.shapeId}'.${evidence} ` +
      "In-place convert is not supported for this shape. " +
      "Run `directive uninstall` then `directive install` to move to the current layout " +
      "(xbrief/ and user-owned shared content follow uninstall keep-lists)."
    );
  }

  if (shape.decision === "unsupported-honest") {
    return (
      `directive ${command}: detected unsupported Directive layout ` +
      `'${shape.shapeId}'.${evidence} ` +
      "Automatic recovery is not supported. Inspect the tree, remove orphan markers if safe, " +
      "then run `directive install`, or ask for support."
    );
  }

  if (shape.decision === "convert-via-removals") {
    return (
      `directive ${command}: layout '${shape.shapeId}' converts via removal strategy ` +
      "(handled by the upgrade/install convert path)."
    );
  }

  // L0 decisions are not refused here — callers fall through to existing paths.
  return (
    `directive ${command}: layout '${shape.shapeId}' uses decision '${shape.decision}' ` +
    "(handled by the current L0 path)."
  );
}

/**
 * True when bookends should refuse and print L2 recovery (not fall through to L0/convert).
 * convert-via-removals is no longer refused (WAVE3-V2 3f).
 */
export function isL2RefusalDecision(decision: ShapeResolution["decision"]): boolean {
  return decision === "uninstall-reinstall" || decision === "unsupported-honest";
}
