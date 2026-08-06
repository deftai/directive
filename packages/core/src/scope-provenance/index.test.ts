import { describe, expect, it } from "vitest";
import * as sp from "./index.js";

describe("scope-provenance index surface (#3145)", () => {
  it("re-exports digest and evaluate APIs", () => {
    expect(typeof sp.evaluateScopeProvenance).toBe("function");
    expect(typeof sp.computeFileScopeDigest).toBe("function");
    expect(typeof sp.writeApprovedScopeRecord).toBe("function");
    expect(sp.APPROVED_SCOPE_DIR).toContain("approved-scope");
  });
});
