import { describe, expect, it, vi } from "vitest";
import {
  defaultRunGh,
  fetchCheckRunsRest,
  fetchGreptileBodyRest,
  fetchPrHeadShaRest,
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

  it("fails on missing check_runs list", () => {
    const runGh: RunGhFn = () => ({ returncode: 0, stdout: "{}", stderr: "" });
    expect(fetchCheckRunsRest("sha", "deftai/directive", runGh).summary).toBeNull();
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
