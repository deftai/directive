import { describe, expect, it } from "vitest";
import * as mod from "./index.js";

describe("eval-health-relocation index re-exports", () => {
  it("exports the gate surface", () => {
    expect(typeof mod.evaluate).toBe("function");
    expect(typeof mod.isRuleRelocationPath).toBe("function");
    expect(typeof mod.detectHealthRegression).toBe("function");
  });
});
