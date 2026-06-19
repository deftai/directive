import { LEGACY_ORIGIN_TYPES, STRICT_ORIGIN_ALLOWLIST } from "./constants.js";
import { lifecycleFolderFor } from "./paths.js";
import type { JsonObject } from "./schema.js";

function legacyOriginMatch(refType: string): boolean {
  if (LEGACY_ORIGIN_TYPES.has(refType)) {
    return true;
  }
  for (const legacy of LEGACY_ORIGIN_TYPES) {
    if (refType.startsWith(`${legacy}-`) || refType.startsWith(`${legacy}/`)) {
      return true;
    }
  }
  return false;
}

function schemaTrustingOrigin(refType: string): boolean {
  return refType.startsWith("x-vbrief/");
}

/** Warn if a scope vBRIEF in pending/ or active/ has no origin reference (D11). */
export function validateOriginProvenance(
  filepath: string,
  data: JsonObject,
  vbriefDir: string,
  strictOriginTypes = false,
): string[] {
  const folder = lifecycleFolderFor(filepath, vbriefDir);
  if (folder !== "pending" && folder !== "active") {
    return [];
  }

  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return [];
  }
  const refs = (plan as JsonObject).references;
  if (!Array.isArray(refs)) {
    return strictOriginTypes
      ? [
          `${filepath}: scope vBRIEF in '${folder}/' has no references ` +
            "with an allow-listed origin type (D11; " +
            "--strict-origin-types)",
        ]
      : [
          `${filepath}: scope vBRIEF in '${folder}/' has no references ` +
            "with an origin type (D11)",
        ];
  }

  let hasOrigin = false;
  for (const ref of refs) {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
      continue;
    }
    const refType = (ref as JsonObject).type;
    if (typeof refType !== "string") {
      continue;
    }
    if (legacyOriginMatch(refType)) {
      hasOrigin = true;
      break;
    }
    if (strictOriginTypes) {
      if (STRICT_ORIGIN_ALLOWLIST.has(refType)) {
        hasOrigin = true;
        break;
      }
    } else if (schemaTrustingOrigin(refType)) {
      hasOrigin = true;
      break;
    }
  }

  if (!hasOrigin) {
    if (strictOriginTypes) {
      return [
        `${filepath}: scope vBRIEF in '${folder}/' has no references with an allow-listed origin type (D11; --strict-origin-types)`,
      ];
    }
    return [
      `${filepath}: scope vBRIEF in '${folder}/' has no references with an origin type (D11)`,
    ];
  }
  return [];
}
