import { describe, expect, it } from "vitest";
import { probeMonitoringTier } from "./tier-detection.js";

describe("tier-detection", () => {
  it("maps WARP env to Tier 1 start_agent", () => {
    const probe = probeMonitoringTier({ WARP_IS_WARP_TERMINAL: "1" });
    expect(probe.tier).toBe(1);
    expect(probe.primitive).toBe("start_agent");
  });
});
