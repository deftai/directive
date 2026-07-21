import { matchAny } from "../orchestration/pathspec.js";
import { readPlanPolicy } from "./plan-extensions.js";
import { loadProjectDefinition } from "./resolve.js";

export const FIELD_RUNTIME_AUTHORITY = "plan.policy.runtimeAuthority";
export const FIELD_RUNTIME_AUTHORITY_CLI_ALIAS = "runtimeAuthority";

/** Graduated permission scopes (#1394 steipete ladder). */
export interface RuntimeAuthorityScopes {
  /** Direct edit/write tools (PreToolUse classifiable today). */
  readonly edits: boolean;
  /** git push / tag push — enforced only when Shell payload is classifiable (host gap). */
  readonly push: boolean;
  /** merge / close / release — enforced only when Shell payload is classifiable (host gap). */
  readonly merge: boolean;
}

export interface RuntimeAuthorityPolicy {
  readonly enabled: boolean;
  /** When non-empty, write targets must match at least one pattern. Empty = allow all paths. */
  readonly allowPaths: readonly string[];
  /** Deny wins over allow. */
  readonly denyPaths: readonly string[];
  readonly scopes: RuntimeAuthorityScopes;
}

export const DEFAULT_RUNTIME_AUTHORITY_SCOPES: RuntimeAuthorityScopes = {
  edits: true,
  push: false,
  merge: false,
};

/** Safe default: opt-in only — existing consumers see no runtime authority until enabled. */
export const DEFAULT_RUNTIME_AUTHORITY_POLICY: RuntimeAuthorityPolicy = {
  enabled: false,
  allowPaths: [],
  denyPaths: [],
  scopes: DEFAULT_RUNTIME_AUTHORITY_SCOPES,
};

export interface RuntimeAuthorityPolicyField {
  readonly name: string;
  readonly current: RuntimeAuthorityPolicy;
  readonly default: RuntimeAuthorityPolicy;
  readonly source: string;
}

function readBoolean(rec: Record<string, unknown>, key: string, fallback: boolean): boolean {
  if (key in rec && typeof rec[key] === "boolean") {
    return rec[key] as boolean;
  }
  return fallback;
}

function readStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function readScopes(raw: unknown): RuntimeAuthorityScopes {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return DEFAULT_RUNTIME_AUTHORITY_SCOPES;
  }
  const rec = raw as Record<string, unknown>;
  return {
    edits: readBoolean(rec, "edits", DEFAULT_RUNTIME_AUTHORITY_SCOPES.edits),
    push: readBoolean(rec, "push", DEFAULT_RUNTIME_AUTHORITY_SCOPES.push),
    merge: readBoolean(rec, "merge", DEFAULT_RUNTIME_AUTHORITY_SCOPES.merge),
  };
}

export function resolveRuntimeAuthorityPolicy(raw: unknown): RuntimeAuthorityPolicy {
  if (raw === null || raw === undefined) {
    return DEFAULT_RUNTIME_AUTHORITY_POLICY;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return DEFAULT_RUNTIME_AUTHORITY_POLICY;
  }
  const rec = raw as Record<string, unknown>;
  return {
    enabled: readBoolean(rec, "enabled", DEFAULT_RUNTIME_AUTHORITY_POLICY.enabled),
    allowPaths: readStringArray(rec.allowPaths),
    denyPaths: readStringArray(rec.denyPaths),
    scopes: readScopes(rec.scopes),
  };
}

export function validateRuntimeAuthority(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return [`${FIELD_RUNTIME_AUTHORITY} must be an object; got ${typeof value}`];
  }
  const rec = value as Record<string, unknown>;
  const errors: string[] = [];
  if ("enabled" in rec && typeof rec.enabled !== "boolean") {
    errors.push(`${FIELD_RUNTIME_AUTHORITY}.enabled must be a boolean`);
  }
  for (const key of ["allowPaths", "denyPaths"] as const) {
    if (key in rec && !Array.isArray(rec[key])) {
      errors.push(`${FIELD_RUNTIME_AUTHORITY}.${key} must be an array of path globs`);
    }
  }
  if ("scopes" in rec) {
    const scopes = rec.scopes;
    if (typeof scopes !== "object" || scopes === null || Array.isArray(scopes)) {
      errors.push(`${FIELD_RUNTIME_AUTHORITY}.scopes must be an object`);
    } else {
      for (const key of ["edits", "push", "merge"] as const) {
        if (
          key in (scopes as Record<string, unknown>) &&
          typeof (scopes as Record<string, unknown>)[key] !== "boolean"
        ) {
          errors.push(`${FIELD_RUNTIME_AUTHORITY}.scopes.${key} must be a boolean`);
        }
      }
    }
  }
  return errors;
}

function fieldFromResolved(
  resolved: RuntimeAuthorityPolicy,
  source: string,
): RuntimeAuthorityPolicyField {
  return {
    name: FIELD_RUNTIME_AUTHORITY,
    current: resolved,
    default: DEFAULT_RUNTIME_AUTHORITY_POLICY,
    source,
  };
}

/** Inspector row for `policy:show --field=runtimeAuthority`. */
export function inspectRuntimeAuthority(
  data: Record<string, unknown> | null,
): RuntimeAuthorityPolicyField {
  if (data === null) {
    return fieldFromResolved(DEFAULT_RUNTIME_AUTHORITY_POLICY, "default");
  }
  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("runtimeAuthority" in (policyBlock as Record<string, unknown>))
  ) {
    return fieldFromResolved(DEFAULT_RUNTIME_AUTHORITY_POLICY, "default");
  }
  const resolved = resolveRuntimeAuthorityPolicy(
    (policyBlock as Record<string, unknown>).runtimeAuthority,
  );
  return fieldFromResolved(resolved, "typed");
}

/** Resolve typed runtime authority policy from PROJECT-DEFINITION. */
export function loadRuntimeAuthorityPolicy(
  data: Record<string, unknown> | null,
): RuntimeAuthorityPolicy {
  if (data === null) {
    return DEFAULT_RUNTIME_AUTHORITY_POLICY;
  }
  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("runtimeAuthority" in (policyBlock as Record<string, unknown>))
  ) {
    return DEFAULT_RUNTIME_AUTHORITY_POLICY;
  }
  return resolveRuntimeAuthorityPolicy((policyBlock as Record<string, unknown>).runtimeAuthority);
}

/** Load runtime authority from a project root (PROJECT-DEFINITION on disk). */
export function loadRuntimeAuthorityFromProject(projectRoot: string): RuntimeAuthorityPolicy {
  const [data] = loadProjectDefinition(projectRoot);
  return loadRuntimeAuthorityPolicy(data);
}

export type RuntimeAuthorityPathVerdict = "allow" | "deny-allowlist" | "deny-denylist";

/** Evaluate a project-relative POSIX path against allow/deny globs. */
export function evaluateRuntimeAuthorityPath(
  policy: RuntimeAuthorityPolicy,
  relPathPosix: string,
): RuntimeAuthorityPathVerdict {
  if (!policy.enabled) return "allow";
  if (matchAny(policy.denyPaths, relPathPosix)) return "deny-denylist";
  if (policy.allowPaths.length > 0 && !matchAny(policy.allowPaths, relPathPosix)) {
    return "deny-allowlist";
  }
  return "allow";
}

export interface RuntimeAuthorityDirectWriteInput {
  readonly policy: RuntimeAuthorityPolicy;
  readonly relPathPosix: string | null;
}

export interface RuntimeAuthorityDirectWriteResult {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly code: "runtime-policy-deny-scope" | "runtime-policy-deny-path" | null;
}

/**
 * Evaluate direct-write runtime authority after ritual/scope gates (#1394).
 * Unclassifiable paths (null) pass — host gap documented for Shell/MCP.
 */
export function evaluateRuntimeAuthorityDirectWrite(
  input: RuntimeAuthorityDirectWriteInput,
): RuntimeAuthorityDirectWriteResult {
  const { policy, relPathPosix } = input;
  if (!policy.enabled) {
    return { allowed: true, reason: null, code: null };
  }
  if (!policy.scopes.edits) {
    return {
      allowed: false,
      code: "runtime-policy-deny-scope",
      reason:
        "Directive denied this direct write: plan.policy.runtimeAuthority.scopes.edits is false. " +
        "Grant the edits scope in PROJECT-DEFINITION or disable runtimeAuthority.",
    };
  }
  if (relPathPosix === null) {
    return { allowed: true, reason: null, code: null };
  }
  const pathVerdict = evaluateRuntimeAuthorityPath(policy, relPathPosix);
  if (pathVerdict === "deny-denylist") {
    return {
      allowed: false,
      code: "runtime-policy-deny-path",
      reason:
        `Directive denied this direct write: path ${relPathPosix} matches ` +
        "plan.policy.runtimeAuthority.denyPaths.",
    };
  }
  if (pathVerdict === "deny-allowlist") {
    return {
      allowed: false,
      code: "runtime-policy-deny-path",
      reason:
        `Directive denied this direct write: path ${relPathPosix} is outside ` +
        "plan.policy.runtimeAuthority.allowPaths.",
    };
  }
  return { allowed: true, reason: null, code: null };
}
