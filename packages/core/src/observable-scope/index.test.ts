import { describe, expect, it } from "vitest";
import { evaluateObservableScope, OBSERVABLE_CHANGE_PLAN_KEY } from "./index.js";

describe("observable-scope package surface (#4495)", () => {
  it("exports the namespaced plan key and evaluate", () => {
    expect(OBSERVABLE_CHANGE_PLAN_KEY).toBe("x-directive/observableChange");
    expect(typeof evaluateObservableScope).toBe("function");
  });
});
