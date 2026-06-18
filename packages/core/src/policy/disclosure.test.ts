import { describe, expect, it } from "vitest";
import { disclosureLine } from "./disclosure.js";

describe("disclosureLine default blocked", () => {
  it("uses the standard ON message when no error", () => {
    expect(
      disclosureLine({
        allowDirectCommits: false,
        source: "default-fail-closed",
        deprecationWarning: null,
        error: null,
      }),
    ).toBe(
      "[deft policy] Branch-protection policy is ON. Direct commits to the " +
        "default branch are blocked. Use a feature branch.",
    );
  });
});
