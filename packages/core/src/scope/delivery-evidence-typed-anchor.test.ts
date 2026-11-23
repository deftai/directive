import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunner } from "../session/git.js";
import {
  discoverDeliveryEvidenceForComplete,
  type FetchClosingPrRefsFn,
  type FetchPrPayloadFn,
  hasGithubIssueRef,
  type MergeTimeForge,
  resolvePlanGithubIssueRef,
  verifyStoryPrMergeIdentity,
} from "./delivery-evidence.js";
import {
  evaluateInPrCompletionInputs,
  evaluateLandsWithProductAdmission,
} from "./lands-with-product.js";

// #7025: only a reference typed exactly as a GitHub issue anchors the story.
// A context link to an upstream issue never makes the identity join or
// discovery read a same-numbered PR from that upstream repository.

const UPSTREAM = "deftai/directive";
const CONSUMER = "example-org/consumer-repo";
const MERGED_AT = "2026-11-22T10:00:00Z";

function issueUri(repo: string, n: number): string {
  return `https://github.com/${repo}/issues/${n}`;
}

function planWith(
  refs: unknown[],
  metadata: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    title: "story",
    status: "running",
    references: refs,
    metadata: { kind: "story", swarm: { file_scope: ["packages/core/src/x.ts"] }, ...metadata },
    items: [],
  };
}

/** The reported shape: two context references, no story issue, optional stamp. */
function contextOnlyPlan(stamp: number | null): Record<string, unknown> {
  return planWith(
    [
      { uri: `https://github.com/${CONSUMER}/pull/90`, type: "x-xbrief/external" },
      { uri: issueUri(UPSTREAM, 6780), type: "x-xbrief/external" },
    ],
    stamp === null ? {} : { productPullRequest: stamp },
  );
}

function mergedPayload(mergeCommitSha: string, body = ""): Record<string, unknown> {
  return {
    merged_at: MERGED_AT,
    merge_commit_sha: mergeCommitSha,
    base: { ref: "master" },
    head: { sha: "headsha" },
    body,
  };
}

/** Same PR number in two repositories with different merge commits. */
function twoRepoPayloads(calls: string[]): FetchPrPayloadFn {
  return (n, repo) => {
    calls.push(`${repo}#${n}`);
    if (n !== 90) return null;
    if (repo === CONSUMER) return mergedPayload("consumersha");
    if (repo === UPSTREAM) return mergedPayload("upstreamsha");
    return null;
  };
}

function gitWithOrigin(repo: string): GitRunner {
  return (_cwd, args) => {
    const joined = args.join(" ");
    if (joined === "remote get-url origin") {
      return { code: 0, stdout: `https://github.com/${repo}.git\n`, stderr: "" };
    }
    if (joined.includes("merge-base") && joined.includes("--is-ancestor")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (joined.includes("rev-parse") && joined.includes("origin/")) {
      return { code: 0, stdout: "deliverytip", stderr: "" };
    }
    if (joined.includes("symbolic-ref")) {
      return { code: 0, stdout: "origin/master", stderr: "" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };
}

describe("resolvePlanGithubIssueRef: exact typed anchor (#7025)", () => {
  it("anchors canonical, legacy and bare github-issue types", () => {
    for (const type of ["x-xbrief/github-issue", "x-vbrief/github-issue", "github-issue"]) {
      expect(resolvePlanGithubIssueRef(planWith([{ uri: issueUri(CONSUMER, 7), type }]))).toEqual({
        repository: CONSUMER,
        issueNumber: 7,
      });
    }
  });

  it("never anchors on a context type or a type that only contains github-issue", () => {
    for (const type of [
      "x-xbrief/external",
      "x-xbrief/refs",
      "x-xbrief/github-issue-context",
      "upstream-github-issue",
      "X-XBRIEF/GITHUB-ISSUE",
      "",
    ]) {
      const plan = planWith([{ uri: issueUri(UPSTREAM, 6780), type }]);
      expect(resolvePlanGithubIssueRef(plan)).toBeNull();
      expect(hasGithubIssueRef(plan)).toBe(false);
    }
    expect(resolvePlanGithubIssueRef(planWith([{ uri: issueUri(UPSTREAM, 6780) }]))).toBeNull();
  });

  it("needs a parsing URI even under the typed reference", () => {
    const plan = planWith([
      { uri: "https://github.com/example-org/consumer-repo/pull/3", type: "x-xbrief/github-issue" },
      { uri: issueUri(CONSUMER, 8), type: "x-xbrief/github-issue" },
    ]);
    expect(resolvePlanGithubIssueRef(plan)).toEqual({ repository: CONSUMER, issueNumber: 8 });
  });

  it("an external upstream issue before a typed story issue picks the typed one", () => {
    const plan = planWith([
      { uri: issueUri(UPSTREAM, 6780), type: "x-xbrief/external" },
      { uri: issueUri(CONSUMER, 12), type: "x-xbrief/github-issue" },
    ]);
    expect(resolvePlanGithubIssueRef(plan)).toEqual({ repository: CONSUMER, issueNumber: 12 });
  });

  it("a context-only brief is issue-less", () => {
    expect(resolvePlanGithubIssueRef(contextOnlyPlan(90))).toBeNull();
  });
});

describe("delivery identity join on context-only briefs (#7025)", () => {
  it("without a productPullRequest stamp refuses with the #5710 stamp-or-issue-origin text", () => {
    const calls: string[] = [];
    const result = verifyStoryPrMergeIdentity({
      plan: contextOnlyPlan(null),
      evidence: { prNumber: 90 },
      mergeCommit: "consumersha",
      fetchPrPayload: twoRepoPayloads(calls),
      resolveCanonicalRepository: () => CONSUMER,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no plan.metadata.productPullRequest/);
    expect(result.message).toMatch(/Stamp productPullRequest .* or add an issue origin/);
    expect(calls).toEqual([]);
  });

  it("with a stamp joins on the canonical remote's repository, never the upstream issue's", () => {
    const calls: string[] = [];
    const result = verifyStoryPrMergeIdentity({
      plan: contextOnlyPlan(90),
      evidence: { prNumber: 90 },
      mergeCommit: "consumersha",
      fetchPrPayload: twoRepoPayloads(calls),
      resolveCanonicalRepository: () => CONSUMER,
    });
    expect(result.ok).toBe(true);
    expect(result.identityBasis).toBe("pr-only");
    expect(result.repository).toBe(CONSUMER);
    expect(calls).toEqual([`${CONSUMER}#90`]);
  });

  it("the PR-only mismatch refusal names the repository and PR it fetched", () => {
    const result = verifyStoryPrMergeIdentity({
      plan: contextOnlyPlan(90),
      evidence: { prNumber: 90 },
      mergeCommit: "othersha",
      fetchPrPayload: twoRepoPayloads([]),
      resolveCanonicalRepository: () => CONSUMER,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain(
      `does not equal PR ${CONSUMER}#90 merge_commit_sha consumersha`,
    );
  });

  it("the issue-anchored mismatch refusal names the repository and PR it fetched", () => {
    const plan = planWith([
      { uri: issueUri(UPSTREAM, 6780), type: "x-xbrief/external" },
      { uri: issueUri(CONSUMER, 12), type: "x-xbrief/github-issue" },
    ]);
    const calls: string[] = [];
    const result = verifyStoryPrMergeIdentity({
      plan,
      evidence: { prNumber: 90 },
      mergeCommit: "othersha",
      fetchPrPayload: twoRepoPayloads(calls),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain(
      `does not equal PR ${CONSUMER}#90 merge_commit_sha consumersha`,
    );
    expect(calls).toEqual([`${CONSUMER}#90`]);
  });

  it("a typed x-xbrief/github-issue story still anchors the join as today", () => {
    const plan = planWith([{ uri: issueUri(UPSTREAM, 90), type: "x-xbrief/github-issue" }]);
    const calls: string[] = [];
    const result = verifyStoryPrMergeIdentity({
      plan,
      evidence: { prNumber: 90 },
      mergeCommit: "othersha",
      fetchPrPayload: twoRepoPayloads(calls),
    });
    expect(calls).toEqual([`${UPSTREAM}#90`]);
    expect(result.message).toContain(`PR ${UPSTREAM}#90 merge_commit_sha upstreamsha`);
  });
});

describe("delivery discovery on typed and context-only briefs (#7025 / #6873)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  function makeRoot(): string {
    root = mkdtempSync(join(tmpdir(), "typed-anchor-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    return root;
  }

  it("a stamped context-only brief discovers its PR from the canonical repository", () => {
    const calls: string[] = [];
    const found = discoverDeliveryEvidenceForComplete({
      projectRoot: makeRoot(),
      plan: contextOnlyPlan(90),
      runGit: gitWithOrigin(CONSUMER),
      fetchPrPayload: twoRepoPayloads(calls),
      fetchClosingPrRefs: () => ({ ok: true, refs: [] }),
    });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.evidence).toMatchObject({
      repository: CONSUMER,
      prNumber: 90,
      mergeCommit: "consumersha",
    });
    expect(calls).toEqual([`${CONSUMER}#90`]);
  });

  it("an unstamped context-only brief reads no closing PRs and no story marks", () => {
    const closing: string[] = [];
    const listed: string[] = [];
    const found = discoverDeliveryEvidenceForComplete({
      projectRoot: makeRoot(),
      plan: contextOnlyPlan(null),
      runGit: gitWithOrigin(CONSUMER),
      fetchPrPayload: twoRepoPayloads([]),
      fetchClosingPrRefs: (n, repo) => {
        closing.push(`${repo}#${n}`);
        return { ok: true, refs: [] };
      },
      mergeTimeForge: recordingForge(listed),
    });
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.message).toMatch(/Delivery evidence required/);
    expect(closing).toEqual([]);
    expect(listed).toEqual([]);
  });

  it("discovery anchors on the typed story issue after an external upstream issue", () => {
    const closing: string[] = [];
    const listed: string[] = [];
    const fetchClosingPrRefs: FetchClosingPrRefsFn = (n, repo) => {
      closing.push(`${repo}#${n}`);
      return { ok: true, refs: [] };
    };
    const found = discoverDeliveryEvidenceForComplete({
      projectRoot: makeRoot(),
      plan: planWith([
        { uri: issueUri(UPSTREAM, 6780), type: "x-xbrief/external" },
        { uri: issueUri(CONSUMER, 12), type: "x-xbrief/github-issue" },
      ]),
      runGit: gitWithOrigin(CONSUMER),
      fetchPrPayload: twoRepoPayloads([]),
      fetchClosingPrRefs,
      mergeTimeForge: recordingForge(listed),
    });
    expect(found.ok).toBe(false);
    expect(closing).toEqual([`${CONSUMER}#12`]);
    expect(listed.length).toBeGreaterThan(0);
    expect(new Set(listed)).toEqual(new Set([CONSUMER]));
  });
});

/** A forge that records the repository of every merged-PR listing (#6873 mark scan). */
function recordingForge(listed: string[]): MergeTimeForge {
  const page = <T>(nodes: readonly T[]) => ({
    ok: true as const,
    nodes,
    hasNextPage: false,
    endCursor: null,
  });
  return {
    listMergedPrsPage: (repository) => {
      listed.push(repository);
      return page([]);
    },
    fetchBodyRevisionsPage: () => page([]),
    fetchConnectionEventsPage: () => page([]),
    fetchPrFilesPage: () => page([]),
    listOpenPrsPage: () => page([]),
    probeRateLimit: () => ({ graphqlRemaining: 5000, coreRemaining: 5000 }),
    nowMs: () => 0,
  };
}

describe("lands-with-product on a context-only brief (#7025)", () => {
  it("in-PR completion refuses: the brief has no GitHub issue reference", () => {
    const result = evaluateInPrCompletionInputs(contextOnlyPlan(null), {
      changedPaths: ["packages/core/src/x.ts"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("the brief has no GitHub issue reference");
  });

  it("admission refuses: the brief has no GitHub issue reference", () => {
    const name = "2026-11-22-90-story.xbrief.json";
    const result = evaluateLandsWithProductAdmission({
      completedRel: `xbrief/completed/${name}`,
      plan: contextOnlyPlan(null),
      records: [
        { status: "R", src: `xbrief/active/${name}`, dest: `xbrief/completed/${name}` },
        { status: "M", src: "packages/core/src/x.ts", dest: "packages/core/src/x.ts" },
      ],
      prBody: `Closes ${UPSTREAM}#6780`,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("the brief has no GitHub issue reference");
  });
});
