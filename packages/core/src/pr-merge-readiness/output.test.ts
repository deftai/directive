import { describe, expect, it } from "vitest";
import { computeGateResult } from "./compute.js";
import { VIA_ERROR, VIA_FALLBACK2 } from "./constants.js";
import { emitJson, exitCodeFor, gateResultToDict, printHuman } from "./output.js";
import { emptyVerdict } from "./parse.js";
import { EMPTY_REVIEW_THREADS_GRAPHQL } from "./test-gh-fixtures.helpers.js";
import type { GateResult, RunGhFn } from "./types.js";

const baseResult: GateResult = {
  prNumber: 1363,
  repo: "deftai/directive",
  headSha: "abc1234567890def1234567890abcdef12345678",
  verdict: {
    ...emptyVerdict(),
    found: true,
    lastReviewedSha: "abc1234567890def1234567890abcdef12345678",
    confidence: 5,
  },
  failures: [],
  via: "primary",
  partialData: {},
  error: null,
};

describe("output helpers", () => {
  it("serialises merge_ready true", () => {
    const json = JSON.parse(emitJson(baseResult)) as Record<string, unknown>;
    expect(json.merge_ready).toBe(true);
    expect(json.via).toBe("primary");
    expect((json.verdict as Record<string, unknown>).informal_clean).toBe(false);
  });

  it("includes partial_data and error when present", () => {
    const blocked: GateResult = {
      ...baseResult,
      failures: ["blocked"],
      via: VIA_ERROR,
      partialData: { primary_error: "x" },
      error: "primary_error=x",
    };
    const dict = gateResultToDict(blocked);
    expect(dict.partial_data).toEqual({ primary_error: "x" });
    expect(dict.error).toBe("primary_error=x");
    expect(exitCodeFor(blocked)).toBe(2);
  });

  it("prints human merge-ready", () => {
    const out = printHuman({
      ...baseResult,
      partialData: {
        ci: {
          summary_line: "CI check-runs: 1 passed / 0 failed / 0 pending",
        },
      },
    });
    expect(out).toContain("MERGE-READY");
    expect(out).toContain("via=primary");
    expect(out).toContain("CI check-runs: 1 passed / 0 failed / 0 pending");
  });

  it("prints platform status URLs on weather-class CI (#3180)", () => {
    const out = printHuman({
      ...baseResult,
      failures: ["CI never scheduled"],
      partialData: {
        ci: {
          ready_state: "ci_never_scheduled",
          summary_line: "CI check-runs: 0 passed / 0 failed / 0 pending (ci_never_scheduled)",
          platform_status_github: "https://www.githubstatus.com/",
          platform_status_blacksmith: "https://status.blacksmith.sh/",
        },
      },
    });
    expect(out).toContain("https://www.githubstatus.com/");
    expect(out).toContain("https://status.blacksmith.sh/");
    expect(out).toContain("Probe status pages before workflow edits (#3180)");
  });

  it("prints excluded-author skip line (#2375)", () => {
    const out = printHuman({
      ...baseResult,
      verdict: {
        ...baseResult.verdict,
        excludedAuthor: true,
        lastReviewedSha: null,
        confidence: null,
      },
    });
    expect(out).toContain("Greptile review:    skipped (author excluded)");
    expect(out).not.toContain("Confidence:");
  });

  it("prints human merge-blocked", () => {
    const out = printHuman({ ...baseResult, failures: ["low confidence"] });
    expect(out).toContain("MERGE-BLOCKED");
    expect(out).toContain("[1] low confidence");
  });

  it("prints human external-error", () => {
    const out = printHuman({
      ...baseResult,
      failures: ["external"],
      via: VIA_ERROR,
      error: "boom",
    });
    expect(out).toContain("EXTERNAL-ERROR");
    expect(out).toContain("Underlying error: boom");
  });

  it("prints fallback2 signal block", () => {
    const out = printHuman({
      ...baseResult,
      failures: ["fallback2 is a coarse signal"],
      via: VIA_FALLBACK2,
      partialData: {
        pr_state: "open",
        merged: false,
        mergeable: true,
        mergeable_state: "clean",
        check_runs: {
          greptile_review: { status: "completed", conclusion: "success" },
        },
      },
    });
    expect(out).toContain("Fallback2 signal:");
    expect(out).toContain(
      "Greptile Review check: {'status': 'completed', 'conclusion': 'success'}",
    );
  });

  it("exit code blocked vs ok", () => {
    expect(exitCodeFor(baseResult)).toBe(0);
    expect(exitCodeFor({ ...baseResult, failures: ["x"] })).toBe(1);
  });
});

describe("compute branches", () => {
  function fake(
    responses: Record<string, { returncode: number; stdout?: string; stderr?: string }>,
  ): RunGhFn {
    const classify = (cmd: readonly string[]): string => {
      const joined = cmd.join(" ");
      if (joined.includes("graphql")) return "graphql";
      if (joined.includes("headRefOid")) return "head-sha";
      if (joined.includes("/check-runs")) return "check-runs";
      if (joined.includes("/pulls/") && !joined.includes("/comments")) return "pr-view-rest";
      if (joined.includes("/comments") && cmd.includes("--jq")) return "comments-jq";
      if (joined.includes("/comments")) return "comments-rest";
      if (joined.includes("nameWithOwner")) return "repo-view";
      return "unknown";
    };
    return (cmd) => {
      const label = classify(cmd);
      const resp =
        responses[label] ??
        (label === "graphql"
          ? { returncode: 0, stdout: EMPTY_REVIEW_THREADS_GRAPHQL }
          : label === "check-runs"
            ? {
                returncode: 0,
                stdout: JSON.stringify({
                  check_runs: [
                    {
                      name: "TypeScript (build + lint + test)",
                      status: "completed",
                      conclusion: "success",
                    },
                  ],
                }),
              }
            : { returncode: 1, stderr: label });
      return { returncode: resp.returncode, stdout: resp.stdout ?? "", stderr: resp.stderr ?? "" };
    };
  }

  it("fallback1 re-fetches head when primary head failed", () => {
    const body =
      "## Greptile Summary\n\n**Confidence Score: 5/5**\n\n" +
      "Last reviewed commit: [x](https://github.com/deftai/directive/commit/abc1234567890def1234567890abcdef12345678)\n";
    const result = computeGateResult(
      1,
      "deftai/directive",
      fake({
        "head-sha": { returncode: 1, stderr: "timeout" },
        "pr-view-rest": {
          returncode: 0,
          stdout: JSON.stringify({ head: { sha: "abc1234567890def1234567890abcdef12345678" } }),
        },
        "comments-jq": { returncode: 1 },
        "comments-rest": {
          returncode: 0,
          stdout: JSON.stringify([{ user: { login: "greptile-apps[bot]" }, body }]),
        },
      }),
    );
    expect(result.via).toBe("fallback1");
    expect(result.failures).toEqual([]);
  });

  it("fallback2 preserves merged state", () => {
    const result = computeGateResult(
      1,
      "deftai/directive",
      fake({
        "head-sha": { returncode: 0, stdout: "abc1234567890def1234567890abcdef12345678\n" },
        "comments-jq": { returncode: 1 },
        "comments-rest": { returncode: 1 },
        "pr-view-rest": {
          returncode: 0,
          stdout: JSON.stringify({
            state: "closed",
            merged: true,
            head: { sha: "abc1234567890def1234567890abcdef12345678" },
          }),
        },
        "check-runs": { returncode: 1, stderr: "endpoint down" },
      }),
    );
    expect(result.partialData.merged).toBe(true);
    expect(result.partialData.fallback2_check_runs_error).toBeDefined();
  });
});
