/**
 * Recovery copy for L2 decisions.
 * WAVE3-V2: convert-via-removals is the long-term decision; until 3f implements
 * upgrade strategies, bookends still refuse with interim uninstall guidance.
 */
import type { ShapeResolution } from "./detect.js";

export function formatShapeRecoveryMessage(
  shape: ShapeResolution,
  command: "upgrade" | "install",
): string {
  const evidence =
    shape.evidence.length > 0 ? ` Evidence: ${shape.evidence.join(", ")}.` : "";

  // Interim refuse until 3f wires STRATEGIES into upgrade (WAVE3-V2).
  if (shape.decision === "convert-via-removals") {
    return (
      `directive ${command}: detected historical Directive layout ` +
      `'${shape.shapeId}'.${evidence} ` +
      "Convert-via-removals is planned (WAVE3-V2) but not yet active on this tip. " +
      "Until then, run `directive uninstall` then `directive install` to move to the current layout " +
      "(xbrief/ and user-owned shared content follow uninstall keep-lists)."
    );
  }

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

  // L0 decisions are not refused here — callers fall through to existing paths.
  return (
    `directive ${command}: layout '${shape.shapeId}' uses decision '${shape.decision}' ` +
    "(handled by the current L0 path)."
  );
}

/**
 * True when bookends should refuse and print L2 recovery (not fall through to L0).
 * convert-via-removals stays refused until 3f wires strategies into upgrade.
 */
export function isL2RefusalDecision(decision: ShapeResolution["decision"]): boolean {
  return (
    decision === "convert-via-removals" ||
    decision === "uninstall-reinstall" ||
    decision === "unsupported-honest"
  );
}
