import { describe, expect, it } from "vitest";
import { evaluateCompletedArcRecord, type ThreadComment } from "./completed-arc-record.js";
import {
  ARC_MODE_FIELD,
  ARC_RUN_POSTURES,
  arcModeRecordLine,
  DIRECT_POSTING_PATH,
  DIRECT_SESSION_START,
  evaluateDirectDispatch,
  isDispatchShaPin,
  parseOperatorRunPosture,
  pinnedShowCommand,
} from "./run-posture.js";

const LEAN_ID = 5442939496;
const TABLE_ID = 5443106967;
const SYNTHESIS_ID = 5443114746;

describe("parseOperatorRunPosture (#4072)", () => {
  it("resolves arc N yolo direct to direct", () => {
    expect(parseOperatorRunPosture("arc 1234 yolo direct")).toEqual({
      kind: "resolved",
      posture: "direct",
    });
  });

  it("resolves forge-only and github-only closed synonyms", () => {
    expect(parseOperatorRunPosture("arc 4066 yolo on github only")).toEqual({
      kind: "resolved",
      posture: "direct",
    });
    expect(parseOperatorRunPosture("arc 1 github-only")).toEqual({
      kind: "resolved",
      posture: "direct",
    });
    expect(parseOperatorRunPosture("arc 1 forge-only")).toEqual({
      kind: "resolved",
      posture: "direct",
    });
    expect(parseOperatorRunPosture("arc 1 no worktrees")).toEqual({
      kind: "resolved",
      posture: "direct",
    });
  });

  it("does not match direct inside directive or directly", () => {
    expect(parseOperatorRunPosture("arc 1 yolo on the directive repo")).toEqual({
      kind: "ask",
      reason: "missing-token",
    });
    expect(parseOperatorRunPosture("please run this directly")).toEqual({
      kind: "ask",
      reason: "missing-token",
    });
  });

  it("asks when yolo has no posture token", () => {
    expect(parseOperatorRunPosture("arc 1234 yolo")).toEqual({
      kind: "ask",
      reason: "missing-token",
    });
    expect(parseOperatorRunPosture("arc 1234")).toEqual({
      kind: "ask",
      reason: "missing-token",
    });
  });

  it("does not treat ingest as a front-door mode", () => {
    expect(parseOperatorRunPosture("arc 1234 yolo ingest")).toEqual({
      kind: "ask",
      reason: "ingest-is-not-posture",
    });
  });

  it("asks when closed tokens collide", () => {
    expect(parseOperatorRunPosture("arc 1 direct checkout")).toEqual({
      kind: "ask",
      reason: "ambiguous",
    });
    expect(parseOperatorRunPosture("arc 1 direct ingest")).toEqual({
      kind: "ask",
      reason: "ambiguous",
    });
  });

  it("resolves checkout as the mutating run posture, not ingest", () => {
    expect(parseOperatorRunPosture("arc 1234 checkout")).toEqual({
      kind: "resolved",
      posture: "checkout",
    });
    expect(arcModeRecordLine("checkout")).toBe("arc-mode: checkout");
    expect(arcModeRecordLine("direct")).toBe("arc-mode: direct");
    expect(ARC_RUN_POSTURES).not.toContain("ingest");
    expect(ARC_MODE_FIELD).toBe("arc-mode:");
  });
});

describe("evaluateDirectDispatch (#4072)", () => {
  it("accepts read-only GitHub comments and SHA-pinned reads with no claim, worktree, or ingest", () => {
    expect(
      evaluateDirectDispatch({
        posture: "direct",
        occupancyClaimed: false,
        worktreeAdd: false,
        issueIngest: false,
        sessionPosture: "read-only",
      }),
    ).toEqual({ ok: true });
    expect(DIRECT_SESSION_START).toBe("session:start --read-only");
    expect(DIRECT_POSTING_PATH).toBe("gh issue comment --body-file -");
    expect(pinnedShowCommand("fec1d758")).toBe("git show fec1d758:");
    expect(isDispatchShaPin("fec1d758")).toBe(true);
    expect(isDispatchShaPin("origin/master")).toBe(false);
    expect(() => pinnedShowCommand("origin/master")).toThrow(/hex pin/);
  });

  it("refuses occupancy claim, worktree add, ingest, and mutation start on direct", () => {
    const result = evaluateDirectDispatch({
      posture: "direct",
      occupancyClaimed: true,
      worktreeAdd: true,
      issueIngest: true,
      sessionPosture: "mutation",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toEqual([
      "occupancy-claim",
      "worktree-add",
      "issue-ingest",
      "mutation-session-start",
    ]);
  });

  it("does not apply direct prohibitions to checkout posture", () => {
    expect(
      evaluateDirectDispatch({
        posture: "checkout",
        occupancyClaimed: true,
        worktreeAdd: true,
        issueIngest: false,
        sessionPosture: "mutation",
      }),
    ).toEqual({ ok: true });
  });
});

describe("completed-arc record ignores arc-mode (#4072)", () => {
  it("still completes when the synthesis carries arc-mode: direct", () => {
    const lean: ThreadComment = {
      id: LEAN_ID,
      body: "**Lean:** operator amend of 5442883752. Chips stay convenience.\n",
    };
    const table: ThreadComment = {
      id: TABLE_ID,
      body: "## Verified-claims table\n\n| Verified claim | Result |\n",
    };
    const synthesis: ThreadComment = {
      id: SYNTHESIS_ID,
      body:
        "model: grok-4.6\nrole: parent\n\n" +
        "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n" +
        `Bound contract: successor lean ${LEAN_ID}, confirmed by operator, verified-claims table ${TABLE_ID}.\n` +
        "arc-mode: direct\n",
    };
    expect(evaluateCompletedArcRecord({ comments: [lean, table, synthesis] })).toEqual({
      status: "complete",
      synthesisCommentId: SYNTHESIS_ID,
      citedLeanId: LEAN_ID,
      citedTableId: TABLE_ID,
    });
  });
});
