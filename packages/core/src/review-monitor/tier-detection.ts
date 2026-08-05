import { MONITORING_TIER_1, MONITORING_TIER_2, MONITORING_TIER_3 } from "./constants.js";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Canonical Approach-1 platform primitives for review-monitor register/verify (#2655 / #2876 / #3134). */
export type PlatformPrimitive =
  | "start_agent"
  | "spawn_subagent"
  | "cursor-task"
  | "claude-agent"
  | "sessions_spawn"
  | "openclaw-sessions-spawn";

/** Accepted `--platform-primitive` values (register CLI + help text). */
export const PLATFORM_PRIMITIVES: readonly PlatformPrimitive[] = [
  "start_agent",
  "spawn_subagent",
  "cursor-task",
  "claude-agent",
  "sessions_spawn",
  "openclaw-sessions-spawn",
] as const;

export const PLATFORM_PRIMITIVE_SET = new Set<string>(PLATFORM_PRIMITIVES);

export interface MonitoringTierProbe {
  readonly tier: typeof MONITORING_TIER_1 | typeof MONITORING_TIER_2 | typeof MONITORING_TIER_3;
  readonly primitive: PlatformPrimitive | null;
  readonly descriptor: string | null;
}

function envTruthy(environ: NodeJS.ProcessEnv, name: string): boolean {
  return TRUTHY.has((environ[name] ?? "").trim().toLowerCase());
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
    return { tier: MONITORING_TIER_3, primitive: null, descriptor: "generic-terminal" };
  }
  return null;
}

/**
 * Inline Tier-1 detection aligned with the swarm Phase 3 / review-cycle matrix
 * (#1877 / #2655 / #2876 / #3134). Prefer `task platform:capabilities` when available (#1357);
 * this probe does not block MVP.
 *
 * Ordered env probe (must match skill matrix placement; Claude after Cursor so bare
 * Task / CURSOR_* never misclassify Claude Code as cursor-composer):
 * start_agent → WARP_* → Cursor → Claude Code → OpenClaw → grok-build → Tier2 → Tier3.
 */
export function probeMonitoringTier(environ: NodeJS.ProcessEnv = process.env): MonitoringTierProbe {
  const override = probeOverride(environ);
  if (override !== null) {
    return override;
  }

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

export function isTier1(probe: MonitoringTierProbe): boolean {
  return probe.tier === MONITORING_TIER_1;
}
