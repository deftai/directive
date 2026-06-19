import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { VALID_STATUSES, VALID_VBRIEF_VERSIONS } from "./constants.js";

type JsonObject = Record<string, unknown>;

function validateNarratives(narratives: unknown, path: string, errors: string[]): void {
  if (typeof narratives !== "object" || narratives === null || Array.isArray(narratives)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const [key, value] of Object.entries(narratives)) {
    if (typeof value !== "string") {
      errors.push(`${path}.${key} must be a string, got ${typeof value}`);
    }
  }
}

function validatePlanItem(item: JsonObject, path: string, errors: string[]): void {
  const itemId = typeof item.id === "string" ? item.id : "<no-id>";
  const itemPath = `${path}[${itemId}]`;

  if (!("title" in item)) errors.push(`${itemPath} missing 'title'`);
  if (!("status" in item)) {
    errors.push(`${itemPath} missing 'status'`);
  } else if (typeof item.status === "string" && !VALID_STATUSES.has(item.status)) {
    errors.push(`${itemPath} invalid status: '${item.status}'`);
  }

  if ("narrative" in item) {
    validateNarratives(item.narrative, `${itemPath}.narrative`, errors);
  }

  for (const nestedKey of ["items", "subItems"] as const) {
    if (!(nestedKey in item)) continue;
    const nested = item[nestedKey];
    if (!Array.isArray(nested)) {
      errors.push(`${itemPath}.${nestedKey} must be an array`);
      continue;
    }
    for (let j = 0; j < nested.length; j += 1) {
      const sub = nested[j];
      if (typeof sub !== "object" || sub === null || Array.isArray(sub)) {
        errors.push(`${itemPath}.${nestedKey}[${j}] must be an object`);
        continue;
      }
      validatePlanItem(sub as JsonObject, `${itemPath}.${nestedKey}`, errors);
    }
  }
}

function validateSchema(data: JsonObject): string[] {
  const errors: string[] = [];

  if (!("vBRIEFInfo" in data)) {
    errors.push("missing required top-level key 'vBRIEFInfo'");
  } else {
    const info = data.vBRIEFInfo;
    if (typeof info !== "object" || info === null || Array.isArray(info)) {
      errors.push("'vBRIEFInfo' must be an object");
    } else {
      const version = (info as JsonObject).version;
      if (!VALID_VBRIEF_VERSIONS.has(String(version))) {
        errors.push(
          `'vBRIEFInfo.version' must be '0.6' (canonical v0.6 schema, #533), got ${JSON.stringify(version)}. Run \`task migrate:vbrief\` to upgrade pre-existing v0.5 vBRIEFs in-place.`,
        );
      }
    }
  }

  if (!("plan" in data)) {
    errors.push("missing required top-level key 'plan'");
  } else {
    const plan = data.plan;
    if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
      errors.push("'plan' must be an object, not a string or other type");
    } else {
      const planObj = plan as JsonObject;
      for (const field of ["title", "status", "items"] as const) {
        if (!(field in planObj)) errors.push(`'plan' missing required field '${field}'`);
      }
      if ("title" in planObj) {
        const title = planObj.title;
        if (typeof title !== "string" || !title) {
          errors.push("'plan.title' must be a non-empty string");
        }
      }
      if ("status" in planObj) {
        const status = planObj.status;
        if (typeof status === "string" && !VALID_STATUSES.has(status)) {
          errors.push(
            `'plan.status' invalid: '${status}' (expected one of ${[...VALID_STATUSES].sort().join(", ")})`,
          );
        }
      }
      if ("narratives" in planObj) {
        validateNarratives(planObj.narratives, "plan.narratives", errors);
      }
      if ("items" in planObj) {
        const items = planObj.items;
        if (!Array.isArray(items)) {
          errors.push("'plan.items' must be an array");
        } else {
          for (let i = 0; i < items.length; i += 1) {
            const item = items[i];
            if (typeof item !== "object" || item === null || Array.isArray(item)) {
              errors.push(`plan.items[${i}] must be an object`);
              continue;
            }
            validatePlanItem(item as JsonObject, "plan.items", errors);
          }
        }
      }
    }
  }

  const legacyKeys = ["vbrief", "tasks", "overview", "architecture"];
  const foundLegacy = legacyKeys.filter((k) => k in data);
  if (foundLegacy.length > 0) {
    errors.push(
      `legacy flat-format keys found at top level: ${foundLegacy.sort().join(", ")}. Migrate to vBRIEF v0.6 envelope (vBRIEFInfo + plan)`,
    );
  }

  return errors;
}

export type ValidateSpecResult = readonly [boolean, string];

/** Validate the spec file at *specPath* (mirrors ``scripts/spec_validate.validate_spec``). */
export function validateSpec(specPath: string): ValidateSpecResult {
  if (!existsSync(specPath)) {
    return [
      false,
      `✗ ${specPath} not found\n` +
        "  Create it by running the interview process (see deft/templates/make-spec.md)",
    ];
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(specPath, "utf8"));
  } catch (exc) {
    return [false, `✗ ${specPath} is not valid JSON: ${String(exc)}`];
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return [false, `✗ ${basename(specPath)} has schema violations:\n  • root must be an object`];
  }
  const errors = validateSchema(data as JsonObject);
  if (errors.length > 0) {
    const detail = errors.map((e) => `  • ${e}`).join("\n");
    return [false, `✗ ${basename(specPath)} has schema violations:\n${detail}`];
  }
  return [true, `✓ ${basename(specPath)} is valid vBRIEF`];
}

/** CLI entry (mirrors ``scripts/spec_validate.main``). */
export function main(argv: readonly string[]): number {
  if (argv.length < 1) {
    process.stderr.write("Usage: spec_validate.py <spec_file>\n");
    return 2;
  }
  const [ok, message] = validateSpec(argv[0] ?? "");
  if (ok) process.stdout.write(`${message}\n`);
  else process.stderr.write(`${message}\n`);
  return ok ? 0 : 1;
}
