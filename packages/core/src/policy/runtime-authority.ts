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

/** Classifiable shell/MCP operation for scopes.push / scopes.merge (#2711). */
export type RuntimeAuthorityShellOp = "push" | "merge";

/** True when token is a shell env assignment (FOO=1 / FOO=). Linear; no nested quantifiers. */
function isShellEnvAssignToken(token: string): boolean {
  const eq = token.indexOf("=");
  if (eq <= 0) return false;
  const name = token.slice(0, eq);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;
  return true;
}

/**
 * Normalize a shell token for classification (#2711).
 * Shell strips quotes, empty quote pairs, and backslash escapes before exec
 * (`g''it` / `g\it` / `'push'` → `git` / `push`). Dropping `'`/`"`/`\` after
 * whitespace split closes those bypasses without nested-quantifier regex. O(n).
 */
function normalizeShellToken(token: string): string {
  return token.replace(/['"\\]/g, "");
}

/**
 * Split a shell command into list/pipeline/newline segments without splitting
 * on separators that appear inside single- or double-quoted spans (#2711).
 * Prevents `printf '%s' ';' 'git push'` from being classified as an executable push.
 */
function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === undefined) break;
    if (quote !== null) {
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    // Outside quotes: list/pipeline separators and newlines start a new segment.
    if (c === "&" && command[i + 1] === "&") {
      segments.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (c === "|" && command[i + 1] === "|") {
      segments.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (c === ";" || c === "|" || c === "&" || c === "\n" || c === "\r") {
      segments.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  segments.push(cur);
  return segments;
}

/**
 * Classify one shell list/pipeline segment for push/merge (#2711).
 * Token walk is O(n) — avoids nested-quantifier ReDoS that CodeQL flags on
 * `git (?:options)* push` style regexes (alerts #77 / #78 on this PR).
 */
function classifyShellSegment(segment: string): RuntimeAuthorityShellOp | null {
  const tokens = segment
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === undefined || !isShellEnvAssignToken(tok)) break;
    i++;
  }
  const wrapTok = tokens[i];
  if (wrapTok !== undefined) {
    const wrap = normalizeShellToken(wrapTok).toLowerCase();
    if (wrap === "sudo" || wrap === "env" || wrap === "command") {
      i++;
      while (i < tokens.length) {
        const tok = tokens[i];
        if (tok === undefined || !isShellEnvAssignToken(tok)) break;
        i++;
      }
    }
  }
  const binTok = tokens[i];
  if (binTok === undefined) return null;

  const bin = normalizeShellToken(binTok).toLowerCase();
  if (bin === "git" || bin === "git.exe") {
    i++;
    // Skip git global options before the subcommand (-C path, -c key=value, --flag, -x).
    while (i < tokens.length) {
      const raw = tokens[i];
      if (raw === undefined) return null;
      const t = normalizeShellToken(raw);
      const lower = t.toLowerCase();
      if (!t.startsWith("-")) {
        return lower === "push" ? "push" : null;
      }
      // -C <path> / -c <name>=<value> consume the next token when not glued.
      if (t === "-C" || t === "-c") {
        i += 2;
        continue;
      }
      // Glued forms: -C/path, -cname=value
      if (t.startsWith("-C") || t.startsWith("-c")) {
        i++;
        continue;
      }
      i++;
    }
    return null;
  }

  if (bin === "gh" || bin === "gh.exe") {
    i++;
    while (i < tokens.length) {
      const flagRaw = tokens[i];
      if (flagRaw === undefined) break;
      const flag = normalizeShellToken(flagRaw);
      if (!flag.startsWith("-")) break;
      i++;
    }
    const pr = tokens[i];
    const merge = tokens[i + 1];
    if (
      pr !== undefined &&
      merge !== undefined &&
      normalizeShellToken(pr).toLowerCase() === "pr" &&
      normalizeShellToken(merge).toLowerCase() === "merge"
    ) {
      return "merge";
    }
    return null;
  }

  return null;
}

/**
 * List all classifiable push/merge ops in a shell command (#2711).
 * Scans every list/pipeline/newline segment so compound commands like
 * `gh pr merge 1 && git push` surface both ops (dispatcher evaluates each).
 * Newlines are delimiters so multi-line scripts cannot hide a later push/merge.
 */
export function listShellOps(command: string): RuntimeAuthorityShellOp[] {
  const cmd = command.trim();
  if (cmd.length === 0) return [];
  const found = new Set<RuntimeAuthorityShellOp>();
  // Quote-aware split so separators inside quotes are not treated as list ops.
  for (const raw of splitShellSegments(cmd)) {
    const op = classifyShellSegment(raw);
    if (op !== null) found.add(op);
  }
  const out: RuntimeAuthorityShellOp[] = [];
  // Stable order for deterministic multi-op evaluation.
  if (found.has("push")) out.push("push");
  if (found.has("merge")) out.push("merge");
  return out;
}

/**
 * Classify a shell command string for push/merge scopes (#2711).
 * Unclassifiable commands return null (fail open at the gate).
 * When a compound command has multiple ops, returns the first of listShellOps
 * (push before merge); prefer listShellOps + evaluate-each for enforcement.
 *
 * Patterns (intentionally narrow; prefer false-open over false-deny):
 * - push: `git push`, `git.exe push`, with optional env / -C / -c prefixes
 * - merge: `gh pr merge`, `gh.exe pr merge`
 */
export function classifyShellCommand(command: string): RuntimeAuthorityShellOp | null {
  const ops = listShellOps(command);
  return ops[0] ?? null;
}

/**
 * Classify an MCP (or MCP-like) tool name + optional argument blob for push/merge (#2711).
 * Returns null when the tool is not a known push/merge mutation (fail open).
 */
export function classifyMcpTool(
  toolName: string,
  argsText: string | null = null,
): RuntimeAuthorityShellOp | null {
  const name = toolName.trim().toLowerCase();
  if (name.length === 0) return null;
  // Common GitHub MCP / bridge spellings for merge
  if (
    /merge[_-]?pull[_-]?request/.test(name) ||
    /pull[_-]?request[_-]?merge/.test(name) ||
    /(^|__)merge_pr($|__)/.test(name) ||
    /pr[_-]?merge/.test(name)
  ) {
    return "merge";
  }
  // Push-like tool names (narrow — prefer fail-open)
  if (/(^|__)git[_-]?push($|__)/.test(name) || /push[_-]?branch/.test(name)) {
    return "push";
  }
  if (/push/.test(name) && /(git|branch|remote|ref)/.test(name)) return "push";

  const blob = (argsText ?? "").toLowerCase();
  if (blob.length > 0) {
    if (/\bgit(?:\.exe)?\s+push\b/.test(blob)) return "push";
    if (/\bgh(?:\.exe)?\s+pr\s+merge\b/.test(blob)) return "merge";
  }
  return null;
}

export interface RuntimeAuthorityShellOpInput {
  readonly policy: RuntimeAuthorityPolicy;
  readonly op: RuntimeAuthorityShellOp | null;
}

export interface RuntimeAuthorityShellOpResult {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly code: "runtime-policy-deny-scope" | null;
  /** True when op was null — gate should fail open. */
  readonly unclassifiable: boolean;
}

/**
 * Evaluate scopes.push / scopes.merge for a classifiable shell/MCP operation (#2711).
 * null op → allow (unclassifiable fail-open). disabled policy → allow.
 */
export function evaluateRuntimeAuthorityShellOp(
  input: RuntimeAuthorityShellOpInput,
): RuntimeAuthorityShellOpResult {
  const { policy, op } = input;
  if (!policy.enabled) {
    return { allowed: true, reason: null, code: null, unclassifiable: op === null };
  }
  if (op === null) {
    return { allowed: true, reason: null, code: null, unclassifiable: true };
  }
  if (op === "push" && !policy.scopes.push) {
    return {
      allowed: false,
      code: "runtime-policy-deny-scope",
      unclassifiable: false,
      reason:
        "Directive denied this shell/MCP operation: plan.policy.runtimeAuthority.scopes.push is false. " +
        "Grant the push scope in PROJECT-DEFINITION or disable runtimeAuthority.",
    };
  }
  if (op === "merge" && !policy.scopes.merge) {
    return {
      allowed: false,
      code: "runtime-policy-deny-scope",
      unclassifiable: false,
      reason:
        "Directive denied this shell/MCP operation: plan.policy.runtimeAuthority.scopes.merge is false. " +
        "Grant the merge scope in PROJECT-DEFINITION or disable runtimeAuthority.",
    };
  }
  return { allowed: true, reason: null, code: null, unclassifiable: false };
}
