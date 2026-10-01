import { MONITORING_TIER_1, MONITORING_TIER_2, MONITORING_TIER_3 } from "./constants.js";
import type { HostCapabilityStamp } from "./host-capability-stamp.js";
import {
  mergeHostCapabilityStampIntoEnviron,
  readHostCapabilityStamp,
} from "./host-capability-stamp.js";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Canonical Approach-1 platform primitives for review-monitor register/verify (#2655 / #2876 / #3134). */
export type PlatformPrimitive =
  | "start_agent"
  | "spawn_subagent"
  | "cursor-task"
  | "claude-agent"
  | "sessions_spawn"
  | "openclaw-sessions-spawn"
  | "grok-bot-executor";

/** Accepted `--platform-primitive` values (register CLI + help text). */
export const PLATFORM_PRIMITIVES: readonly PlatformPrimitive[] = [
  "start_agent",
  "spawn_subagent",
  "cursor-task",
  "claude-agent",
  "sessions_spawn",
  "openclaw-sessions-spawn",
  "grok-bot-executor",
] as const;

export const PLATFORM_PRIMITIVE_SET = new Set<string>(PLATFORM_PRIMITIVES);

/** Descriptor for explicit `DEFT_MONITOR_TIER=3` — must not equal honest `generic-terminal` (#5229). */
export const OVERRIDE_TIER3_DESCRIPTOR = "override-tier3";

export interface MonitoringTierProbe {
  readonly tier: typeof MONITORING_TIER_1 | typeof MONITORING_TIER_2 | typeof MONITORING_TIER_3;
  readonly primitive: PlatformPrimitive | null;
  readonly descriptor: string | null;
}

export interface ProbeMonitoringTierOptions {
  /** When set, merge durable host→CLI capability stamp before probing (#5229). */
  readonly projectRoot?: string | null;
  /** Injected stamp for tests; when undefined, reads from projectRoot when provided. */
  readonly hostCapabilityStamp?: HostCapabilityStamp | null;
}

function envTruthy(environ: NodeJS.ProcessEnv, name: string): boolean {
  return TRUTHY.has((environ[name] ?? "").trim().toLowerCase());
}

function stripTierOverride(environ: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...environ };
  delete next.DEFT_MONITOR_TIER;
  delete next.DEFT_MONITOR_TIER_OVERRIDE;
  return next;
}

function probeOverride(environ: NodeJS.ProcessEnv): MonitoringTierProbe | null {
  const raw = (environ.DEFT_MONITOR_TIER ?? environ.DEFT_MONITOR_TIER_OVERRIDE ?? "").trim();
  if (raw === "1" || raw.toLowerCase() === "tier1") {
    const requested = (environ.DEFT_MONITOR_TIER1_PRIMITIVE ?? "cursor-task").trim();
    const primitive = PLATFORM_PRIMITIVE_SET.has(requested)
      ? (requested as PlatformPrimitive)
      : "cursor-task";
    return { tier: MONITORING_TIER_1, primitive, descriptor: "override-tier1" };
  }
  if (raw === "3" || raw.toLowerCase() === "tier3") {
    // Labeled distinctly from honest generic-terminal (#5229 Prefer-A).
    return { tier: MONITORING_TIER_3, primitive: null, descriptor: OVERRIDE_TIER3_DESCRIPTOR };
  }
  return null;
}

/**
 * Natural (non-override) tier probe. Shared by {@link probeMonitoringTier} and
 * Tier-3 override refusal when a stamp/env already proves Tier 1 (#5229).
 */
function probeNaturalTier(environ: NodeJS.ProcessEnv): MonitoringTierProbe {
  if (envTruthy(environ, "DEFT_PROBE_START_AGENT") || envTruthy(environ, "DEFT_HAS_START_AGENT")) {
    return { tier: MONITORING_TIER_1, primitive: "start_agent", descriptor: "warp-orchestrated" };
  }

  if (envTruthy(environ, "WARP_IS_WARP_TERMINAL") || envTruthy(environ, "WARP_TERMINAL_SESSION")) {
    return { tier: MONITORING_TIER_1, primitive: "start_agent", descriptor: "warp-manual" };
  }

  if (envTruthy(environ, "CURSOR_COMPOSER")) {
    return { tier: MONITORING_TIER_1, primitive: "cursor-task", descriptor: "cursor-composer" };
  }

  if (envTruthy(environ, "CURSOR_AGENT")) {
    return {
      tier: MONITORING_TIER_1,
      primitive: "cursor-task",
      descriptor: "cursor-cloud-agent",
    };
  }

  const runtime = (environ.DEFT_AGENT_RUNTIME ?? "").trim().toLowerCase();
  // Claude Code: Claude-unique env signals only — never bare "Task" (#3134).
  // CLAUDECODE is set in Claude Code tool/hook subprocesses (Anthropic docs).
  // DEFT_PROBE_CLAUDE_CODE / DEFT_AGENT_RUNTIME=claude-code are explicit overrides.
  // Cursor already short-circuited above, so CURSOR_* never falls into this branch.
  if (
    envTruthy(environ, "DEFT_PROBE_CLAUDE_CODE") ||
    envTruthy(environ, "DEFT_HAS_CLAUDE_AGENT") ||
    envTruthy(environ, "CLAUDECODE") ||
    envTruthy(environ, "CLAUDE_CODE") ||
    runtime === "claude-code" ||
    runtime === "claude"
  ) {
    return { tier: MONITORING_TIER_1, primitive: "claude-agent", descriptor: "claude-code" };
  }

  // OpenClaw: sessions_spawn is the Tier-1 Approach 1 primitive (#2876).
  // Alias openclaw-sessions-spawn accepted on register for explicit naming.
  if (
    envTruthy(environ, "DEFT_PROBE_SESSIONS_SPAWN") ||
    envTruthy(environ, "DEFT_HAS_SESSIONS_SPAWN") ||
    envTruthy(environ, "DEFT_PROBE_OPENCLAW") ||
    envTruthy(environ, "OPENCLAW") ||
    runtime === "openclaw" ||
    runtime === "openclaw-sessions-spawn"
  ) {
    const alias =
      (environ.DEFT_MONITOR_TIER1_PRIMITIVE ?? "").trim() === "openclaw-sessions-spawn"
        ? "openclaw-sessions-spawn"
        : "sessions_spawn";
    return { tier: MONITORING_TIER_1, primitive: alias, descriptor: "openclaw" };
  }

  // Grok Bot: unique signals BEFORE spawn_subagent → grok-build (#4201).
  // Same class as Claude-before-Task (#3134) and OpenClaw-before-grok-build (#2875).
  // Bare spawn_subagent or bare Task must not win this branch.
  if (
    envTruthy(environ, "DEFT_PROBE_GROK_BOT") ||
    envTruthy(environ, "DEFT_HAS_GROK_BOT_WIDGETS") ||
    envTruthy(environ, "DEFT_HAS_GROK_BOT_EXECUTOR") ||
    envTruthy(environ, "GROK_BOT") ||
    runtime === "grok-bot" ||
    runtime === "grokbot"
  ) {
    return { tier: MONITORING_TIER_1, primitive: "grok-bot-executor", descriptor: "grok-bot" };
  }

  if (
    envTruthy(environ, "DEFT_PROBE_GROK_BUILD") ||
    envTruthy(environ, "GROK_BUILD") ||
    runtime === "grok-build"
  ) {
    return { tier: MONITORING_TIER_1, primitive: "spawn_subagent", descriptor: "grok-build" };
  }

  if (
    envTruthy(environ, "DEFT_PROBE_SPAWN_SUBAGENT") ||
    envTruthy(environ, "DEFT_HAS_SPAWN_SUBAGENT")
  ) {
    return { tier: MONITORING_TIER_1, primitive: "spawn_subagent", descriptor: "grok-build" };
  }

  if (envTruthy(environ, "DEFT_MONITOR_TIER2") || envTruthy(environ, "DEFT_HAS_AUTO_REINVOKE")) {
    return { tier: MONITORING_TIER_2, primitive: null, descriptor: "yield-between-polls" };
  }

  return { tier: MONITORING_TIER_3, primitive: null, descriptor: "generic-terminal" };
}

/**
 * Inline Tier-1 detection aligned with the swarm Phase 3 / review-cycle matrix
 * (#1877 / #2655 / #2876 / #3134). Prefer `task platform:capabilities` when available (#1357);
 * this probe does not block MVP.
 *
 * Ordered env probe (must match skill matrix placement; Claude after Cursor so bare
 * Task / CURSOR_* never misclassify Claude Code as cursor-composer; Grok Bot unique
 * signals before spawn_subagent so Grok Bot is never grok-build, #4201):
 * start_agent → WARP_* → Cursor → Claude Code → OpenClaw → grok-bot → grok-build → Tier2 → Tier3.
 *
 * Durable host stamp (#5229): when `projectRoot` / `hostCapabilityStamp` is supplied,
 * missing CLI env is filled from `.deft-scratch/host-capability-stamp.json` so Grok Build
 * subprocesses do not default to honest `generic-terminal` while `spawn_subagent` exists.
 * `DEFT_MONITOR_TIER=3` is labeled `override-tier3` (not byte-identical to honest Tier 3)
 * and refused when natural/stamp evidence already proves Tier 1.
 */
export function probeMonitoringTier(
  environ: NodeJS.ProcessEnv = process.env,
  options: ProbeMonitoringTierOptions = {},
): MonitoringTierProbe {
  let stamp: HostCapabilityStamp | null = null;
  if (options.hostCapabilityStamp !== undefined) {
    stamp = options.hostCapabilityStamp;
  } else if (typeof options.projectRoot === "string" && options.projectRoot.trim().length > 0) {
    stamp = readHostCapabilityStamp(options.projectRoot, { environ });
  }
  const effective = mergeHostCapabilityStampIntoEnviron(environ, stamp);

  const override = probeOverride(effective);
  if (override !== null) {
    if (override.descriptor === OVERRIDE_TIER3_DESCRIPTOR) {
      // Refuse Tier-3 downgrade when stamp/env already proves Tier 1 (#5229).
      const natural = probeNaturalTier(stripTierOverride(effective));
      if (natural.tier === MONITORING_TIER_1) {
        return natural;
      }
    }
    return override;
  }

  return probeNaturalTier(effective);
}

export function isTier1(probe: MonitoringTierProbe): boolean {
  return probe.tier === MONITORING_TIER_1;
}

/** True when a sticky lease `platform_primitive` is a Tier-1 Approach 1 primitive (#5229). */
export function isTier1PlatformPrimitive(value: string | null | undefined): boolean {
  return typeof value === "string" && PLATFORM_PRIMITIVE_SET.has(value);
}
