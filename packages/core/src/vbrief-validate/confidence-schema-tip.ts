/**
 * Update success tip when deposited 0.8 Confidence schema shape changes (#5385).
 */
import { existsSync, readFileSync } from "node:fs";
import { CONFIDENCE_MIGRATE_COMMAND, CONFIDENCE_VALUES } from "./provenance.js";

export interface ConfidenceSchemaShape {
  readonly present: boolean;
  readonly type: string | null;
  readonly hasEnum: boolean;
}

export const CONFIDENCE_SCHEMA_COMPAT_TIP =
  `Confidence-compat: 0.8 schema Confidence is type string (writers MUST emit ` +
  `${CONFIDENCE_VALUES.join("|")}; legacy strings WARN). Optional: ${CONFIDENCE_MIGRATE_COMMAND}`;

export function readConfidenceSchemaShapeFromText(text: string): ConfidenceSchemaShape {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { present: false, type: null, hasEnum: false };
    }
    const defs = (parsed as Record<string, unknown>).$defs;
    if (typeof defs !== "object" || defs === null || Array.isArray(defs)) {
      return { present: false, type: null, hasEnum: false };
    }
    const plan = (defs as Record<string, unknown>).Plan;
    if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
      return { present: false, type: null, hasEnum: false };
    }
    const planProps = (plan as Record<string, unknown>).properties;
    if (typeof planProps !== "object" || planProps === null || Array.isArray(planProps)) {
      return { present: false, type: null, hasEnum: false };
    }
    const narratives = (planProps as Record<string, unknown>).narratives;
    if (typeof narratives !== "object" || narratives === null || Array.isArray(narratives)) {
      return { present: false, type: null, hasEnum: false };
    }
    const narrativeProps = (narratives as Record<string, unknown>).properties;
    if (
      typeof narrativeProps !== "object" ||
      narrativeProps === null ||
      Array.isArray(narrativeProps)
    ) {
      return { present: false, type: null, hasEnum: false };
    }
    const confidence = (narrativeProps as Record<string, unknown>).Confidence;
    if (typeof confidence !== "object" || confidence === null || Array.isArray(confidence)) {
      return { present: false, type: null, hasEnum: false };
    }
    const node = confidence as Record<string, unknown>;
    return {
      present: true,
      type: typeof node.type === "string" ? node.type : null,
      hasEnum: "enum" in node,
    };
  } catch {
    return { present: false, type: null, hasEnum: false };
  }
}

export function readConfidenceSchemaShape(path: string): ConfidenceSchemaShape {
  if (!existsSync(path)) {
    return { present: false, type: null, hasEnum: false };
  }
  try {
    return readConfidenceSchemaShapeFromText(readFileSync(path, "utf8"));
  } catch {
    return { present: false, type: null, hasEnum: false };
  }
}

/** True when Confidence enum/type shape changed across a deposit (schema-diff tip gate). */
export function confidenceSchemaShapeChanged(
  before: ConfidenceSchemaShape,
  after: ConfidenceSchemaShape,
): boolean {
  if (!after.present) {
    return false;
  }
  if (!before.present) {
    return after.type === "string" && !after.hasEnum;
  }
  return before.hasEnum !== after.hasEnum || before.type !== after.type;
}
