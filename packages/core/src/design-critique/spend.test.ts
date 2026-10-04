import { describe, expect, it } from "vitest";
import { dualStopSpendSeats, evaluateDualStopPostBudget } from "./leftover-pain.js";
import { resolveArcRunPostureForHost } from "./run-posture.js";
import {
  ARC_SPENDS,
  evaluateHostMemorySpendConflict,
  evaluateSpendRecord,
  HOST_MEMORY_CONFLICT_DISCLOSURE_PREFIX,
  HOST_MEMORY_EXTERNAL_CONTEXT_FAMILY,
  hostMemoryHasPersonalAuthority,
  N1_SPEND,
  N3_SPEND,
  parseOperatorSpend,
  parseSpendRecommend,
  SPEND_ASK_FIELD,
  SPEND_ASK_REMEDIATION,
  SPEND_FIELD,
  SPEND_RECOMMEND_FIELD,
  spendAskRecordLine,
  spendRecommendRecordLine,
  spendRecordLine,
} from "./spend.js";

describe("parseOperatorSpend (#4705)", () => {
  it("asks missing-token on the measured launching utterance", () => {
    expect(parseOperatorSpend("arc no-ingest yolo 4690")).toEqual({
      kind: "ask",
      reason: "missing-token",
    });
    expect(parseOperatorSpend("arc no-ingest yolo 4690 4692 4697 4698")).toEqual({
      kind: "ask",
      reason: "missing-token",
    });
  });

  it("ignores yolo as a spend token", () => {
    expect(parseOperatorSpend("arc 1234 yolo")).toEqual({
      kind: "ask",
      reason: "missing-token",
    });
    expect(parseOperatorSpend("yolo")).toEqual({
      kind: "ask",
      reason: "missing-token",
    });
  });

  it("resolves n=1 and does not treat each-separately English as n=1", () => {
    expect(parseOperatorSpend("arc 4690 n=1")).toEqual({
      kind: "resolved",
      spend: N1_SPEND,
    });
    expect(parseOperatorSpend("arc 4690 N=1")).toEqual({
      kind: "resolved",
      spend: N1_SPEND,
    });
    expect(parseOperatorSpend("arc 4690 each separately")).toEqual({
      kind: "ask",
      reason: "missing-token",
    });
  });

  it("resolves n=3, n>=3, and unicode n≥3 to N≥3", () => {
    expect(parseOperatorSpend("arc 4690 n=3")).toEqual({
      kind: "resolved",
      spend: N3_SPEND,
    });
    expect(parseOperatorSpend("arc 4690 n>=3")).toEqual({
      kind: "resolved",
      spend: N3_SPEND,
    });
    expect(parseOperatorSpend("arc 4690 n≥3")).toEqual({
      kind: "resolved",
      spend: N3_SPEND,
    });
    expect(parseOperatorSpend("arc 4690 N≥3")).toEqual({
      kind: "resolved",
      spend: N3_SPEND,
    });
  });

  it("maps bare panel to ask, not N≥3", () => {
    expect(parseOperatorSpend("arc 4690 panel")).toEqual({
      kind: "ask",
      reason: "ambiguous",
    });
    expect(parseOperatorSpend("critique panel")).toEqual({
      kind: "ask",
      reason: "ambiguous",
    });
    expect(parseOperatorSpend("do not launch a 3-panel unless the operator asks")).toEqual({
      kind: "ask",
      reason: "ambiguous",
    });
    expect(parseOperatorSpend("record a panel-deposit")).toEqual({
      kind: "ask",
      reason: "ambiguous",
    });
    expect(parseOperatorSpend("not a panel")).toEqual({
      kind: "ask",
      reason: "ambiguous",
    });
  });

  it("asks when both resolved classes hit, including panel-plus-n=1", () => {
    expect(parseOperatorSpend("arc 4690 n=1 n=3")).toEqual({
      kind: "ask",
      reason: "ambiguous",
    });
    expect(parseOperatorSpend("arc 4690 n=1 n>=3")).toEqual({
      kind: "ask",
      reason: "ambiguous",
    });
    expect(parseOperatorSpend("arc 4690 n=1 panel")).toEqual({
      kind: "ask",
      reason: "ambiguous",
    });
    expect(parseOperatorSpend("arc 4690 n=3 panel")).toEqual({
      kind: "ask",
      reason: "ambiguous",
    });
  });

  it("does not match n=1 inside an issue number", () => {
    expect(parseOperatorSpend("arc 4690")).toEqual({
      kind: "ask",
      reason: "missing-token",
    });
  });

  it("rejects decimal continuations and keeps sentence punctuation", () => {
    expect(parseOperatorSpend("arc 4690 n=1.5")).toEqual({
      kind: "ask",
      reason: "missing-token",
    });
    expect(parseOperatorSpend("arc 4690 n=3.5")).toEqual({
      kind: "ask",
      reason: "missing-token",
    });
    expect(parseOperatorSpend("arc 4690 n>=3.5")).toEqual({
      kind: "ask",
      reason: "missing-token",
    });
    expect(parseOperatorSpend("arc 4690 n=1.")).toEqual({
      kind: "resolved",
      spend: N1_SPEND,
    });
    expect(parseOperatorSpend("arc 4690 n=1")).toEqual({
      kind: "resolved",
      spend: N1_SPEND,
    });
  });
});

describe("evaluateSpendRecord (#4705)", () => {
  it("refuses missing-token plus asked false, including Stop 1 spend N=1", () => {
    const parse = parseOperatorSpend("arc no-ingest yolo 4690");
    expect(parse).toEqual({ kind: "ask", reason: "missing-token" });
    expect(
      evaluateSpendRecord({
        parse,
        asked: false,
        answer: null,
        stop1Spend: N1_SPEND,
        spendAsk: null,
      }),
    ).toEqual({
      ok: false,
      reason: "missing-token",
      remediation: SPEND_ASK_REMEDIATION,
    });
    expect(SPEND_ASK_REMEDIATION).toBe("ask before Stop 1");
    expect(SPEND_ASK_REMEDIATION).not.toMatch(/launch a panel/i);
  });

  it("refuses ambiguous plus asked false", () => {
    expect(
      evaluateSpendRecord({
        parse: parseOperatorSpend("arc 4690 n=1 n=3"),
        asked: false,
        answer: null,
        stop1Spend: N1_SPEND,
        spendAsk: null,
      }),
    ).toEqual({
      ok: false,
      reason: "ambiguous",
      remediation: SPEND_ASK_REMEDIATION,
    });
  });

  it("admits N=1 from a resolved n=1 token with spend-ask resolved", () => {
    const parse = parseOperatorSpend("arc 4690 n=1");
    expect(
      evaluateSpendRecord({
        parse,
        asked: false,
        answer: null,
        stop1Spend: N1_SPEND,
        spendAsk: "resolved",
      }),
    ).toEqual({ ok: true, spend: N1_SPEND });
    expect(spendRecordLine(N1_SPEND)).toBe("spend: N=1");
    expect(spendAskRecordLine("resolved")).toBe("spend-ask: resolved");
    expect(SPEND_FIELD).toBe("spend:");
    expect(SPEND_ASK_FIELD).toBe("spend-ask:");
  });

  it("admits N=1 only from a recorded ask-answer after missing-token", () => {
    expect(
      evaluateSpendRecord({
        parse: parseOperatorSpend("arc no-ingest yolo 4690"),
        asked: true,
        answer: N1_SPEND,
        stop1Spend: N1_SPEND,
        spendAsk: "asked",
      }),
    ).toEqual({ ok: true, spend: N1_SPEND });
    expect(spendAskRecordLine("asked")).toBe("spend-ask: asked");
  });

  it("does not treat spend-why English as the asked record", () => {
    expect(
      evaluateSpendRecord({
        parse: parseOperatorSpend("arc no-ingest yolo 4690"),
        asked: true,
        answer: N1_SPEND,
        stop1Spend: N1_SPEND,
        spendAsk: null,
      }),
    ).toEqual({
      ok: false,
      reason: "invalid-ask-record",
      remediation: SPEND_ASK_REMEDIATION,
    });
  });

  it("refuses missing Stop 1 spend and parse mismatch", () => {
    const resolved = parseOperatorSpend("arc 4690 n=1");
    expect(
      evaluateSpendRecord({
        parse: resolved,
        asked: false,
        answer: null,
        stop1Spend: null,
        spendAsk: "resolved",
      }),
    ).toEqual({
      ok: false,
      reason: "missing-spend",
      remediation: SPEND_ASK_REMEDIATION,
    });
    expect(
      evaluateSpendRecord({
        parse: resolved,
        asked: false,
        answer: null,
        stop1Spend: N3_SPEND,
        spendAsk: "resolved",
      }),
    ).toEqual({
      ok: false,
      reason: "mismatch",
      remediation: SPEND_ASK_REMEDIATION,
    });
  });

  it("admits N≥3 from a resolved n=3 token", () => {
    expect(
      evaluateSpendRecord({
        parse: parseOperatorSpend("arc 4690 n=3"),
        asked: false,
        answer: null,
        stop1Spend: N3_SPEND,
        spendAsk: "resolved",
      }),
    ).toEqual({ ok: true, spend: N3_SPEND });
    expect(spendRecordLine(N3_SPEND)).toBe("spend: N≥3");
    expect(ARC_SPENDS).toEqual(["N=1", "N≥3"]);
  });

  it("refuses asked-true missing spend and answer mismatch", () => {
    const parse = parseOperatorSpend("arc no-ingest yolo 4690");
    expect(
      evaluateSpendRecord({
        parse,
        asked: true,
        answer: null,
        stop1Spend: null,
        spendAsk: "asked",
      }),
    ).toEqual({
      ok: false,
      reason: "missing-spend",
      remediation: SPEND_ASK_REMEDIATION,
    });
    expect(
      evaluateSpendRecord({
        parse,
        asked: true,
        answer: N1_SPEND,
        stop1Spend: N3_SPEND,
        spendAsk: "asked",
      }),
    ).toEqual({
      ok: false,
      reason: "mismatch",
      remediation: SPEND_ASK_REMEDIATION,
    });
  });

  it("refuses resolved parse when spend-ask is not resolved", () => {
    expect(
      evaluateSpendRecord({
        parse: parseOperatorSpend("arc 4690 n=1"),
        asked: false,
        answer: null,
        stop1Spend: N1_SPEND,
        spendAsk: "asked",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid-ask-record",
      remediation: SPEND_ASK_REMEDIATION,
    });
  });
});

describe("spend does not copy grok-bot run-posture default (#4705)", () => {
  it("asks missing-token without spend-recommend even when posture defaults", () => {
    const utterance = "arc no-ingest yolo 4690";
    expect(parseOperatorSpend(utterance)).toEqual({
      kind: "ask",
      reason: "missing-token",
    });
    expect(
      resolveArcRunPostureForHost({ utterance: "run an arc on #286", grokBotDetected: false }),
    ).toEqual({ kind: "resolved", posture: "no-ingest" });
    expect(parseOperatorSpend("run an arc on #286")).toEqual({
      kind: "ask",
      reason: "missing-token",
    });
  });
});

describe("spend-recommend closed source (#5111)", () => {
  it("parses closed spend-recommend lines only", () => {
    expect(parseSpendRecommend("spend-recommend: N=1")).toBe(N1_SPEND);
    expect(parseSpendRecommend("spend-recommend: N≥3")).toBe(N3_SPEND);
    expect(parseSpendRecommend("spend-recommend: N>=3")).toBeNull();
    expect(parseSpendRecommend("use recommended n")).toBeNull();
    expect(parseSpendRecommend(null)).toBeNull();
    expect(spendRecommendRecordLine(N1_SPEND)).toBe("spend-recommend: N=1");
    expect(SPEND_RECOMMEND_FIELD).toBe("spend-recommend:");
  });

  it("resolves missing utterance token from spend-recommend without silent N=1", () => {
    expect(parseOperatorSpend("arc no-ingest yolo 4690", { spendRecommend: N1_SPEND })).toEqual({
      kind: "resolved",
      spend: N1_SPEND,
    });
    expect(parseOperatorSpend("arc no-ingest yolo 4690", { spendRecommend: N3_SPEND })).toEqual({
      kind: "resolved",
      spend: N3_SPEND,
    });
    expect(parseOperatorSpend("arc no-ingest yolo 4690")).toEqual({
      kind: "ask",
      reason: "missing-token",
    });
    expect(
      evaluateSpendRecord({
        parse: parseOperatorSpend("arc 5111", { spendRecommend: N3_SPEND }),
        asked: false,
        answer: null,
        stop1Spend: N3_SPEND,
        spendAsk: "resolved",
      }),
    ).toEqual({ ok: true, spend: N3_SPEND });
  });

  it("lets explicit n= tokens override spend-recommend", () => {
    expect(parseOperatorSpend("arc 5111 n=1", { spendRecommend: N3_SPEND })).toEqual({
      kind: "resolved",
      spend: N1_SPEND,
    });
    expect(parseOperatorSpend("arc 5111 n=3", { spendRecommend: N1_SPEND })).toEqual({
      kind: "resolved",
      spend: N3_SPEND,
    });
  });
});

describe("host-memory external-context authority (#5321)", () => {
  it("gives every host-memory provenance zero Personal authority", () => {
    expect(hostMemoryHasPersonalAuthority("unsigned")).toBe(false);
    expect(hostMemoryHasPersonalAuthority("agent-inferred")).toBe(false);
    expect(hostMemoryHasPersonalAuthority(null)).toBe(false);
    expect(hostMemoryHasPersonalAuthority(undefined)).toBe(false);
    // operator-asked is write-consent audit, not USER.md Personal (#5321 F5)
    expect(hostMemoryHasPersonalAuthority("operator-asked")).toBe(false);
  });

  it("lets spend-recommend resolve beat host-memory always-ask with disclosure", () => {
    const verdict = evaluateHostMemorySpendConflict({
      hostMemoryAlwaysAsk: true,
      hostMemoryProvenance: "unsigned",
      utterance: "arc 5318",
      spendRecommend: N1_SPEND,
    });
    expect(verdict.follow).toBe("contract");
    expect(verdict.hostMemoryPersonalAuthority).toBe(false);
    expect(verdict.spendParse).toEqual({ kind: "resolved", spend: N1_SPEND });
    expect(verdict.spendAsk).toBe("resolved");
    expect(verdict.spendRecord).toEqual({ ok: true, spend: N1_SPEND });
    expect(verdict.disclosure).toBe(
      `${HOST_MEMORY_CONFLICT_DISCLOSURE_PREFIX} spend (spend-recommend → spend-ask: resolved)`,
    );
    expect(HOST_MEMORY_EXTERNAL_CONTEXT_FAMILY).toContain("host agent memory");
    expect(HOST_MEMORY_EXTERNAL_CONTEXT_FAMILY).toContain("Warp Drive");
  });

  it("discloses when an explicit utterance token beats host-memory always-ask", () => {
    const verdict = evaluateHostMemorySpendConflict({
      hostMemoryAlwaysAsk: true,
      hostMemoryProvenance: "unsigned",
      utterance: "arc 5318 n=1",
      spendRecommend: null,
    });
    expect(verdict.spendParse).toEqual({ kind: "resolved", spend: N1_SPEND });
    expect(verdict.disclosure).toBe(
      `${HOST_MEMORY_CONFLICT_DISCLOSURE_PREFIX} spend (utterance token → spend-ask: resolved)`,
    );
  });

  it("credits the utterance token when both token and spend-recommend resolve", () => {
    const verdict = evaluateHostMemorySpendConflict({
      hostMemoryAlwaysAsk: true,
      hostMemoryProvenance: "operator-asked",
      utterance: "arc 5318 n=1",
      spendRecommend: N3_SPEND,
    });
    expect(verdict.hostMemoryPersonalAuthority).toBe(false);
    expect(verdict.spendParse).toEqual({ kind: "resolved", spend: N1_SPEND });
    expect(verdict.disclosure).toBe(
      `${HOST_MEMORY_CONFLICT_DISCLOSURE_PREFIX} spend (utterance token → spend-ask: resolved)`,
    );
  });

  it("does not invent disclosure when host memory is silent", () => {
    const verdict = evaluateHostMemorySpendConflict({
      hostMemoryAlwaysAsk: false,
      hostMemoryProvenance: "unsigned",
      utterance: "arc 5318",
      spendRecommend: N1_SPEND,
    });
    expect(verdict.disclosure).toBeNull();
    expect(verdict.spendAsk).toBe("resolved");
  });
});

describe("dualStopSpendSeats (#4705)", () => {
  it("maps used N≥3 permission to spendSeats 3 and leaves N>3 unaddressed", () => {
    expect(dualStopSpendSeats(N1_SPEND)).toBe(1);
    expect(dualStopSpendSeats(N3_SPEND)).toBe(3);
    expect(
      evaluateDualStopPostBudget({
        spendSeats: dualStopSpendSeats(N3_SPEND),
        criticPostsUsed: 0,
        operatorRaisedCap: null,
        afterHandoff: false,
      }).numberedCap,
    ).toBe(3);
    expect(
      evaluateDualStopPostBudget({
        spendSeats: Number(N3_SPEND),
        criticPostsUsed: 0,
        operatorRaisedCap: null,
        afterHandoff: false,
      }).numberedCap,
    ).toBe(0);
    expect(
      evaluateDualStopPostBudget({
        spendSeats: 4,
        criticPostsUsed: 0,
        operatorRaisedCap: null,
        afterHandoff: false,
      }).numberedCap,
    ).toBe(0);
  });
});
