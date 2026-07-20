import { describe, expect, it } from "vitest";
import * as reviewMonitor from "./index.js";

describe("review-monitor index", () => {
  it("re-exports gate entrypoints", () => {
    expect(typeof reviewMonitor.evaluateReviewMonitorGate).toBe("function");
    expect(typeof reviewMonitor.probeMonitoringTier).toBe("function");
    expect(typeof reviewMonitor.registerReviewMonitor).toBe("function");
  });
});
