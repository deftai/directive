import { describe, expect, it } from "vitest";
import {
  authorLoginFromRawIssue,
  formatAuthorFilterLine,
  matchesAuthorFilter,
  normalizeAuthorLogin,
  parseAuthorTokens,
  partitionByAuthorFilter,
  resolveAuthorFilter,
} from "./author-filter.js";

describe("parseAuthorTokens", () => {
  it("splits comma allow-list and trims", () => {
    expect(parseAuthorTokens("alice, bob ,carol")).toEqual(["alice", "bob", "carol"]);
  });

  it("returns empty for whitespace-only", () => {
    expect(parseAuthorTokens("  ,  ")).toEqual([]);
  });
});

describe("resolveAuthorFilter", () => {
  it("resolves explicit login", () => {
    const r = resolveAuthorFilter("alice");
    expect(r.error).toBeUndefined();
    expect(r.filter?.allowLogins).toEqual(["alice"]);
    expect(r.filter?.usedMe).toBe(false);
    expect(r.filter?.display).toBe("alice");
  });

  it("resolves @me via injector", () => {
    const r = resolveAuthorFilter("@me", () => "MScottAdams");
    expect(r.filter?.allowLogins).toEqual(["MScottAdams"]);
    expect(r.filter?.usedMe).toBe(true);
    expect(r.filter?.display).toContain("MScottAdams");
  });

  it("errors when @me cannot resolve", () => {
    const r = resolveAuthorFilter("@me", () => null);
    expect(r.error).toMatch(/@me could not be resolved/);
  });

  it("accepts comma allow-list with @me", () => {
    const r = resolveAuthorFilter("@me,bob", () => "alice");
    expect(r.filter?.allowLogins).toEqual(["alice", "bob"]);
  });

  it("rejects empty author", () => {
    expect(resolveAuthorFilter("  ").error).toMatch(/non-empty/);
  });
});

describe("matchesAuthorFilter / partition", () => {
  const resolved = resolveAuthorFilter("alice,bob");
  const filter = resolved.filter;
  if (filter === undefined) {
    throw new Error("expected filter for alice,bob");
  }

  it("matches exact login", () => {
    expect(matchesAuthorFilter("alice", filter)).toBe(true);
    expect(matchesAuthorFilter("carol", filter)).toBe(false);
  });

  it("does not match missing author", () => {
    expect(matchesAuthorFilter(null, filter)).toBe(false);
    expect(matchesAuthorFilter("", filter)).toBe(false);
    expect(normalizeAuthorLogin("")).toBeNull();
  });

  it("partitions match, unknown, non-match", () => {
    const items = [
      { n: 1, author: "alice" },
      { n: 2, author: "carol" },
      { n: 3, author: "" },
      { n: 4, author: undefined as unknown as string },
    ];
    const part = partitionByAuthorFilter(items, (i) => i.author, filter);
    expect(part.matched.map((i) => i.n)).toEqual([1]);
    expect(part.unknownCount).toBe(2);
    expect(part.nonMatchingCount).toBe(1);
  });
});

describe("authorLoginFromRawIssue", () => {
  it("reads author.login and user.login", () => {
    expect(authorLoginFromRawIssue({ author: { login: "a" } })).toBe("a");
    expect(authorLoginFromRawIssue({ user: { login: "u" } })).toBe("u");
    expect(authorLoginFromRawIssue({ author: "stringy" })).toBe("stringy");
    expect(authorLoginFromRawIssue({})).toBeNull();
  });
});

describe("formatAuthorFilterLine", () => {
  it("surfaces filter and unknown count", () => {
    const resolved = resolveAuthorFilter("alice");
    expect(resolved.filter).toBeDefined();
    if (resolved.filter === undefined) {
      return;
    }
    expect(formatAuthorFilterLine(resolved.filter)).toBe("author filter: alice");
    expect(formatAuthorFilterLine(resolved.filter, { unknownCount: 3 })).toContain(
      "3 cached issue(s) missing author",
    );
  });
});
