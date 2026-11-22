import { describe, expect, it } from "vitest";
import { dropLeadingDoubleDash, registeredVerbs } from "./dispatch.js";

/**
 * Split a flat `<verb> ...` argv at the head and apply the shared helper, as the router
 * (`routeArgv`) does at the verb boundary for a single-token verb (#6912).
 */
function restAfterDrop(argv: readonly string[]): string[] {
  const [, ...rest] = argv;
  return dropLeadingDoubleDash(rest);
}

describe("dropLeadingDoubleDash (#6647 / #6887)", () => {
  it("drops one leading lone -- for verify: and verify- verbs", () => {
    expect(restAfterDrop(["verify:ac", "--", "path.json"])).toEqual(["path.json"]);
    expect(restAfterDrop(["verify-ac", "--", "--issue", "7"])).toEqual(["--issue", "7"]);
  });

  it("drops one leading lone -- for non-verify verbs", () => {
    expect(restAfterDrop(["review-monitor:register", "--", "--pr", "12"])).toEqual(["--pr", "12"]);
    expect(restAfterDrop(["occupancy:release", "--", "--session-id", "s"])).toEqual([
      "--session-id",
      "s",
    ]);
  });

  it("drops -- for a non-verify verb (#6647 case flipped by #6887)", () => {
    expect(restAfterDrop(["session:start", "--", "x"])).toEqual(["x"]);
  });

  it("names verbs that are registered", () => {
    const names = registeredVerbs();
    for (const name of [
      "verify:ac",
      "session:start",
      "review-monitor:register",
      "occupancy:release",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("keeps a later -- token", () => {
    expect(dropLeadingDoubleDash(["--", "a", "--", "b"])).toEqual(["a", "--", "b"]);
  });

  it("drops only the first of -- --", () => {
    expect(dropLeadingDoubleDash(["--", "--", "x"])).toEqual(["--", "x"]);
  });

  it("only drops a leading --, not a trailing one", () => {
    expect(dropLeadingDoubleDash(["path.json", "--"])).toEqual(["path.json", "--"]);
  });

  it("leaves arguments with no leading -- unchanged", () => {
    expect(dropLeadingDoubleDash(["--pr=12", "x"])).toEqual(["--pr=12", "x"]);
    expect(dropLeadingDoubleDash(["--x", "y"])).toEqual(["--x", "y"]);
    expect(dropLeadingDoubleDash([])).toEqual([]);
  });

  it("returns a copy, not the input array", () => {
    const args = ["a"];
    const out = dropLeadingDoubleDash(args);
    expect(out).toEqual(args);
    expect(out).not.toBe(args);
  });
});
