import { readFileSync } from "node:fs";
import type { HookHost } from "../hooks/dispatcher.js";
import { HOOK_HOSTS } from "../hooks/dispatcher.js";
import {
  atomicWriteProjectDefinition,
  projectDefinitionMutationLock,
} from "../vbrief-build/project-definition-io.js";
import { migrateLegacyPolicyKey, PLAN_POLICY_KEY, readPlanPolicy } from "./plan-extensions.js";
import { policyColonInvocation } from "./policy-invocation.js";
import {
  appendAuditLog,
  loadProjectDefinition,
  POLICY_AUDIT_NOOP_STDOUT,
  projectDefinitionPath,
} from "./resolve.js";

export type { HookHost };

export const FIELD_HOST_HOOKS = "plan.policy.hostHooks";
export const FIELD_HOST_HOOKS_CLI_ALIAS = "hostHooks";
export const DISABLE_HOST_HOOKS_SUBCOMMAND = "disable-host-hooks";

/** Confirm-gated disable verb for unused-host recovery copy (#3571). CLI form: no go-task `--`. */
export function disableHostHooksInvocation(trailing = " --host <host> --confirm"): string {
  return policyColonInvocation(DISABLE_HOST_HOOKS_SUBCOMMAND, trailing);
}

export const HOST_HOOKS_DISABLE_CAPABILITY_COST_DISCLOSURE =
  "\u26a0 Capability-cost disclosure -- disabling hostHooks for a host removes " +
  "deft-hook pre-execution guardrails for anyone who later opens this repo in that host. " +
  "The result is tracked.\n" +
  "  \u2022 Opted-out hosts skip Directive hook deposit; leftover-free files write {}.\n" +
  "  \u2022 This is not a timeout or live-probe fix. Retry the gated ritual when load is the cause.\n" +
  "  \u2022 Inspect: `" +
  policyColonInvocation("show", " --field=hostHooks") +
  "`.\n" +
  "  \u2022 Apply: `" +
  disableHostHooksInvocation() +
  "`.\n" +
  "  \u2022 Reversible: set the host back to true and run `deft update`.\n" +
  "  \u2022 Hand-edit of plan.policy.hostHooks plus `deft update` still strips " +
  "(human high-trust bypass).\n" +
  "  \u2022 Changes are recorded to meta/policy-changes.log for auditability.";

export const UNUSED_HOST_HOOKS_RECOVERY =
  "If an affected host is unused, inspect `" +
  policyColonInvocation("show", " --field=hostHooks") +
  "`, then run `" +
  disableHostHooksInvocation() +
  "`. That removes deft-hook pre-execution guardrails for that host and the result is tracked.";

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

export function parseHookHost(value: string | undefined): HookHost | null {
  if (value === undefined) return null;
  return HOOK_HOSTS.includes(value as HookHost) ? (value as HookHost) : null;
}

export interface DisableHostHooksOptions {
  readonly host: HookHost;
  readonly confirm: boolean;
  readonly actor?: string;
  readonly note?: string;
}

export interface DisableHostHooksResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly changed: boolean;
}

/** Persist `hostHooks.<host>=false` after capability-cost disclosure (#3571). */
export function disableHostHooks(
  projectRoot: string,
  options: DisableHostHooksOptions,
): DisableHostHooksResult {
  if (!HOOK_HOSTS.includes(options.host)) {
    return {
      exitCode: 2,
      stdout: `\u274c ${FIELD_HOST_HOOKS}.${String(options.host)} is not a deposited host (${HOOK_HOSTS.join(", ")}).\n`,
      changed: false,
    };
  }
  if (!options.confirm) {
    return {
      exitCode: 1,
      stdout:
        `${HOST_HOOKS_DISABLE_CAPABILITY_COST_DISCLOSURE}\n\n` +
        `Re-run with --confirm to apply: ${disableHostHooksInvocation(` --host ${options.host} --confirm`)}\n`,
      changed: false,
    };
  }

  const path = projectDefinitionPath(projectRoot);
  try {
    const { changed } = projectDefinitionMutationLock(projectRoot, () => {
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
      const legacyKeyMigrated = migrateLegacyPolicyKey(plan);
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
      const previous = resolveHostHooksPolicy(policyBlock.hostHooks);
      const next: HostHooksPolicy = { ...previous, [options.host]: false };
      const changedFlag = previous[options.host] !== false || legacyKeyMigrated;
      policyBlock.hostHooks = next;
      if (changedFlag) {
        atomicWriteProjectDefinition(path, data);
      }

      const actor = options.actor ?? disableHostHooksInvocation();
      const note = options.note ?? "";
      const parts = [
        `actor=${actor}`,
        `${FIELD_HOST_HOOKS}.${options.host}=false`,
        `previous=${JSON.stringify(previous)}`,
      ];
      if (note) {
        parts.push(`note=${note.replace(/\n/g, " ").replace(/\r/g, " ")}`);
      }
      appendAuditLog(projectRoot, parts.join(" "), changedFlag);
      return { changed: changedFlag };
    });

    const lines = [
      `\u2713 ${FIELD_HOST_HOOKS}.${options.host}=false (deft-hook guardrails removed for ${options.host}; result is tracked).`,
      changed ? "  audit: meta/policy-changes.log updated." : POLICY_AUDIT_NOOP_STDOUT,
      "  Run `deft update` to strip Directive-managed hook entries for that host.",
    ];
    return { exitCode: 0, stdout: `${lines.join("\n")}\n`, changed };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ENOENT") || message.includes("PROJECT-DEFINITION not found")) {
      return {
        exitCode: 2,
        stdout: `\u274c PROJECT-DEFINITION not found at ${path}\n`,
        changed: false,
      };
    }
    return { exitCode: 2, stdout: `\u274c Config error: ${message}\n`, changed: false };
  }
}
