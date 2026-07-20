import { describe, expect, it } from "vitest";
import { probeMonitoringTier } from "./tier-detection.js";

describe("tier-detection", () => {
  it("maps WARP env to Tier 1 start_agent", () => {
    const probe = probeMonitoringTier({ WARP_IS_WARP_TERMINAL: "1" });
    expect(probe.tier).toBe(1);
    expect(probe.primitive).toBe("start_agent");
  });

  it("honors DEFT_PROBE_START_AGENT and DEFT_HAS_START_AGENT", () => {
    expect(probeMonitoringTier({ DEFT_PROBE_START_AGENT: "yes" }).descriptor).toBe(
      "warp-orchestrated",
    );
    expect(probeMonitoringTier({ DEFT_HAS_START_AGENT: "1" }).primitive).toBe("start_agent");
  });

  it("honors spawn_subagent probe and tier2 auto-reinvoke", () => {
    expect(probeMonitoringTier({ DEFT_PROBE_SPAWN_SUBAGENT: "1" }).primitive).toBe(
      "spawn_subagent",
    );
    expect(probeMonitoringTier({ DEFT_HAS_SPAWN_SUBAGENT: "true" }).descriptor).toBe("grok-build");
    expect(probeMonitoringTier({ DEFT_MONITOR_TIER2: "1" }).tier).toBe(2);
    expect(probeMonitoringTier({ DEFT_HAS_AUTO_REINVOKE: "on" }).descriptor).toBe(
      "yield-between-polls",
    );
  });

  it("honors tier overrides", () => {
    expect(probeMonitoringTier({ DEFT_MONITOR_TIER: "tier1" }).descriptor).toBe("override-tier1");
    expect(
      probeMonitoringTier({
        DEFT_MONITOR_TIER_OVERRIDE: "1",
        DEFT_MONITOR_TIER1_PRIMITIVE: "start_agent",
      }).primitive,
    ).toBe("start_agent");
    expect(probeMonitoringTier({ DEFT_MONITOR_TIER: "tier3" }).tier).toBe(3);
  });
});
