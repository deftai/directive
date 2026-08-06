import { describe, expect, it } from "vitest";
import * as tb from "./index.js";

describe("test-boundary index surface (#3145)", () => {
  it("re-exports evaluate and policy helpers", () => {
    expect(typeof tb.evaluateTestBoundary).toBe("function");
    expect(typeof tb.loadTestBoundaryPolicy).toBe("function");
    expect(typeof tb.matchPolicyGlob).toBe("function");
    expect(Array.isArray(tb.DEFAULT_SOURCE_ROOTS)).toBe(true);
  });
});
