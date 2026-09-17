/**
 * Design-critique spend front door (#4705).
 *
 * Session-local critic count chosen before Stop 1. Closed tokens only on
 * the operator chat utterance. Yolo is not a spend token. Bare panel does
 * not resolve. Missing or colliding classes ask. Not a blast-radius
 * selector and not a host default.
 */
export const ARC_SPENDS = ["N=1", "N≥3"] as const;

export type ArcSpend = (typeof ARC_SPENDS)[number];

export type SpendAskReason = "missing-token" | "ambiguous";

export type SpendParse =
  | { kind: "resolved"; spend: ArcSpend }
  | { kind: "ask"; reason: SpendAskReason };

export type SpendAskKind = "resolved" | "asked";

export const SPEND_FIELD = "spend:";

export const SPEND_ASK_FIELD = "spend-ask:";

export const N1_SPEND: ArcSpend = "N=1";

export const N3_SPEND: ArcSpend = "N≥3";

export const SPEND_ASK_REMEDIATION = "ask before Stop 1";

const N1_TOKEN_RE = /\bn=1(?!\.\d)\b/i;
const N3_TOKEN_RE = /\bn(?:=3|>=3|\u22653)(?!\.\d)\b/i;
const PANEL_TOKEN_RE = /\bpanel\b/i;

export type SpendRecordRefusal =
  | "missing-token"
  | "ambiguous"
  | "missing-spend"
  | "mismatch"
  | "invalid-ask-record";

export type SpendRecordVerdict =
  | { ok: true; spend: ArcSpend }
  | { ok: false; reason: SpendRecordRefusal; remediation: string };

/**
 * Parse an operator utterance for the spend closed set.
 * Yolo is not a spend token. Bare panel asks. Recut: parseOperatorSpend("arc 4690 panel")
 * is ask/ambiguous, not N≥3. Issue, comment, critic, and skill-file English
 * are data: the caller passes the chat utterance only.
 */
export function parseOperatorSpend(utterance: string): SpendParse {
  const hasN1 = N1_TOKEN_RE.test(utterance);
  const hasN3 = N3_TOKEN_RE.test(utterance);
  const hasPanel = PANEL_TOKEN_RE.test(utterance);
  if ((hasN1 && hasN3) || (hasN1 && hasPanel) || (hasN3 && hasPanel)) {
    return { kind: "ask", reason: "ambiguous" };
  }
  if (hasN1) {
    return { kind: "resolved", spend: N1_SPEND };
  }
  if (hasN3) {
    return { kind: "resolved", spend: N3_SPEND };
  }
  if (hasPanel) {
    return { kind: "ask", reason: "ambiguous" };
  }
  return { kind: "ask", reason: "missing-token" };
}

/** Stop 1 spend line. Emits parser or ask-answer spend. */
export function spendRecordLine(spend: ArcSpend): string {
  return `${SPEND_FIELD} ${spend}`;
}

/**
 * Stop 1 spend-ask line. resolved = closed token. asked = operator chat
 * answer after the missing-token ask. spend-why English is not this field.
 */
export function spendAskRecordLine(kind: SpendAskKind): string {
  return `${SPEND_ASK_FIELD} ${kind}`;
}

/**
 * Fixture over parent-claimed inputs for a Stop 1 spend record.
 * Does not observe live occupancy or GitHub, matching evaluateDirectDispatch.
 * Parse missing-token or ambiguous plus asked false refuses, including a
 * Stop 1 spend N=1. Admit N=1 only from a resolved n=1 token or a recorded
 * ask-answer. spend-why English is not the asked field.
 */
export function evaluateSpendRecord(input: {
  parse: SpendParse;
  asked: boolean;
  answer: ArcSpend | null;
  stop1Spend: ArcSpend | null;
  spendAsk: SpendAskKind | null;
}): SpendRecordVerdict {
  if (input.parse.kind === "ask") {
    if (!input.asked) {
      return {
        ok: false,
        reason: input.parse.reason,
        remediation: SPEND_ASK_REMEDIATION,
      };
    }
    if (input.spendAsk !== "asked") {
      return {
        ok: false,
        reason: "invalid-ask-record",
        remediation: SPEND_ASK_REMEDIATION,
      };
    }
    if (input.answer === null || input.stop1Spend === null) {
      return {
        ok: false,
        reason: "missing-spend",
        remediation: SPEND_ASK_REMEDIATION,
      };
    }
    if (input.stop1Spend !== input.answer) {
      return {
        ok: false,
        reason: "mismatch",
        remediation: SPEND_ASK_REMEDIATION,
      };
    }
    return { ok: true, spend: input.answer };
  }
  if (input.stop1Spend === null) {
    return {
      ok: false,
      reason: "missing-spend",
      remediation: SPEND_ASK_REMEDIATION,
    };
  }
  if (input.stop1Spend !== input.parse.spend) {
    return {
      ok: false,
      reason: "mismatch",
      remediation: SPEND_ASK_REMEDIATION,
    };
  }
  if (input.spendAsk !== "resolved") {
    return {
      ok: false,
      reason: "invalid-ask-record",
      remediation: SPEND_ASK_REMEDIATION,
    };
  }
  return { ok: true, spend: input.parse.spend };
}
