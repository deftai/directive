import { describe, expect, it } from "vitest";
import { computeGateResult } from "./compute.js";
import type { RunGhFn } from "./types.js";

const HEAD = "abc1234567890def1234567890abcdef12345678";
const OLD = "1111111111111111111111111111111111111111";

const GREEN_CHECKS = JSON.stringify({
  check_runs: [
    { name: "TypeScript (build + lint + test)", status: "completed", conclusion: "success" },
  ],
});

function cleanGreptileBody(sha: string): string {
  return (
    "## Greptile Summary\n\n**Confidence Score: 5/5**\n\n" +
    `Last reviewed commit: [x](https://github.com/deftai/directive/commit/${sha})\n`
  );
}

const GREEN_THREADS = JSON.stringify({
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

interface FakeOpts {
  readonly commentBody?: string;
  readonly mergeableState?: string;
  readonly mergeable?: boolean | null;
  readonly checks?: string;
  readonly reviewThreads?: string;
}

function fakeRunGh(opts: FakeOpts): RunGhFn {
  const checks = opts.checks ?? GREEN_CHECKS;
  const reviewThreads = opts.reviewThreads ?? GREEN_THREADS;
  return (cmd) => {
    const joined = cmd.join(" ");
    if (joined.includes("graphql")) {
      if (opts.reviewThreads === "") {
        return { returncode: 1, stdout: "", stderr: "graphql unavailable" };
      }
      return { returncode: 0, stdout: reviewThreads, stderr: "" };
    }
    if (joined.includes("headRefOid")) {
      return { returncode: 0, stdout: `${HEAD}\n`, stderr: "" };
    }
    if (joined.includes("/comments")) {
      return { returncode: 0, stdout: opts.commentBody ?? "", stderr: "" };
    }
    if (joined.includes("/check-runs")) {
      return { returncode: 0, stdout: checks, stderr: "" };
    }
    // No rulesets / classic protection configured (soft-empty inventory).
    if (joined.includes("/rules/branches/") || joined.includes("/protection")) {
      return { returncode: 1, stdout: "", stderr: "HTTP 404: Not Found" };
    }
    if (joined.includes("/pulls/")) {
      return {
        returncode: 0,
        stdout: JSON.stringify({
          state: "open",
          merged: false,
          mergeable: opts.mergeable ?? true,
          mergeable_state: opts.mergeableState ?? "clean",
          head: { sha: HEAD },
          base: { ref: "master" },
        }),
        stderr: "",
      };
    }
    return { returncode: 1, stdout: "", stderr: `unexpected: ${joined}` };
  };
}

describe("computeGateResult #2260 reconciliation", () => {
  it("merges when verdict is ABSENT but GitHub is CLEAN + MERGEABLE", () => {
    const result = computeGateResult(
      2258,
      "deftai/directive",
      fakeRunGh({ commentBody: "", mergeableState: "clean", mergeable: true }),
    );
    expect(result.via).toBe("primary");
    expect(result.failures).toEqual([]);
    const override = (result.partialData as Record<string, unknown>).verdict_override as Record<
      string,
      unknown
    >;
    expect(override.reason).toBe("verdict-absent");
    const mergeability = (result.partialData as Record<string, unknown>).mergeability as Record<
      string,
      unknown
    >;
    expect(mergeability.mergeable_state).toBe("clean");
  });

  it("merges when verdict is STALE (rebased head SHA) but GitHub is CLEAN", () => {
    const result = computeGateResult(
      2258,
      "deftai/directive",
      fakeRunGh({ commentBody: cleanGreptileBody(OLD), mergeableState: "clean", mergeable: true }),
    );
    expect(result.failures).toEqual([]);
    const override = (result.partialData as Record<string, unknown>).verdict_override as Record<
      string,
      unknown
    >;
    expect(override.reason).toBe("verdict-stale-head-sha");
  });

  it("does NOT merge when verdict absent but GitHub is UNSTABLE (not clean)", () => {
    const result = computeGateResult(
      2258,
      "deftai/directive",
      fakeRunGh({ commentBody: "", mergeableState: "unstable", mergeable: true }),
    );
    expect(result.failures.length).toBeGreaterThan(0);
    expect((result.partialData as Record<string, unknown>).verdict_override).toBeUndefined();
    const mergeability = (result.partialData as Record<string, unknown>).mergeability as Record<
      string,
      unknown
    >;
    expect(mergeability.mergeable_state).toBe("unstable");
  });

  it("does NOT merge stale P0/P1 even when GitHub is CLEAN (#2382)", () => {
    const body =
      "## Greptile Summary\n\n**Confidence Score: 5/5**\n\n" +
      `Last reviewed commit: [x](https://github.com/deftai/directive/commit/${OLD})\n` +
      '### P0 findings (1)\n<img alt="P0" />\n';
    const result = computeGateResult(
      2258,
      "deftai/directive",
      fakeRunGh({ commentBody: body, mergeableState: "clean", mergeable: true }),
    );
    expect(result.failures.length).toBeGreaterThan(0);
    expect((result.partialData as Record<string, unknown>).verdict_override).toBeUndefined();
  });

  it("merges when Greptile excluded-author skip is present and CI is green (#2375)", () => {
    const body = "<!-- greptile-status --> PR author is in the excluded authors list.";
    const result = computeGateResult(
      2352,
      "deftai/directive",
      fakeRunGh({ commentBody: body, mergeableState: "clean", mergeable: true }),
    );
    expect(result.failures).toEqual([]);
    expect(result.verdict.excludedAuthor).toBe(true);
    expect((result.partialData as Record<string, unknown>).verdict_override).toBeUndefined();
  });

  it("does NOT merge a genuine P0/P1 on the current head even when GitHub is CLEAN", () => {
    const body =
      "## Greptile Summary\n\n**Confidence Score: 5/5**\n\n" +
      `Last reviewed commit: [x](https://github.com/deftai/directive/commit/${HEAD})\n` +
      '### P0 findings (1)\n<img alt="P0" />\n';
    const result = computeGateResult(
      2258,
      "deftai/directive",
      fakeRunGh({ commentBody: body, mergeableState: "clean", mergeable: true }),
    );
    expect(result.failures.length).toBeGreaterThan(0);
    expect((result.partialData as Record<string, unknown>).verdict_override).toBeUndefined();
  });

  it("respects disableMergeabilityReconcile", () => {
    const result = computeGateResult(
      2258,
      "deftai/directive",
      fakeRunGh({ commentBody: "", mergeableState: "clean", mergeable: true }),
      { disableMergeabilityReconcile: true },
    );
    expect(result.failures.length).toBeGreaterThan(0);
    expect((result.partialData as Record<string, unknown>).verdict_override).toBeUndefined();
  });

  it("clean canonical verdict + green CI still merges via existing path", () => {
    const result = computeGateResult(
      2258,
      "deftai/directive",
      fakeRunGh({ commentBody: cleanGreptileBody(HEAD), mergeableState: "clean", mergeable: true }),
    );
    expect(result.failures).toEqual([]);
    // No override needed — the verdict itself was clean.
    expect((result.partialData as Record<string, unknown>).verdict_override).toBeUndefined();
  });

  it("fails closed on green observed CI when ruleset required context is absent (#3234)", () => {
    const result = computeGateResult(
      3234,
      "deftai/directive",
      fakeRunGh({ commentBody: cleanGreptileBody(HEAD), mergeableState: "clean", mergeable: true }),
      {
        requiredContexts: [
          "TypeScript (build + lint + test)",
          "terraform-plan",
          "terraform-apply-staging",
        ],
      },
    );
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures.join(" ")).toContain("ci_absent_required");
    expect(result.failures.join(" ")).toContain("terraform-plan");
    const ci = (result.partialData as Record<string, unknown>).ci as Record<string, unknown>;
    expect(ci.ready_state).toBe("ci_absent_required");
    expect(ci.absent_required).toEqual(["terraform-plan", "terraform-apply-staging"]);
    expect(ci.required_contexts).toEqual([
      "TypeScript (build + lint + test)",
      "terraform-plan",
      "terraform-apply-staging",
    ]);
  });

  it("stays merge-ready when injected required contexts are all observed green (#3234)", () => {
    const result = computeGateResult(
      3234,
      "deftai/directive",
      fakeRunGh({ commentBody: cleanGreptileBody(HEAD), mergeableState: "clean", mergeable: true }),
      {
        requiredContexts: ["TypeScript (build + lint + test)"],
      },
    );
    expect(result.failures).toEqual([]);
    const ci = (result.partialData as Record<string, unknown>).ci as Record<string, unknown>;
    expect(ci.ready_state).toBe("ready");
    expect(ci.absent_required).toEqual([]);
  });

  it("resolves required contexts via fetchRequiredContextsFn seam (#3234)", () => {
    let branchSeen = "";
    const result = computeGateResult(
      3234,
      "deftai/directive",
      fakeRunGh({ commentBody: cleanGreptileBody(HEAD), mergeableState: "clean", mergeable: true }),
      {
        fetchRequiredContextsFn: (_repo, branch) => {
          branchSeen = branch;
          return {
            contexts: [{ name: "TypeScript (build + lint + test)" }, { name: "terraform-plan" }],
            sources: ["rulesets"],
            error: "",
            resolutionFailed: false,
          };
        },
      },
    );
    expect(branchSeen).toBe("master");
    expect(result.failures.join(" ")).toContain("terraform-plan");
    const ci = (result.partialData as Record<string, unknown>).ci as Record<string, unknown>;
    expect(ci.ready_state).toBe("ci_absent_required");
    expect(ci.required_contexts_source).toBe("rulesets");
    expect(ci.required_contexts_base_ref).toBe("master");
  });

  it("does not discard ci_absent_required under soft-verdict CLEAN reconciliation (#3234)", () => {
    const result = computeGateResult(
      3234,
      "deftai/directive",
      // Absent Greptile verdict → soft block; GitHub CLEAN would previously
      // wipe CI failures via #2260 reconciliation.
      fakeRunGh({ commentBody: "", mergeableState: "clean", mergeable: true }),
      {
        requiredContexts: ["TypeScript (build + lint + test)", "terraform-plan"],
      },
    );
    expect(result.failures.join(" ")).toContain("ci_absent_required");
    expect(result.failures.join(" ")).toContain("terraform-plan");
    expect((result.partialData as Record<string, unknown>).verdict_override).toBeUndefined();
    const ci = (result.partialData as Record<string, unknown>).ci as Record<string, unknown>;
    expect(ci.ready_state).toBe("ci_absent_required");
  });

  it("fails closed when required-context inventory resolution fails (#3234)", () => {
    const result = computeGateResult(
      3234,
      "deftai/directive",
      fakeRunGh({ commentBody: cleanGreptileBody(HEAD), mergeableState: "clean", mergeable: true }),
      {
        fetchRequiredContextsFn: () => ({
          contexts: [],
          sources: [],
          error: "rules/branches parse: Unexpected token",
          resolutionFailed: true,
        }),
      },
    );
    expect(result.failures.join(" ")).toContain("could not be resolved");
    expect(result.failures.join(" ")).toContain("#3234");
    const ci = (result.partialData as Record<string, unknown>).ci as Record<string, unknown>;
    expect(ci.ready_state).toBe("blocked");
    expect(ci.required_contexts_resolution_failed).toBe(true);
  });

  it("uses injectable fetchMergeabilityFn seam", () => {
    let called = false;
    const result = computeGateResult(
      2258,
      "deftai/directive",
      fakeRunGh({ commentBody: "", mergeableState: "unstable", mergeable: false }),
      {
        fetchMergeabilityFn: () => {
          called = true;
          return { mergeableState: "clean", mergeable: true, error: null };
        },
      },
    );
    expect(called).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("blocks merge-ready when summary is clean but unresolved inline P1 remains (#2620)", () => {
    const inlineP1Body =
      '<img alt="P1" src="https://greptile-static-assets.s3.amazonaws.com/badges/p1.svg?v=9" align="top"> ' +
      "**Path traversal via `..` in owner/repo segments**";
    const reviewThreads = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  isResolved: false,
                  isOutdated: false,
                  comments: {
                    nodes: [
                      {
                        author: { login: "greptile-apps[bot]" },
                        body: inlineP1Body,
                        path: "server/src/register/github.ts",
                        commit: { oid: HEAD },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    });
    const result = computeGateResult(
      120,
      "deftai/statusreport",
      fakeRunGh({
        commentBody: cleanGreptileBody(HEAD),
        mergeableState: "clean",
        mergeable: true,
        reviewThreads,
      }),
    );
    expect(result.failures.some((f) => f.includes("unresolved inline P1"))).toBe(true);
    expect((result.partialData as Record<string, unknown>).verdict_override).toBeUndefined();
  });

  it("fails closed when inline reviewThreads fetch errors on a clean summary (#2620)", () => {
    const result = computeGateResult(
      120,
      "deftai/directive",
      fakeRunGh({
        commentBody: cleanGreptileBody(HEAD),
        reviewThreads: "",
      }),
    );
    expect(
      result.failures.some((f) => f.includes("Could not verify Greptile inline review comments")),
    ).toBe(true);
    expect((result.partialData as Record<string, unknown>).verdict_override).toBeUndefined();
  });
});
