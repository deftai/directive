import { describe, expect, it } from "vitest";
import {
  GhRestError,
  InvalidRepoError,
  type RunGhApiFn,
  restIssueList,
  restIssueListOpenInventory,
  restIssueView,
  splitRepo,
} from "./gh-rest.js";

describe("splitRepo", () => {
  it("splits owner/repo", () => {
    expect(splitRepo("deftai/directive")).toEqual(["deftai", "directive"]);
  });

  it("rejects empty repo", () => {
    expect(() => splitRepo("")).toThrow(InvalidRepoError);
  });

  it("rejects malformed repo", () => {
    expect(() => splitRepo("directive")).toThrow(InvalidRepoError);
  });
});

describe("restIssueView", () => {
  it("returns parsed issue JSON", () => {
    const runGhApiFn: RunGhApiFn = (args) => {
      expect(args[0]).toBe("repos/deftai/directive/issues/1");
      return {
        returncode: 0,
        stdout: JSON.stringify({ number: 1, title: "hello" }),
        stderr: "",
      };
    };
    expect(restIssueView("deftai/directive", 1, { runGhApiFn })).toEqual({
      number: 1,
      title: "hello",
    });
  });

  it("raises GhRestError on non-zero exit", () => {
    const runGhApiFn: RunGhApiFn = () => ({
      returncode: 1,
      stdout: "",
      stderr: "HTTP 404",
    });
    expect(() => restIssueView("deftai/directive", 999, { runGhApiFn })).toThrow(GhRestError);
  });

  it("raises GhRestError on non-JSON response", () => {
    const runGhApiFn: RunGhApiFn = () => ({
      returncode: 0,
      stdout: "not-json",
      stderr: "",
    });
    expect(() => restIssueView("deftai/directive", 1, { runGhApiFn })).toThrow(GhRestError);
  });
});

describe("restIssueList", () => {
  it("returns parsed list JSON with query params", () => {
    const runGhApiFn: RunGhApiFn = (args) => {
      expect(args).toContain("--raw-field");
      expect(args).toContain("state=closed");
      expect(args).toContain("labels=epic,cache");
      expect(args).toContain("creator=octocat");
      return {
        returncode: 0,
        stdout: JSON.stringify([{ number: 1, title: "first" }]),
        stderr: "",
      };
    };
    expect(
      restIssueList(
        "deftai/directive",
        { state: "closed", labels: ["epic", "cache"], author: "octocat", perPage: 50 },
        { runGhApiFn },
      ),
    ).toEqual([{ number: 1, title: "first" }]);
  });

  it("raises GhRestError when response is not a list", () => {
    const runGhApiFn: RunGhApiFn = () => ({
      returncode: 0,
      stdout: JSON.stringify({ number: 1 }),
      stderr: "",
    });
    expect(() => restIssueList("deftai/directive", {}, { runGhApiFn })).toThrow(GhRestError);
  });
});

describe("restIssueListOpenInventory", () => {
  const endpoint = "repos/deftai/directive/issues?state=open&per_page=100";

  it("uses one paginate+slurp subprocess and filters pull requests", () => {
    const runGhApiFn: RunGhApiFn = (args) => {
      expect(args).toEqual(["--paginate", "--slurp", endpoint]);
      return {
        returncode: 0,
        stdout: JSON.stringify([
          { number: 1, state: "open" },
          { number: 2, state: "open", pull_request: { url: "https://github.com/o/r/pull/2" } },
        ]),
        stderr: "",
      };
    };
    expect(restIssueListOpenInventory("deftai/directive", { runGhApiFn })).toEqual([
      { number: 1, state: "open" },
    ]);
  });

  it("flattens slurped page arrays from gh paginate output", () => {
    const runGhApiFn: RunGhApiFn = () => ({
      returncode: 0,
      stdout: JSON.stringify([
        [
          { number: 10, state: "open" },
          { number: 11, state: "open", pull_request: { url: "https://github.com/o/r/pull/11" } },
        ],
        [{ number: 12, state: "open" }],
      ]),
      stderr: "",
    });
    expect(restIssueListOpenInventory("deftai/directive", { runGhApiFn })).toEqual([
      { number: 10, state: "open" },
      { number: 12, state: "open" },
    ]);
  });

  it("returns empty list for empty stdout", () => {
    const runGhApiFn: RunGhApiFn = () => ({ returncode: 0, stdout: "", stderr: "" });
    expect(restIssueListOpenInventory("deftai/directive", { runGhApiFn })).toEqual([]);
  });

  it("raises GhRestError on command failure", () => {
    const runGhApiFn: RunGhApiFn = () => ({ returncode: 1, stdout: "", stderr: "auth failed" });
    expect(() => restIssueListOpenInventory("deftai/directive", { runGhApiFn })).toThrow(
      GhRestError,
    );
  });

  it("raises GhRestError on non-array JSON", () => {
    const runGhApiFn: RunGhApiFn = () => ({
      returncode: 0,
      stdout: JSON.stringify({ not: "array" }),
      stderr: "",
    });
    expect(() => restIssueListOpenInventory("deftai/directive", { runGhApiFn })).toThrow(
      GhRestError,
    );
  });

  it("raises GhRestError when a row is not an object", () => {
    const runGhApiFn: RunGhApiFn = () => ({
      returncode: 0,
      stdout: JSON.stringify([null]),
      stderr: "",
    });
    expect(() => restIssueListOpenInventory("deftai/directive", { runGhApiFn })).toThrow(
      GhRestError,
    );
  });
});
