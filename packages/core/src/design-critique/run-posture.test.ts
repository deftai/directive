import { describe, expect, it } from "vitest";
import { evaluateCompletedArcRecord, type ThreadComment } from "./completed-arc-record.js";
import {
  ARC_MODE_FIELD,
  ARC_RUN_POSTURES,
  arcModeRecordLine,
  CHECKOUT_RUN_POSTURE_TOKENS,
  DIRECT_POSTING_PATH,
  DIRECT_RUN_POSTURE_TOKENS,
  DIRECT_SESSION_START,
  evaluateDirectDispatch,
  isDispatchShaPin,
  NO_INGEST_ARC_MODE,
  parseOperatorRunPosture,
  pinnedShowCommand,
  resolveArcRunPostureForHost,
} from "./run-posture.js";

const LEAN_ID = 5442939496;
const TABLE_ID = 5443106967;
const SYNTHESIS_ID = 5443114746;

describe("parseOperatorRunPosture (#4072 / #4296)", () => {
  it("resolves arc N yolo direct to no-ingest", () => {
    expect(parseOperatorRunPosture("arc 1234 yolo direct")).toEqual({
      kind: "resolved",
      posture: "no-ingest",
    });
  });

  it("resolves forge-only and github-only closed synonyms to no-ingest", () => {
    expect(parseOperatorRunPosture("arc 4066 yolo on github only")).toEqual({
      kind: "resolved",
      posture: "no-ingest",
    });
    expect(parseOperatorRunPosture("arc 1 github-only")).toEqual({
      kind: "resolved",
      posture: "no-ingest",
    });
    expect(parseOperatorRunPosture("arc 1 forge-only")).toEqual({
      kind: "resolved",
      posture: "no-ingest",
    });
    expect(parseOperatorRunPosture("arc 1 no worktrees")).toEqual({
      kind: "resolved",
      posture: "no-ingest",
    });
    expect(parseOperatorRunPosture("arc 1 no-ingest")).toEqual({
      kind: "resolved",
      posture: "no-ingest",
    });
    expect(parseOperatorRunPosture("arc 1 no ingest")).toEqual({
      kind: "resolved",
      posture: "no-ingest",
    });
  });

  it("does not match direct inside directive", () => {
    expect(parseOperatorRunPosture("arc 1 yolo on the directive repo")).toEqual({
      kind: "ask",
      reason: "missing-token",
    });
  });

  it("resolves please run this directly to no-ingest", () => {
    expect(parseOperatorRunPosture("please run this directly")).toEqual({
      kind: "resolved",
      posture: "no-ingest",
    });
  });

  it("resolves on github as a location synonym, including extra matches", () => {
    expect(parseOperatorRunPosture("arc 4219 yolo on github")).toEqual({
      kind: "resolved",
      posture: "no-ingest",
    });
    expect(parseOperatorRunPosture("file an issue on github")).toEqual({
      kind: "resolved",
      posture: "no-ingest",
    });
    expect(parseOperatorRunPosture("the comments live on github")).toEqual({
      kind: "resolved",
      posture: "no-ingest",
    });
  });

  it("keeps DIRECT_RUN_POSTURE_TOKENS twins with the matcher", () => {
    for (const token of DIRECT_RUN_POSTURE_TOKENS) {
      expect(parseOperatorRunPosture(token)).toEqual({
        kind: "resolved",
        posture: "no-ingest",
      });
    }
  });

  it("returns missing-token when yolo has no posture token", () => {
    expect(parseOperatorRunPosture("arc 1234 yolo")).toEqual({
      kind: "ask",
      reason: "missing-token",
    });
    expect(parseOperatorRunPosture("arc 1234")).toEqual({
      kind: "ask",
      reason: "missing-token",
    });
  });

  it("resolves bare ingest to checkout posture only", () => {
    expect(parseOperatorRunPosture("arc 1234 yolo ingest")).toEqual({
      kind: "resolved",
      posture: "checkout",
    });
    expect(parseOperatorRunPosture("arc 5111 ingest")).toEqual({
      kind: "resolved",
      posture: "checkout",
    });
    expect(arcModeRecordLine("checkout")).toBe("arc-mode: checkout");
    expect(arcModeRecordLine("checkout")).not.toContain("ingest");
  });

  it("resolves negated ingest to no-ingest, not checkout", () => {
    expect(parseOperatorRunPosture("arc 1234 do not ingest")).toEqual({
      kind: "resolved",
      posture: "no-ingest",
    });
    expect(parseOperatorRunPosture("arc 1234 don't ingest")).toEqual({
      kind: "resolved",
      posture: "no-ingest",
    });
    expect(parseOperatorRunPosture("arc 1234 dont ingest")).toEqual({
      kind: "resolved",
      posture: "no-ingest",
    });
    expect(parseOperatorRunPosture("arc 1234 does not ingest")).toEqual({
      kind: "resolved",
      posture: "no-ingest",
    });
    expect(parseOperatorRunPosture("arc 1234 never ingest")).toEqual({
      kind: "resolved",
      posture: "no-ingest",
    });
    expect(parseOperatorRunPosture("arc 1234 not ingest")).toEqual({
      kind: "resolved",
      posture: "no-ingest",
    });
    expect(
      resolveArcRunPostureForHost({
        utterance: "arc 1234 do not ingest",
        grokBotDetected: false,
      }),
    ).toEqual({ kind: "resolved", posture: "no-ingest" });
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

  it("resolves checkout as the mutating run posture; never arc-mode ingest", () => {
    expect(parseOperatorRunPosture("arc 1234 checkout")).toEqual({
      kind: "resolved",
      posture: "checkout",
    });
    expect(arcModeRecordLine("checkout")).toBe("arc-mode: checkout");
    expect(arcModeRecordLine(NO_INGEST_ARC_MODE)).toBe(`arc-mode: ${NO_INGEST_ARC_MODE}`);
    expect(NO_INGEST_ARC_MODE).toBe("no-ingest");
    expect(ARC_RUN_POSTURES).not.toContain("ingest");
    expect(ARC_RUN_POSTURES).not.toContain("direct");
    expect(CHECKOUT_RUN_POSTURE_TOKENS).toContain("ingest");
    expect(ARC_MODE_FIELD).toBe("arc-mode:");
  });
});

describe("resolveArcRunPostureForHost (#4202 / #5111)", () => {
  it("defaults missing-token to no-ingest for all hosts", () => {
    expect(
      resolveArcRunPostureForHost({ utterance: "run an arc on #286", grokBotDetected: true }),
    ).toEqual({ kind: "resolved", posture: "no-ingest" });
    expect(
      resolveArcRunPostureForHost({ utterance: "run an arc on #286", grokBotDetected: false }),
    ).toEqual({ kind: "resolved", posture: "no-ingest" });
    expect(
      resolveArcRunPostureForHost({ utterance: "arc 1234 yolo", grokBotDetected: false }),
    ).toEqual({ kind: "resolved", posture: "no-ingest" });
  });

  it("lets checkout and ingest tokens win over the no-ingest default", () => {
    expect(
      resolveArcRunPostureForHost({ utterance: "arc 1234 checkout", grokBotDetected: true }),
    ).toEqual({ kind: "resolved", posture: "checkout" });
    expect(
      resolveArcRunPostureForHost({ utterance: "arc 1234 ingest", grokBotDetected: false }),
    ).toEqual({ kind: "resolved", posture: "checkout" });
  });

  it("still asks on ambiguous mixes", () => {
    expect(
      resolveArcRunPostureForHost({ utterance: "arc 1 direct ingest", grokBotDetected: false }),
    ).toEqual({ kind: "ask", reason: "ambiguous" });
  });
});
describe("evaluateDirectDispatch (#4072 / #4296)", () => {
  it("accepts read-only GitHub comments, dest worktree, and SHA-pinned reads when parent is unclaimed", () => {
    expect(
      evaluateDirectDispatch({
        posture: "no-ingest",
        occupancyClaimed: false,
        worktreeAdd: true,
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

  it("refuses occupancy claim, ingest, and mutation start; dest worktree is not a violation", () => {
    const result = evaluateDirectDispatch({
      posture: "no-ingest",
      occupancyClaimed: true,
      worktreeAdd: true,
      issueIngest: true,
      sessionPosture: "mutation",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toEqual([
      "occupancy-claim",
      "issue-ingest",
      "mutation-session-start",
    ]);
    expect(result.violations).not.toContain("worktree-add");
  });

  it("keeps parent-unclaimed as its own MUST when dest is created", () => {
    const result = evaluateDirectDispatch({
      posture: "no-ingest",
      occupancyClaimed: true,
      worktreeAdd: true,
      issueIngest: false,
      sessionPosture: "read-only",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toEqual(["occupancy-claim"]);
  });

  it("does not apply no-ingest prohibitions to checkout posture", () => {
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
  it("still completes when the synthesis carries arc-mode: no-ingest", () => {
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
        "arc-mode: no-ingest\n",
    };
    expect(evaluateCompletedArcRecord({ comments: [lean, table, synthesis] })).toEqual({
      status: "complete",
      synthesisCommentId: SYNTHESIS_ID,
      citedLeanId: LEAN_ID,
      citedTableId: TABLE_ID,
    });
  });
});
