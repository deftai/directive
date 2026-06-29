/**
 * contract-drift.ts — deterministic gate for the public contract layer (#1799).
 *
 * Ensures:
 *   1. packages/types/schemas/vbrief-core-0.6.schema.json matches the canonical
 *      content/vbrief/schemas/vbrief-core.schema.json byte-for-byte.
 *   2. @deftai/directive-types Status enum matches the schema Status enum.
 *   3. @deftai/directive-types VBRIEF_VERSION matches the schema version const.
 *
 * Exit codes: 0 clean / 1 drift / 2 config error.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type GateExitCode, VALID_STATUSES, VBRIEF_VERSION } from "@deftai/directive-types";

export const EXIT_OK = 0;
export const EXIT_DRIFT = 1;
export const EXIT_CONFIG_ERROR = 2;

export const CANONICAL_SCHEMA_REL = "content/vbrief/schemas/vbrief-core.schema.json";
export const PUBLISHED_SCHEMA_REL = "packages/types/schemas/vbrief-core-0.6.schema.json";

export interface ContractDriftResult {
  readonly code: GateExitCode;
  readonly message: string;
  readonly stream: "stdout" | "stderr";
}

export interface ContractDriftOptions {
  readonly root: string;
  readonly readText?: (path: string) => string;
}

function defaultReadText(path: string): string {
  return readFileSync(path, "utf8");
}

function loadSchemaJson(text: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${label} is not a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${detail}`);
  }
}

function schemaStatusEnum(schema: Record<string, unknown>): string[] {
  const defs = schema.$defs;
  if (typeof defs !== "object" || defs === null || Array.isArray(defs)) {
    throw new Error("schema missing $defs");
  }
  const status = (defs as Record<string, unknown>).Status;
  if (typeof status !== "object" || status === null || Array.isArray(status)) {
    throw new Error("schema missing $defs.Status");
  }
  const enumValues = (status as Record<string, unknown>).enum;
  if (!Array.isArray(enumValues) || enumValues.some((v) => typeof v !== "string")) {
    throw new Error("schema $defs.Status.enum must be a string array");
  }
  return [...enumValues];
}

function schemaVersionConst(schema: Record<string, unknown>): string {
  const defs = schema.$defs;
  if (typeof defs !== "object" || defs === null || Array.isArray(defs)) {
    throw new Error("schema missing $defs");
  }
  const info = (defs as Record<string, unknown>).vBRIEFInfo;
  if (typeof info !== "object" || info === null || Array.isArray(info)) {
    throw new Error("schema missing $defs.vBRIEFInfo");
  }
  const properties = (info as Record<string, unknown>).properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    throw new Error("schema missing $defs.vBRIEFInfo.properties");
  }
  const version = (properties as Record<string, unknown>).version;
  if (typeof version !== "object" || version === null || Array.isArray(version)) {
    throw new Error("schema missing $defs.vBRIEFInfo.properties.version");
  }
  const constValue = (version as Record<string, unknown>).const;
  if (typeof constValue !== "string") {
    throw new Error("schema $defs.vBRIEFInfo.properties.version.const must be a string");
  }
  return constValue;
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort();
}

/** Evaluate contract drift for the directive source tree. */
export function evaluateContractDrift(
  projectRoot: string,
  options: Partial<ContractDriftOptions> = {},
): ContractDriftResult {
  const root = resolve(projectRoot);
  const readText = options.readText ?? defaultReadText;
  const canonicalPath = join(root, CANONICAL_SCHEMA_REL);
  const publishedPath = join(root, PUBLISHED_SCHEMA_REL);

  let canonicalText: string;
  let publishedText: string;
  try {
    canonicalText = readText(canonicalPath);
    publishedText = readText(publishedPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      code: EXIT_CONFIG_ERROR,
      message: `contract-drift: config error — could not read schema files (${detail}). Run pnpm --prefix packages/types run prebuild.`,
      stream: "stderr",
    };
  }

  if (canonicalText !== publishedText) {
    return {
      code: EXIT_DRIFT,
      message:
        `contract-drift: ${PUBLISHED_SCHEMA_REL} is out of sync with ${CANONICAL_SCHEMA_REL}. ` +
        "Run: pnpm --prefix packages/types run prebuild",
      stream: "stderr",
    };
  }

  let schema: Record<string, unknown>;
  try {
    schema = loadSchemaJson(canonicalText, CANONICAL_SCHEMA_REL);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      code: EXIT_CONFIG_ERROR,
      message: `contract-drift: config error — ${detail}`,
      stream: "stderr",
    };
  }

  try {
    const schemaStatuses = sortedStrings(schemaStatusEnum(schema));
    const typeStatuses = sortedStrings(VALID_STATUSES);
    if (schemaStatuses.join("|") !== typeStatuses.join("|")) {
      return {
        code: EXIT_DRIFT,
        message:
          "contract-drift: VALID_STATUSES in @deftai/directive-types diverges from " +
          `$defs.Status.enum in ${CANONICAL_SCHEMA_REL}.`,
        stream: "stderr",
      };
    }

    const schemaVersion = schemaVersionConst(schema);
    if (schemaVersion !== VBRIEF_VERSION) {
      return {
        code: EXIT_DRIFT,
        message:
          "contract-drift: VBRIEF_VERSION in @deftai/directive-types diverges from " +
          "schema vBRIEFInfo.version const.",
        stream: "stderr",
      };
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      code: EXIT_CONFIG_ERROR,
      message: `contract-drift: config error — ${detail}`,
      stream: "stderr",
    };
  }

  return {
    code: EXIT_OK,
    message:
      "contract-drift: canonical schema, published copy, and TS contract constants are in sync.",
    stream: "stdout",
  };
}
