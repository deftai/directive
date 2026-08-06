import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEST_FILE_PATTERNS,
  defaultTestBoundaryPolicy,
  loadTestBoundaryPolicy,
} from "./policy.js";

describe("test-boundary policy (#3145)", () => {
  it("exposes default patterns covering py/cs/ts", () => {
    expect(DEFAULT_TEST_FILE_PATTERNS.some((p) => p.includes("test_*.py"))).toBe(true);
    expect(DEFAULT_TEST_FILE_PATTERNS.some((p) => p.includes("Tests.cs"))).toBe(true);
    expect(DEFAULT_TEST_FILE_PATTERNS.some((p) => p.includes(".test.ts"))).toBe(true);
  });

  it("defaults to warn-only migration mode", () => {
    const p = defaultTestBoundaryPolicy();
    expect(p.enforcementMode).toBe("warn");
    expect(p.productionMayReferenceTestRoots).toBe(false);
  });

  it("loads defaults when no policy file exists", () => {
    const p = loadTestBoundaryPolicy("/tmp/no-policy-root-3145");
    expect(p.source).toBe("defaults");
  });
});
