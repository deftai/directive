import { describe, expect, it } from "vitest";
import { evaluateReleaseConsumerReadiness, issuesFromInventory } from "./run-consumer-readiness.js";

describe("evaluateReleaseConsumerReadiness (#3900)", () => {
  it("blocks on an open BLOCKER not in Closes and still returns non-blocking disclosure", () => {
    const result = evaluateReleaseConsumerReadiness({
      changelogText: "## [Unreleased]\n\n### Added\n- fail-closed verifier.\n",
      issues: [{ number: 3600, title: "BLOCKER: schema", labels: [] }],
    });
    expect(result.hardStops.code).toBe(1);
    expect(result.disclosure.blocking).toBe(false);
    expect(result.disclosure.text).toContain("does not block the tag");
  });

  it("is clear when there are no hard-stops", () => {
    const result = evaluateReleaseConsumerReadiness({
      changelogText: "## [Unreleased]\n\n### Added\n",
      issues: [{ number: 5, title: "feat: x", labels: [] }],
    });
    expect(result.hardStops.code).toBe(0);
    expect(result.disclosure.blocking).toBe(false);
  });
});

describe("issuesFromInventory", () => {
  it("drops pull requests and never copies body", () => {
    const issues = issuesFromInventory([
      { number: 1, title: "BLOCKER: x", labels: [], body: "nope" },
      { number: 2, title: "BLOCKER: pr", labels: [], pull_request: {} },
    ]);
    expect(issues).toEqual([{ number: 1, title: "BLOCKER: x", labels: [] }]);
  });
});
