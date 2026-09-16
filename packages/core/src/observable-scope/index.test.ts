import { describe, expect, it } from "vitest";
import {
  evaluateObservableScope,
  OBSERVABLE_CHANGE_PLAN_KEY,
  OBSERVABLE_MINT_FAIL_CLOSED_SITE,
  OBSERVABLE_MINT_PARKING_IS_WHEN,
} from "./index.js";

describe("observable-scope package surface (#4495)", () => {
  it("exports the namespaced plan key and evaluate", () => {
    expect(OBSERVABLE_CHANGE_PLAN_KEY).toBe("x-directive/observableChange");
    expect(typeof evaluateObservableScope).toBe("function");
  });
  it("exports the named mint-when predicate (#4588)", () => {
    expect(OBSERVABLE_MINT_FAIL_CLOSED_SITE).toBe("verify-merge-base");
    expect(OBSERVABLE_MINT_PARKING_IS_WHEN).toBe(false);
  });
});
