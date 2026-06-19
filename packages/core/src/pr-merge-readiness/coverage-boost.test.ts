import { describe, expect, it, vi } from "vitest";
import { computeGateResult } from "./compute.js";
import { evaluateGates } from "./evaluate.js";
import {
  defaultRunGh,
  fetchCheckRunsRest,
  fetchGreptileCommentBody,
  fetchPrHeadSha,
  resolveRepo,
} from "./gh.js";
import { run } from "./main.js";
import { printHuman } from "./output.js";
import { emptyVerdict, parseGreptileBody } from "./parse.js";
import type { RunGhFn } from "./types.js";

const HEAD = "abc1234567890def1234567890abcdef12345678";

describe("coverage boost branches", () => {
  it("evaluateGates covers errored and missing confidence branches together", () => {
    const v = {
      ...emptyVerdict(),
      found: true,
      errored: true,
      lastReviewedSha: null,
      confidence: null,
    };
    const failures = evaluateGates(1, HEAD, v);
    expect(failures.some((f) => f.includes("ERRORED"))).toBe(true);
    expect(failures.some((f) => f.includes("Last reviewed commit"))).toBe(true);
    expect(failures.some((f) => f.includes("Confidence Score"))).toBe(true);
  });

  it("parseGreptileBody mixed format uses section fallback", () => {
    const body =
      '<img alt="P2" src="x"> nit\n### P1 findings (1)\n\n' +
      "**Confidence Score: 4/5**\n\n" +
      "Last reviewed commit: [x](https://github.com/o/r/commit/abc1234)\n";
    const v = parseGreptileBody(body);
    expect(v.p1Count).toBe(1);
    expect(v.p2Count).toBe(1);
  });

  it("fetchPrHeadSha logs stderr on failure", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runGh: RunGhFn = () => ({ returncode: 1, stdout: "", stderr: "head fail" });
    expect(fetchPrHeadSha(9, "deftai/directive", runGh)).toBeNull();
    expect(stderr.mock.calls.join("")).toContain("head fail");
    stderr.mockRestore();
  });

  it("fetchGreptileCommentBody resolves repo and handles empty repo", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runGh: RunGhFn = (cmd) => {
      if (cmd.join(" ").includes("nameWithOwner")) {
        return { returncode: 0, stdout: "\n", stderr: "" };
      }
      return { returncode: 1, stdout: "", stderr: "x" };
    };
    expect(fetchGreptileCommentBody(1, null, runGh)).toBeNull();
    stderr.mockRestore();
  });

  it("fetchGreptileCommentBody resolves repo from cwd", () => {
    const runGh: RunGhFn = (cmd) => {
      const j = cmd.join(" ");
      if (j.includes("nameWithOwner")) {
        return { returncode: 0, stdout: "deftai/directive\n", stderr: "" };
      }
      if (j.includes("/comments")) {
        return { returncode: 0, stdout: "", stderr: "" };
      }
      return { returncode: 1, stdout: "", stderr: "" };
    };
    expect(fetchGreptileCommentBody(1, null, runGh)).toBe("");
  });

  it("resolveRepo empty gh output", () => {
    const runGh: RunGhFn = () => ({ returncode: 0, stdout: "  \n", stderr: "" });
    expect(resolveRepo(null, runGh).error).toContain("empty repo");
  });

  it("computeGateResult fallback1 repo resolution failure", () => {
    const runGh: RunGhFn = (cmd) => {
      const j = cmd.join(" ");
      if (j.includes("headRefOid")) return { returncode: 1, stderr: "x", stdout: "" };
      if (j.includes("nameWithOwner")) return { returncode: 1, stderr: "no repo", stdout: "" };
      if (j.includes("/pulls/")) return { returncode: 1, stderr: "x", stdout: "" };
      return { returncode: 1, stdout: "", stderr: "x" };
    };
    const result = computeGateResult(1, null, runGh);
    expect(result.via).toBe("error");
  });

  it("computeGateResult fallback2 repo resolution failure", () => {
    const runGh: RunGhFn = (cmd) => {
      const j = cmd.join(" ");
      if (j.includes("headRefOid")) return { returncode: 0, stdout: `${HEAD}\n`, stderr: "" };
      if (j.includes("--jq")) return { returncode: 1, stdout: "", stderr: "x" };
      if (j.includes("/comments")) return { returncode: 1, stdout: "", stderr: "x" };
      if (j.includes("nameWithOwner")) return { returncode: 1, stdout: "", stderr: "bad repo" };
      return { returncode: 1, stdout: "", stderr: "x" };
    };
    const result = computeGateResult(1, null, runGh);
    expect(result.via).toBe("error");
    expect(result.partialData.fallback2_error).toBeDefined();
  });

  it("computeGateResult fallback2 invalid PR json", () => {
    const runGh: RunGhFn = (cmd) => {
      const j = cmd.join(" ");
      if (j.includes("headRefOid")) return { returncode: 0, stdout: `${HEAD}\n`, stderr: "" };
      if (j.includes("--jq")) return { returncode: 1, stdout: "", stderr: "x" };
      if (j.includes("/comments")) return { returncode: 1, stdout: "", stderr: "x" };
      if (j.includes("/pulls/")) return { returncode: 0, stdout: "not-json", stderr: "" };
      return { returncode: 1, stdout: "", stderr: "x" };
    };
    const result = computeGateResult(1, "deftai/directive", runGh);
    expect(result.via).toBe("error");
  });

  it("fetchCheckRunsRest gh failure and empty body", () => {
    expect(
      fetchCheckRunsRest("sha", "deftai/directive", () => ({
        returncode: 1,
        stdout: "",
        stderr: "e",
      })).error,
    ).toContain("failed");
    expect(
      fetchCheckRunsRest("sha", "deftai/directive", () => ({
        returncode: 0,
        stdout: "",
        stderr: "",
      })).error,
    ).toContain("empty body");
  });

  it("fetchCheckRunsRest invalid json and wrong shape", () => {
    expect(
      fetchCheckRunsRest("sha", "deftai/directive", () => ({
        returncode: 0,
        stdout: "{",
        stderr: "",
      })).error,
    ).toContain("parse");
    expect(
      fetchCheckRunsRest("sha", "deftai/directive", () => ({
        returncode: 0,
        stdout: "[]",
        stderr: "",
      })).error,
    ).toContain("not a dict");
  });

  it("printHuman omits fallback2 greptile when absent", () => {
    const out = printHuman({
      prNumber: 1,
      repo: "deftai/directive",
      headSha: HEAD,
      verdict: emptyVerdict(),
      failures: ["fallback2 is a coarse signal"],
      via: "fallback2",
      partialData: { pr_state: "open", check_runs: { total: 0 } },
      error: null,
    });
    expect(out).not.toContain("Greptile Review check:");
  });

  it("run prints human output when not json", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const runGh: RunGhFn = (cmd) => {
      const j = cmd.join(" ");
      if (j.includes("headRefOid")) return { returncode: 0, stdout: `${HEAD}\n`, stderr: "" };
      if (j.includes("/comments")) {
        return {
          returncode: 0,
          stdout:
            "## Greptile Summary\n\n**Confidence Score: 5/5**\n\n" +
            `Last reviewed commit: [x](https://github.com/deftai/directive/commit/${HEAD})\n`,
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: "" };
    };
    expect(run(["5", "--repo", "deftai/directive"], { runGh })).toBe(0);
    expect(String(stdout.mock.calls[0]?.[0])).toContain("MERGE-READY");
    stdout.mockRestore();
  });

  it("run rejects extra positional args", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run(["1", "2"], { runGh: () => ({ returncode: 0, stdout: "", stderr: "" }) })).toBe(2);
    stderr.mockRestore();
  });

  it("defaultRunGh rejects non-gh argv", () => {
    expect(defaultRunGh(["git", "status"]).returncode).toBe(-1);
  });
});
