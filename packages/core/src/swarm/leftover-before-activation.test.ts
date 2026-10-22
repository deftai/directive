import { describe, expect, it } from "vitest";
import { evaluateLeftoverBeforeActivation } from "./leftover-before-activation.js";

describe("evaluateLeftoverBeforeActivation (#5736)", () => {
  it("refuses when leftover-complete PRs are still open", () => {
    const result = evaluateLeftoverBeforeActivation({
      openLeftoverPrNumbers: [5815, 5824],
      cohortId: "through-merge-5791-5736",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("outstanding-leftover-land");
    expect(result.openLeftoverPrNumbers).toEqual([5815, 5824]);
    expect(result.detail).toMatch(/Land leftover first/);
  });

  it("admits when leftover land set is cleared", () => {
    const result = evaluateLeftoverBeforeActivation({
      openLeftoverPrNumbers: [],
      cohortId: "through-merge-5791-5736",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.detail).toMatch(/no outstanding/);
  });

  it("ignores non-positive PR numbers", () => {
    const result = evaluateLeftoverBeforeActivation({
      openLeftoverPrNumbers: [0, -1],
    });
    expect(result.ok).toBe(true);
  });
});
