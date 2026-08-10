import { describe, expect, it, vi } from "vitest";
import { evaluateGates, isMergeReady } from "../pr-merge-readiness/index.js";
import {
  completeCohort,
  renderSweepText,
  sweepCohort,
  sweepResultToDict,
} from "./complete-cohort.js";
import {
  cohortResultToDict,
  evaluatePr,
  renderReviewCleanText,
  resolveCohortFromVbriefs,
  verifyReviewClean,
} from "./verify-review-clean.js";

const EMPTY_REVIEW_THREADS = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
      },
    },
  },
});

describe("swarm verify-review-clean", () => {
  it("returns external error for empty cohort", () => {
    const result = verifyReviewClean({ prNumbers: [] });
    expect(result.exitCode).toBe(2);
  });

  it("evaluates PR with injected gh", () => {
    const sha = "abcdef1234567890abcdef1234567890abcdef12";
    const body =
      "## Greptile Summary\n\n**Confidence Score: 5/5**\n\n" +
      `Last reviewed commit: [fix](https://github.com/deftai/directive/commit/${sha})\n`;
    const runGh = vi.fn((cmd: readonly string[]) => {
      const joined = cmd.join(" ");
      if (joined.includes("graphql")) {
        return { returncode: 0, stdout: EMPTY_REVIEW_THREADS, stderr: "" };
      }
      if (joined.includes("headRefOid")) {
        return { returncode: 0, stdout: `${sha}\n`, stderr: "" };
      }
      if (joined.includes("/comments")) {
        return { returncode: 0, stdout: body, stderr: "" };
      }
      if (joined.includes("/check-runs")) {
        return {
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
          stderr: "",
        };
      }
      if (joined.includes("/rules/branches/") || joined.includes("/protection")) {
        return { returncode: 1, stdout: "", stderr: "HTTP 404: Not Found" };
      }
      if (joined.includes("/pulls/")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({
            head: { sha },
            base: { ref: "master" },
            mergeable: true,
            mergeable_state: "clean",
          }),
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    });
    const per = evaluatePr(1, "deftai/directive", runGh);
    expect(per?.clean).toBe(true);
  });

  it("reconciles an absent Greptile verdict through the canonical GitHub gate", () => {
    const sha = "abcdef1234567890abcdef1234567890abcdef12";
    const runGh = vi.fn((cmd: readonly string[]) => {
      const joined = cmd.join(" ");
      if (joined.includes("graphql")) {
        return { returncode: 0, stdout: EMPTY_REVIEW_THREADS, stderr: "" };
      }
      if (joined.includes("headRefOid")) {
        return { returncode: 0, stdout: `${sha}\n`, stderr: "" };
      }
      if (joined.includes("/comments")) {
        return { returncode: 0, stdout: "", stderr: "" };
      }
      if (joined.includes("/check-runs")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({
            check_runs: [
              {
                name: "validate",
                status: "completed",
                conclusion: "success",
              },
            ],
          }),
          stderr: "",
        };
      }
      if (joined.includes("/rules/branches/") || joined.includes("/protection")) {
        return { returncode: 1, stdout: "", stderr: "HTTP 404: Not Found" };
      }
      if (joined.includes("/pulls/")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({
            state: "open",
            merged: false,
            mergeable: true,
            mergeable_state: "clean",
            head: { sha },
            base: { ref: "master" },
          }),
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: `unexpected: ${joined}` };
    });

    const result = verifyReviewClean({
      prNumbers: [24],
      repo: "bxc-3ci/FreshserviceAI",
      emitJson: true,
      runGh,
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      all_clean: boolean;
      pr_results: Array<{
        clean: boolean;
        via: string;
        partial_data: { verdict_override: { reason: string } };
      }>;
    };
    expect(payload.all_clean).toBe(true);
    expect(payload.pr_results[0]).toMatchObject({
      clean: true,
      via: "primary",
      partial_data: {
        verdict_override: { reason: "verdict-absent" },
      },
    });

    const human = verifyReviewClean({
      prNumbers: [24],
      repo: "bxc-3ci/FreshserviceAI",
      runGh,
    });
    expect(human.stdout).toContain("Gate via:           primary");
    expect(human.stdout).toContain("Verdict override:   verdict-absent");
    expect(human.stdout).toContain("Override basis:     github mergeable_state=clean");
  });

  it("does not reconcile a genuine current-head P0 finding", () => {
    const sha = "abcdef1234567890abcdef1234567890abcdef12";
    const runGh = vi.fn((cmd: readonly string[]) => {
      const joined = cmd.join(" ");
      if (joined.includes("graphql")) {
        return { returncode: 0, stdout: EMPTY_REVIEW_THREADS, stderr: "" };
      }
      if (joined.includes("headRefOid")) {
        return { returncode: 0, stdout: `${sha}\n`, stderr: "" };
      }
      if (joined.includes("/comments")) {
        return {
          returncode: 0,
          stdout:
            "## Greptile Summary\n\n**Confidence Score: 5/5**\n\n" +
            `Last reviewed commit: [fix](https://github.com/deftai/directive/commit/${sha})\n` +
            '### P0 findings (1)\n<img alt="P0" />\n',
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: `unexpected: ${joined}` };
    });

    const per = evaluatePr(25, "bxc-3ci/FreshserviceAI", runGh);

    expect(per).toMatchObject({ clean: false, via: "primary" });
    expect(per?.failures.some((failure) => failure.includes("P0 and 0 P1"))).toBe(true);
    expect(per?.partial_data?.verdict_override).toBeUndefined();
  });

  it("keeps fallback2 as a non-clean heartbeat", () => {
    const sha = "abcdef1234567890abcdef1234567890abcdef12";
    const runGh = vi.fn((cmd: readonly string[]) => {
      const joined = cmd.join(" ");
      if (joined.includes("headRefOid") || joined.includes("--jq .head.sha")) {
        return { returncode: 1, stdout: "", stderr: "primary paths unavailable" };
      }
      if (joined.includes("/pulls/26")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({
            state: "open",
            merged: false,
            mergeable: true,
            mergeable_state: "clean",
            head: { sha },
          }),
          stderr: "",
        };
      }
      if (joined.includes("/check-runs")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({
            check_runs: [{ name: "validate", status: "completed", conclusion: "success" }],
          }),
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: `unexpected: ${joined}` };
    });

    const per = evaluatePr(26, "bxc-3ci/FreshserviceAI", runGh);

    expect(per).toMatchObject({ clean: false, via: "fallback2" });
    expect(per?.failures.some((failure) => failure.includes("coarse signal"))).toBe(true);
  });

  it("resolveCohortFromVbriefs handles empty glob", () => {
    const { prNumbers, failures } = resolveCohortFromVbriefs(["/no/such/glob/*.json"]);
    expect(prNumbers).toEqual([]);
    expect(failures.length).toBe(1);
  });
});

describe("swarm complete-cohort", () => {
  it("returns config error for missing vbrief dir", () => {
    const result = completeCohort({ projectRoot: "/nonexistent-root-xyz", stories: [] });
    expect(result.exitCode).toBe(2);
  });

  it("sweepCohort dry-run on empty paths", () => {
    const result = sweepCohort([], "/tmp", true);
    expect(result.stories).toEqual([]);
  });

  it("renderSweepText reports incomplete sweeps", () => {
    const text = renderSweepText({
      project_root: "/proj",
      dry_run: false,
      ok: false,
      errors: ["glob matched no files"],
      stories: [{ kind: "story", path: "a", action: "failed", ok: false, detail: "nope" }],
      parents: [],
    });
    expect(text).toContain("INCOMPLETE");
    expect(
      sweepResultToDict({
        project_root: "/proj",
        dry_run: true,
        ok: true,
        errors: [],
        stories: [],
        parents: [],
      }).ok,
    ).toBe(true);
  });
});

describe("evaluateGates confidence block", () => {
  it("blocks low confidence", () => {
    const failures = evaluateGates(1, "abc", {
      found: true,
      errored: false,
      informalClean: false,
      lastReviewedSha: "abc",
      confidence: 3,
      p0Count: 0,
      p1Count: 0,
      p2Count: 0,
    });
    expect(failures.some((f) => f.includes("confidence"))).toBe(true);
  });

  it("renderReviewCleanText shows blocked cohort details", () => {
    const text = renderReviewCleanText({
      repo: "deftai/directive",
      pr_results: [
        {
          pr_number: 9,
          head_sha: "abc",
          verdict: {
            found: true,
            errored: false,
            informalClean: false,
            lastReviewedSha: "abc",
            confidence: 5,
            p0Count: 0,
            p1Count: 1,
            p2Count: 2,
          },
          failures: ["P1 finding"],
          clean: false,
        },
      ],
      resolution_errors: [{ vbrief_path: "x", reason: "missing pr ref" }],
      all_clean: false,
    });
    expect(text).toContain("COHORT BLOCKED");
    expect(text).toContain("Resolution errors");
  });

  it("evaluateGates covers merge-readiness branches", () => {
    expect(evaluateGates(1, "abc", { found: false } as never).length).toBeGreaterThan(0);
    expect(
      evaluateGates(1, "abc", {
        found: true,
        errored: false,
        informalClean: true,
        lastReviewedSha: "abc",
        confidence: 5,
        p0Count: 0,
        p1Count: 0,
        p2Count: 0,
      }).some((f) => f.includes("informal-clean")),
    ).toBe(true);
    expect(
      evaluateGates(1, "abc", {
        found: true,
        errored: false,
        informalClean: false,
        lastReviewedSha: null,
        confidence: 5,
        p0Count: 0,
        p1Count: 0,
        p2Count: 0,
      }).some((f) => f.includes("Last reviewed commit")),
    ).toBe(true);
    expect(
      evaluateGates(1, "abc123", {
        found: true,
        errored: false,
        informalClean: false,
        lastReviewedSha: "abc",
        confidence: null,
        p0Count: 0,
        p1Count: 0,
        p2Count: 0,
      }).some((f) => f.includes("Confidence Score")),
    ).toBe(true);
    expect(
      evaluateGates(1, "abc123", {
        found: true,
        errored: false,
        informalClean: false,
        lastReviewedSha: "abc",
        confidence: 5,
        p0Count: 2,
        p1Count: 1,
        p2Count: 0,
      }).some((f) => f.includes("P0 and 1 P1")),
    ).toBe(true);
    expect(
      evaluateGates(1, "abc123", {
        found: true,
        errored: true,
        informalClean: false,
        lastReviewedSha: "abc123",
        confidence: 5,
        p0Count: 0,
        p1Count: 0,
        p2Count: 0,
      }).some((f) => f.includes("ERRORED")),
    ).toBe(true);
    expect(
      evaluateGates(1, "deadbeef", {
        found: true,
        errored: false,
        informalClean: false,
        lastReviewedSha: "cafe",
        confidence: 5,
        p0Count: 0,
        p1Count: 0,
        p2Count: 0,
      }).some((f) => f.includes("stale")),
    ).toBe(true);
    expect(
      evaluateGates(1, "abc1234567", {
        found: true,
        errored: false,
        informalClean: false,
        lastReviewedSha: "abc123",
        confidence: 5,
        p0Count: 0,
        p1Count: 0,
        p2Count: 0,
      }),
    ).toEqual([]);
    expect(isMergeReady([])).toBe(true);
    expect(isMergeReady(["blocked"])).toBe(false);
    expect(
      cohortResultToDict({
        repo: null,
        pr_results: [],
        resolution_errors: [],
        all_clean: false,
      }).all_clean,
    ).toBe(false);
  });
});
