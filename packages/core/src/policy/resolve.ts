import { existsSync, readFileSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { resolveProjectDefinitionPath } from "../layout/resolve.js";
import {
  atomicWriteProjectDefinition,
  projectDefinitionMutationLock,
} from "../vbrief-build/project-definition-io.js";
import { migrateLegacyPolicyKey, PLAN_POLICY_KEY, readPlanPolicy } from "./plan-extensions.js";
import { policyColonInvocation } from "./policy-invocation.js";

/** Filesystem-relative location of the project-definition xBRIEF (display/back-compat). */
export const PROJECT_DEFINITION_REL_PATH = "xbrief/PROJECT-DEFINITION.xbrief.json";

/** Environment variable emergency bypass for branch protection (#747). */
export const ENV_BYPASS = "DEFT_ALLOW_DEFAULT_BRANCH_COMMIT";

/** Legacy narrative key replaced by the typed flag (#746). */
export const LEGACY_NARRATIVE_KEY = "Allow direct commits to master";

/** Audit log relative path (#746). */
export const AUDIT_LOG_REL_PATH = "meta/policy-changes.log";

/** Operator line when a policy writer matches current state and does not append (#3528). */
export const POLICY_AUDIT_NOOP_STDOUT = "  no-op: value already matched (ledger unchanged).";

const CHANGED_TOKEN_RE = /(?:^|\s)changed=(?:true|false)(?:\s|$)/;

/** Stamp a machine-readable `changed=true|false` token (#3528 / UPGRADING.md). */
export function stampChangedToken(entry: string, changed: boolean): string {
  if (CHANGED_TOKEN_RE.test(entry)) {
    return entry;
  }
  return `${entry} changed=${changed ? "true" : "false"}`;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export type PolicySource = "typed" | "legacy-narrative" | "env-bypass" | "default-fail-closed";

export interface PolicyResult {
  readonly allowDirectCommits: boolean;
  readonly source: PolicySource;
  readonly deprecationWarning: string | null;
  readonly error: string | null;
}

/**
 * Resolve absolute path to PROJECT-DEFINITION. Layout-aware (#2109 part 2a):
 * resolves PROJECT-DEFINITION.xbrief.json when the xbrief layout is present,
 * else PROJECT-DEFINITION.vbrief.json (unchanged on today's tree).
 */
export function projectDefinitionPath(projectRoot: string): string {
  const root = pathResolve(projectRoot);
  try {
    return resolveProjectDefinitionPath(root);
  } catch {
    // No xbrief/ layout; return canonical xbrief path so callers get a predictable
    // "not found" result rather than a thrown error.
    return join(root, PROJECT_DEFINITION_REL_PATH);
  }
}

function envBypassActive(): boolean {
  const raw = process.env[ENV_BYPASS] ?? "";
  return TRUTHY.has(raw.trim().toLowerCase());
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

function pythonRepr(value: unknown): string {
  if (value === undefined) return "None";
  if (typeof value === "string") return `'${value}'`;
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

/** Best-effort coerce a legacy narrative value to a boolean. */
export function coerceLegacyNarrative(value: unknown): { allow: boolean; raw: string } {
  if (typeof value === "boolean") {
    return { allow: value, raw: pythonRepr(value) };
  }
  if (typeof value !== "string") {
    return { allow: false, raw: pythonRepr(value) };
  }
  const raw = value.trim();
  const low = raw.toLowerCase();
  if (["true", "yes", "on", "1"].includes(low)) {
    return { allow: true, raw };
  }
  const match = /:\s*(true|yes|on|1)\b/.exec(low);
  if (match !== null) {
    return { allow: true, raw };
  }
  return { allow: false, raw };
}

/** Load and parse PROJECT-DEFINITION. Returns [data, error]. */
export function loadProjectDefinition(
  projectRoot: string,
): [Record<string, unknown> | null, string | null] {
  const path = projectDefinitionPath(projectRoot);
  if (!existsSync(path)) {
    return [null, `PROJECT-DEFINITION not found at ${path}`];
  }
  try {
    const text = readFileSync(path, { encoding: "utf8" });
    const data = JSON.parse(text) as Record<string, unknown>;
    return [data, null];
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      return [null, `PROJECT-DEFINITION at ${path} is not valid JSON: ${String(err)}`];
    }
    return [null, `PROJECT-DEFINITION at ${path} cannot be read: ${String(err)}`];
  }
}

/** Resolve the effective branch-commit policy (#746 / #747). */
export function resolvePolicy(projectRoot: string): PolicyResult {
  if (envBypassActive()) {
    return {
      allowDirectCommits: true,
      source: "env-bypass",
      deprecationWarning: null,
      error: null,
    };
  }

  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return {
      allowDirectCommits: false,
      source: "default-fail-closed",
      deprecationWarning: null,
      error: err,
    };
  }

  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return {
      allowDirectCommits: false,
      source: "default-fail-closed",
      deprecationWarning: null,
      error: "PROJECT-DEFINITION 'plan' is not an object",
    };
  }

  const planObj = plan as Record<string, unknown>;
  const policyBlock = readPlanPolicy(planObj);
  if (
    typeof policyBlock === "object" &&
    policyBlock !== null &&
    !Array.isArray(policyBlock) &&
    "allowDirectCommitsToMaster" in policyBlock
  ) {
    const raw = (policyBlock as Record<string, unknown>).allowDirectCommitsToMaster;
    if (typeof raw !== "boolean") {
      return {
        allowDirectCommits: false,
        source: "default-fail-closed",
        deprecationWarning: null,
        error: `plan.policy.allowDirectCommitsToMaster must be a boolean; got ${pythonTypeName(raw)} (${pythonRepr(raw)})`,
      };
    }
    return {
      allowDirectCommits: raw,
      source: "typed",
      deprecationWarning: null,
      error: null,
    };
  }

  const narratives = planObj.narratives;
  if (
    typeof narratives === "object" &&
    narratives !== null &&
    !Array.isArray(narratives) &&
    LEGACY_NARRATIVE_KEY in narratives
  ) {
    const { allow, raw } = coerceLegacyNarrative(
      (narratives as Record<string, unknown>)[LEGACY_NARRATIVE_KEY],
    );
    const warn =
      `DEPRECATED: PROJECT-DEFINITION uses the legacy narrative key ` +
      `'${LEGACY_NARRATIVE_KEY}' (${pythonRepr(raw)}). Migrate to typed ` +
      `plan.policy.allowDirectCommitsToMaster (#746). Run ` +
      `\`${policyColonInvocation("enforce-branches")}\` or ` +
      `\`${policyColonInvocation("allow-direct-commits", " -- --confirm")}\` ` +
      `to set the typed flag explicitly.`;
    return {
      allowDirectCommits: allow,
      source: "legacy-narrative",
      deprecationWarning: warn,
      error: null,
    };
  }

  return {
    allowDirectCommits: false,
    source: "default-fail-closed",
    deprecationWarning: null,
    error: null,
  };
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Append a one-line audit entry to meta/policy-changes.log (#746).
 * No-op (`changed=false`) does not create or modify the tracked file (#3528). */
export function appendAuditLog(projectRoot: string, entry: string, changed = true): string {
  const root = pathResolve(projectRoot);
  const logPath = join(root, AUDIT_LOG_REL_PATH);
  const stamped = stampChangedToken(entry, changed);
  if (!changed) {
    return logPath;
  }
  // #2980 wave D: product write sink routes through containedWrite.
  if (!existsSync(logPath)) {
    const header =
      "# meta/policy-changes.log -- audit trail for " +
      "policy.allowDirectCommitsToMaster transitions (#746)\n";
    containedWrite({
      root,
      target: AUDIT_LOG_REL_PATH,
      data: header,
      mode: "create",
    });
  }
  containedWrite({
    root,
    target: AUDIT_LOG_REL_PATH,
    data: `${nowIso()} ${stamped}\n`,
    mode: "append",
  });
  return logPath;
}

/** Write the typed policy flag back to PROJECT-DEFINITION (#746). */
export function setPolicy(
  projectRoot: string,
  options: {
    allowDirectCommits: boolean;
    actor?: string;
    note?: string;
  },
): { changed: boolean; auditEntry: string } {
  const { allowDirectCommits, actor = "agent", note = "" } = options;
  const path = projectDefinitionPath(projectRoot);
  if (!existsSync(path)) {
    throw new Error(`PROJECT-DEFINITION not found at ${path}`);
  }

  // Serialise the read-modify-write + audit-log append behind the shared
  // PROJECT-DEFINITION mutation lock so a concurrent policy/ritual mutator
  // cannot lose this update or desync the typed flag from the audit row (#1260).
  return projectDefinitionMutationLock(projectRoot, () => {
    const parsed: unknown = JSON.parse(readFileSync(path, { encoding: "utf8" }));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`PROJECT-DEFINITION at ${path} top-level value is not a JSON object`);
    }
    const data = parsed as Record<string, unknown>;
    if (typeof data.plan !== "object" || data.plan === null || Array.isArray(data.plan)) {
      if (data.plan === undefined) {
        data.plan = {};
      } else {
        throw new Error("PROJECT-DEFINITION 'plan' is not an object");
      }
    }
    const plan = data.plan as Record<string, unknown>;
    migrateLegacyPolicyKey(plan);
    const existingPolicy = plan[PLAN_POLICY_KEY];
    if (
      typeof existingPolicy !== "object" ||
      existingPolicy === null ||
      Array.isArray(existingPolicy)
    ) {
      if (existingPolicy === undefined) {
        plan[PLAN_POLICY_KEY] = {};
      } else {
        throw new Error("plan.policy is not an object");
      }
    }
    const policyBlock = plan[PLAN_POLICY_KEY] as Record<string, unknown>;

    const previous = policyBlock.allowDirectCommitsToMaster;
    policyBlock.allowDirectCommitsToMaster = Boolean(allowDirectCommits);

    let legacyDropped = false;
    const narratives = plan.narratives;
    if (
      typeof narratives === "object" &&
      narratives !== null &&
      !Array.isArray(narratives) &&
      LEGACY_NARRATIVE_KEY in narratives
    ) {
      delete (narratives as Record<string, unknown>)[LEGACY_NARRATIVE_KEY];
      legacyDropped = true;
    }

    const changed = previous !== Boolean(allowDirectCommits) || legacyDropped;
    const parts = [
      `actor=${actor}`,
      `allowDirectCommitsToMaster=${allowDirectCommits ? "true" : "false"}`,
      `previous=${pythonRepr(previous)}`,
    ];
    if (legacyDropped) {
      parts.push("legacy-narrative-migrated=true");
    }
    if (note) {
      parts.push(`note=${note.replace(/\n/g, " ").replace(/\r/g, " ")}`);
    }
    const auditEntry = stampChangedToken(parts.join(" "), changed);
    if (changed) {
      atomicWriteProjectDefinition(path, data);
    }
    appendAuditLog(projectRoot, auditEntry, changed);
    return { changed, auditEntry };
  });
}
