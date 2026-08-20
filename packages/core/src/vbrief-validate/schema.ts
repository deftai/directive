import { pyStrRepr, pythonTypeName } from "../triage/scope/python-repr.js";
import {
  PROJECT_DEF_EXPECTED_NARRATIVES,
  VALID_INFO_ROOT_KEYS,
  VALID_ITEM_STATUSES,
  VALID_PLAN_ITEM_EFFORTS,
  VALID_PLAN_ITEM_TYPES,
  VALID_PLAN_STATUSES,
  VALID_VBRIEF_VERSIONS,
} from "./constants.js";

export type JsonObject = Record<string, unknown>;

function validateNarratives(narratives: unknown, path: string, errors: string[]): void {
  if (typeof narratives !== "object" || narratives === null || Array.isArray(narratives)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const [key, value] of Object.entries(narratives)) {
    if (typeof value !== "string") {
      errors.push(`${path}.${key} must be a string, got ${pythonTypeName(value)}`);
    }
  }
}

function validatePlanRefs(planRefs: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(planRefs)) {
    errors.push(`${path}.planRefs must be an array`);
    return;
  }
  for (let i = 0; i < planRefs.length; i += 1) {
    if (typeof planRefs[i] !== "string") {
      errors.push(`${path}.planRefs[${i}] must be a string, got ${pythonTypeName(planRefs[i])}`);
    }
  }
}

export function resolveInfoBlock(
  data: JsonObject,
): { key: "vBRIEFInfo" | "xBRIEFInfo"; info: JsonObject } | null {
  for (const key of VALID_INFO_ROOT_KEYS) {
    if (!(key in data)) {
      continue;
    }
    const info = data[key];
    if (typeof info !== "object" || info === null || Array.isArray(info)) {
      return null;
    }
    return { key: key as "vBRIEFInfo" | "xBRIEFInfo", info: info as JsonObject };
  }
  return null;
}

function validatePlanItem(item: JsonObject, path: string, errors: string[]): void {
  const itemId = typeof item.id === "string" ? item.id : "<no-id>";
  const itemPath = `${path}[${itemId}]`;

  if (!("title" in item)) {
    errors.push(`${itemPath} missing 'title'`);
  }
  if (!("status" in item)) {
    errors.push(`${itemPath} missing 'status'`);
  } else if (!VALID_ITEM_STATUSES.has(String(item.status))) {
    errors.push(`${itemPath} invalid status: ${pyStrRepr(String(item.status))}`);
  }

  if ("type" in item && !VALID_PLAN_ITEM_TYPES.has(String(item.type))) {
    errors.push(`${itemPath} invalid type: ${pyStrRepr(String(item.type))}`);
  }

  if ("effort" in item && !VALID_PLAN_ITEM_EFFORTS.has(String(item.effort))) {
    errors.push(`${itemPath} invalid effort: ${pyStrRepr(String(item.effort))}`);
  }

  if ("summary" in item && typeof item.summary !== "string") {
    errors.push(`${itemPath}.summary must be a string, got ${pythonTypeName(item.summary)}`);
  }

  if ("planRefs" in item) {
    validatePlanRefs(item.planRefs, itemPath, errors);
  }

  if ("narrative" in item) {
    validateNarratives(item.narrative, `${itemPath}.narrative`, errors);
  }

  if ("items" in item) {
    if (!Array.isArray(item.items)) {
      errors.push(`${itemPath}.items must be an array`);
    } else {
      for (let j = 0; j < item.items.length; j += 1) {
        const sub = item.items[j];
        if (typeof sub !== "object" || sub === null || Array.isArray(sub)) {
          errors.push(`${itemPath}.items[${j}] must be an object`);
          continue;
        }
        validatePlanItem(sub as JsonObject, `${itemPath}.items`, errors);
      }
    }
  }

  if ("subItems" in item) {
    if (!Array.isArray(item.subItems)) {
      errors.push(`${itemPath}.subItems must be an array`);
    } else {
      for (let j = 0; j < item.subItems.length; j += 1) {
        const sub = item.subItems[j];
        if (typeof sub !== "object" || sub === null || Array.isArray(sub)) {
          errors.push(`${itemPath}.subItems[${j}] must be an object`);
          continue;
        }
        validatePlanItem(sub as JsonObject, `${itemPath}.subItems`, errors);
      }
    }
  }
}

/** Validate vBRIEF/xBRIEF structural requirements (v0.6 + v0.8 additive). */
export function validateVbriefSchema(data: JsonObject, filepath: string): string[] {
  const errors: string[] = [];

  const resolved = resolveInfoBlock(data);
  if (resolved === null) {
    let infoShapeError = false;
    for (const key of VALID_INFO_ROOT_KEYS) {
      if (!(key in data)) {
        continue;
      }
      const info = data[key];
      if (info === null || Array.isArray(info) || typeof info !== "object") {
        errors.push(`${filepath}: '${key}' must be an object`);
        infoShapeError = true;
        break;
      }
    }
    if (!infoShapeError) {
      errors.push(`${filepath}: missing required top-level key 'vBRIEFInfo' or 'xBRIEFInfo'`);
    }
  } else {
    const version = resolved.info.version;
    if (!VALID_VBRIEF_VERSIONS.has(String(version))) {
      errors.push(
        `${filepath}: '${resolved.key}.version' must be one of ` +
          `${[...VALID_VBRIEF_VERSIONS].map((v) => `'${v}'`).join(", ")} ` +
          `(canonical v0.6/v0.8 schema, #2107), got ` +
          `${pyStrRepr(String(version))}. Run \`task migrate:vbrief\` to ` +
          `upgrade pre-existing v0.5 vBRIEFs in-place.`,
      );
    }
  }

  if (!("plan" in data)) {
    errors.push(`${filepath}: missing required top-level key 'plan'`);
  } else {
    const plan = data.plan;
    if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
      errors.push(`${filepath}: 'plan' must be an object`);
    } else {
      const planObj = plan as JsonObject;
      for (const field of ["title", "status", "items"] as const) {
        if (!(field in planObj)) {
          errors.push(`${filepath}: 'plan' missing required field '${field}'`);
        }
      }

      if ("title" in planObj && (typeof planObj.title !== "string" || !planObj.title)) {
        errors.push(`${filepath}: 'plan.title' must be a non-empty string`);
      }

      if ("status" in planObj && !VALID_PLAN_STATUSES.has(String(planObj.status))) {
        const sorted = [...VALID_PLAN_STATUSES]
          .sort()
          .map((s) => `'${s}'`)
          .join(", ");
        errors.push(
          `${filepath}: 'plan.status' invalid: ${pyStrRepr(String(planObj.status))} ` +
            `(expected one of [${sorted}])`,
        );
      }

      if ("narratives" in planObj) {
        validateNarratives(planObj.narratives, `${filepath}: plan.narratives`, errors);
      }

      if ("items" in planObj) {
        if (!Array.isArray(planObj.items)) {
          errors.push(`${filepath}: 'plan.items' must be an array`);
        } else {
          for (let i = 0; i < planObj.items.length; i += 1) {
            const item = planObj.items[i];
            if (typeof item !== "object" || item === null || Array.isArray(item)) {
              errors.push(`${filepath}: plan.items[${i}] must be an object`);
              continue;
            }
            validatePlanItem(item as JsonObject, `${filepath}: plan.items`, errors);
          }
        }
      }
    }
  }

  return errors;
}

/** Normalize a narrative key for D3 comparison. */
export function normalizeNarrativeKey(key: string): string {
  return (key ?? "").toLowerCase().replace(/[\s_-]+/g, "");
}

/** Check expected PROJECT-DEFINITION narrative keys (D3). */
export function validateProjectDefNarratives(filepath: string, plan: JsonObject): string[] {
  const errors: string[] = [];
  // Mirror Python ``plan.get("narratives", {})`` -- a missing ``narratives``
  // key defaults to an empty object, which still triggers the
  // "missing expected key" D3 diagnostics (parity with validate_all).
  const narratives = "narratives" in plan ? plan.narratives : {};
  if (typeof narratives === "object" && narratives !== null && !Array.isArray(narratives)) {
    const present = new Set(Object.keys(narratives).map((key) => normalizeNarrativeKey(key)));
    for (const expected of PROJECT_DEF_EXPECTED_NARRATIVES) {
      if (!present.has(expected)) {
        errors.push(`${filepath}: narratives missing expected key '${expected}' (D3)`);
      }
    }
  }
  return errors;
}
