import { describe, expect, it } from "vitest";
import { resolveAutoStampCatalogChip } from "./auto-stamp-chip.js";
import {
  evaluateAutoStampPath1Write,
  isPainCoverageBlockReason,
  leanCiteOnlyPath1Body,
  PAIN_COVERAGE_BLOCK_REASONS,
} from "./auto-stamp-path1.js";
import {
  COMPLETED_ARC_BLOCK_REASONS,
  evaluateCompletedArcRecord,
  type ThreadComment,
} from "./completed-arc-record.js";
import { evaluateHandoffPrint } from "./handoff.js";

const STOP1_ID = 5689610059;
const LEAN_4589 = 5689732726;
const LEAN_4590 = 5689733295;
const ROUND1_CRITIC_ID = 5689600001;

const PATH1_SUMMARY =
  "The problem was unrelieved pain on the bind lean. The accepted design keeps path-1 behind completed-arc clearance.";

function stop1(painLine: string, id = STOP1_ID): ThreadComment {
  return {
    id,
    body:
      "model: grok-4.6\nrole: triage\n\n" +
      "design-critique: warranted, because leftover stamp.\n\n" +
      painLine,
  };
}

function plainEnglishBlock(summary = PATH1_SUMMARY): string {
  return `## In plain English\n\n${summary}\n\n`;
}

function specPathLean(id: number, extra = ""): ThreadComment {
  return {
    id,
    body:
      plainEnglishBlock() +
      `**Lean:** recut.\n\nSpec-path: next-build contract is not this body.\n${extra}`,
  };
}

function relievesLean(id: number): ThreadComment {
  return {
    id,
    body:
      plainEnglishBlock() +
      "**Lean:** recut.\n\nSpec-path: next-build contract is not this body.\n\nrelieves: P1\n",
  };
}

function criticAfter(id: number, targets: string, withClearCarrier = true): ThreadComment {
  return {
    id,
    body:
      `model: grok-4.6\nrole: critic\n\naudit-targets: ${targets}\n` +
      (withClearCarrier ? "finding-classes: none\nharvest-changed: false\n" : ""),
  };
}

function englishPainAuditCritic(id: number): ThreadComment {
  return {
    id,
    body:
      "model: grok-4.6\nrole: critic\n\n" +
      "## Pain-audit of relieves: P1\n\n" +
      "Footnote-only. Harvest unchanged.\n",
  };
}

describe("evaluateAutoStampPath1Write (#4592)", () => {
  it("publishes the full pain-coverage reason set, not a two-reason allowlist", () => {
    expect(PAIN_COVERAGE_BLOCK_REASONS).toEqual([
      "missing-pain",
      "malformed-pain",
      "unrelieved-pain",
      "unresolved-pain-audit",
    ]);
    for (const reason of PAIN_COVERAGE_BLOCK_REASONS) {
      expect(COMPLETED_ARC_BLOCK_REASONS).toContain(reason);
      expect(isPainCoverageBlockReason(reason)).toBe(true);
    }
    expect(isPainCoverageBlockReason("missing-record")).toBe(false);
    expect(isPainCoverageBlockReason("missing-table-cite")).toBe(false);
  });

  it("constructs unpublished path-1 that cites only the lean", () => {
    const built = leanCiteOnlyPath1Body(LEAN_4589, PATH1_SUMMARY);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body).toContain("## In plain English");
    expect(built.body).toContain(PATH1_SUMMARY);
    expect(built.body).toContain("design-critique: synthesis accepted, because");
    expect(built.body).toContain(`successor lean ${String(LEAN_4589)}`);
    expect(built.body).not.toMatch(/verified-claims table/i);
  });

  it("refuses #4589 uncited Spec-path as unrelieved-pain and skips remaining-set", () => {
    const live: ThreadComment[] = [stop1("pain: P1\n"), specPathLean(LEAN_4589)];
    const liveThread = evaluateCompletedArcRecord({ comments: live, issueNumber: 4589 });
    expect(liveThread).toMatchObject({ status: "blocked", reason: "missing-record" });

    const verdict = evaluateAutoStampPath1Write({
      comments: live,
      issueNumber: 4589,
      plainEnglishSummary: PATH1_SUMMARY,
    });
    expect(verdict.writePath1).toBe(false);
    expect(verdict.writeIngestReadyRemainingSet).toBe(false);
    const expected = leanCiteOnlyPath1Body(LEAN_4589, PATH1_SUMMARY);
    expect(expected.ok).toBe(true);
    if (expected.ok) expect(verdict.unpublished?.body).toBe(expected.body);
    expect(verdict.unpublished?.body).not.toMatch(/verified-claims table/i);
    expect(verdict.candidate).toMatchObject({ status: "blocked", reason: "unrelieved-pain" });
    expect(
      evaluateHandoffPrint({ mapBody: specPathLean(LEAN_4589).body, stop1PainIds: ["P1"] }).print,
    ).toBe(true);
  });

  it("refuses #4590 relieves with no critic after the lean as unresolved-pain-audit", () => {
    const live: ThreadComment[] = [stop1("pain: P1\n", 5689610808), relievesLean(LEAN_4590)];
    const liveThread = evaluateCompletedArcRecord({ comments: live, issueNumber: 4590 });
    expect(liveThread).toMatchObject({ status: "blocked", reason: "missing-record" });

    const verdict = evaluateAutoStampPath1Write({
      comments: live,
      issueNumber: 4590,
      plainEnglishSummary: PATH1_SUMMARY,
    });
    expect(verdict.writePath1).toBe(false);
    expect(verdict.writeIngestReadyRemainingSet).toBe(false);
    expect(verdict.candidate).toMatchObject({
      status: "blocked",
      reason: "unresolved-pain-audit",
    });
    expect(
      evaluateHandoffPrint({ mapBody: relievesLean(LEAN_4590).body, stop1PainIds: ["P1"] }).print,
    ).toBe(false);
  });

  it("does not treat a round-1 critic of original P1 as a pain audit", () => {
    const live: ThreadComment[] = [
      criticAfter(ROUND1_CRITIC_ID, "pain-P1"),
      stop1("pain: P1\n"),
      relievesLean(LEAN_4590),
    ];
    const verdict = evaluateAutoStampPath1Write({
      comments: live,
      issueNumber: 4590,
      plainEnglishSummary: PATH1_SUMMARY,
    });
    expect(verdict.writePath1).toBe(false);
    expect(verdict.candidate).toMatchObject({
      status: "blocked",
      reason: "unresolved-pain-audit",
    });
  });

  it("refuses English Pain-audit heading after the bind lean as unresolved-pain-audit (#4648)", () => {
    const live: ThreadComment[] = [
      stop1("pain: P1\n"),
      relievesLean(LEAN_4590),
      englishPainAuditCritic(LEAN_4590 + 1),
    ];
    const verdict = evaluateAutoStampPath1Write({
      comments: live,
      issueNumber: 4590,
      plainEnglishSummary: PATH1_SUMMARY,
    });
    expect(verdict.writePath1).toBe(false);
    expect(verdict.writeIngestReadyRemainingSet).toBe(false);
    expect(verdict.candidate).toMatchObject({
      status: "blocked",
      reason: "unresolved-pain-audit",
    });
  });

  it("allows path-1 and remaining-set when a critic after the lean targets pain-P1", () => {
    const live: ThreadComment[] = [
      stop1("pain: P1\n"),
      relievesLean(LEAN_4590),
      criticAfter(LEAN_4590 + 1, "pain-P1"),
    ];
    const verdict = evaluateAutoStampPath1Write({
      comments: live,
      issueNumber: 4590,
      plainEnglishSummary: PATH1_SUMMARY,
    });
    expect(verdict.writePath1).toBe(true);
    expect(verdict.writeIngestReadyRemainingSet).toBe(true);
    expect(verdict.candidate).toMatchObject({
      status: "complete",
      citedLeanId: LEAN_4590,
      citedTableId: null,
    });
  });

  it("refuses missing-pain and malformed-pain, not only the 2026-09-15 pair", () => {
    const missing = evaluateAutoStampPath1Write({
      comments: [stop1(""), specPathLean(LEAN_4589)],
      issueNumber: 4589,
      plainEnglishSummary: PATH1_SUMMARY,
    });
    expect(missing.writePath1).toBe(false);
    expect(missing.writeIngestReadyRemainingSet).toBe(false);
    expect(missing.candidate).toMatchObject({ status: "blocked", reason: "missing-pain" });

    const malformed = evaluateAutoStampPath1Write({
      comments: [stop1("pain: P1 extra\n"), specPathLean(LEAN_4589)],
      issueNumber: 4589,
      plainEnglishSummary: PATH1_SUMMARY,
    });
    expect(malformed.writePath1).toBe(false);
    expect(malformed.writeIngestReadyRemainingSet).toBe(false);
    expect(malformed.candidate).toMatchObject({ status: "blocked", reason: "malformed-pain" });
  });

  it("does not use a table-citing unpublished body that would skip pain", () => {
    const live: ThreadComment[] = [stop1("pain: P1\n"), specPathLean(LEAN_4589)];
    const verdict = evaluateAutoStampPath1Write({
      comments: live,
      issueNumber: 4589,
      plainEnglishSummary: PATH1_SUMMARY,
    });
    expect(verdict.unpublished?.body ?? "").not.toMatch(/verified-claims table \d+/i);
    const path1 = leanCiteOnlyPath1Body(LEAN_4589, PATH1_SUMMARY);
    expect(path1.ok).toBe(true);
    if (!path1.ok) return;
    const tableCiting: ThreadComment = {
      id: LEAN_4589 + 10,
      body: `${path1.body}verified-claims table 9999999999.\n`,
    };
    const skipped = evaluateCompletedArcRecord({
      comments: [...live, tableCiting],
      issueNumber: 4589,
    });
    expect(skipped).toMatchObject({ status: "blocked", reason: "missing-table-cite" });
    expect(verdict.candidate).toMatchObject({ status: "blocked", reason: "unrelieved-pain" });
  });

  it("does not grow resolveAutoStampCatalogChip as this gate", () => {
    const lean = specPathLean(LEAN_4589);
    expect(resolveAutoStampCatalogChip(lean.body)).toBe("design-critique:ingest-ready");
    const refused = evaluateAutoStampPath1Write({
      comments: [stop1("pain: P1\n"), lean],
      issueNumber: 4589,
      plainEnglishSummary: PATH1_SUMMARY,
    });
    expect(refused.writeIngestReadyRemainingSet).toBe(false);
  });

  it("refuses when dest cannot be constructed because no successor lean is present", () => {
    const verdict = evaluateAutoStampPath1Write({
      comments: [stop1("pain: P1\n")],
      plainEnglishSummary: PATH1_SUMMARY,
    });
    expect(verdict.writePath1).toBe(false);
    expect(verdict.writeIngestReadyRemainingSet).toBe(false);
    expect(verdict.unpublished).toBeNull();
  });

  it("uses an unpublished id after the cited lean when provided", () => {
    const live: ThreadComment[] = [stop1("pain: P1\n"), specPathLean(LEAN_4589)];
    const unpublishedId = LEAN_4589 + 7;
    const verdict = evaluateAutoStampPath1Write({
      comments: live,
      issueNumber: 4589,
      unpublishedCommentId: unpublishedId,
      plainEnglishSummary: PATH1_SUMMARY,
    });
    expect(verdict.unpublished?.id).toBe(unpublishedId);
    expect(verdict.candidate).toMatchObject({ status: "blocked", reason: "unrelieved-pain" });
    const tooEarly = evaluateAutoStampPath1Write({
      comments: live,
      issueNumber: 4589,
      unpublishedCommentId: LEAN_4589,
      plainEnglishSummary: PATH1_SUMMARY,
    });
    expect(tooEarly.unpublished?.id).toBeGreaterThan(LEAN_4589);
  });

  it("refuses path-1 when supplied handbacks fail panel verification (#3979)", () => {
    const ceiling = 5918176420;
    const panelDeposit: ThreadComment = {
      id: ceiling,
      body:
        "model: grok-4.5\nrole: parent\n\n" +
        "panel-deposit\n" +
        "round: 1\n" +
        "siblings: 1\n" +
        `input-ceiling: ${String(ceiling)}\n` +
        "families: grok\n",
    };
    const live: ThreadComment[] = [
      stop1("pain: P1\n"),
      relievesLean(LEAN_4590),
      criticAfter(LEAN_4590 + 1, "pain-P1"),
      panelDeposit,
    ];
    const withoutGate = evaluateAutoStampPath1Write({
      comments: live,
      issueNumber: 3979,
      plainEnglishSummary: PATH1_SUMMARY,
    });
    expect(withoutGate.writePath1).toBe(true);

    const withFailedHandback = evaluateAutoStampPath1Write({
      comments: live,
      issueNumber: 3979,
      plainEnglishSummary: PATH1_SUMMARY,
      handbacks: [
        {
          seatId: "grok",
          hostSuccess: true,
          claimedCommentId: 5470572756,
          toolCallCount: 0,
        },
      ],
    });
    expect(withFailedHandback.panelDelivery).not.toBeNull();
    expect(withFailedHandback.panelDelivery?.dispatchFailedSeatIds).toContain("grok");
    expect(withFailedHandback.writePath1).toBe(false);
    expect(withFailedHandback.writeIngestReadyRemainingSet).toBe(false);
  });
});

describe("path-1 plain-English summary (#5415)", () => {
  it("publishes missing-plain-english in the closed reason set", () => {
    expect(COMPLETED_ARC_BLOCK_REASONS).toContain("missing-plain-english");
  });

  it("succeeds when parent supplies a valid non-empty summary", () => {
    const live: ThreadComment[] = [
      stop1("pain: P1\n"),
      relievesLean(LEAN_4590),
      criticAfter(LEAN_4590 + 1, "pain-P1"),
    ];
    const verdict = evaluateAutoStampPath1Write({
      comments: live,
      issueNumber: 4590,
      plainEnglishSummary: PATH1_SUMMARY,
    });
    expect(verdict.writePath1).toBe(true);
    expect(verdict.writeIngestReadyRemainingSet).toBe(true);
    expect(verdict.unpublished?.body).toContain("## In plain English");
    expect(verdict.unpublished?.body).toContain(PATH1_SUMMARY);
    expect(verdict.candidate).toMatchObject({ status: "complete", citedLeanId: LEAN_4590 });
  });

  it("refuses both writes when the summary is missing", () => {
    const live: ThreadComment[] = [
      stop1("pain: P1\n"),
      relievesLean(LEAN_4590),
      criticAfter(LEAN_4590 + 1, "pain-P1"),
    ];
    const verdict = evaluateAutoStampPath1Write({
      comments: live,
      issueNumber: 4590,
    });
    expect(verdict.writePath1).toBe(false);
    expect(verdict.writeIngestReadyRemainingSet).toBe(false);
    expect(verdict.candidate).toMatchObject({
      status: "blocked",
      reason: "missing-plain-english",
    });
    const detail = String(verdict.candidate.status === "blocked" ? verdict.candidate.detail : "");
    expect(detail).toContain("path-1 unpublished candidate");
    expect(detail).toContain("repair the candidate summary");
    expect(detail).not.toMatch(/patch named comment id\(s\), then re-evaluate \/ re-chip/);
  });

  it("keeps published lean failure text when path-1 summary is missing", () => {
    const leanNoSummary: ThreadComment = {
      id: LEAN_4590,
      body: "**Lean:** Prefer-A Bound without summary.\n\nrelieves: P1\n",
    };
    const live: ThreadComment[] = [
      stop1("pain: P1\n"),
      leanNoSummary,
      criticAfter(LEAN_4590 + 1, "pain-P1"),
    ];
    const verdict = evaluateAutoStampPath1Write({
      comments: live,
      issueNumber: 4590,
    });
    expect(verdict.writePath1).toBe(false);
    expect(verdict.candidate).toMatchObject({
      status: "blocked",
      reason: "missing-plain-english",
    });
    const detail = String(verdict.candidate.status === "blocked" ? verdict.candidate.detail : "");
    expect(detail).toContain(`cited lean ${String(LEAN_4590)}`);
    expect(detail).toContain("repair the candidate summary");
    expect(detail).toContain("patch named published lean id");
  });

  it("refuses both writes when the summary is whitespace-only", () => {
    const live: ThreadComment[] = [
      stop1("pain: P1\n"),
      relievesLean(LEAN_4590),
      criticAfter(LEAN_4590 + 1, "pain-P1"),
    ];
    const verdict = evaluateAutoStampPath1Write({
      comments: live,
      issueNumber: 4590,
      plainEnglishSummary: "   \n\t  ",
    });
    expect(verdict.writePath1).toBe(false);
    expect(verdict.writeIngestReadyRemainingSet).toBe(false);
    expect(verdict.candidate).toMatchObject({
      status: "blocked",
      reason: "missing-plain-english",
    });
  });

  it("succeeds after a corrected candidate summary", () => {
    const live: ThreadComment[] = [
      stop1("pain: P1\n"),
      relievesLean(LEAN_4590),
      criticAfter(LEAN_4590 + 1, "pain-P1"),
    ];
    const missing = evaluateAutoStampPath1Write({
      comments: live,
      issueNumber: 4590,
      plainEnglishSummary: "",
    });
    expect(missing.writePath1).toBe(false);
    const corrected = evaluateAutoStampPath1Write({
      comments: live,
      issueNumber: 4590,
      plainEnglishSummary: PATH1_SUMMARY,
    });
    expect(corrected.writePath1).toBe(true);
    expect(corrected.writeIngestReadyRemainingSet).toBe(true);
    expect(corrected.candidate).toMatchObject({ status: "complete" });
  });

  it("returns ok:false when leanCiteOnlyPath1Body is called with an empty summary", () => {
    expect(leanCiteOnlyPath1Body(LEAN_4589, "  ")).toEqual({
      ok: false,
      reason: "empty-plain-english-summary",
    });
  });
});
