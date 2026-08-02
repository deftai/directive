/**
 * Multi-host skill discovery layouts + per-host opt-out (#75 residual).
 *
 * Deposits **skill** discovery dirs (thin SKILL.md pointers). Distinct from
 * epic #55 slash/command paths (`.claude/commands/`, `.codex/prompts/`, …).
 *
 * | Host id | Relative skills directory |
 * |---------|---------------------------|
 * | claude  | `.claude/skills`          |
 * | cursor  | `.cursor/skills`          |
 * | codex   | `.codex/skills`           |
 * | github  | `.github/skills`          |
 *
 * Policy: `plan.policy.hostSkillDiscovery` — per-host boolean, default all true.
 * Opt-out skips deposit for that host only.
 */

import { readPlanPolicy } from "../policy/plan-extensions.js";
import { loadProjectDefinition } from "../policy/resolve.js";

/** Hosts with a known residual skill-discovery path matrix (#75). */
export const SKILL_DISCOVERY_HOSTS = ["claude", "cursor", "codex", "github"] as const;

export type SkillDiscoveryHostId = (typeof SKILL_DISCOVERY_HOSTS)[number];

/** Repo-relative layout for one host’s skill discovery tree. */
export interface HostSkillDiscoveryLayout {
  readonly hostId: SkillDiscoveryHostId;
  /**
   * Repo-relative directory (posix, no trailing slash).
   * Example: `.claude/skills`
   */
  readonly relativeDir: string;
  /** Typical agent product that scans this path. */
  readonly typicalHost: string;
  /**
   * Filename under `{relativeDir}/{skillDir}/` (always `SKILL.md` for v1 —
   * same thin-pointer format as `.agents/skills/`).
   */
  readonly skillFilename: string;
}

/**
 * Documented host id → skills directory mapping (#75 residual matrix).
 * Frozen; additive registration only.
 */
export const HOST_SKILL_DISCOVERY_LAYOUTS: Readonly<
  Record<SkillDiscoveryHostId, HostSkillDiscoveryLayout>
> = Object.freeze({
  claude: Object.freeze({
    hostId: "claude",
    relativeDir: ".claude/skills",
    typicalHost: "Claude Code",
    skillFilename: "SKILL.md",
  }),
  cursor: Object.freeze({
    hostId: "cursor",
    relativeDir: ".cursor/skills",
    typicalHost: "Cursor",
    skillFilename: "SKILL.md",
  }),
  codex: Object.freeze({
    hostId: "codex",
    relativeDir: ".codex/skills",
    typicalHost: "OpenAI Codex",
    skillFilename: "SKILL.md",
  }),
  github: Object.freeze({
    hostId: "github",
    relativeDir: ".github/skills",
    typicalHost: "GitHub Copilot",
    skillFilename: "SKILL.md",
  }),
});

export const FIELD_HOST_SKILL_DISCOVERY = "plan.policy.hostSkillDiscovery";
export const FIELD_HOST_SKILL_DISCOVERY_CLI_ALIAS = "hostSkillDiscovery";

/** Per-host skill discovery deposit toggles (#75). Default: all enabled. */
export type HostSkillDiscoveryPolicy = Record<SkillDiscoveryHostId, boolean>;

export const DEFAULT_HOST_SKILL_DISCOVERY_POLICY: HostSkillDiscoveryPolicy = {
  claude: true,
  cursor: true,
  codex: true,
  github: true,
};

export interface HostSkillDiscoveryPolicyField {
  readonly name: string;
  readonly current: HostSkillDiscoveryPolicy;
  readonly default: HostSkillDiscoveryPolicy;
  readonly source: string;
}

/** Type guard for {@link SkillDiscoveryHostId}. */
export function isSkillDiscoveryHostId(value: string): value is SkillDiscoveryHostId {
  return (SKILL_DISCOVERY_HOSTS as readonly string[]).includes(value);
}

/** Stable list of residual skill-discovery hosts. */
export function listSkillDiscoveryHosts(): readonly SkillDiscoveryHostId[] {
  return SKILL_DISCOVERY_HOSTS;
}

/** Look up the documented layout for a host, or throw. */
export function getHostSkillDiscoveryLayout(
  hostId: SkillDiscoveryHostId,
): HostSkillDiscoveryLayout {
  const layout = HOST_SKILL_DISCOVERY_LAYOUTS[hostId];
  if (layout === undefined) {
    throw new Error(`No skill discovery layout for host: ${hostId}`);
  }
  return layout;
}

/**
 * Resolve one host toggle. Malformed present values fail closed to **disabled**
 * (do not silently enable deposit when the operator attempted an opt-out shape).
 */
function readHostBoolean(
  rec: Record<string, unknown>,
  host: SkillDiscoveryHostId,
  fallback: boolean,
  warnings: string[],
): boolean {
  if (!(host in rec)) {
    return fallback;
  }
  const value = rec[host];
  if (typeof value === "boolean") {
    return value;
  }
  warnings.push(
    `${FIELD_HOST_SKILL_DISCOVERY}.${host} must be a boolean (got ${typeof value}); treating as disabled`,
  );
  return false;
}

export interface ResolvedHostSkillDiscoveryPolicy {
  readonly policy: HostSkillDiscoveryPolicy;
  /** Non-empty when raw policy was malformed; callers SHOULD surface these. */
  readonly warnings: readonly string[];
  /**
   * True when the entire raw value is unusable (not an object). Deposit SHOULD
   * skip all hosts rather than silently apply defaults after a bad opt-out.
   */
  readonly refuseAll: boolean;
}

/**
 * Resolve typed host skill discovery policy from raw PROJECT-DEFINITION value.
 * Fail-closed on malformed opt-outs (#75 Greptile P1): bad host values disable
 * that host; wholly non-object values refuse all multi-host deposit.
 */
export function resolveHostSkillDiscoveryPolicyDetailed(
  raw: unknown,
): ResolvedHostSkillDiscoveryPolicy {
  if (raw === null || raw === undefined) {
    return {
      policy: { ...DEFAULT_HOST_SKILL_DISCOVERY_POLICY },
      warnings: [],
      refuseAll: false,
    };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      policy: {
        claude: false,
        cursor: false,
        codex: false,
        github: false,
      },
      warnings: [
        `${FIELD_HOST_SKILL_DISCOVERY} must be an object; got ${typeof raw} — multi-host skill discovery deposit skipped`,
      ],
      refuseAll: true,
    };
  }
  const rec = raw as Record<string, unknown>;
  const warnings: string[] = [];
  for (const key of Object.keys(rec)) {
    if (!isSkillDiscoveryHostId(key)) {
      warnings.push(
        `${FIELD_HOST_SKILL_DISCOVERY}.${key} is not a skill-discovery host (${SKILL_DISCOVERY_HOSTS.join(", ")})`,
      );
    }
  }
  const policy: HostSkillDiscoveryPolicy = {
    claude: readHostBoolean(rec, "claude", DEFAULT_HOST_SKILL_DISCOVERY_POLICY.claude, warnings),
    cursor: readHostBoolean(rec, "cursor", DEFAULT_HOST_SKILL_DISCOVERY_POLICY.cursor, warnings),
    codex: readHostBoolean(rec, "codex", DEFAULT_HOST_SKILL_DISCOVERY_POLICY.codex, warnings),
    github: readHostBoolean(rec, "github", DEFAULT_HOST_SKILL_DISCOVERY_POLICY.github, warnings),
  };
  return { policy, warnings, refuseAll: false };
}

/** Resolve typed host skill discovery policy from raw PROJECT-DEFINITION value. */
export function resolveHostSkillDiscoveryPolicy(raw: unknown): HostSkillDiscoveryPolicy {
  return resolveHostSkillDiscoveryPolicyDetailed(raw).policy;
}

export function validateHostSkillDiscovery(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return [`${FIELD_HOST_SKILL_DISCOVERY} must be an object; got ${typeof value}`];
  }
  const rec = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const host of SKILL_DISCOVERY_HOSTS) {
    if (host in rec && typeof rec[host] !== "boolean") {
      errors.push(`${FIELD_HOST_SKILL_DISCOVERY}.${host} must be a boolean`);
    }
  }
  for (const key of Object.keys(rec)) {
    if (!isSkillDiscoveryHostId(key)) {
      errors.push(
        `${FIELD_HOST_SKILL_DISCOVERY}.${key} is not a skill-discovery host (${SKILL_DISCOVERY_HOSTS.join(", ")})`,
      );
    }
  }
  return errors;
}

export function isHostSkillDiscoveryEnabled(
  host: SkillDiscoveryHostId,
  policy: HostSkillDiscoveryPolicy = DEFAULT_HOST_SKILL_DISCOVERY_POLICY,
): boolean {
  return policy[host];
}

function fieldFromResolved(
  resolved: HostSkillDiscoveryPolicy,
  source: string,
): HostSkillDiscoveryPolicyField {
  return {
    name: FIELD_HOST_SKILL_DISCOVERY,
    current: resolved,
    default: DEFAULT_HOST_SKILL_DISCOVERY_POLICY,
    source,
  };
}

/** Inspector row for `policy:show --field=hostSkillDiscovery`. */
export function inspectHostSkillDiscovery(
  data: Record<string, unknown> | null,
): HostSkillDiscoveryPolicyField {
  if (data === null) {
    return fieldFromResolved(DEFAULT_HOST_SKILL_DISCOVERY_POLICY, "default");
  }
  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("hostSkillDiscovery" in (policyBlock as Record<string, unknown>))
  ) {
    return fieldFromResolved(DEFAULT_HOST_SKILL_DISCOVERY_POLICY, "default");
  }
  const resolved = resolveHostSkillDiscoveryPolicy(
    (policyBlock as Record<string, unknown>).hostSkillDiscovery,
  );
  return fieldFromResolved(resolved, "typed");
}

/** Load raw hostSkillDiscovery value from PROJECT-DEFINITION, if present. */
export function loadHostSkillDiscoveryRawFromProject(projectRoot: string): unknown {
  const [data] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return undefined;
  }
  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("hostSkillDiscovery" in (policyBlock as Record<string, unknown>))
  ) {
    return undefined;
  }
  return (policyBlock as Record<string, unknown>).hostSkillDiscovery;
}

/** Resolve host skill discovery policy from PROJECT-DEFINITION on disk. */
export function loadHostSkillDiscoveryPolicyFromProject(
  projectRoot: string,
): HostSkillDiscoveryPolicy {
  return resolveHostSkillDiscoveryPolicy(loadHostSkillDiscoveryRawFromProject(projectRoot));
}

/**
 * Resolve policy + validation warnings from PROJECT-DEFINITION for deposit.
 * Surfaces malformed opt-outs so init/update can report them (#75 Greptile P1).
 */
export function loadHostSkillDiscoveryPolicyDetailedFromProject(
  projectRoot: string,
): ResolvedHostSkillDiscoveryPolicy {
  return resolveHostSkillDiscoveryPolicyDetailed(loadHostSkillDiscoveryRawFromProject(projectRoot));
}

/**
 * Repo-relative posix path for one skill under a host layout.
 * Example: `.claude/skills/deft-directive-build/SKILL.md`
 */
export function hostSkillRelativePath(hostId: SkillDiscoveryHostId, skillDir: string): string {
  const layout = getHostSkillDiscoveryLayout(hostId);
  return `${layout.relativeDir}/${skillDir}/${layout.skillFilename}`;
}
