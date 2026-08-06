import { describe, expect, it } from "vitest";
import {
  DEFAULT_DELIVERY_BUDGET_POLICY,
  DELIVERY_ATTEMPT_SCHEMA_VERSION,
  deliveryUnitKey,
  isAllowDecision,
  isBlockDecision,
  isDenyDecision,
  mergePolicy,
  utcIso,
} from "./types.js";

describe("delivery-attempt types (#3143)", () => {
  it("composes unit keys and policy defaults", () => {
    expect(deliveryUnitKey("s", "t", "w")).toContain("s");
    expect(DEFAULT_DELIVERY_BUDGET_POLICY.maxFailedAttempts).toBe(3);
    expect(mergePolicy({ maxFailedAttempts: 5 }).maxFailedAttempts).toBe(5);
    expect(DELIVERY_ATTEMPT_SCHEMA_VERSION).toBe(1);
  });

  it("classifies decision prefixes", () => {
    expect(isAllowDecision("ALLOW_FIRST_ATTEMPT")).toBe(true);
    expect(isBlockDecision("BLOCK_ATTEMPT_BUDGET")).toBe(true);
    expect(isDenyDecision("DENY_DUPLICATE_ACTIVE")).toBe(true);
    expect(isAllowDecision("BLOCK_ATTEMPT_BUDGET")).toBe(false);
  });

  it("formats utc iso without milliseconds by default", () => {
    expect(utcIso("2026-08-06T12:00:00.123Z")).toBe("2026-08-06T12:00:00Z");
    expect(utcIso(new Date("2026-08-06T12:00:00.000Z"))).toMatch(/Z$/);
  });
});
