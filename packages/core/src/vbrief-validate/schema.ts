import { pyStrRepr, pythonTypeName } from "../triage/scope/python-repr.js";
import {
  PROJECT_DEF_EXPECTED_NARRATIVES,
  VALID_STATUSES,
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

function validatePlanItem(item: JsonObject, path: string, errors: string[]): void {
  const itemId = typeof item.id === "string" ? item.id : "<no-id>";
  const itemPath = `${path}[${itemId}]`;

  if (!("title" in item)) {
    errors.push(`${itemPath} missing 'title'`);
  }
  if (!("status" in item)) {
    errors.push(`${itemPath} missing 'status'`);
  } else if (!VALID_STATUSES.has(String(item.status))) {
    errors.push(`${itemPath} invalid status: ${pyStrRepr(String(item.status))}`);
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

/** Validate vBRIEF structural requirements (v0.6). */
export function validateVbriefSchema(data: JsonObject, filepath: string): string[] {
  const errors: string[] = [];

  if (!("vBRIEFInfo" in data)) {
    errors.push(`${filepath}: missing required top-level key 'vBRIEFInfo'`);
  } else {
    const info = data.vBRIEFInfo;
    if (typeof info !== "object" || info === null || Array.isArray(info)) {
      errors.push(`${filepath}: 'vBRIEFInfo' must be an object`);
    } else {
      const version = (info as JsonObject).version;
      if (!VALID_VBRIEF_VERSIONS.has(String(version))) {
        errors.push(
          `${filepath}: 'vBRIEFInfo.version' must be '0.6' ` +
            `(canonical v0.6 schema, #533), got ` +
            `${pyStrRepr(String(version))}. Run \`task migrate:vbrief\` to ` +
            `upgrade pre-existing v0.5 vBRIEFs in-place.`,
        );
      }
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

      if ("status" in planObj && !VALID_STATUSES.has(String(planObj.status))) {
        const sorted = [...VALID_STATUSES]
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
