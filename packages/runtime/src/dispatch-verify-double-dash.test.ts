import { describe, expect, it } from "vitest";
import { dropLeadingDoubleDashForVerify, registeredVerbs } from "./dispatch.js";

describe("dropLeadingDoubleDashForVerify (#6647)", () => {
  it("drops one leading lone -- for a verify: verb", () => {
    expect(dropLeadingDoubleDashForVerify("verify:ac", ["--", "path.json"])).toEqual(["path.json"]);
  });

  it("drops one leading lone -- for a verify- verb", () => {
    expect(dropLeadingDoubleDashForVerify("verify-ac", ["--", "--issue", "7"])).toEqual([
      "--issue",
      "7",
    ]);
  });

  it("keeps a later -- token", () => {
    expect(dropLeadingDoubleDashForVerify("verify:ac", ["--", "a", "--", "b"])).toEqual([
      "a",
      "--",
      "b",
    ]);
  });

  it("only drops a leading --, not a bare argument list", () => {
    expect(dropLeadingDoubleDashForVerify("verify:ac", ["path.json", "--"])).toEqual([
      "path.json",
      "--",
    ]);
  });

  it("leaves a non-verify verb untouched", () => {
    expect(dropLeadingDoubleDashForVerify("session:start", ["--", "x"])).toEqual(["--", "x"]);
  });

  it("returns a copy for an undefined verb", () => {
    expect(dropLeadingDoubleDashForVerify(undefined, ["--"])).toEqual(["--"]);
  });

  it("drops -- for every registered verify verb", () => {
    const verifyVerbs = registeredVerbs().filter(
      (name) => name.startsWith("verify:") || name.startsWith("verify-"),
    );
    expect(verifyVerbs.length).toBeGreaterThan(0);
    for (const name of verifyVerbs) {
      expect(dropLeadingDoubleDashForVerify(name, ["--", "x"])).toEqual(["x"]);
    }
  });
});
