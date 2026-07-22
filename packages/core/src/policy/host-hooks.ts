import type { HookHost } from "../hooks/dispatcher.js";
import { HOOK_HOSTS } from "../hooks/dispatcher.js";
import { readPlanPolicy } from "./plan-extensions.js";
import { loadProjectDefinition } from "./resolve.js";

export const FIELD_HOST_HOOKS = "plan.policy.hostHooks";
export const FIELD_HOST_HOOKS_CLI_ALIAS = "hostHooks";

/** Per-host Directive hook deposit toggles (#2752). */
export type HostHooksPolicy = Record<HookHost, boolean>;

export const DEFAULT_HOST_HOOKS_POLICY: HostHooksPolicy = {
  claude: true,
  cursor: true,
  grok: true,
  codex: true,
};

export interface HostHooksPolicyField {
  readonly name: string;
  readonly current: HostHooksPolicy;
  readonly default: HostHooksPolicy;
  readonly source: string;
}

function readHostBoolean(rec: Record<string, unknown>, host: HookHost, fallback: boolean): boolean {
  if (host in rec && typeof rec[host] === "boolean") {
    return rec[host] as boolean;
  }
  return fallback;
}

/** Resolve typed host hook deposit policy from raw PROJECT-DEFINITION value. */
export function resolveHostHooksPolicy(raw: unknown): HostHooksPolicy {
  if (raw === null || raw === undefined) {
    return { ...DEFAULT_HOST_HOOKS_POLICY };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_HOST_HOOKS_POLICY };
  }
  const rec = raw as Record<string, unknown>;
  return {
    claude: readHostBoolean(rec, "claude", DEFAULT_HOST_HOOKS_POLICY.claude),
    cursor: readHostBoolean(rec, "cursor", DEFAULT_HOST_HOOKS_POLICY.cursor),
    grok: readHostBoolean(rec, "grok", DEFAULT_HOST_HOOKS_POLICY.grok),
    codex: readHostBoolean(rec, "codex", DEFAULT_HOST_HOOKS_POLICY.codex),
  };
}

export function validateHostHooks(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return [`${FIELD_HOST_HOOKS} must be an object; got ${typeof value}`];
  }
  const rec = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const host of HOOK_HOSTS) {
    if (host in rec && typeof rec[host] !== "boolean") {
      errors.push(`${FIELD_HOST_HOOKS}.${host} must be a boolean`);
    }
  }
  for (const key of Object.keys(rec)) {
    if (!HOOK_HOSTS.includes(key as HookHost)) {
      errors.push(`${FIELD_HOST_HOOKS}.${key} is not a deposited host (${HOOK_HOSTS.join(", ")})`);
    }
  }
  return errors;
}

export function isHostHookDepositEnabled(
  host: HookHost,
  policy: HostHooksPolicy = DEFAULT_HOST_HOOKS_POLICY,
): boolean {
  return policy[host];
}

function fieldFromResolved(resolved: HostHooksPolicy, source: string): HostHooksPolicyField {
  return {
    name: FIELD_HOST_HOOKS,
    current: resolved,
    default: DEFAULT_HOST_HOOKS_POLICY,
    source,
  };
}

/** Inspector row for `policy:show --field=hostHooks`. */
export function inspectHostHooks(data: Record<string, unknown> | null): HostHooksPolicyField {
  if (data === null) {
    return fieldFromResolved(DEFAULT_HOST_HOOKS_POLICY, "default");
  }
  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("hostHooks" in (policyBlock as Record<string, unknown>))
  ) {
    return fieldFromResolved(DEFAULT_HOST_HOOKS_POLICY, "default");
  }
  const resolved = resolveHostHooksPolicy((policyBlock as Record<string, unknown>).hostHooks);
  return fieldFromResolved(resolved, "typed");
}

/** Resolve host hook deposit policy from PROJECT-DEFINITION on disk. */
export function loadHostHooksPolicyFromProject(projectRoot: string): HostHooksPolicy {
  const [data] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return { ...DEFAULT_HOST_HOOKS_POLICY };
  }
  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("hostHooks" in (policyBlock as Record<string, unknown>))
  ) {
    return { ...DEFAULT_HOST_HOOKS_POLICY };
  }
  return resolveHostHooksPolicy((policyBlock as Record<string, unknown>).hostHooks);
}
