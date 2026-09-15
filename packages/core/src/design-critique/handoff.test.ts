/**
 * Parent-class Handoff fixtures (#4531).
 *
 * open-question: is Spec-path-class wrapping, not a successor-lean classifier.
 * Print condition is not residualHeadingCount / Retry.
 */
import { describe, expect, it } from "vitest";
import { leanCarriesSpecPathToken } from "./auto-stamp-chip.js";
import { COMPLETED_ARC_BLOCK_REASONS, isSuccessorLeanBody } from "./completed-arc-record.js";
import {
  evaluateDualStopReservedSlot,
  evaluateHandoffPrint,
  extractOperativeOpenQuestion,
  handoffOpensSuccessorLeanToken,
  hasOperativeOpenQuestionLine,
  isParentHandoffBody,
  openQuestionClassifiesAsSuccessorLean,
  postHandoffStop1Writeback,
} from "./handoff.js";

const OPEN_QUESTION_SPELLINGS = [
  "open-question:",
  "*open-question:",
  "**open-question:",
  "open-question:*",
  "open-question:**",
  "*open-question:*",
  "*open-question:**",
  "**open-question:*",
  "**open-question:**",
] as const;

const HANDOFF_BODY = "model: grok-4.6\nrole: parent\n\nopen-question: where does the dwell live?\n";

const UNRELIEVED_RECUT_MAP = "**Lean:** all-accept recut.\n\nSpec-path:\n\ndoes-not-relieve: P1\n";

describe("open-question reserved line-start (#4531)", () => {
  it("detects Spec-path-class wrapping in all nine spellings", () => {
    for (const spelling of OPEN_QUESTION_SPELLINGS) {
      const body = `model: grok-4.6\nrole: parent\n\n${spelling} where does the dwell live?\n`;
      expect(hasOperativeOpenQuestionLine(body), spelling).toBe(true);
      expect(extractOperativeOpenQuestion(body), spelling).toBe("where does the dwell live?");
    }
  });

  it("does not count fence or quote", () => {
    const fenced = "role: parent\n\n```\nopen-question: where does the dwell live?\n```\n";
    const quoted = "role: parent\n\n> open-question: where does the dwell live?\n";
    expect(hasOperativeOpenQuestionLine(fenced)).toBe(false);
    expect(hasOperativeOpenQuestionLine(quoted)).toBe(false);
    expect(extractOperativeOpenQuestion(fenced)).toBeNull();
    expect(extractOperativeOpenQuestion(quoted)).toBeNull();
  });

  it("is not a successor-lean classifier and is not Spec-path", () => {
    expect(isSuccessorLeanBody(HANDOFF_BODY)).toBe(false);
    expect(openQuestionClassifiesAsSuccessorLean(HANDOFF_BODY)).toBe(false);
    expect(leanCarriesSpecPathToken(HANDOFF_BODY)).toBe(false);
    expect(isParentHandoffBody(HANDOFF_BODY)).toBe(true);
    expect(handoffOpensSuccessorLeanToken(HANDOFF_BODY)).toBe(false);
  });

  it("reclassifies when the handoff also opens a successor-lean token", () => {
    const withLean = `${HANDOFF_BODY}\n**Lean:** must not.\n`;
    expect(handoffOpensSuccessorLeanToken(withLean)).toBe(true);
    expect(isSuccessorLeanBody(withLean)).toBe(true);
  });

  it("does not treat audit-targets as the open-question field", () => {
    const auditOnly = "role: parent\n\naudit-targets: pain-P1\n";
    expect(hasOperativeOpenQuestionLine(auditOnly)).toBe(false);
    expect(extractOperativeOpenQuestion(auditOnly)).toBeNull();
  });
});

describe("evaluateHandoffPrint (#4531)", () => {
  it("prints on the measured all-accept does-not-relieve Spec-path shape", () => {
    const verdict = evaluateHandoffPrint({
      mapBody: UNRELIEVED_RECUT_MAP,
      stop1PainIds: ["P1"],
      dualStopCapSpent: true,
    });
    expect(verdict).toEqual({
      print: true,
      unrelievedPain: true,
      recutConjunct: true,
      harvestRelievesOverlap: false,
    });
  });

  it("prints on uncited pain plus Recut, and on supersedes without Spec-path", () => {
    const uncitedRecut = evaluateHandoffPrint({
      mapBody: "**Lean:** leftover.\n\n**Recut:**\n",
      stop1PainIds: ["P1"],
    });
    expect(uncitedRecut.print).toBe(true);

    const priorLean = { id: 5669015941, body: "**Lean:** prior take.\n" };
    const supersedes = evaluateHandoffPrint({
      mapBody: "**Lean:** recut.\n\nSupersedes 5669015941.\n\ndoes-not-relieve: P1\n",
      stop1PainIds: ["P1"],
      comments: [priorLean],
    });
    expect(supersedes.print).toBe(true);
    expect(supersedes.recutConjunct).toBe(true);

    const missing = evaluateHandoffPrint({
      mapBody: "**Lean:** recut.\n\nSupersedes 5669015941.\n\ndoes-not-relieve: P1\n",
      stop1PainIds: ["P1"],
    });
    expect(missing.print).toBe(false);
    expect(missing.recutConjunct).toBe(false);

    const notLean = evaluateHandoffPrint({
      mapBody: "**Lean:** recut.\n\nSupersedes 5669015941.\n\ndoes-not-relieve: P1\n",
      stop1PainIds: ["P1"],
      comments: [{ id: 5669015941, body: "role: parent\n\nWalk note.\n" }],
    });
    expect(notLean.print).toBe(false);
    expect(notLean.recutConjunct).toBe(false);
  });

  it("does not print without the pain conjunct or without the recut conjunct", () => {
    const noPain = evaluateHandoffPrint({
      mapBody: "**Lean:** bind.\n\nSpec-path:\n\nrelieves: P1\n",
      stop1PainIds: ["P1"],
    });
    expect(noPain.print).toBe(false);
    expect(noPain.unrelievedPain).toBe(false);

    const noRecut = evaluateHandoffPrint({
      mapBody: "**Lean:** leftover.\n\ndoes-not-relieve: P1\n",
      stop1PainIds: ["P1"],
    });
    expect(noRecut.print).toBe(false);
    expect(noRecut.recutConjunct).toBe(false);
  });

  it("skips fenced supersedes and empty open-question capture", () => {
    expect(extractOperativeOpenQuestion("role: parent\n\nopen-question:\n")).toBe("");
    const fencedSupersedes = evaluateHandoffPrint({
      mapBody: "**Lean:** leftover.\n\n```\nSupersedes 5669015941.\n```\n\ndoes-not-relieve: P1\n",
      stop1PainIds: ["P1"],
    });
    expect(fencedSupersedes.recutConjunct).toBe(false);
    expect(fencedSupersedes.print).toBe(false);
  });

  it("does not treat a fenced Spec-path example as the recut conjunct", () => {
    const fenced = evaluateHandoffPrint({
      mapBody: "**Lean:** leftover.\n\n```\nSpec-path:\n```\n\ndoes-not-relieve: P1\n",
      stop1PainIds: ["P1"],
    });
    expect(fenced.print).toBe(false);
    expect(fenced.recutConjunct).toBe(false);
  });
});

describe("evaluateHandoffPrint harvest relieves overlap (#4554)", () => {
  const priorRelieves = {
    id: 5672497879,
    body: "**Lean:** first relieves.\n\nrelieves: P1\n",
  };
  const writeBack = {
    id: 5672420866,
    body: "role: parent\n\ndesign-critique: warranted, because leftover.\n",
  };
  const priorDoesNotRelieve = {
    id: 5669885896,
    body: "**Lean:** unrelieved.\n\nSpec-path:\n\ndoes-not-relieve: P1\n",
  };

  it("prints when current relieves Recut-supersedes a prior successor map that relieves the same P*", () => {
    const harvest = evaluateHandoffPrint({
      mapBody: "**Lean:** harvest recut.\n\nSpec-path:\n\nrelieves: P1\n\nSupersedes 5672497879.\n",
      stop1PainIds: ["P1"],
      comments: [priorRelieves],
    });
    expect(harvest).toEqual({
      print: true,
      unrelievedPain: false,
      recutConjunct: true,
      harvestRelievesOverlap: true,
    });
  });

  it("does not print on first relieves that supersedes a write-back", () => {
    const first = evaluateHandoffPrint({
      mapBody:
        "**Lean:** first relieves.\n\nSpec-path:\n\nrelieves: P1\n\nSupersedes 5672420866.\n",
      stop1PainIds: ["P1"],
      comments: [writeBack],
    });
    expect(first.print).toBe(false);
    expect(first.unrelievedPain).toBe(false);
    expect(first.recutConjunct).toBe(true);
    expect(first.harvestRelievesOverlap).toBe(false);
  });

  it("does not print on relieves after a does-not-relieve map", () => {
    const after = evaluateHandoffPrint({
      mapBody:
        "**Lean:** relieves after unrelieved.\n\nSpec-path:\n\nrelieves: P1\n\nSupersedes 5669885896.\n",
      stop1PainIds: ["P1"],
      comments: [priorDoesNotRelieve],
    });
    expect(after.print).toBe(false);
    expect(after.harvestRelievesOverlap).toBe(false);
  });

  it("does not print when current relieves a different P* than the superseded map", () => {
    const different = evaluateHandoffPrint({
      mapBody: "**Lean:** harvest P2.\n\nSpec-path:\n\nrelieves: P2\n\nSupersedes 5672497879.\n",
      stop1PainIds: ["P2"],
      comments: [priorRelieves],
    });
    expect(different.print).toBe(false);
    expect(different.unrelievedPain).toBe(false);
    expect(different.harvestRelievesOverlap).toBe(false);
  });

  it("does not scrape class tokens as a print input", () => {
    const scrape = evaluateHandoffPrint({
      mapBody:
        "**Lean:** first relieves.\n\nSpec-path:\n\nrelieves: P1\n\nsharpens-framing\nblocks-the-design\n\nSupersedes 5672420866.\n",
      stop1PainIds: ["P1"],
      comments: [writeBack],
    });
    expect(scrape.print).toBe(false);
    expect(scrape.harvestRelievesOverlap).toBe(false);
  });

  it("does not print when the current map is not a successor lean", () => {
    const writeBack = evaluateHandoffPrint({
      mapBody: "role: parent\n\nrelieves: P1\n\nSupersedes 5672497879.\n",
      stop1PainIds: ["P1"],
      comments: [priorRelieves],
    });
    expect(writeBack.print).toBe(false);
    expect(writeBack.harvestRelievesOverlap).toBe(false);
  });

  it("does not print when overlap is only an undeclared pain id", () => {
    const undeclared = evaluateHandoffPrint({
      mapBody: "**Lean:** harvest recut.\n\nSpec-path:\n\nrelieves: P1\nrelieves: P9\n\nSupersedes 5672497879.\n",
      stop1PainIds: ["P1"],
      comments: [{ id: 5672497879, body: "**Lean:** prior.\n\nrelieves: P9\n" }],
    });
    expect(undeclared.print).toBe(false);
    expect(undeclared.harvestRelievesOverlap).toBe(false);
  });

  it("keeps dest unrelieved print and ORs harvest overlap", () => {
    const unrelieved = evaluateHandoffPrint({
      mapBody: UNRELIEVED_RECUT_MAP,
      stop1PainIds: ["P1"],
    });
    expect(unrelieved.print).toBe(true);
    expect(unrelieved.unrelievedPain).toBe(true);
    expect(unrelieved.harvestRelievesOverlap).toBe(false);
  });
});

describe("evaluateDualStopReservedSlot (#4531)", () => {
  it("is not always-on +1 on the N=1 default of two posts", () => {
    const beforeCap = evaluateDualStopReservedSlot({
      numberedCap: 2,
      criticPostsUsed: 1,
      mapCarriesOperativeRelieves: true,
      reservedPainAuditPostsUsed: 0,
      operatorRaisedCap: false,
    });
    expect(beforeCap).toEqual({ inCapWithoutRaise: false, needsRaise: false });
  });

  it("admits one in-cap pain-audit when cap is spent and the map carries relieves", () => {
    const first = evaluateDualStopReservedSlot({
      numberedCap: 3,
      criticPostsUsed: 3,
      mapCarriesOperativeRelieves: true,
      reservedPainAuditPostsUsed: 0,
      operatorRaisedCap: false,
    });
    expect(first).toEqual({ inCapWithoutRaise: true, needsRaise: false });

    const second = evaluateDualStopReservedSlot({
      numberedCap: 3,
      criticPostsUsed: 3,
      mapCarriesOperativeRelieves: true,
      reservedPainAuditPostsUsed: 1,
      operatorRaisedCap: false,
    });
    expect(second).toEqual({ inCapWithoutRaise: false, needsRaise: true });
  });

  it("needs a raise when the numbered cap is spent without relieves", () => {
    const spent = evaluateDualStopReservedSlot({
      numberedCap: 2,
      criticPostsUsed: 2,
      mapCarriesOperativeRelieves: false,
      reservedPainAuditPostsUsed: 0,
      operatorRaisedCap: false,
    });
    expect(spent).toEqual({ inCapWithoutRaise: false, needsRaise: true });
    const raised = evaluateDualStopReservedSlot({
      numberedCap: 2,
      criticPostsUsed: 2,
      mapCarriesOperativeRelieves: true,
      reservedPainAuditPostsUsed: 1,
      operatorRaisedCap: true,
    });
    expect(raised).toEqual({ inCapWithoutRaise: false, needsRaise: false });
  });
});

describe("postHandoffStop1Writeback (#4531)", () => {
  it("records open critique and omits refutation-target after Handoff", () => {
    expect(
      postHandoffStop1Writeback({ afterHandoff: true, bodyWouldSelectRefutation: true }),
    ).toEqual({ charter: "open critique", recordRefutationTarget: false });
  });

  it("does not re-select from the body on a post-handoff write-back", () => {
    const withoutHandoff = postHandoffStop1Writeback({
      afterHandoff: false,
      bodyWouldSelectRefutation: true,
    });
    expect(withoutHandoff).toEqual({ charter: "refutation", recordRefutationTarget: true });
  });

  it("keeps open critique when the body would not select refutation", () => {
    expect(
      postHandoffStop1Writeback({ afterHandoff: false, bodyWouldSelectRefutation: false }),
    ).toEqual({ charter: "open critique", recordRefutationTarget: true });
  });
});

describe("evaluateCompletedArcRecord stays free of reframe-needed (#4531)", () => {
  it("does not add reframe-needed to the closed reason set", () => {
    expect(COMPLETED_ARC_BLOCK_REASONS).not.toContain("reframe-needed");
  });
});
