import { describe, expect, it } from "vitest";
import {
  botReviewCheckPresent,
  evaluateReviewerExpectation,
  MERGE_READY_NO_REVIEWER_FAILURE,
  REVIEW_CYCLE_NO_REVIEWER_HANDBACK,
  REVIEWER_STATE_EXPECTED,
  REVIEWER_STATE_NO_REVIEWER_INSTALLED,
  reviewerConfigPresent,
} from "./reviewer-presence.js";

describe("evaluateReviewerExpectation (#3630)", () => {
  it("explicit empty policy is no_reviewer_installed even with a comment", () => {
    const r = evaluateReviewerExpectation({
      policyReviewers: [],
      reviewCommentPresent: true,
      botReviewCheckPresent: true,
      reviewerConfigPresent: true,
    });
    expect(r.state).toBe(REVIEWER_STATE_NO_REVIEWER_INSTALLED);
    expect(r.source).toBe("policy");
    expect(r.handback).toBe(REVIEW_CYCLE_NO_REVIEWER_HANDBACK);
  });

  it("explicit non-empty policy is expected while the comment is still missing (slow)", () => {
    const r = evaluateReviewerExpectation({
      policyReviewers: ["greptile"],
      reviewCommentPresent: false,
      botReviewCheckPresent: false,
      reviewerConfigPresent: false,
      checkRunsUnknown: false,
      ciReadyState: "ci_never_scheduled",
    });
    expect(r.state).toBe(REVIEWER_STATE_EXPECTED);
    expect(r.source).toBe("policy");
    expect(r.handback).toBeNull();
  });

  it("comment present is expected", () => {
    const r = evaluateReviewerExpectation({
      policyReviewers: null,
      reviewCommentPresent: true,
      botReviewCheckPresent: false,
      reviewerConfigPresent: false,
    });
    expect(r.state).toBe(REVIEWER_STATE_EXPECTED);
    expect(r.source).toBe("comment");
  });

  it("bot check-run without a comment is expected (slow reviewer still polls)", () => {
    const r = evaluateReviewerExpectation({
      policyReviewers: null,
      reviewCommentPresent: false,
      botReviewCheckPresent: true,
      reviewerConfigPresent: false,
      ciReadyState: "not_ready_yet",
    });
    expect(r.state).toBe(REVIEWER_STATE_EXPECTED);
    expect(r.source).toBe("check_run");
  });

  it("local config without a comment is expected", () => {
    const r = evaluateReviewerExpectation({
      policyReviewers: null,
      reviewCommentPresent: false,
      botReviewCheckPresent: false,
      reviewerConfigPresent: true,
    });
    expect(r.state).toBe(REVIEWER_STATE_EXPECTED);
    expect(r.source).toBe("config");
  });

  it("unreachable check-runs fail-close to poll, never CLEAN / never absent", () => {
    const r = evaluateReviewerExpectation({
      policyReviewers: null,
      reviewCommentPresent: false,
      botReviewCheckPresent: false,
      reviewerConfigPresent: false,
      checkRunsUnknown: true,
    });
    expect(r.state).toBe(REVIEWER_STATE_EXPECTED);
    expect(r.source).toBe("probe");
    expect(r.handback).toBeNull();
  });

  it("in-flight CI without a bot check fail-closes to poll (slow vs absent)", () => {
    const r = evaluateReviewerExpectation({
      policyReviewers: null,
      reviewCommentPresent: false,
      botReviewCheckPresent: false,
      reviewerConfigPresent: false,
      checkRunsUnknown: false,
      ciReadyState: "not_ready_yet",
    });
    expect(r.state).toBe(REVIEWER_STATE_EXPECTED);
    expect(r.source).toBe("probe");
  });

  it("empty check-runs (ci_never_scheduled) fail-close to poll (young inventory)", () => {
    const r = evaluateReviewerExpectation({
      policyReviewers: null,
      reviewCommentPresent: false,
      botReviewCheckPresent: false,
      reviewerConfigPresent: false,
      checkRunsUnknown: false,
      ciReadyState: "ci_never_scheduled",
    });
    expect(r.state).toBe(REVIEWER_STATE_EXPECTED);
    expect(r.source).toBe("probe");
    expect(r.handback).toBeNull();
  });

  it("completed non-bot CI without a bot check-run fail-closes to poll", () => {
    const r = evaluateReviewerExpectation({
      policyReviewers: null,
      reviewCommentPresent: false,
      botReviewCheckPresent: false,
      reviewerConfigPresent: false,
      checkRunsUnknown: false,
      ciReadyState: "ready",
    });
    expect(r.state).toBe(REVIEWER_STATE_EXPECTED);
    expect(r.source).toBe("probe");
    expect(r.handback).toBeNull();
  });

  it("explicit empty policy is absent even on completed non-bot CI", () => {
    const r = evaluateReviewerExpectation({
      policyReviewers: [],
      reviewCommentPresent: false,
      botReviewCheckPresent: false,
      reviewerConfigPresent: false,
      checkRunsUnknown: false,
      ciReadyState: "ready",
    });
    expect(r.state).toBe(REVIEWER_STATE_NO_REVIEWER_INSTALLED);
    expect(r.source).toBe("policy");
  });

  it("doctor/local none plus an honest complete inventory is no_reviewer_installed", () => {
    const r = evaluateReviewerExpectation({
      policyReviewers: null,
      reviewCommentPresent: false,
      botReviewCheckPresent: false,
      reviewerConfigPresent: false,
      checkRunsUnknown: false,
      ciReadyState: "ready",
      absenceInventoryComplete: true,
    });
    expect(r.state).toBe(REVIEWER_STATE_NO_REVIEWER_INSTALLED);
    expect(r.source).toBe("probe");
    expect(r.handback).toBe(REVIEW_CYCLE_NO_REVIEWER_HANDBACK);
  });
});

describe("botReviewCheckPresent / reviewerConfigPresent", () => {
  it("reuses isBotReviewCheck names", () => {
    expect(botReviewCheckPresent([{ name: "TypeScript (build + lint)" }])).toBe(false);
    expect(botReviewCheckPresent([{ name: "Greptile Review" }])).toBe(true);
    expect(botReviewCheckPresent([{ name: "SLizard" }])).toBe(true);
  });

  it("detects greptile.json via injected isFile", () => {
    const isFile = (p: string) => p.replaceAll("\\", "/").endsWith("/greptile.json");
    expect(reviewerConfigPresent("/tmp/proj", isFile)).toBe(true);
    expect(reviewerConfigPresent("/tmp/proj", () => false)).toBe(false);
    expect(reviewerConfigPresent(null, () => true)).toBe(false);
  });
});

describe("MERGE_READY_NO_REVIEWER_FAILURE", () => {
  it("names the terminal, pre-pr route, handback, and #769 fence", () => {
    expect(MERGE_READY_NO_REVIEWER_FAILURE).toContain("NO_REVIEWER_INSTALLED");
    expect(MERGE_READY_NO_REVIEWER_FAILURE).toContain("deft-directive-pre-pr");
    expect(MERGE_READY_NO_REVIEWER_FAILURE).toContain(REVIEW_CYCLE_NO_REVIEWER_HANDBACK);
    expect(MERGE_READY_NO_REVIEWER_FAILURE).toContain("#769");
    expect(MERGE_READY_NO_REVIEWER_FAILURE).not.toContain("Wait for the review");
  });
});
