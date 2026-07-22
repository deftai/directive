import type { JsonObject } from "../vbrief-build/types.js";

/** Minimal schema-valid scope brief for lifecycle unit tests (#2131). */
export function minimalScopeBrief(plan: Record<string, unknown>): JsonObject {
  return {
    xBRIEFInfo: { version: "0.8" },
    plan,
  };
}
