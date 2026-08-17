/**
 * Typed plan.policy.projectInvariants (#3425 Story A).
 *
 * Authored project-level must-not-break contracts. Empty or absent list is a
 * no-op. Parse/validate only — preflight fail-closed is Story B.
 */

import { readPlanPolicy } from "./plan-extensions.js";
import { loadProjectDefinition } from "./resolve.js";

export const FIELD_PROJECT_INVARIANTS = "plan.policy.projectInvariants";
export const FIELD_PROJECT_INVARIANTS_CLI_ALIAS = "projectInvariants";

export interface ProjectInvariantContractSurface {
  readonly paths: readonly string[];
  readonly moduleIds: readonly string[];
}

export interface ProjectInvariant {
  readonly id: string;
  readonly statement: string;
  readonly contractSurface: ProjectInvariantContractSurface;
}

export type ProjectInvariantsSource = "typed" | "default" | "default-on-error";

export interface ProjectInvariantsParseResult {
  readonly invariants: readonly ProjectInvariant[];
  readonly errors: readonly string[];
}

export interface ProjectInvariantsResolved {
  readonly invariants: readonly ProjectInvariant[];
  readonly source: ProjectInvariantsSource;
  readonly error: string | null;
}

export interface ProjectInvariantsPolicyField {
  readonly name: typeof FIELD_PROJECT_INVARIANTS;
  readonly current: readonly ProjectInvariant[];
  readonly default: readonly ProjectInvariant[];
  readonly source: string;
}

const EMPTY: readonly ProjectInvariant[] = [];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asStrList(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return value.trim().length > 0 ? [value.trim()] : [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter((s) => s.length > 0);
  }
  return [];
}

function pythonTypeName(value: unknown): string {
  if (value === null) return "None";
  if (Array.isArray(value)) return "list";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "string") return "str";
  if (typeof value === "object") return "dict";
  return typeof value;
}

function parseContractSurface(
  body: Record<string, unknown>,
  loc: string,
): { surface: ProjectInvariantContractSurface | null; errors: string[] } {
  const nested =
    asRecord(body.contractSurface) ?? asRecord(body.contract_surface) ?? asRecord(body.contract);
  const pathSource = nested ?? body;
  const moduleSource = nested ?? body;

  const pathsRaw = pathSource.paths ?? pathSource.pathGlobs ?? pathSource.path_globs ?? body.paths;
  const moduleRaw =
    moduleSource.moduleIds ??
    moduleSource.module_ids ??
    moduleSource.modules ??
    body.moduleIds ??
    body.module_ids;

  // Shorthand: contractSurface / contract_surface as a string list of paths.
  const shorthand = body.contractSurface ?? body.contract_surface ?? body.contract;
  const paths = [...asStrList(pathsRaw), ...(nested === null ? asStrList(shorthand) : [])];
  const moduleIds = asStrList(moduleRaw);

  if (paths.length === 0 && moduleIds.length === 0) {
    return {
      surface: null,
      errors: [
        `${loc}: contract surface requires paths[] and/or moduleIds[] ` +
          `(must-not-break module/contract)`,
      ],
    };
  }

  return {
    surface: { paths, moduleIds },
    errors: [],
  };
}

/** Parse a raw projectInvariants value. Absent/null → empty list, no errors. */
export function parseProjectInvariants(raw: unknown): ProjectInvariantsParseResult {
  if (raw === null || raw === undefined) {
    return { invariants: EMPTY, errors: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      invariants: EMPTY,
      errors: [`${FIELD_PROJECT_INVARIANTS} must be an array; got ${pythonTypeName(raw)}`],
    };
  }

  const invariants: ProjectInvariant[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < raw.length; i += 1) {
    const loc = `${FIELD_PROJECT_INVARIANTS}[${i}]`;
    const item = raw[i];
    const rec = asRecord(item);
    if (rec === null) {
      errors.push(`${loc}: entry must be an object`);
      continue;
    }
    const id = rec.id;
    const statement = rec.statement ?? rec.Statement;
    if (!isNonEmptyString(id)) {
      errors.push(`${loc}: id is required`);
      continue;
    }
    const trimmedId = id.trim();
    if (seen.has(trimmedId)) {
      errors.push(`${loc}: duplicate id '${trimmedId}'`);
      continue;
    }
    if (!isNonEmptyString(statement)) {
      errors.push(`${loc}: statement is required`);
      continue;
    }
    const { surface, errors: surfaceErrors } = parseContractSurface(rec, loc);
    errors.push(...surfaceErrors);
    if (surface === null) continue;
    seen.add(trimmedId);
    invariants.push({
      id: trimmedId,
      statement: String(statement).trim(),
      contractSurface: surface,
    });
  }

  return { invariants, errors };
}

/**
 * Map codeStructure.modules[] id → pathGlobs for applicability intersection.
 * Pure: pass PROJECT-DEFINITION (or plan) data, no disk IO.
 */
export function extractModulePathGlobs(projectDefinition: unknown): Record<string, string[]> {
  const root = asRecord(projectDefinition);
  if (root === null) return {};
  const plan = asRecord(root.plan) ?? root;
  const architecture = asRecord(plan.architecture);
  if (architecture === null) return {};
  const codeStructure = asRecord(architecture.codeStructure ?? architecture.code_structure);
  if (codeStructure === null) return {};
  const modules = codeStructure.modules;
  if (!Array.isArray(modules)) return {};

  const out: Record<string, string[]> = {};
  for (const item of modules) {
    const rec = asRecord(item);
    if (rec === null || !isNonEmptyString(rec.id)) continue;
    const globs = asStrList(rec.pathGlobs ?? rec.path_globs ?? rec.paths);
    if (globs.length === 0) continue;
    out[rec.id.trim()] = globs;
  }
  return out;
}

function readPolicyBlock(data: Record<string, unknown> | null): Record<string, unknown> | null {
  if (data === null) return null;
  const policy = readPlanPolicy(data.plan);
  return asRecord(policy);
}

/**
 * Resolve projectInvariants from PROJECT-DEFINITION data already in memory.
 * Absent/null → default empty. Present invalid → default-on-error + message.
 */
export function resolveProjectInvariantsFromData(
  data: Record<string, unknown> | null,
): ProjectInvariantsResolved {
  const policy = readPolicyBlock(data);
  if (policy === null || !("projectInvariants" in policy)) {
    return { invariants: EMPTY, source: "default", error: null };
  }
  const raw = policy.projectInvariants;
  if (raw === null) {
    return { invariants: EMPTY, source: "default", error: null };
  }
  const parsed = parseProjectInvariants(raw);
  if (parsed.errors.length > 0) {
    return {
      invariants: EMPTY,
      source: "default-on-error",
      error: parsed.errors.join("; "),
    };
  }
  return { invariants: parsed.invariants, source: "typed", error: null };
}

/** Resolve from a project root via the PROJECT-DEFINITION IO path. */
export function resolveProjectInvariants(projectRoot: string): ProjectInvariantsResolved {
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return { invariants: EMPTY, source: "default", error: err };
  }
  return resolveProjectInvariantsFromData(data);
}

/** Inspector row for `task policy:show --field=projectInvariants`. */
export function inspectProjectInvariants(
  data: Record<string, unknown> | null,
  projectRoot?: string,
): ProjectInvariantsPolicyField {
  const resolved =
    data !== null
      ? resolveProjectInvariantsFromData(data)
      : projectRoot !== undefined && projectRoot.length > 0
        ? resolveProjectInvariants(projectRoot)
        : { invariants: EMPTY, source: "default" as const, error: null };
  return {
    name: FIELD_PROJECT_INVARIANTS,
    current: resolved.invariants,
    default: EMPTY,
    source: resolved.source,
  };
}
