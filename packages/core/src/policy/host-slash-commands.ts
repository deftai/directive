/**
 * Per-host slash-command deposit policy (#3054 / epic #55 L6).
 *
 * Parallel to {@link plan.policy.hostHooks}: default multi-host enablement for
 * every host that has a real emitter (no stubs). Per-host `false` opts out.
 */

import {
  isSlashEmitterHostId,
  listSlashEmitterHosts,
  SLASH_EMITTER_HOSTS,
  type SlashEmitterHostId,
} from "../slash/emitters.js";
import { readPlanPolicy } from "./plan-extensions.js";
import { loadProjectDefinition } from "./resolve.js";

export const FIELD_HOST_SLASH_COMMANDS = "plan.policy.hostSlashCommands";
export const FIELD_HOST_SLASH_COMMANDS_CLI_ALIAS = "hostSlashCommands";

/** Per-host Directive slash-command deposit toggles (#3054). */
export type HostSlashCommandsPolicy = Record<SlashEmitterHostId, boolean>;

/** Default = all hosts with real emitters enabled (L6; not single-host-only). */
export const DEFAULT_HOST_SLASH_COMMANDS_POLICY: HostSlashCommandsPolicy = Object.freeze({
  claude: true,
  cursor: true,
  grok: true,
  codex: true,
}) as HostSlashCommandsPolicy;

export interface HostSlashCommandsPolicyField {
  readonly name: string;
  readonly current: HostSlashCommandsPolicy;
  readonly default: HostSlashCommandsPolicy;
  readonly source: string;
}

function readHostBoolean(
  rec: Record<string, unknown>,
  host: SlashEmitterHostId,
  fallback: boolean,
): boolean {
  if (host in rec && typeof rec[host] === "boolean") {
    return rec[host] as boolean;
  }
  return fallback;
}

/** Resolve typed slash-command deposit policy from raw PROJECT-DEFINITION value. */
export function resolveHostSlashCommandsPolicy(raw: unknown): HostSlashCommandsPolicy {
  if (raw === null || raw === undefined) {
    return { ...DEFAULT_HOST_SLASH_COMMANDS_POLICY };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_HOST_SLASH_COMMANDS_POLICY };
  }
  const rec = raw as Record<string, unknown>;
  return {
    claude: readHostBoolean(rec, "claude", DEFAULT_HOST_SLASH_COMMANDS_POLICY.claude),
    cursor: readHostBoolean(rec, "cursor", DEFAULT_HOST_SLASH_COMMANDS_POLICY.cursor),
    grok: readHostBoolean(rec, "grok", DEFAULT_HOST_SLASH_COMMANDS_POLICY.grok),
    codex: readHostBoolean(rec, "codex", DEFAULT_HOST_SLASH_COMMANDS_POLICY.codex),
  };
}

export function validateHostSlashCommands(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return [`${FIELD_HOST_SLASH_COMMANDS} must be an object; got ${typeof value}`];
  }
  const rec = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const host of SLASH_EMITTER_HOSTS) {
    if (host in rec && typeof rec[host] !== "boolean") {
      errors.push(`${FIELD_HOST_SLASH_COMMANDS}.${host} must be a boolean`);
    }
  }
  for (const key of Object.keys(rec)) {
    if (!isSlashEmitterHostId(key)) {
      errors.push(
        `${FIELD_HOST_SLASH_COMMANDS}.${key} is not a slash emitter host (${SLASH_EMITTER_HOSTS.join(", ")})`,
      );
    }
  }
  return errors;
}

export function isHostSlashCommandDepositEnabled(
  host: SlashEmitterHostId,
  policy: HostSlashCommandsPolicy = DEFAULT_HOST_SLASH_COMMANDS_POLICY,
): boolean {
  return policy[host];
}

/** Hosts that should receive deposit under the given policy (default = all emitters). */
export function enabledSlashDepositHosts(
  policy: HostSlashCommandsPolicy = DEFAULT_HOST_SLASH_COMMANDS_POLICY,
): readonly SlashEmitterHostId[] {
  return listSlashEmitterHosts().filter((host) => isHostSlashCommandDepositEnabled(host, policy));
}

function fieldFromResolved(
  resolved: HostSlashCommandsPolicy,
  source: string,
): HostSlashCommandsPolicyField {
  return {
    name: FIELD_HOST_SLASH_COMMANDS,
    current: resolved,
    default: { ...DEFAULT_HOST_SLASH_COMMANDS_POLICY },
    source,
  };
}

/** Inspector row for `policy:show --field=hostSlashCommands`. */
export function inspectHostSlashCommands(
  data: Record<string, unknown> | null,
): HostSlashCommandsPolicyField {
  if (data === null) {
    return fieldFromResolved({ ...DEFAULT_HOST_SLASH_COMMANDS_POLICY }, "default");
  }
  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("hostSlashCommands" in (policyBlock as Record<string, unknown>))
  ) {
    return fieldFromResolved({ ...DEFAULT_HOST_SLASH_COMMANDS_POLICY }, "default");
  }
  const resolved = resolveHostSlashCommandsPolicy(
    (policyBlock as Record<string, unknown>).hostSlashCommands,
  );
  return fieldFromResolved(resolved, "typed");
}

/** Resolve slash-command deposit policy from PROJECT-DEFINITION on disk. */
export function loadHostSlashCommandsPolicyFromProject(
  projectRoot: string,
): HostSlashCommandsPolicy {
  const [data] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return { ...DEFAULT_HOST_SLASH_COMMANDS_POLICY };
  }
  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("hostSlashCommands" in (policyBlock as Record<string, unknown>))
  ) {
    return { ...DEFAULT_HOST_SLASH_COMMANDS_POLICY };
  }
  return resolveHostSlashCommandsPolicy((policyBlock as Record<string, unknown>).hostSlashCommands);
}
