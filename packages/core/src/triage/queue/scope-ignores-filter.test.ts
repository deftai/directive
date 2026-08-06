/**
 * Branch coverage for triageScopeIgnores matchers (#3144 coverage-debt hairline).
 */
import { describe, expect, it } from "vitest";
import {
  hasActiveScopeIgnores,
  isCachedIssueScopeIgnored,
  isRawIssueScopeIgnored,
  type ScopeIgnores,
} from "./scope-ignores-filter.js";

function emptyIgnores(): ScopeIgnores {
  return { labels: new Set(), milestones: new Set(), authors: new Set() };
}

describe("hasActiveScopeIgnores (#3144)", () => {
  it("is false when all sets empty", () => {
    expect(hasActiveScopeIgnores(emptyIgnores())).toBe(false);
  });

  it("is true when any ignore set is non-empty", () => {
    expect(hasActiveScopeIgnores({ ...emptyIgnores(), labels: new Set(["wontfix"]) })).toBe(true);
    expect(hasActiveScopeIgnores({ ...emptyIgnores(), milestones: new Set(["parked"]) })).toBe(
      true,
    );
    expect(hasActiveScopeIgnores({ ...emptyIgnores(), authors: new Set(["bot"]) })).toBe(true);
  });
});

describe("isRawIssueScopeIgnored (#3144)", () => {
  it("returns false with empty ignores", () => {
    expect(
      isRawIssueScopeIgnored(
        { user: { login: "alice" }, labels: [{ name: "bug" }], milestone: { title: "m1" } },
        emptyIgnores(),
      ),
    ).toBe(false);
  });

  it("matches author ignore", () => {
    const ignores: ScopeIgnores = {
      ...emptyIgnores(),
      authors: new Set(["dependabot"]),
    };
    expect(isRawIssueScopeIgnored({ user: { login: "dependabot" }, labels: [] }, ignores)).toBe(
      true,
    );
    expect(isRawIssueScopeIgnored({ user: { login: "alice" }, labels: [] }, ignores)).toBe(false);
  });

  it("matches label ignore", () => {
    const ignores: ScopeIgnores = {
      ...emptyIgnores(),
      labels: new Set(["duplicate", "wontfix"]),
    };
    expect(
      isRawIssueScopeIgnored({ labels: [{ name: "bug" }, { name: "duplicate" }] }, ignores),
    ).toBe(true);
    expect(isRawIssueScopeIgnored({ labels: [{ name: "bug" }] }, ignores)).toBe(false);
  });

  it("matches milestone ignore when present", () => {
    const ignores: ScopeIgnores = {
      ...emptyIgnores(),
      milestones: new Set(["icebox"]),
    };
    expect(isRawIssueScopeIgnored({ labels: [], milestone: { title: "icebox" } }, ignores)).toBe(
      true,
    );
    expect(isRawIssueScopeIgnored({ labels: [], milestone: { title: "now" } }, ignores)).toBe(
      false,
    );
    expect(isRawIssueScopeIgnored({ labels: [], milestone: null }, ignores)).toBe(false);
  });
});

describe("isCachedIssueScopeIgnored (#3144)", () => {
  it("returns false with empty ignores", () => {
    expect(
      isCachedIssueScopeIgnored(
        { labels: ["bug"], author: "alice", milestone: "m1" },
        emptyIgnores(),
      ),
    ).toBe(false);
  });

  it("matches author only when author is non-empty", () => {
    const ignores: ScopeIgnores = { ...emptyIgnores(), authors: new Set(["bot"]) };
    expect(isCachedIssueScopeIgnored({ labels: [], author: "bot" }, ignores)).toBe(true);
    expect(isCachedIssueScopeIgnored({ labels: [], author: "" }, ignores)).toBe(false);
    expect(isCachedIssueScopeIgnored({ labels: [] }, ignores)).toBe(false);
    expect(isCachedIssueScopeIgnored({ labels: [], author: "human" }, ignores)).toBe(false);
  });

  it("matches labels", () => {
    const ignores: ScopeIgnores = {
      ...emptyIgnores(),
      labels: new Set(["meta"]),
    };
    expect(isCachedIssueScopeIgnored({ labels: ["bug", "meta"] }, ignores)).toBe(true);
    expect(isCachedIssueScopeIgnored({ labels: ["bug"] }, ignores)).toBe(false);
  });

  it("matches milestone only when non-empty", () => {
    const ignores: ScopeIgnores = {
      ...emptyIgnores(),
      milestones: new Set(["later"]),
    };
    expect(isCachedIssueScopeIgnored({ labels: [], milestone: "later" }, ignores)).toBe(true);
    expect(isCachedIssueScopeIgnored({ labels: [], milestone: "" }, ignores)).toBe(false);
    expect(isCachedIssueScopeIgnored({ labels: [] }, ignores)).toBe(false);
    expect(isCachedIssueScopeIgnored({ labels: [], milestone: "now" }, ignores)).toBe(false);
  });
});
