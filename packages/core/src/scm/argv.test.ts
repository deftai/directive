import { describe, expect, it } from "vitest";
import { extractFlag, extractValueFlag, filterJsonFields } from "./argv.js";

describe("argv helpers", () => {
  it("extractFlag removes all occurrences", () => {
    const [present, remainder] = extractFlag(["--rest", "1", "--rest"], "--rest");
    expect(present).toBe(true);
    expect(remainder).toEqual(["1"]);
  });

  it("extractValueFlag parses space-separated values", () => {
    const [value, remainder] = extractValueFlag(
      ["1", "--repo", "deftai/directive", "--json", "number,title"],
      "--repo",
    );
    expect(value).toBe("deftai/directive");
    expect(remainder).toEqual(["1", "--json", "number,title"]);
  });

  it("extractValueFlag parses equals form", () => {
    const [value, remainder] = extractValueFlag(
      ["1", "--repo=deftai/directive", "--json=number"],
      "--repo",
    );
    expect(value).toBe("deftai/directive");
    expect(remainder).toEqual(["1", "--json=number"]);
  });

  it("extractValueFlag returns default when absent", () => {
    const [value, remainder] = extractValueFlag(["1", "--repo", "o/r"], "--state", "open");
    expect(value).toBe("open");
    expect(remainder).toEqual(["1", "--repo", "o/r"]);
  });

  it("extractValueFlag uses first occurrence", () => {
    const [value] = extractValueFlag(["--state", "open", "--state", "closed"], "--state");
    expect(value).toBe("open");
  });

  it("filterJsonFields projects dict keys", () => {
    expect(filterJsonFields({ number: 1, title: "x", state: "open" }, ["number", "title"])).toEqual(
      { number: 1, title: "x" },
    );
  });

  it("filterJsonFields is list-aware", () => {
    expect(
      filterJsonFields(
        [
          { number: 1, title: "a" },
          { number: 2, title: "b" },
        ],
        ["number", "title"],
      ),
    ).toEqual([
      { number: 1, title: "a" },
      { number: 2, title: "b" },
    ]);
  });
});
