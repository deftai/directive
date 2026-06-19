import { describe, expect, it, vi } from "vitest";
import { computeGateResult } from "./compute.js";
import { evaluateGates } from "./evaluate.js";
import {
  defaultRunGh,
  fetchCheckRunsRest,
  fetchGreptileBodyRest,
  fetchGreptileCommentBody,
  fetchPrHeadSha,
  fetchPrHeadShaRest,
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
    expect(
      fetchCheckRunsRest("sha", "deftai/directive", () => ({
        returncode: 0,
        stdout: JSON.stringify({}),
        stderr: "",
      })).error,
    ).toContain("missing check_runs");
  });

  it("fetchCheckRunsRest summarizes runs including Greptile Review", () => {
    const result = fetchCheckRunsRest("sha", "deftai/directive", () => ({
      returncode: 0,
      stdout: JSON.stringify({
        check_runs: [
          null,
          {
            name: "Greptile Review",
            status: "completed",
            conclusion: "success",
          },
          { status: 42, conclusion: null },
        ],
      }),
      stderr: "",
    }));
    expect(result.error).toBe("");
    expect(result.summary?.total).toBe(3);
    expect(result.summary?.greptile_review).toEqual({
      status: "completed",
      conclusion: "success",
    });
    expect((result.summary?.by_status as Record<string, number>).unknown).toBe(1);
    expect((result.summary?.by_conclusion as Record<string, number>).none).toBe(1);
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

  it("computeGateResult walks fallback cascade on gh failures", () => {
    const runGh: RunGhFn = () => ({ returncode: 1, stdout: "", stderr: "fail" });
    const result = computeGateResult(99, "deftai/directive", runGh);
    expect(result.error).not.toBeNull();
    expect(result.via.length).toBeGreaterThan(0);
  });

  it("computeGateResult returns primary path when gh succeeds", () => {
    const runGh: RunGhFn = (cmd) => {
      const j = cmd.join(" ");
      if (j.includes("headRefOid")) {
        return { returncode: 0, stdout: `${HEAD}\n`, stderr: "" };
      }
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
    const result = computeGateResult(5, "deftai/directive", runGh);
    expect(result.via).toBe("primary");
    expect(result.failures).toEqual([]);
  });

  it("computeGateResult uses fallback when comments fetch fails", () => {
    const runGh: RunGhFn = (cmd) => {
      const j = cmd.join(" ");
      if (j.includes("headRefOid")) {
        return { returncode: 0, stdout: `${HEAD}\n`, stderr: "" };
      }
      return { returncode: 1, stdout: "", stderr: "comments failed" };
    };
    const result = computeGateResult(6, "deftai/directive", runGh);
    expect(result.via).not.toBe("primary");
  });

  it("resolveRepo handles explicit and inferred repo values", () => {
    const noopGh: RunGhFn = () => ({ returncode: 0, stdout: "", stderr: "" });
    expect(resolveRepo("deftai/directive", noopGh).repo).toBe("deftai/directive");
    expect(
      resolveRepo(null, () => ({ returncode: 0, stdout: "deftai/directive\n", stderr: "" })).repo,
    ).toBe("deftai/directive");
    expect(resolveRepo(null, () => ({ returncode: 0, stdout: "\n", stderr: "" })).error).toContain(
      "empty repo",
    );
    expect(
      resolveRepo(null, () => ({ returncode: 1, stdout: "", stderr: "nope" })).error,
    ).toContain("could not resolve --repo");
  });

  it("parseGreptileBody counts badge findings", () => {
    const body =
      "## Greptile Summary\n\n" +
      '<img alt="P0" src="x"> one\n<img alt="P1" src="x"> two\n' +
      "**Confidence Score: 4/5**\n\n" +
      `Last reviewed commit: [x](https://github.com/deftai/directive/commit/${HEAD})\n`;
    const verdict = parseGreptileBody(body);
    expect(verdict.p0Count).toBe(1);
    expect(verdict.p1Count).toBe(1);
    expect(verdict.confidence).toBe(4);
  });

  it("computeGateResult reaches fallback2 with partial PR payload", () => {
    const runGh: RunGhFn = (cmd) => {
      const j = cmd.join(" ");
      if (j.includes("headRefOid") || j.includes("/comments")) {
        return { returncode: 1, stdout: "", stderr: "primary unavailable" };
      }
      if (j.includes("repo view")) {
        return { returncode: 0, stdout: "deftai/directive\n", stderr: "" };
      }
      if (j.includes("/pulls/")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({
            state: "open",
            merged: false,
            mergeable: true,
            mergeable_state: "clean",
            head: { sha: HEAD },
          }),
          stderr: "",
        };
      }
      if (j.includes("check-runs")) {
        return { returncode: 1, stdout: "", stderr: "checks unavailable" };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
    const result = computeGateResult(7, null, runGh);
    expect(result.via).toBe("fallback2");
    expect(result.failures.length).toBeGreaterThan(0);
  });

  it("computeGateResult records fallback2 parse and shape errors", () => {
    const runGh: RunGhFn = (cmd) => {
      const j = cmd.join(" ");
      if (j.includes("headRefOid") || j.includes("/comments")) {
        return { returncode: 1, stdout: "", stderr: "primary unavailable" };
      }
      if (j.includes("repo view")) {
        return { returncode: 0, stdout: "deftai/directive\n", stderr: "" };
      }
      if (j.includes("/pulls/")) {
        return { returncode: 0, stdout: "[]", stderr: "" };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
    const result = computeGateResult(8, null, runGh);
    expect(result.error).not.toBeNull();
  });

  it("computeGateResult succeeds via fallback1 REST path", () => {
    const cleanBody =
      "## Greptile Summary\n\n**Confidence Score: 5/5**\n\n" +
      `Last reviewed commit: [x](https://github.com/deftai/directive/commit/${HEAD})\n`;
    const runGh: RunGhFn = (cmd) => {
      const j = cmd.join(" ");
      if (j.includes("headRefOid")) {
        return { returncode: 0, stdout: `${HEAD}\n`, stderr: "" };
      }
      if (j.includes("/comments") && j.includes("--jq")) {
        return { returncode: 1, stdout: "", stderr: "primary comments failed" };
      }
      if (j.includes("/pulls/") && !j.includes("check-runs")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({ head: { sha: HEAD } }),
          stderr: "",
        };
      }
      if (j.includes("/issues/") && j.includes("/comments")) {
        return {
          returncode: 0,
          stdout: JSON.stringify([{ user: { login: "greptile-apps[bot]" }, body: cleanBody }]),
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
    const result = computeGateResult(10, "deftai/directive", runGh);
    expect(result.via).toBe("fallback1");
    expect(result.failures).toEqual([]);
  });

  it("fetchPrHeadShaRest and fetchGreptileBodyRest cover error branches", () => {
    expect(
      fetchPrHeadShaRest(1, "deftai/directive", () => ({
        returncode: 1,
        stdout: "",
        stderr: "boom",
      })).error,
    ).toContain("failed");
    expect(
      fetchPrHeadShaRest(1, "deftai/directive", () => ({
        returncode: 0,
        stdout: "",
        stderr: "",
      })).error,
    ).toContain("empty body from gh api");
    expect(
      fetchPrHeadShaRest(1, "deftai/directive", () => ({
        returncode: 0,
        stdout: "not-json",
        stderr: "",
      })).error,
    ).toContain("could not parse PR JSON");
    expect(
      fetchPrHeadShaRest(1, "deftai/directive", () => ({
        returncode: 0,
        stdout: "[]",
        stderr: "",
      })).error,
    ).toContain("unexpected PR JSON shape");
    expect(
      fetchPrHeadShaRest(1, "deftai/directive", () => ({
        returncode: 0,
        stdout: JSON.stringify({ head: { sha: "" } }),
        stderr: "",
      })).error,
    ).toContain("missing head.sha");
    expect(
      fetchPrHeadShaRest(1, "deftai/directive", () => ({
        returncode: 0,
        stdout: JSON.stringify({ head: { sha: HEAD } }),
        stderr: "",
      })).sha,
    ).toBe(HEAD);
    expect(
      fetchGreptileBodyRest(1, "deftai/directive", () => ({
        returncode: 1,
        stdout: "",
        stderr: "fail",
      })).error,
    ).toContain("failed");
    expect(
      fetchGreptileBodyRest(1, "deftai/directive", () => ({
        returncode: 0,
        stdout: "",
        stderr: "",
      })),
    ).toEqual({ body: "", error: "" });
    expect(
      fetchGreptileBodyRest(1, "deftai/directive", () => ({
        returncode: 0,
        stdout: JSON.stringify([{ user: { login: "other" }, body: "x" }]),
        stderr: "",
      })).body,
    ).toBe("");
    expect(
      fetchGreptileBodyRest(1, "deftai/directive", () => ({
        returncode: 0,
        stdout: `${JSON.stringify([{ user: { login: "greptile-apps[bot]" }, body: "first" }])}${JSON.stringify([{ user: { login: "greptile-apps[bot]" }, body: "last" }])}`,
        stderr: "",
      })).body,
    ).toBe("last");
    expect(
      fetchGreptileBodyRest(1, "deftai/directive", () => ({
        returncode: 0,
        stdout: JSON.stringify({ user: { login: "greptile-apps[bot]" }, body: "solo" }),
        stderr: "",
      })).body,
    ).toBe("solo");
    expect(
      fetchGreptileBodyRest(1, "deftai/directive", () => ({
        returncode: 0,
        stdout: "{bad",
        stderr: "",
      })).error,
    ).toContain("invalid JSON at offset");
    expect(
      fetchPrHeadShaRest(1, "deftai/directive", () => ({
        returncode: 0,
        stdout: JSON.stringify({ head: [] }),
        stderr: "",
      })).error,
    ).toContain("missing head.sha");
  });
});
