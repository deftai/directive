import { describe, expect, it } from "vitest";
import { evaluateIntentConstraint, INTENT_CONSTRAINT_PLAN_KEY } from "./index.js";

describe("intent-constraint package surface (#4541)", () => {
  it("exports the namespaced plan key and evaluate", () => {
    expect(INTENT_CONSTRAINT_PLAN_KEY).toBe("x-directive/intentConstraint");
    expect(typeof evaluateIntentConstraint).toBe("function");
  });
});
