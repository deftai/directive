import { describe, expect, it } from "vitest";
import { mergeFragmentsIntoChangelogText } from "../changelog/effective-unreleased.js";
import { evaluateReleaseConsumerReadiness, issuesFromInventory } from "./run-consumer-readiness.js";

describe("evaluateReleaseConsumerReadiness (#3900)", () => {
  it("blocks on an open privileged hard-stop not in Closes and still returns non-blocking disclosure", () => {
    const result = evaluateReleaseConsumerReadiness({
      changelogText: "## [Unreleased]\n\n### Added\n- fail-closed verifier.\n",
      issues: [{ number: 3899, title: "chore: remediation", labels: ["blocks-release-tag"] }],
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

describe("consumer readiness on the effective [Unreleased] view (#6314)", () => {
  it("sees Closes lines and new-refusal hints from changelog.d fragments", () => {
    const changelog = "## [Unreleased]\n\n### Added\n\n## [0.1.0]\n";
    const effective = mergeFragmentsIntoChangelogText(changelog, [
      {
        path: "changelog.d/3899-x.md",
        section: "Fixed",
        entries: ["- Remediation lands (Closes #3899)"],
      },
      { path: "changelog.d/3900-y.md", section: "Added", entries: ["- New gate refuses to tag"] },
    ]);
    const issues = [{ number: 3899, title: "chore: remediation", labels: ["blocks-release-tag"] }];
    expect(
      evaluateReleaseConsumerReadiness({ changelogText: changelog, issues }).hardStops.code,
    ).toBe(1);
    const result = evaluateReleaseConsumerReadiness({ changelogText: effective, issues });
    expect(result.hardStops.code).toBe(0);
    expect(result.disclosure.newRefusalHints.map((h) => h.excerpt)).toEqual([
      "- New gate refuses to tag",
    ]);
  });
});
