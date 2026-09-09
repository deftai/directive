import { describe, expect, it } from "vitest";
import { parseGreptileBody } from "../../pr-merge-readiness/parse.js";
import {
  BODY_AC4_MARKDOWN_LINK_CLEAN,
  BODY_PR4287_THIN_HTML,
  BODY_PR4292_INLINE_P1,
  BODY_PR4292_THIN_HTML,
  detect,
  evaluateCleanGate,
  isThinHtmlSummary,
  parseCommentsAdded,
  parseConfidence,
  parseLastReviewedShaMarkdownLink,
  parseLastReviewedShaNaiveInline,
  resolveFindingsChannel,
  resolveShaCurrency,
  simulatePollLoop,
} from "./greptile-detector.js";

const HEAD = "73f6e732aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("thin HTML greptile_summary (#4289)", () => {
  it("names PR 4287 HTML: confidence present, no Last reviewed, not informal-clean", () => {
    expect(isThinHtmlSummary(BODY_PR4287_THIN_HTML)).toBe(true);
    expect(parseConfidence(BODY_PR4287_THIN_HTML)).toBe(5);
    expect(parseLastReviewedShaMarkdownLink(BODY_PR4287_THIN_HTML)).toBeNull();
    expect(parseLastReviewedShaNaiveInline(BODY_PR4287_THIN_HTML)).toBeNull();
    const findings = detect(BODY_PR4287_THIN_HTML);
    expect(findings.p0_count).toBe(0);
    expect(findings.p1_count).toBe(0);
    expect(findings.has_blocking).toBe(false);
    const verdict = parseGreptileBody(BODY_PR4287_THIN_HTML);
    expect(verdict.thinHtmlSummary).toBe(true);
    expect(verdict.confidence).toBe(5);
    expect(verdict.lastReviewedSha).toBeNull();
    expect(verdict.informalClean).toBe(false);
  });
  it("names PR 4292 HTML the same way; detect zeros are missing markup", () => {
    expect(isThinHtmlSummary(BODY_PR4292_THIN_HTML)).toBe(true);
    expect(detect(BODY_PR4292_THIN_HTML).p1_count).toBe(0);
    expect(detect(BODY_PR4292_INLINE_P1).p1_count).toBeGreaterThanOrEqual(1);
  });

  it("does not name old markdown as thin HTML", () => {
    expect(isThinHtmlSummary(BODY_AC4_MARKDOWN_LINK_CLEAN)).toBe(false);
  });

  it("parses comments-added from check-run summary", () => {
    expect(parseCommentsAdded("6 files reviewed, 0 comments added.")).toBe(0);
    expect(parseCommentsAdded("3 files reviewed, 1 comments added.")).toBe(1);
    expect(parseCommentsAdded(null)).toBeNull();
  });

  it("pins SHA to Greptile Review check-run on HEAD, not body", () => {
    expect(
      resolveShaCurrency({
        bodySha: null,
        headSha: HEAD,
        thinHtmlSummary: true,
        greptileReviewTerminalOnHead: true,
      }),
    ).toEqual({ sha: HEAD, source: "greptile_review_check_run" });
    expect(
      resolveShaCurrency({
        bodySha: null,
        headSha: HEAD,
        thinHtmlSummary: true,
        greptileReviewTerminalOnHead: false,
      }).source,
    ).toBe("none");
    expect(
      resolveShaCurrency({
        bodySha: "abcdef1234567",
        headSha: HEAD,
        thinHtmlSummary: false,
        greptileReviewTerminalOnHead: true,
      }),
    ).toEqual({ sha: "abcdef1234567", source: "body" });
  });
  it("fail-closes CLEAN when thin HTML has no findings channel", () => {
    const channel = resolveFindingsChannel({
      thinHtmlSummary: true,
      bodyDetect: detect(BODY_PR4287_THIN_HTML),
      commentsAdded: null,
      restPullComments: null,
    });
    expect(channel.present).toBe(false);
    const [clean, holdout] = evaluateCleanGate({
      lastReviewedSha: HEAD,
      headSha: HEAD,
      hasBlocking: false,
      confidence: 5,
      ciFailures: 0,
      errored: false,
      terminalCheckRun: true,
      findingsChannelPresent: false,
    });
    expect(clean).toBe(false);
    expect(holdout).toBe("findings_channel");
  });

  it("CLEANs 4287 when check-run pin plus 0 comments added", () => {
    const [exitClass, , holdout] = simulatePollLoop({
      body: BODY_PR4287_THIN_HTML,
      headSha: HEAD,
      greptileReviewTerminalOnHead: true,
      commentsAdded: 0,
      restPullComments: { p0Count: 0, p1Count: 0 },
    });
    expect(exitClass).toBe("CLEAN");
    expect(holdout).toBeNull();
  });

  it("does not CLEAN 4292 on confidence plus terminal check-run plus detect zeros", () => {
    const [exitClass, , holdout] = simulatePollLoop({
      body: BODY_PR4292_THIN_HTML,
      headSha: HEAD,
      greptileReviewTerminalOnHead: true,
      commentsAdded: 1,
      restPullComments: { p0Count: 0, p1Count: 1 },
    });
    expect(exitClass).toBe("NEW_P0P1");
    expect(holdout).toBe("has_blocking");
  });

  it("STALLs thin HTML without a SHA pin (swarm poller surface)", () => {
    const [exitClass, polls, holdout] = simulatePollLoop({
      body: BODY_PR4287_THIN_HTML,
      headSha: HEAD,
      greptileReviewTerminalOnHead: false,
      stallThreshold: 3,
    });
    expect(exitClass).toBe("STALL");
    expect(polls).toBe(3);
    expect(holdout).toBe("sha_match");
  });
});
