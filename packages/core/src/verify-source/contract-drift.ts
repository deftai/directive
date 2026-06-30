/**
 * contract-drift.ts — deterministic gate for the public contract layer (#1799, #2107).
 *
 * Ensures:
 *   1. packages/types/schemas/vbrief-core-0.6.schema.json matches the canonical
 *      content/vbrief/schemas/vbrief-core.schema.json byte-for-byte.
 *   2. packages/types/schemas/xbrief-core-0.8.schema.json matches the canonical
 *      content/vbrief/schemas/xbrief-core-0.8.schema.json byte-for-byte.
 *   3. @deftai/directive-types VALID_STATUSES matches v0.6 $defs.Status enum.
 *   4. @deftai/directive-types VBRIEF_VERSION matches v0.8 $defs.xBRIEFInfo.version const.
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
export const XBRIEF_CANONICAL_SCHEMA_REL = "content/vbrief/schemas/xbrief-core-0.8.schema.json";
export const XBRIEF_PUBLISHED_SCHEMA_REL = "packages/types/schemas/xbrief-core-0.8.schema.json";

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

function xbriefVersionConst(schema: Record<string, unknown>): string {
  const defs = schema.$defs;
  if (typeof defs !== "object" || defs === null || Array.isArray(defs)) {
    throw new Error("schema missing $defs");
  }
  const info = (defs as Record<string, unknown>).xBRIEFInfo;
  if (typeof info !== "object" || info === null || Array.isArray(info)) {
    throw new Error("schema missing $defs.xBRIEFInfo");
  }
  const properties = (info as Record<string, unknown>).properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    throw new Error("schema missing $defs.xBRIEFInfo.properties");
  }
  const version = (properties as Record<string, unknown>).version;
  if (typeof version !== "object" || version === null || Array.isArray(version)) {
    throw new Error("schema missing $defs.xBRIEFInfo.properties.version");
  }
  const constValue = (version as Record<string, unknown>).const;
  if (typeof constValue !== "string") {
    throw new Error("schema $defs.xBRIEFInfo.properties.version.const must be a string");
  }
  return constValue;
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort();
}

function schemaPairInSync(
  root: string,
  readText: (path: string) => string,
  canonicalRel: string,
  publishedRel: string,
): ContractDriftResult | null {
  const canonicalPath = join(root, canonicalRel);
  const publishedPath = join(root, publishedRel);
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
        `contract-drift: ${publishedRel} is out of sync with ${canonicalRel}. ` +
        "Run: pnpm --prefix packages/types run prebuild",
      stream: "stderr",
    };
  }
  return null;
}

/** Evaluate contract drift for the directive source tree. */
export function evaluateContractDrift(
  projectRoot: string,
  options: Partial<ContractDriftOptions> = {},
): ContractDriftResult {
  const root = resolve(projectRoot);
  const readText = options.readText ?? defaultReadText;

  for (const [canonicalRel, publishedRel] of [
    [CANONICAL_SCHEMA_REL, PUBLISHED_SCHEMA_REL],
    [XBRIEF_CANONICAL_SCHEMA_REL, XBRIEF_PUBLISHED_SCHEMA_REL],
  ] as const) {
    const syncResult = schemaPairInSync(root, readText, canonicalRel, publishedRel);
    if (syncResult !== null) {
      return syncResult;
    }
  }

  let v06Schema: Record<string, unknown>;
  let v08Schema: Record<string, unknown>;
  try {
    v06Schema = loadSchemaJson(readText(join(root, CANONICAL_SCHEMA_REL)), CANONICAL_SCHEMA_REL);
    v08Schema = loadSchemaJson(
      readText(join(root, XBRIEF_CANONICAL_SCHEMA_REL)),
      XBRIEF_CANONICAL_SCHEMA_REL,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      code: EXIT_CONFIG_ERROR,
      message: `contract-drift: config error — ${detail}`,
      stream: "stderr",
    };
  }

  try {
    const schemaStatuses = sortedStrings(schemaStatusEnum(v06Schema));
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

    const schemaVersion = xbriefVersionConst(v08Schema);
    if (schemaVersion !== VBRIEF_VERSION) {
      return {
        code: EXIT_DRIFT,
        message:
          "contract-drift: VBRIEF_VERSION in @deftai/directive-types diverges from " +
          "schema xBRIEFInfo.version const.",
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
      "contract-drift: canonical schemas, published copies, and TS contract constants are in sync.",
    stream: "stdout",
  };
}
