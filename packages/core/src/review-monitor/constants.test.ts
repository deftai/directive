import { describe, expect, it } from "vitest";
import {
  EXIT_NOT_READY,
  EXIT_READY,
  MONITORING_TIER_1,
  REVIEW_MONITOR_HELP,
  SCHEMA_VERSION,
} from "./constants.js";

describe("review-monitor constants", () => {
  it("exports three-state exit codes and help", () => {
    expect(EXIT_READY).toBe(0);
    expect(EXIT_NOT_READY).toBe(1);
    expect(MONITORING_TIER_1).toBe(1);
    expect(SCHEMA_VERSION).toBe(1);
    expect(REVIEW_MONITOR_HELP).toContain("verify:review-monitor");
    expect(REVIEW_MONITOR_HELP).toContain("grok-bot-executor");
  });
});
