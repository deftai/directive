import { describe, expect, it, vi } from "vitest";
import {
  contextsFromBranchProtection,
  contextsFromBranchRules,
  defaultRunGh,
  fetchCheckRunsRest,
  fetchGreptileBodyRest,
  fetchPrBaseRef,
  fetchPrHeadShaRest,
  fetchRequiredStatusContexts,
  resolveRepo,
} from "./gh.js";
import type { RunGhFn } from "./types.js";

describe("defaultRunGh", () => {
  it("rejects non-gh commands", () => {
    expect(defaultRunGh(["git", "status"]).returncode).toBe(-1);
  });
});

describe("fetchGreptileBodyRest paginate", () => {
  const runGh: RunGhFn = (cmd) => {
    if (cmd.join(" ").includes("/comments")) {
      const page1 = JSON.stringify([{ user: { login: "human" }, body: "first" }]);
      const page2 = JSON.stringify([
        { user: { login: "greptile-apps[bot]" }, body: "clean summary" },
      ]);
      return { returncode: 0, stdout: page1 + page2, stderr: "" };
    }
    return { returncode: 1, stdout: "", stderr: "unexpected" };
  };

  it("collapses paginated arrays", () => {
    const { body, error } = fetchGreptileBodyRest(1, "deftai/directive", runGh);
    expect(error).toBe("");
    expect(body).toBe("clean summary");
  });

  it("prefers the most recently updated Greptile summary over a later-created stale one", () => {
    const run: RunGhFn = () => ({
      returncode: 0,
      stdout: JSON.stringify([
        {
          user: { login: "greptile-apps[bot]" },
          body: "fresh head review",
          updated_at: "2026-07-20T03:00:00Z",
          created_at: "2026-07-20T01:00:00Z",
        },
        {
          user: { login: "greptile-apps[bot]" },
          body: "stale duplicate",
          updated_at: "2026-07-20T01:30:00Z",
          created_at: "2026-07-20T01:30:00Z",
        },
      ]),
      stderr: "",
    });
    expect(fetchGreptileBodyRest(1, "deftai/directive", run).body).toBe("fresh head review");
  });

  it("returns empty when no greptile comments", () => {
    const empty: RunGhFn = () => ({ returncode: 0, stdout: "[]", stderr: "" });
    expect(fetchGreptileBodyRest(1, "deftai/directive", empty).body).toBe("");
  });

  it("returns null on gh failure", () => {
    const fail: RunGhFn = () => ({ returncode: 1, stdout: "", stderr: "boom" });
    const result = fetchGreptileBodyRest(1, "deftai/directive", fail);
    expect(result.body).toBeNull();
    expect(result.error).toContain("failed");
  });

  it("returns null on invalid json", () => {
    const bad: RunGhFn = () => ({ returncode: 0, stdout: "{not-json", stderr: "" });
    const result = fetchGreptileBodyRest(1, "deftai/directive", bad);
    expect(result.body).toBeNull();
  });
});

describe("fetchPrHeadShaRest", () => {
  it("extracts head.sha", () => {
    const runGh: RunGhFn = () => ({
      returncode: 0,
      stdout: JSON.stringify({ head: { sha: "abc1234" } }),
      stderr: "",
    });
    expect(fetchPrHeadShaRest(1, "deftai/directive", runGh).sha).toBe("abc1234");
  });

  it("handles empty body", () => {
    const runGh: RunGhFn = () => ({ returncode: 0, stdout: "", stderr: "" });
    expect(fetchPrHeadShaRest(1, "deftai/directive", runGh).sha).toBeNull();
  });

  it("handles malformed json", () => {
    const runGh: RunGhFn = () => ({ returncode: 0, stdout: "not-json", stderr: "" });
    expect(fetchPrHeadShaRest(1, "deftai/directive", runGh).error).toContain("parse");
  });
});

describe("fetchCheckRunsRest", () => {
  it("summarises check runs", () => {
    const runGh: RunGhFn = () => ({
      returncode: 0,
      stdout: JSON.stringify({
        check_runs: [
          { name: "Greptile Review", status: "completed", conclusion: "success" },
          { name: "CI", status: "completed", conclusion: "success" },
        ],
      }),
      stderr: "",
    });
    const { summary } = fetchCheckRunsRest("sha", "deftai/directive", runGh);
    expect(summary?.total).toBe(2);
    expect(summary?.greptile_review).toEqual({ status: "completed", conclusion: "success" });
  });

  it("returns normalized check run records", () => {
    const runGh: RunGhFn = () => ({
      returncode: 0,
      stdout: JSON.stringify({
        check_runs: [
          {
            name: "CI",
            status: "completed",
            conclusion: "success",
            app: { id: 15368 },
          },
        ],
      }),
      stderr: "",
    });
    const result = fetchCheckRunsRest("sha", "deftai/directive", runGh);
    expect(result.checkRuns).toEqual([
      {
        name: "CI",
        status: "completed",
        conclusion: "success",
        created_at: null,
        started_at: null,
        appId: 15368,
      },
    ]);
  });

  it("fails on missing check_runs list", () => {
    const runGh: RunGhFn = () => ({ returncode: 0, stdout: "{}", stderr: "" });
    expect(fetchCheckRunsRest("sha", "deftai/directive", runGh).summary).toBeNull();
  });
});

describe("required status contexts (#3234)", () => {
  it("parses rules/branches required_status_checks contexts with integration_id", () => {
    expect(
      contextsFromBranchRules([
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [
              { context: "terraform-plan" },
              { context: "TypeScript (build + lint + test)", integration_id: 42 },
            ],
          },
        },
        { type: "pull_request" },
      ]),
    ).toEqual([
      { name: "terraform-plan" },
      { name: "TypeScript (build + lint + test)", appId: 42 },
    ]);
  });

  it("parses classic branch-protection contexts and app-bound checks", () => {
    expect(
      contextsFromBranchProtection({
        required_status_checks: {
          contexts: ["legacy-ci"],
          checks: [{ context: "modern-ci", app_id: 1 }],
        },
      }),
    ).toEqual([{ name: "legacy-ci" }, { name: "modern-ci", appId: 1 }]);
  });

  it("fetchRequiredStatusContexts unions rulesets + protection", () => {
    const runGh: RunGhFn = (cmd) => {
      const joined = cmd.join(" ");
      if (joined.includes("/rules/branches/")) {
        return {
          returncode: 0,
          stdout: JSON.stringify([
            {
              type: "required_status_checks",
              parameters: {
                required_status_checks: [{ context: "terraform-plan" }],
              },
            },
          ]),
          stderr: "",
        };
      }
      if (joined.includes("/protection")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({
            required_status_checks: { contexts: ["legacy-ci"], checks: [] },
          }),
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: `unexpected: ${joined}` };
    };
    const result = fetchRequiredStatusContexts("o/r", "master", runGh);
    expect(result.contexts).toEqual([{ name: "legacy-ci" }, { name: "terraform-plan" }]);
    expect(result.sources).toEqual(["rulesets", "branch_protection"]);
    expect(result.resolutionFailed).toBe(false);
  });

  it("marks resolutionFailed on parse error with no successful source", () => {
    const runGh: RunGhFn = (cmd) => {
      const joined = cmd.join(" ");
      if (joined.includes("/rules/branches/")) {
        return { returncode: 0, stdout: "{not-json", stderr: "" };
      }
      if (joined.includes("/protection")) {
        return { returncode: 1, stdout: "", stderr: "Branch not protected" };
      }
      return { returncode: 1, stdout: "", stderr: `unexpected: ${joined}` };
    };
    const result = fetchRequiredStatusContexts("o/r", "master", runGh);
    expect(result.resolutionFailed).toBe(true);
    expect(result.contexts).toEqual([]);
    expect(result.error).toContain("parse");
  });

  it("marks resolutionFailed on exit-zero empty body", () => {
    const runGh: RunGhFn = (cmd) => {
      const joined = cmd.join(" ");
      if (joined.includes("/rules/branches/")) {
        return { returncode: 0, stdout: "", stderr: "" };
      }
      if (joined.includes("/protection")) {
        return { returncode: 1, stdout: "", stderr: "Branch not protected" };
      }
      return { returncode: 1, stdout: "", stderr: `unexpected: ${joined}` };
    };
    const result = fetchRequiredStatusContexts("o/r", "master", runGh);
    expect(result.resolutionFailed).toBe(true);
    expect(result.error).toContain("empty body");
  });

  it("marks resolutionFailed when one source succeeds and the other hard-fails", () => {
    const runGh: RunGhFn = (cmd) => {
      const joined = cmd.join(" ");
      if (joined.includes("/rules/branches/")) {
        return {
          returncode: 0,
          stdout: JSON.stringify([
            {
              type: "required_status_checks",
              parameters: {
                required_status_checks: [{ context: "terraform-plan" }],
              },
            },
          ]),
          stderr: "",
        };
      }
      if (joined.includes("/protection")) {
        return { returncode: 0, stdout: "{not-json", stderr: "" };
      }
      return { returncode: 1, stdout: "", stderr: `unexpected: ${joined}` };
    };
    const result = fetchRequiredStatusContexts("o/r", "master", runGh);
    expect(result.resolutionFailed).toBe(true);
    expect(result.sources).toEqual(["rulesets"]);
    expect(result.contexts).toEqual([{ name: "terraform-plan" }]);
    expect(result.error).toContain("parse");
  });

  it("fetchPrBaseRef extracts base.ref", () => {
    const runGh: RunGhFn = () => ({
      returncode: 0,
      stdout: JSON.stringify({ base: { ref: "master" }, head: { sha: "abc" } }),
      stderr: "",
    });
    expect(fetchPrBaseRef(1, "o/r", runGh).baseRef).toBe("master");
  });
});

describe("resolveRepo", () => {
  it("returns provided repo unchanged", () => {
    expect(resolveRepo("deftai/directive", vi.fn() as RunGhFn)).toEqual({
      repo: "deftai/directive",
      error: "",
    });
  });

  it("resolves from gh repo view", () => {
    const runGh: RunGhFn = () => ({
      returncode: 0,
      stdout: "deftai/directive\n",
      stderr: "",
    });
    expect(resolveRepo(null, runGh).repo).toBe("deftai/directive");
  });

  it("errors when gh fails", () => {
    const runGh: RunGhFn = () => ({ returncode: 1, stdout: "", stderr: "nope" });
    expect(resolveRepo(null, runGh).repo).toBeNull();
  });
});
