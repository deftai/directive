/**
 * Public barrel for verify:telemetry-coverage (#3362).
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCAN_ROOTS,
  DEFAULT_TRIAL_STEPS,
  ENROLLED_FIELD_FIXTURE_KINDS,
  evaluateTelemetryCoverage,
  runFakeTrial,
} from "./index.js";

describe("telemetry-coverage public API (#3362)", () => {
  it("re-exports the evaluator, harness, and enrollment list", () => {
    expect(typeof evaluateTelemetryCoverage).toBe("function");
    expect(typeof runFakeTrial).toBe("function");
    expect(ENROLLED_FIELD_FIXTURE_KINDS.length).toBeGreaterThan(0);
    expect(DEFAULT_TRIAL_STEPS.length).toBe(ENROLLED_FIELD_FIXTURE_KINDS.length);
    expect(DEFAULT_SCAN_ROOTS).toContain("packages/core/src");
  });
});
