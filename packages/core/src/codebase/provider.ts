import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEBASE_MAP_SCHEMA_PATH } from "./constants.js";
import {
  buildCodebaseMap,
  CodeStructureConfigError,
  configErrorToDict,
  defaultCodeStructurePath,
} from "./default-extractor.js";
import { sortedStringifyPretty } from "./json.js";
import { CODEBASE_MAP_KIND } from "./projection-registry.js";

export { CODEBASE_MAP_KIND };

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SCHEMA_ANNOTATION_KEYS = new Set(["$schema", "$id", "title", "description"]);
const SUPPORTED_SCHEMA_KEYS = new Set([
  ...SCHEMA_ANNOTATION_KEYS,
  "additionalProperties",
  "const",
  "items",
  "minItems",
  "minimum",
  "minLength",
  "properties",
  "required",
  "type",
]);

export interface ProviderSelection {
  readonly artifact: Record<string, unknown>;
  readonly used_external_provider: boolean;
  readonly fallback_reason: string | null;
}

let cachedSchema: Record<string, unknown> | null = null;

function loadCodebaseMapSchema(): Record<string, unknown> {
  if (cachedSchema !== null) {
    return cachedSchema;
  }
  const schemaPath = join(REPO_ROOT, CODEBASE_MAP_SCHEMA_PATH);
  const schema = JSON.parse(readFileSync(schemaPath, { encoding: "utf8" })) as unknown;
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new Error(`${CODEBASE_MAP_SCHEMA_PATH} must contain a JSON object`);
  }
  cachedSchema = schema as Record<string, unknown>;
  return cachedSchema;
}

function schemaForExpectedKind(expectedKind: string): Record<string, unknown> {
  const schema = loadCodebaseMapSchema();
  if (expectedKind === CODEBASE_MAP_KIND) {
    return schema;
  }
  const copy = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  const properties = copy.properties;
  if (typeof properties === "object" && properties !== null && !Array.isArray(properties)) {
    const kindProp = (properties as Record<string, unknown>).kind;
    if (typeof kindProp === "object" && kindProp !== null && !Array.isArray(kindProp)) {
      (kindProp as Record<string, unknown>).const = expectedKind;
    }
  }
  return copy;
}

function schemaPath(path: string, field: string): string {
  return path.length > 0 ? `${path}.${field}` : field;
}

function schemaErrorPath(path: string): string {
  return path.length > 0 ? path : "<root>";
}

function typeNames(schemaType: unknown): string[] {
  if (typeof schemaType === "string") {
    return [schemaType];
  }
  if (Array.isArray(schemaType) && schemaType.every((item) => typeof item === "string")) {
    return schemaType as string[];
  }
  return [];
}

function matchesJsonType(value: unknown, schemaType: string): boolean {
  if (schemaType === "array") {
    return Array.isArray(value);
  }
  if (schemaType === "boolean") {
    return typeof value === "boolean";
  }
  if (schemaType === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }
  if (schemaType === "null") {
    return value === null;
  }
  if (schemaType === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  if (schemaType === "string") {
    return typeof value === "string";
  }
  return false;
}

function typeLabel(schemaType: string): string {
  if (schemaType === "array") {
    return "an array";
  }
  if (schemaType === "integer") {
    return "an integer";
  }
  if (schemaType === "object") {
    return "an object";
  }
  return `a ${schemaType}`;
}

function schemaTypeError(path: string, schemaTypes: string[]): string {
  if (schemaTypes.length === 1) {
    return `${schemaErrorPath(path)} must be ${typeLabel(schemaTypes[0] ?? "value")}`;
  }
  return `${schemaErrorPath(path)} must be one of: ${schemaTypes.join(", ")}`;
}

function validateSchemaShape(schema: unknown, path: string): string[] {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return [`schema at ${schemaErrorPath(path)} must be an object`];
  }
  const rec = schema as Record<string, unknown>;
  const errors: string[] = [];
  for (const keyword of Object.keys(rec).sort()) {
    if (!SUPPORTED_SCHEMA_KEYS.has(keyword)) {
      errors.push(`schema at ${schemaErrorPath(path)} uses unsupported keyword '${keyword}'`);
    }
  }
  const schemaTypes = typeNames(rec.type);
  if ("type" in rec && schemaTypes.length === 0) {
    errors.push(`schema at ${schemaErrorPath(path)} has unsupported type`);
  }
  const required = rec.required;
  if (
    required !== undefined &&
    (!Array.isArray(required) || required.some((item) => typeof item !== "string"))
  ) {
    errors.push(`schema at ${schemaErrorPath(path)} has invalid required[]`);
  }
  const properties = rec.properties;
  if (properties !== undefined) {
    if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
      errors.push(`schema at ${schemaErrorPath(path)} has invalid properties`);
    } else {
      for (const [field, childSchema] of Object.entries(properties as Record<string, unknown>)) {
        errors.push(...validateSchemaShape(childSchema, schemaPath(path, field)));
      }
    }
  }
  if ("items" in rec) {
    errors.push(...validateSchemaShape(rec.items, `${path}[]`));
  }
  const additional = rec.additionalProperties;
  if (additional !== undefined && typeof additional !== "boolean") {
    errors.push(`schema at ${schemaErrorPath(path)} has unsupported additionalProperties`);
  }
  return errors;
}

function validateJsonSchemaSubset(
  value: unknown,
  schema: Record<string, unknown>,
  path = "",
): string[] {
  const schemaErrors = validateSchemaShape(schema, path);
  if (schemaErrors.length > 0) {
    return schemaErrors;
  }
  const schemaTypes = typeNames(schema.type);
  if (
    schemaTypes.length > 0 &&
    !schemaTypes.some((schemaType) => matchesJsonType(value, schemaType))
  ) {
    return [schemaTypeError(path, schemaTypes)];
  }

  const errors: string[] = [];
  if ("const" in schema && value !== schema.const) {
    errors.push(`${schemaErrorPath(path)} must be ${JSON.stringify(schema.const)}`);
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const field of required) {
        if (typeof field === "string" && !(field in rec)) {
          errors.push(`${schemaPath(path, field)} must be present`);
        }
      }
    }
    const properties = schema.properties;
    if (typeof properties === "object" && properties !== null && !Array.isArray(properties)) {
      for (const [field, childSchema] of Object.entries(properties as Record<string, unknown>)) {
        if (field in rec) {
          errors.push(
            ...validateJsonSchemaSubset(
              rec[field],
              childSchema as Record<string, unknown>,
              schemaPath(path, field),
            ),
          );
        }
      }
    }
    if (
      schema.additionalProperties === false &&
      typeof properties === "object" &&
      properties !== null
    ) {
      for (const field of Object.keys(rec).sort()) {
        if (!(field in (properties as Record<string, unknown>))) {
          errors.push(`${schemaPath(path, field)} is not allowed`);
        }
      }
    }
  }

  if (Array.isArray(value)) {
    const minItems = schema.minItems;
    if (typeof minItems === "number" && value.length < minItems) {
      if (minItems === 1) {
        errors.push(`${schemaErrorPath(path)} must be a non-empty array`);
      } else {
        errors.push(`${schemaErrorPath(path)} must contain at least ${minItems} items`);
      }
    }
    if ("items" in schema) {
      for (let index = 0; index < value.length; index += 1) {
        errors.push(
          ...validateJsonSchemaSubset(
            value[index],
            schema.items as Record<string, unknown>,
            `${path}[${index}]`,
          ),
        );
      }
    }
  }

  if (typeof value === "string") {
    const minLength = schema.minLength;
    if (typeof minLength === "number" && value.length < minLength) {
      if (minLength === 1) {
        errors.push(`${schemaErrorPath(path)} must be a non-empty string`);
      } else {
        errors.push(`${schemaErrorPath(path)} must contain at least ${minLength} characters`);
      }
    }
  }

  if (typeof value === "number" && Number.isInteger(value)) {
    const minimum = schema.minimum;
    if (typeof minimum === "number" && value < minimum) {
      errors.push(`${schemaErrorPath(path)} must be >= ${minimum}`);
    }
  }

  return errors;
}

/** Return deterministic JSON Schema contract errors for a provider artifact. */
export function validateProviderArtifact(
  artifact: unknown,
  expectedKind = CODEBASE_MAP_KIND,
): string[] {
  if (typeof artifact !== "object" || artifact === null || Array.isArray(artifact)) {
    return ["artifact must be a JSON object"];
  }
  return validateJsonSchemaSubset(artifact, schemaForExpectedKind(expectedKind));
}

function fallback(projectRoot: string, reason: string): ProviderSelection {
  return {
    artifact: buildCodebaseMap(projectRoot, { fallbackReason: reason }),
    used_external_provider: false,
    fallback_reason: reason,
  };
}

function parseShellCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaping = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command.charAt(i);
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}

function runProviderCommand(
  command: string[],
  cwd: string,
): { returncode: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(command[0] ?? "", command.slice(1), {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { returncode: 0, stdout, stderr: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      returncode: typeof e.status === "number" ? e.status : 1,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : String(e.message ?? err),
    };
  }
}

/** Return an external provider artifact when valid, else the default artifact. */
export function selectCodebaseMap(
  projectRoot: string,
  providerCommand?: string | string[] | null,
): ProviderSelection {
  if (providerCommand === undefined || providerCommand === null || providerCommand === "") {
    return fallback(projectRoot, "no external codebase-map provider configured");
  }

  let command: string[];
  try {
    command =
      typeof providerCommand === "string"
        ? parseShellCommand(providerCommand)
        : [...providerCommand];
  } catch (err) {
    return fallback(projectRoot, `provider command could not be parsed: ${String(err)}`);
  }
  if (command.length === 0) {
    return fallback(projectRoot, "provider command was empty");
  }

  let completed: { returncode: number; stdout: string; stderr: string };
  try {
    completed = runProviderCommand(command, resolve(projectRoot));
  } catch (err) {
    return fallback(projectRoot, `provider command failed before output: ${String(err)}`);
  }

  if (completed.returncode !== 0) {
    const detail = completed.stderr.trim() || completed.stdout.trim() || "no provider output";
    return fallback(projectRoot, `provider command exited ${completed.returncode}: ${detail}`);
  }

  let artifact: unknown;
  try {
    artifact = JSON.parse(completed.stdout);
  } catch (err) {
    const msg = err instanceof SyntaxError ? err.message : String(err);
    return fallback(projectRoot, `provider output was not valid JSON: ${msg}`);
  }

  const errors = validateProviderArtifact(artifact);
  if (errors.length > 0) {
    return fallback(projectRoot, `provider artifact contract mismatch: ${errors.join("; ")}`);
  }

  return {
    artifact: artifact as Record<string, unknown>,
    used_external_provider: true,
    fallback_reason: null,
  };
}

export interface ProviderCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** CLI entry point. */
export function runProviderCli(argv: string[]): ProviderCliResult {
  let projectRoot = ".";
  let providerCommand: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: "argument --project-root: expected one argument\n",
        };
      }
      projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--provider-command") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: "argument --provider-command: expected one argument\n",
        };
      }
      providerCommand = value;
      i += 1;
    } else if (arg?.startsWith("--provider-command=")) {
      providerCommand = arg.slice("--provider-command=".length);
    }
  }

  const root = resolve(projectRoot);
  try {
    const selection = selectCodebaseMap(root, providerCommand);
    return {
      exitCode: 0,
      stdout: sortedStringifyPretty(selection.artifact),
      stderr: "",
    };
  } catch (err) {
    if (err instanceof CodeStructureConfigError || err instanceof Error) {
      const path = defaultCodeStructurePath(root);
      return {
        exitCode: 2,
        stdout: "",
        stderr: sortedStringifyPretty(configErrorToDict(path, err)),
      };
    }
    throw err;
  }
}
