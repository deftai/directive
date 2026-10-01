/**
 * Immutable activation projection (#4714 R2/R4).
 * Strips only the exact namespaced evidence/disposition slots before digest.
 */
import { createHash } from "node:crypto";

const EVIDENCE_KEY = "x-directive/evidence";
const DISPOSITION_KEY = "x-directive/disposition";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Deep-clone JSON value while omitting evidence/disposition on plan.items. */
export function stripNamespacedEvidenceSlots(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripNamespacedEvidenceSlots(entry));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "plan" && isPlainObject(child)) {
      const planOut: Record<string, unknown> = {};
      for (const [planKey, planChild] of Object.entries(child)) {
        if (planKey === "items" && Array.isArray(planChild)) {
          planOut.items = planChild.map((item) => {
            if (!isPlainObject(item)) {
              return stripNamespacedEvidenceSlots(item);
            }
            const itemOut: Record<string, unknown> = {};
            for (const [itemKey, itemChild] of Object.entries(item)) {
              if (itemKey === EVIDENCE_KEY || itemKey === DISPOSITION_KEY) {
                continue;
              }
              itemOut[itemKey] = stripNamespacedEvidenceSlots(itemChild);
            }
            return itemOut;
          });
        } else {
          planOut[planKey] = stripNamespacedEvidenceSlots(planChild);
        }
      }
      out.plan = planOut;
      continue;
    }
    out[key] = stripNamespacedEvidenceSlots(child);
  }
  return out;
}

/** Canonical JSON for digest: sorted object keys, stable arrays. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(",")}}`;
}

export function immutableProjectionDigest(brief: unknown): string {
  const stripped = stripNamespacedEvidenceSlots(brief);
  return createHash("sha256").update(canonicalJson(stripped), "utf8").digest("hex");
}

export function projectionsEqual(left: unknown, right: unknown): boolean {
  return immutableProjectionDigest(left) === immutableProjectionDigest(right);
}
