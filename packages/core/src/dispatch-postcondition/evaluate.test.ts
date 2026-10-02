import { describe, expect, it } from "vitest";
import {
  acceptDispatchPostcondition,
  commentBindsObligation,
  type EnvelopePostcondition,
  type ParentVerification,
} from "./evaluate.js";

const OBLIGATION = {
  issueNumber: 3979,
  round: 1,
  seatId: "grok",
  inputCeilingCommentId: 5918176420,
} as const;

const POSTCONDITION: EnvelopePostcondition = {
  artifactClass: "comment-id",
  obligation: OBLIGATION,
};

function criticBody(seat: string, round = 1): string {
  return (
    "model: grok-4.5\n" +
    "role: critic\n\n" +
    `round: ${String(round)}\n` +
    `seat: ${seat}\n` +
    "launcher: grok\n\n" +
    "## Findings\nF1 — example\n"
  );
}

function threadOk(
  comments: readonly { id: number; body: string }[],
  issueNumber = 3979,
): ParentVerification {
  return { kind: "thread", status: "ok", issueNumber, comments };
}

describe("commentBindsObligation", () => {
  it("binds critic comments after the ceiling with matching round and seat", () => {
    expect(commentBindsObligation({ id: 5918223700, body: criticBody("grok") }, OBLIGATION)).toBe(
      true,
    );
  });

  it("rejects ceiling-or-earlier ids, wrong seat, wrong round, and non-critic roles", () => {
    expect(
      commentBindsObligation(
        { id: OBLIGATION.inputCeilingCommentId, body: criticBody("grok") },
        OBLIGATION,
      ),
    ).toBe(false);
    expect(commentBindsObligation({ id: 5918223700, body: criticBody("claude") }, OBLIGATION)).toBe(
      false,
    );
    expect(
      commentBindsObligation({ id: 5918223700, body: criticBody("grok", 2) }, OBLIGATION),
    ).toBe(false);
    expect(
      commentBindsObligation(
        {
          id: 5918223700,
          body: "model: grok-4.5\nrole: parent\n\nround: 1\nseat: grok\n",
        },
        OBLIGATION,
      ),
    ).toBe(false);
  });
});

describe("acceptDispatchPostcondition (#3979)", () => {
  it("AC fixture: zero-tool completion with claimed nonexistent artifact fails closed", () => {
    const verdict = acceptDispatchPostcondition({
      postcondition: POSTCONDITION,
      verification: threadOk([]),
      handback: {
        hostSuccess: true,
        claimedCommentId: 5470572756,
        toolCallCount: 0,
        childProbes: {
          command: "gh api repos/deftai/directive/issues/comments/5470572756",
          snippet: '{"id":5470572756,"html_url":"https://github.com/…"}',
        },
      },
    });
    expect(verdict.accepted).toBe(false);
    expect(verdict.deliveryStatus).toBe("dispatch-failure");
    expect(verdict.failClass).toBe("missing");
    expect(verdict.complementaryToolCallCount).toBe(0);
    expect(verdict.reasons.join(" ")).toMatch(/untrusted|dispatch-failure|zero tool/i);
  });

  it("AC fixture: partial-work completion with claimed nonexistent artifact fails closed", () => {
    const verdict = acceptDispatchPostcondition({
      postcondition: POSTCONDITION,
      verification: threadOk([]),
      handback: {
        hostSuccess: true,
        claimedCommentId: 5470174383,
        toolCallCount: 4,
      },
    });
    expect(verdict.accepted).toBe(false);
    expect(verdict.deliveryStatus).toBe("dispatch-failure");
    expect(verdict.failClass).toBe("missing");
    expect(verdict.complementaryToolCallCount).toBe(4);
  });

  it("does not bind on child probes alone when the thread has no matching comment", () => {
    const verdict = acceptDispatchPostcondition({
      postcondition: POSTCONDITION,
      verification: threadOk([]),
      handback: {
        hostSuccess: true,
        claimedCommentId: 5470174383,
        toolCallCount: 4,
        childProbes: { proof_status: "bound", snippet: '{"id":5470174383}' },
      },
    });
    expect(verdict.accepted).toBe(false);
    expect(verdict.deliveryStatus).toBe("dispatch-failure");
  });

  it("accepts when a parent-fetched obligation-bound critic comment exists", () => {
    const verdict = acceptDispatchPostcondition({
      postcondition: POSTCONDITION,
      verification: threadOk([
        { id: 5918176420, body: "role: parent\npanel-deposit\n" },
        { id: 5918223700, body: criticBody("grok") },
      ]),
      handback: { hostSuccess: true, claimedCommentId: 5918223700, toolCallCount: 38 },
    });
    expect(verdict).toMatchObject({
      accepted: true,
      deliveryStatus: "verified",
      failClass: "none",
      boundCommentId: 5918223700,
      complementaryToolCallCount: 38,
    });
  });

  it("shape-2 zero tools never overrides a failed postcondition, and never alone accepts", () => {
    const missing = acceptDispatchPostcondition({
      postcondition: POSTCONDITION,
      verification: threadOk([]),
      handback: { hostSuccess: true, toolCallCount: 0 },
    });
    expect(missing.accepted).toBe(false);

    const verified = acceptDispatchPostcondition({
      postcondition: POSTCONDITION,
      verification: threadOk([{ id: 5918223700, body: criticBody("grok") }]),
      handback: { hostSuccess: true, toolCallCount: 0 },
    });
    expect(verified.accepted).toBe(true);
    expect(verified.complementaryToolCallCount).toBe(0);
  });

  it("unknown/unavailable parent reads never accept delivery", () => {
    const verdict = acceptDispatchPostcondition({
      postcondition: POSTCONDITION,
      verification: {
        kind: "thread",
        status: "unavailable",
        reason: "HTTP 503",
      },
      handback: { hostSuccess: true, claimedCommentId: 5918223700, toolCallCount: 4 },
    });
    expect(verdict.accepted).toBe(false);
    expect(verdict.deliveryStatus).toBe("unverifiable");
    expect(verdict.failClass).toBe("unavailable");
    expect(verdict.reasons.join(" ")).toMatch(/never accepts/i);
  });

  it("wrong-issue verification is mismatch", () => {
    const wrongIssue = acceptDispatchPostcondition({
      postcondition: POSTCONDITION,
      verification: threadOk([{ id: 5918223700, body: criticBody("grok") }], 3961),
      handback: { hostSuccess: true, claimedCommentId: 5918223700 },
    });
    expect(wrongIssue).toMatchObject({
      accepted: false,
      deliveryStatus: "dispatch-failure",
      failClass: "mismatch",
    });
  });

  it("repeat dispatch: nonexistent claim does not credit an earlier matching comment", () => {
    const staleClaim = acceptDispatchPostcondition({
      postcondition: POSTCONDITION,
      verification: threadOk([{ id: 5918223700, body: criticBody("grok") }]),
      handback: { hostSuccess: true, claimedCommentId: 5470174383, toolCallCount: 0 },
    });
    expect(staleClaim).toMatchObject({
      accepted: false,
      deliveryStatus: "dispatch-failure",
      failClass: "mismatch",
      boundCommentId: null,
      complementaryToolCallCount: 0,
    });
    expect(staleClaim.reasons.join(" ")).toMatch(/earlier matching|nonexistent|untrusted/i);
  });

  it("binds boundCommentId to the verified claimed id when multiple comments match", () => {
    const verdict = acceptDispatchPostcondition({
      postcondition: POSTCONDITION,
      verification: threadOk([
        { id: 5918223700, body: criticBody("grok") },
        { id: 5918299614, body: criticBody("grok") },
      ]),
      handback: { hostSuccess: true, claimedCommentId: 5918299614, toolCallCount: 12 },
    });
    expect(verdict).toMatchObject({
      accepted: true,
      deliveryStatus: "verified",
      boundCommentId: 5918299614,
      complementaryToolCallCount: 12,
    });
  });

  it("old-round and parent-comment artifacts do not satisfy the seat obligation", () => {
    const oldRound = acceptDispatchPostcondition({
      postcondition: POSTCONDITION,
      verification: threadOk([{ id: 5918223700, body: criticBody("grok", 2) }]),
      handback: { hostSuccess: true, claimedCommentId: 5918223700 },
    });
    expect(oldRound.failClass).toBe("missing");

    const parentComment = acceptDispatchPostcondition({
      postcondition: POSTCONDITION,
      verification: threadOk([
        {
          id: 5918223700,
          body: "model: grok-4.5\nrole: parent\n\nround: 1\nseat: grok\n",
        },
      ]),
      handback: { hostSuccess: true, claimedCommentId: 5918223700 },
    });
    expect(parentComment.failClass).toBe("missing");
  });
});
