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

function stop1(painLine: string, id = STOP1_ID): ThreadComment {
  return {
    id,
    body:
      "model: grok-4.6\nrole: triage\n\n" +
      "design-critique: warranted, because leftover stamp.\n\n" +
      painLine,
  };
}

function specPathLean(id: number, extra = ""): ThreadComment {
  return {
    id,
    body: `**Lean:** recut.\n\nSpec-path: next-build contract is not this body.\n${extra}`,
  };
}

function relievesLean(id: number): ThreadComment {
  return {
    id,
    body: "**Lean:** recut.\n\nSpec-path: next-build contract is not this body.\n\nrelieves: P1\n",
  };
}

function criticAfter(id: number, targets: string): ThreadComment {
  return {
    id,
    body: `model: grok-4.6\nrole: critic\n\naudit-targets: ${targets}\n`,
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
    const body = leanCiteOnlyPath1Body(LEAN_4589);
    expect(body).toContain("design-critique: synthesis accepted, because");
    expect(body).toContain(`successor lean ${String(LEAN_4589)}`);
    expect(body).not.toMatch(/verified-claims table/i);
  });

  it("refuses #4589 uncited Spec-path as unrelieved-pain and skips remaining-set", () => {
    const live: ThreadComment[] = [stop1("pain: P1\n"), specPathLean(LEAN_4589)];
    const liveThread = evaluateCompletedArcRecord({ comments: live, issueNumber: 4589 });
    expect(liveThread).toMatchObject({ status: "blocked", reason: "missing-record" });

    const verdict = evaluateAutoStampPath1Write({ comments: live, issueNumber: 4589 });
    expect(verdict.writePath1).toBe(false);
    expect(verdict.writeIngestReadyRemainingSet).toBe(false);
    expect(verdict.unpublished?.body).toBe(leanCiteOnlyPath1Body(LEAN_4589));
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

    const verdict = evaluateAutoStampPath1Write({ comments: live, issueNumber: 4590 });
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
    const verdict = evaluateAutoStampPath1Write({ comments: live, issueNumber: 4590 });
    expect(verdict.writePath1).toBe(false);
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
    const verdict = evaluateAutoStampPath1Write({ comments: live, issueNumber: 4590 });
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
    });
    expect(missing.writePath1).toBe(false);
    expect(missing.writeIngestReadyRemainingSet).toBe(false);
    expect(missing.candidate).toMatchObject({ status: "blocked", reason: "missing-pain" });

    const malformed = evaluateAutoStampPath1Write({
      comments: [stop1("pain: P1 extra\n"), specPathLean(LEAN_4589)],
      issueNumber: 4589,
    });
    expect(malformed.writePath1).toBe(false);
    expect(malformed.writeIngestReadyRemainingSet).toBe(false);
    expect(malformed.candidate).toMatchObject({ status: "blocked", reason: "malformed-pain" });
  });

  it("does not use a table-citing unpublished body that would skip pain", () => {
    const live: ThreadComment[] = [stop1("pain: P1\n"), specPathLean(LEAN_4589)];
    const verdict = evaluateAutoStampPath1Write({ comments: live, issueNumber: 4589 });
    expect(verdict.unpublished?.body ?? "").not.toMatch(/verified-claims table \d+/i);
    const tableCiting: ThreadComment = {
      id: LEAN_4589 + 10,
      body: `${leanCiteOnlyPath1Body(LEAN_4589)}verified-claims table 9999999999.\n`,
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
    });
    expect(refused.writeIngestReadyRemainingSet).toBe(false);
  });

  it("refuses when dest cannot be constructed because no successor lean is present", () => {
    const verdict = evaluateAutoStampPath1Write({ comments: [stop1("pain: P1\n")] });
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
    });
    expect(verdict.unpublished?.id).toBe(unpublishedId);
    expect(verdict.candidate).toMatchObject({ status: "blocked", reason: "unrelieved-pain" });
    const tooEarly = evaluateAutoStampPath1Write({
      comments: live,
      issueNumber: 4589,
      unpublishedCommentId: LEAN_4589,
    });
    expect(tooEarly.unpublished?.id).toBeGreaterThan(LEAN_4589);
  });
});
