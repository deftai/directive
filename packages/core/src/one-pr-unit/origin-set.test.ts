import { describe, expect, it } from "vitest";
import {
  exactOriginSetEquals,
  formatOriginSet,
  normalizeOrigin,
  originKey,
  stripTrailingSlashes,
  uniqueOrigins,
} from "./origin-set.js";

describe("origin-set", () => {
  it("normalizes repo case and exact-set equality", () => {
    const a = [normalizeOrigin("DeftAI/Directive", 1), normalizeOrigin("deftai/directive", 2)];
    const b = uniqueOrigins([
      { repo: "deftai/directive", issueId: 2 },
      { repo: "deftai/directive", issueId: 1 },
      { repo: "deftai/directive", issueId: 1 },
    ]);
    expect(exactOriginSetEquals(a, b)).toBe(true);
    const first = a[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(originKey(first)).toBe("deftai/directive#1");
    expect(formatOriginSet(a)).toContain("deftai/directive#1");
  });

  it("rejects overlap as equality", () => {
    expect(
      exactOriginSetEquals(
        [{ repo: "o/r", issueId: 1 }],
        [
          { repo: "o/r", issueId: 1 },
          { repo: "o/r", issueId: 2 },
        ],
      ),
    ).toBe(false);
  });

  it("strips trailing slashes without a plus-regex", () => {
    expect(stripTrailingSlashes("o/r///")).toBe("o/r");
    expect(normalizeOrigin("DeftAI/Directive///", 1).repo).toBe("deftai/directive");
  });
});
