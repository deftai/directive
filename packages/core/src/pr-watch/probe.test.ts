import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BODY_AC4_MARKDOWN_LINK_CLEAN,
  BODY_PR4287_THIN_HTML,
  BODY_PR4292_INLINE_P1,
  BODY_PR4292_THIN_HTML,
  BODY_TIER2_P1_ONLY,
} from "../content-contracts/skills/greptile-detector.js";
import { GREPTILE_ERRORED_SENTINEL } from "../pr-merge-readiness/constants.js";
import type { RunGhResult } from "../pr-merge-readiness/types.js";
import { fetchPrLifecycleRest, probeOnce } from "./probe.js";

/** The last_reviewed sha embedded in the BODY_AC4_* / BODY_TIER2_P1_ONLY fixtures. */
const FIXTURE_SHA = "abcdef1234567";
const OTHER_SHA = "9999999deadbee";

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

interface FakeGhConfig {
  headSha?: string | null;
  body?: string;
  checkRuns?: unknown[];
  pullComments?: unknown[];
  pullCommentsError?: boolean;
  headError?: boolean;
  /** REST pulls `state` (#4288). Default open so existing Greptile cases fall through. */
  prState?: string;
  /** REST pulls `merged` (#4288). Default false. */
  prMerged?: boolean;
  /** Force pulls REST failure (lifecycle unresolved → continue / HEAD error). */
  pullsRestError?: boolean;
  /** GraphQL reviewThreads JSON. Default empty success (#3944 ordinary inline path). */
  reviewThreads?: string;
  /** Force GraphQL reviewThreads failure (thin-HTML REST fallback / lookup error). */
  graphqlError?: boolean;
}

/** Route the canonical pr-merge-readiness gh calls to canned responses. */
function makeFakeGh(cfg: FakeGhConfig) {
  const ok = (stdout: string): RunGhResult => ({ returncode: 0, stdout, stderr: "" });
  const fail = (stderr: string): RunGhResult => ({ returncode: 1, stdout: "", stderr });
  return (cmd: readonly string[]): RunGhResult => {
    const joined = cmd.join(" ");
    if (cmd[1] === "pr" && cmd[2] === "view") {
      if (cfg.headError === true) return fail("no such PR");
      return ok(cfg.headSha === null ? "" : `${cfg.headSha ?? FIXTURE_SHA}\n`);
    }
    if (joined.includes("graphql")) {
      if (cfg.graphqlError === true) return fail("graphql unavailable");
      return ok(cfg.reviewThreads ?? EMPTY_REVIEW_THREADS);
    }
    if (joined.includes("/pulls/") && joined.includes("/comments")) {
      if (cfg.pullCommentsError === true) return fail("comments unavailable");
      return ok(JSON.stringify(cfg.pullComments ?? []));
    }
    if (joined.includes("/pulls/")) {
      // REST HEAD + lifecycle (#4288).
      if (cfg.headError === true || cfg.pullsRestError === true) {
        return fail("no such PR (REST)");
      }
      return ok(
        JSON.stringify({
          head: { sha: cfg.headSha ?? FIXTURE_SHA },
          state: cfg.prState ?? "open",
          merged: cfg.prMerged ?? false,
        }),
      );
    }
    if (joined.includes("/issues/") && joined.includes("/comments") && joined.includes("--jq")) {
      return ok(cfg.body ?? "");
    }
    if (joined.includes("/commits/") && joined.includes("/check-runs")) {
      return ok(JSON.stringify({ check_runs: cfg.checkRuns ?? [] }));
    }
    return fail(`unexpected gh call: ${joined}`);
  };
}

const GREEN_CI = [
  { name: "TypeScript (build + lint + test)", status: "completed", conclusion: "success" },
];

let emptyReviewersRoot = "";

describe("probeOnce (canonical greptile-detector integration)", () => {
  afterEach(() => {
    if (emptyReviewersRoot.length > 0) {
      rmSync(emptyReviewersRoot, { recursive: true, force: true });
      emptyReviewersRoot = "";
    }
  });

  it("CLEAN body on a matching HEAD -> isClean, no blocking", () => {
    const probe = probeOnce(
      1056,
      "deftai/directive",
      makeFakeGh({
        headSha: FIXTURE_SHA,
        body: BODY_AC4_MARKDOWN_LINK_CLEAN,
        checkRuns: GREEN_CI,
      }),
    );
    expect(probe.error).toBeNull();
    expect(probe.shaMatch).toBe(true);
    expect(probe.isClean).toBe(true);
    expect(probe.hasBlocking).toBe(false);
    expect(probe.confidence).toBe(5);
    expect(probe.ciReadyState).toBe("ready");
    expect(probe.prState).toBe("open");
    expect(probe.prMerged).toBe(false);
  });

  it("merged PR short-circuits before Greptile body even when sha would not match (#4288)", () => {
    const probe = probeOnce(
      4288,
      "deftai/directive",
      makeFakeGh({
        headSha: OTHER_SHA,
        prState: "closed",
        prMerged: true,
        // Deliberately omit body — lifecycle must not require Greptile fetch.
      }),
    );
    expect(probe.error).toBeNull();
    expect(probe.prMerged).toBe(true);
    expect(probe.prState).toBe("closed");
    expect(probe.shaMatch).toBe(false);
    expect(probe.found).toBe(false);
    expect(probe.isClean).toBe(false);
  });

  it("closed unmerged PR short-circuits before Greptile body (#4288)", () => {
    const probe = probeOnce(
      4288,
      "deftai/directive",
      makeFakeGh({
        headSha: FIXTURE_SHA,
        prState: "closed",
        prMerged: false,
      }),
    );
    expect(probe.error).toBeNull();
    expect(probe.prMerged).toBe(false);
    expect(probe.prState).toBe("closed");
    expect(probe.found).toBe(false);
    expect(probe.isClean).toBe(false);
  });

  it("open PR with stale review still reaches Greptile path (#4288)", () => {
    const probe = probeOnce(
      4288,
      "deftai/directive",
      makeFakeGh({
        headSha: OTHER_SHA,
        prState: "open",
        prMerged: false,
        body: BODY_AC4_MARKDOWN_LINK_CLEAN,
        checkRuns: GREEN_CI,
      }),
    );
    expect(probe.error).toBeNull();
    expect(probe.prState).toBe("open");
    expect(probe.prMerged).toBe(false);
    expect(probe.shaMatch).toBe(false);
    expect(probe.found).toBe(true);
    expect(probe.isClean).toBe(false);
    expect(probe.cleanGateHoldout).toBe("sha_match");
  });

  it("lifecycle REST failure polls with lifecycle_unknown (no CLEAN, no CONFIG) (#4288)", () => {
    // HEAD comes from `gh pr view`; pulls REST fails for lifecycle only.
    const ok = (stdout: string): RunGhResult => ({ returncode: 0, stdout, stderr: "" });
    const fail = (stderr: string): RunGhResult => ({ returncode: 1, stdout: "", stderr });
    const runGh = (cmd: readonly string[]): RunGhResult => {
      const joined = cmd.join(" ");
      if (cmd[1] === "pr" && cmd[2] === "view") {
        return ok(`${FIXTURE_SHA}\n`);
      }
      if (joined.includes("/pulls/") && joined.includes("/comments")) {
        return ok("[]");
      }
      if (joined.includes("/pulls/")) {
        return fail("pulls unavailable");
      }
      if (joined.includes("/issues/") && joined.includes("/comments")) {
        return ok(BODY_AC4_MARKDOWN_LINK_CLEAN);
      }
      if (joined.includes("/check-runs")) {
        return ok(JSON.stringify({ check_runs: GREEN_CI }));
      }
      return fail(`unexpected: ${joined}`);
    };
    const probe = probeOnce(4288, "deftai/directive", runGh);
    expect(probe.error).toBeNull();
    expect(probe.prState).toBeNull();
    expect(probe.prMerged).toBeNull();
    expect(probe.isClean).toBe(false);
    expect(probe.cleanGateHoldout).toBe("lifecycle_unknown");
  });

  it("empty check-runs with clean Greptile -> ci_never_scheduled, not CLEAN (#3167)", () => {
    const probe = probeOnce(
      1056,
      "deftai/directive",
      makeFakeGh({ headSha: FIXTURE_SHA, body: BODY_AC4_MARKDOWN_LINK_CLEAN, checkRuns: [] }),
    );
    expect(probe.ciReadyState).toBe("ci_never_scheduled");
    expect(probe.isClean).toBe(false);
    expect(probe.cleanGateHoldout).toBe("ci_never_scheduled");
  });

  it("P1 findings on a matching HEAD -> hasBlocking, sha-matched, not clean", () => {
    const probe = probeOnce(
      1056,
      "deftai/directive",
      makeFakeGh({ headSha: FIXTURE_SHA, body: BODY_TIER2_P1_ONLY }),
    );
    expect(probe.hasBlocking).toBe(true);
    expect(probe.p1Count).toBeGreaterThanOrEqual(1);
    expect(probe.shaMatch).toBe(true);
    expect(probe.isClean).toBe(false);
    expect(probe.cleanGateHoldout).toBe("has_blocking");
  });

  it("clean body but HEAD moved past the review -> sha_match false, not clean (stale-review guard)", () => {
    const probe = probeOnce(
      1056,
      "deftai/directive",
      makeFakeGh({ headSha: OTHER_SHA, body: BODY_AC4_MARKDOWN_LINK_CLEAN }),
    );
    expect(probe.shaMatch).toBe(false);
    expect(probe.isClean).toBe(false);
    expect(probe.cleanGateHoldout).toBe("sha_match");
    expect(probe.found).toBe(true);
  });

  it("errored sentinel body -> errored true", () => {
    const probe = probeOnce(
      1056,
      "deftai/directive",
      makeFakeGh({ headSha: FIXTURE_SHA, body: GREPTILE_ERRORED_SENTINEL }),
    );
    expect(probe.errored).toBe(true);
    expect(probe.isClean).toBe(false);
  });

  it("empty body -> found false", () => {
    const probe = probeOnce(
      1056,
      "deftai/directive",
      makeFakeGh({ headSha: FIXTURE_SHA, body: "" }),
    );
    expect(probe.found).toBe(false);
    expect(probe.isClean).toBe(false);
  });

  it("completed non-bot CI without a bot check-run fail-closes to expected (#3630)", () => {
    const probe = probeOnce(
      1056,
      "deftai/directive",
      makeFakeGh({
        headSha: FIXTURE_SHA,
        body: "",
        checkRuns: GREEN_CI,
      }),
    );
    expect(probe.found).toBe(false);
    expect(probe.isClean).toBe(false);
    expect(probe.reviewerReadyState).toBe("expected");
    expect(probe.cleanGateHoldout).not.toBe("no_reviewer_installed");
    expect(probe.reviewCycleHandback).toBeNull();
  });

  it("empty check-runs (young inventory) fail-close to expected (#3630)", () => {
    const probe = probeOnce(
      1056,
      "deftai/directive",
      makeFakeGh({ headSha: FIXTURE_SHA, body: "", checkRuns: [] }),
    );
    expect(probe.ciReadyState).toBe("ci_never_scheduled");
    expect(probe.reviewerReadyState).toBe("expected");
    expect(probe.isClean).toBe(false);
  });

  it("slow reviewer (Greptile check in_progress, no comment) still expected (#3630)", () => {
    const probe = probeOnce(
      1056,
      "deftai/directive",
      makeFakeGh({
        headSha: FIXTURE_SHA,
        body: "",
        checkRuns: [{ name: "Greptile Review", status: "in_progress", conclusion: "none" }],
      }),
    );
    expect(probe.found).toBe(false);
    expect(probe.isClean).toBe(false);
    expect(probe.reviewerReadyState).toBe("expected");
    expect(probe.reviewCycleHandback).toBeNull();
  });

  it("explicit empty reviewers policy is no_reviewer_installed even on green non-bot CI (#3630)", () => {
    emptyReviewersRoot = mkdtempSync(join(tmpdir(), "probe-reviewers-"));
    mkdirSync(join(emptyReviewersRoot, "xbrief"), { recursive: true });
    writeFileSync(
      join(emptyReviewersRoot, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        plan: { title: "P", status: "running", policy: { review: { reviewers: [] } } },
      }),
      "utf8",
    );
    const probe = probeOnce(
      1056,
      "deftai/directive",
      makeFakeGh({
        headSha: FIXTURE_SHA,
        body: "",
        checkRuns: GREEN_CI,
      }),
      emptyReviewersRoot,
    );
    expect(probe.reviewerReadyState).toBe("no_reviewer_installed");
    expect(probe.cleanGateHoldout).toBe("no_reviewer_installed");
    expect(probe.reviewCycleHandback).toBe("review_cycle: skipped:no-reviewer-installed");
    expect(probe.isClean).toBe(false);
  });

  it("stale Greptile comment without a current-HEAD bot check is not comment-expected (#3630)", () => {
    const probe = probeOnce(
      1056,
      "deftai/directive",
      makeFakeGh({
        headSha: OTHER_SHA,
        body: BODY_AC4_MARKDOWN_LINK_CLEAN,
        checkRuns: GREEN_CI,
      }),
    );
    expect(probe.found).toBe(true);
    expect(probe.shaMatch).toBe(false);
    expect(probe.reviewerReadyState).toBe("expected");
    expect(probe.isClean).toBe(false);
  });

  it("in-flight CI without a bot check fail-closes to expected (slow vs absent) (#3630)", () => {
    const probe = probeOnce(
      1056,
      "deftai/directive",
      makeFakeGh({
        headSha: FIXTURE_SHA,
        body: "",
        checkRuns: [
          { name: "TypeScript (build + lint + test)", status: "in_progress", conclusion: "none" },
        ],
      }),
    );
    expect(probe.reviewerReadyState).toBe("expected");
    expect(probe.isClean).toBe(false);
  });

  it("failed CI check-run -> ci_failures counted, blocks clean", () => {
    const probe = probeOnce(
      1056,
      "deftai/directive",
      makeFakeGh({
        headSha: FIXTURE_SHA,
        body: BODY_AC4_MARKDOWN_LINK_CLEAN,
        checkRuns: [{ name: "build", status: "completed", conclusion: "failure" }],
      }),
    );
    expect(probe.ciFailures).toBe(1);
    expect(probe.isClean).toBe(false);
    expect(probe.cleanGateHoldout).toBe("ci_failures");
    expect(probe.ciReadyState).toBe("ci_failures");
  });

  it("cancelled primary without green sibling -> ci_cancelled_no_failover (#3167)", () => {
    const probe = probeOnce(
      1056,
      "deftai/directive",
      makeFakeGh({
        headSha: FIXTURE_SHA,
        body: BODY_AC4_MARKDOWN_LINK_CLEAN,
        checkRuns: [
          {
            name: "TypeScript (blacksmith primary)",
            status: "completed",
            conclusion: "cancelled",
          },
        ],
      }),
    );
    expect(probe.ciReadyState).toBe("ci_cancelled_no_failover");
    expect(probe.isClean).toBe(false);
  });

  it("unresolvable HEAD -> config error probe", () => {
    const probe = probeOnce(1056, "deftai/directive", makeFakeGh({ headError: true }));
    expect(probe.error).not.toBeNull();
    expect(probe.headSha).toBeNull();
  });

  it("cannot resolve repo -> config error probe (no --repo, gh repo view fails)", () => {
    const gh = (cmd: readonly string[]): RunGhResult => {
      if (cmd[1] === "repo" && cmd[2] === "view") {
        return { returncode: 1, stdout: "", stderr: "not a repo" };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
    const probe = probeOnce(1056, null, gh);
    expect(probe.error).toContain("could not resolve repo");
  });

  const GREPTILE_CLEAN = {
    name: "Greptile Review",
    status: "completed",
    conclusion: "success",
    output: { summary: "6 files reviewed, 0 comments added." },
  };
  const GREPTILE_DIRTY = {
    name: "Greptile Review",
    status: "completed",
    conclusion: "success",
    output: { summary: "3 files reviewed, 1 comments added." },
  };

  it("thin HTML 4287 with check-run pin and 0 comments added is CLEAN", () => {
    const probe = probeOnce(
      4287,
      "deftai/directive",
      makeFakeGh({
        headSha: FIXTURE_SHA,
        body: BODY_PR4287_THIN_HTML,
        checkRuns: [...GREEN_CI, GREPTILE_CLEAN],
        pullComments: [],
      }),
    );
    expect(probe.error).toBeNull();
    expect(probe.isClean).toBe(true);
    expect(probe.shaMatch).toBe(true);
    expect(probe.greptileReviewTerminal).toBe(true);
    expect(probe.hasBlocking).toBe(false);
    expect(probe.cleanGateHoldout).toBeNull();
  });

  it("thin HTML without findings channel fail-closes (not CLEAN on detect zeros)", () => {
    const probe = probeOnce(
      4287,
      "deftai/directive",
      makeFakeGh({
        headSha: FIXTURE_SHA,
        body: BODY_PR4287_THIN_HTML,
        checkRuns: [
          ...GREEN_CI,
          { name: "Greptile Review", status: "completed", conclusion: "success" },
        ],
        graphqlError: true,
        pullCommentsError: true,
      }),
    );
    expect(probe.isClean).toBe(false);
    expect(["findings_channel", "inline_lookup_error"]).toContain(probe.cleanGateHoldout);
  });

  it("thin HTML 4292 inline P1 is NEW_P0_P1 without a body SHA", () => {
    const probe = probeOnce(
      4292,
      "deftai/directive",
      makeFakeGh({
        headSha: FIXTURE_SHA,
        body: BODY_PR4292_THIN_HTML,
        checkRuns: [...GREEN_CI, GREPTILE_DIRTY],
        graphqlError: true,
        pullComments: [
          {
            user: { login: "greptile-apps[bot]" },
            body: BODY_PR4292_INLINE_P1,
            commit_id: FIXTURE_SHA,
            original_commit_id: FIXTURE_SHA,
          },
        ],
      }),
    );
    expect(probe.isClean).toBe(false);
    expect(probe.hasBlocking).toBe(true);
    expect(probe.p1Count).toBeGreaterThanOrEqual(1);
    expect(probe.shaMatch).toBe(true);
    expect(probe.lastReviewedSha).toBe(FIXTURE_SHA);
    expect(probe.cleanGateHoldout).toBe("has_blocking");
  });

  it("thin HTML GraphQL resolved P1 does not stay blocking via REST (#4289)", () => {
    const graphqlPayload = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  isResolved: true,
                  isOutdated: false,
                  comments: {
                    nodes: [
                      {
                        author: { login: "greptile-apps" },
                        body: BODY_PR4292_INLINE_P1,
                        path: "greptile-inline.ts",
                        commit: { oid: FIXTURE_SHA },
                        originalCommit: { oid: FIXTURE_SHA },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    };
    const probe = probeOnce(
      4303,
      "deftai/directive",
      makeFakeGh({
        headSha: FIXTURE_SHA,
        body: BODY_PR4292_THIN_HTML,
        checkRuns: [...GREEN_CI, GREPTILE_CLEAN],
        reviewThreads: JSON.stringify(graphqlPayload),
        pullComments: [
          {
            user: { login: "greptile-apps[bot]" },
            body: BODY_PR4292_INLINE_P1,
            commit_id: FIXTURE_SHA,
            original_commit_id: FIXTURE_SHA,
          },
        ],
      }),
    );
    expect(probe.error).toBeNull();
    expect(probe.hasBlocking).toBe(false);
    expect(probe.isClean).toBe(true);
  });

  it("ordinary summary-clean + GraphQL greptile-apps inline P1 is not CLEAN (#3944)", () => {
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
                        author: { login: "greptile-apps" },
                        body: BODY_PR4292_INLINE_P1,
                        path: "server/src/register/github.ts",
                        commit: { oid: FIXTURE_SHA },
                        originalCommit: { oid: FIXTURE_SHA },
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
    const probe = probeOnce(
      3944,
      "deftai/directive",
      makeFakeGh({
        headSha: FIXTURE_SHA,
        body: BODY_AC4_MARKDOWN_LINK_CLEAN,
        checkRuns: GREEN_CI,
        reviewThreads,
      }),
    );
    expect(probe.error).toBeNull();
    expect(probe.isClean).toBe(false);
    expect(probe.hasBlocking).toBe(true);
    expect(probe.p1Count).toBeGreaterThanOrEqual(1);
    expect(probe.cleanGateHoldout).toBe("has_blocking");
  });

  it("thin HTML REST fallback does not shaMatch when summary SHA is unknown (#3944)", () => {
    // GraphQL fail → REST may count resolved comments (no isResolved). Without a
    // known summary SHA, do not force shaMatch / false NEW_P0_P1.
    const probe = probeOnce(
      4292,
      "deftai/directive",
      makeFakeGh({
        headSha: OTHER_SHA,
        body: BODY_PR4292_THIN_HTML,
        checkRuns: GREEN_CI,
        graphqlError: true,
        pullComments: [
          {
            user: { login: "greptile-apps[bot]" },
            body: BODY_PR4292_INLINE_P1,
            commit_id: OTHER_SHA,
            original_commit_id: OTHER_SHA,
          },
        ],
      }),
    );
    expect(probe.error).toBeNull();
    expect(probe.lastReviewedSha).toBeNull();
    expect(probe.hasBlocking).toBe(true);
    expect(probe.p1Count).toBeGreaterThanOrEqual(1);
    expect(probe.shaMatch).toBe(false);
    expect(probe.isClean).toBe(false);
  });

  it("stale summary SHA + HEAD-anchored inline P1 → shaMatch + hasBlocking (#3944)", () => {
    // Rolling summary still names FIXTURE_SHA; live HEAD is OTHER_SHA with an
    // unresolved greptile-apps inline P1 on originalCommit=OTHER_SHA.
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
                        author: { login: "greptile-apps" },
                        body: BODY_PR4292_INLINE_P1,
                        path: "packages/core/src/pr-watch/probe.ts",
                        commit: { oid: OTHER_SHA },
                        originalCommit: { oid: OTHER_SHA },
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
    const probe = probeOnce(
      3944,
      "deftai/directive",
      makeFakeGh({
        headSha: OTHER_SHA,
        body: BODY_AC4_MARKDOWN_LINK_CLEAN,
        checkRuns: GREEN_CI,
        reviewThreads,
      }),
    );
    expect(probe.error).toBeNull();
    expect(probe.lastReviewedSha).toBe(FIXTURE_SHA);
    expect(probe.headSha).toBe(OTHER_SHA);
    expect(probe.hasBlocking).toBe(true);
    expect(probe.p1Count).toBeGreaterThanOrEqual(1);
    expect(probe.shaMatch).toBe(true);
    expect(probe.isClean).toBe(false);
    expect(probe.cleanGateHoldout).toBe("has_blocking");
  });

  it("ordinary probe is non-clean when inline GraphQL lookup fails (#3944)", () => {
    const probe = probeOnce(
      3944,
      "deftai/directive",
      makeFakeGh({
        headSha: FIXTURE_SHA,
        body: BODY_AC4_MARKDOWN_LINK_CLEAN,
        checkRuns: GREEN_CI,
        graphqlError: true,
      }),
    );
    expect(probe.isClean).toBe(false);
    expect(probe.cleanGateHoldout).toBe("inline_lookup_error");
  });

  it("does not CLEAN when --repo is missing and cwd repo resolve fails (#3944)", () => {
    // resolveRepo + body fetch both need `gh repo view`; failure → error probe (non-clean).
    const probe = probeOnce(
      3944,
      null,
      makeFakeGh({ headSha: FIXTURE_SHA, body: BODY_AC4_MARKDOWN_LINK_CLEAN }),
    );
    expect(probe.isClean).toBe(false);
    expect(probe.error !== null || probe.cleanGateHoldout === "inline_repo_unresolved").toBe(true);
  });
});

describe("fetchPrLifecycleRest (#4288)", () => {
  it("returns state/merged from pulls JSON", () => {
    const life = fetchPrLifecycleRest(1, "o/r", () => ({
      returncode: 0,
      stdout: JSON.stringify({ state: "closed", merged: true, head: { sha: "abc" } }),
      stderr: "",
    }));
    expect(life.error).toBeNull();
    expect(life.state).toBe("closed");
    expect(life.merged).toBe(true);
  });

  it("returns error on non-zero gh", () => {
    const life = fetchPrLifecycleRest(1, "o/r", () => ({
      returncode: 1,
      stdout: "",
      stderr: "boom",
    }));
    expect(life.state).toBeNull();
    expect(life.merged).toBeNull();
    expect(life.error).toContain("failed");
  });

  it("returns error on empty body", () => {
    const life = fetchPrLifecycleRest(1, "o/r", () => ({
      returncode: 0,
      stdout: "   ",
      stderr: "",
    }));
    expect(life.error).toContain("empty body");
  });

  it("returns error on invalid JSON", () => {
    const life = fetchPrLifecycleRest(1, "o/r", () => ({
      returncode: 0,
      stdout: "not-json",
      stderr: "",
    }));
    expect(life.error).toContain("could not parse");
  });

  it("returns error on non-object JSON", () => {
    const life = fetchPrLifecycleRest(1, "o/r", () => ({
      returncode: 0,
      stdout: "[]",
      stderr: "",
    }));
    expect(life.error).toContain("unexpected PR JSON shape");
  });

  it("leaves merged null when key is not boolean", () => {
    const life = fetchPrLifecycleRest(1, "o/r", () => ({
      returncode: 0,
      stdout: JSON.stringify({ state: "open", merged: "yes" }),
      stderr: "",
    }));
    expect(life.error).toBeNull();
    expect(life.state).toBe("open");
    expect(life.merged).toBeNull();
  });
});
