import { MONITORING_TIER_1, MONITORING_TIER_2, MONITORING_TIER_3 } from "./constants.js";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export type PlatformPrimitive = "start_agent" | "spawn_subagent" | "cursor-task";

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
    const primitive =
      (environ.DEFT_MONITOR_TIER1_PRIMITIVE as PlatformPrimitive | undefined) ?? "cursor-task";
    return { tier: MONITORING_TIER_1, primitive, descriptor: "override-tier1" };
  }
  if (raw === "3" || raw.toLowerCase() === "tier3") {
    return { tier: MONITORING_TIER_3, primitive: null, descriptor: "generic-terminal" };
  }
  return null;
}

/**
 * Inline Tier-1 detection aligned with the swarm Phase 3 / review-cycle matrix
 * (#1877 / #2655). Prefer `task platform:capabilities` when available (#1357);
 * this probe does not block MVP.
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
