import { describe, expect, it } from "vitest";
import {
  collectMilestoneSubscribedNames,
  inferRepoFromIssues,
  resolveScopeIgnores,
  resolveScopeRules,
  rulesRequestIsOpen,
  subscribedLabels,
  subscribedMilestones,
} from "./scope-rules.js";

describe("scope-rules", () => {
  it("returns default when project definition missing", () => {
    expect(resolveScopeRules("/nonexistent-path-xyz")[0]?.rule).toBe("all-open");
  });

  it("returns default for empty scope list", () => {
    expect(resolveScopeRules("/x", { plan: { policy: { triageScope: [] } } })[0]?.rule).toBe(
      "all-open",
    );
  });

  it("parses ignores with author rule", () => {
    const ignores = resolveScopeIgnores("/nonexistent", {
      plan: {
        policy: {
          triageScopeIgnores: [{ rule: "author", "any-of": ["dependabot"] }, { label: "wontfix" }],
        },
      },
    });
    expect(ignores.authors.has("dependabot")).toBe(true);
    expect(ignores.labels.has("wontfix")).toBe(true);
  });

  it("infers repo from api and html urls", () => {
    expect(
      inferRepoFromIssues([{ repository_url: "https://api.github.com/repos/deftai/directive" }]),
    ).toBe("deftai/directive");
    expect(
      inferRepoFromIssues([{ html_url: "https://github.com/deftai/directive/issues/1" }]),
    ).toBe("deftai/directive");
    expect(inferRepoFromIssues([{ html_url: "https://evil.example.com/o/r" }])).toBeNull();
  });

  it("collects subscribed labels and milestones", () => {
    const rules = [
      { rule: "labels", "any-of": ["a"], "all-of": ["b"] },
      { rule: "milestone", name: "m1" },
      { rule: "milestone", "is-open": true, "any-of": ["m2"] },
    ];
    expect(subscribedLabels(rules).has("a")).toBe(true);
    expect(subscribedLabels(rules).has("b")).toBe(true);
    expect(collectMilestoneSubscribedNames(rules).has("m1")).toBe(true);
    expect(collectMilestoneSubscribedNames(rules).has("m2")).toBe(true);
    expect(rulesRequestIsOpen(rules)).toBe(true);
    expect(subscribedMilestones(rules, new Set(["live"])).has("live")).toBe(true);
    expect(subscribedMilestones(rules).has("live")).toBe(false);
  });
});
