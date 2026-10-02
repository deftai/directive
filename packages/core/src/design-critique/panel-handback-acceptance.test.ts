import { describe, expect, it } from "vitest";
import type { ThreadComment } from "./completed-arc-record.js";
import {
  evaluatePanelSeatDelivery,
  evaluatePanelSeatDeliveryFromThread,
  latestPanelDeposit,
  parsePanelDeposit,
} from "./panel-handback-acceptance.js";

const CEILING = 5918176420;

function deposit(id = CEILING): ThreadComment {
  return {
    id,
    body:
      "model: grok-4.5\nrole: parent\n\n" +
      "panel-deposit\n" +
      "round: 1\n" +
      "siblings: 3\n" +
      `input-ceiling: ${String(id)}\n` +
      "families: grok, claude, codex\n" +
      "seat: grok launcher: grok\n" +
      "seat: claude launcher: claude\n" +
      "seat: codex launcher: codex\n",
  };
}

function critic(id: number, seat: string): ThreadComment {
  return {
    id,
    body: `model: ${seat}\nrole: critic\n\nround: 1\nseat: ${seat}\n## Findings\nok\n`,
  };
}

function familiesOnlyDeposit(id = CEILING): ThreadComment {
  return {
    id,
    body:
      "model: grok-4.5\nrole: parent\n\n" +
      "panel-deposit\n" +
      "round: 1\n" +
      "siblings: 3\n" +
      `input-ceiling: ${String(id)}\n` +
      "families: grok, claude, codex\n",
  };
}

describe("parsePanelDeposit / latestPanelDeposit", () => {
  it("reads round, ceiling, siblings, and seat ids from the deposit", () => {
    const parsed = parsePanelDeposit(deposit());
    expect(parsed).toEqual({
      commentId: CEILING,
      round: 1,
      inputCeilingCommentId: CEILING,
      siblings: 3,
      seatIds: ["grok", "claude", "codex"],
    });
    expect(latestPanelDeposit([deposit(10), deposit(CEILING)])?.commentId).toBe(CEILING);
  });

  it("reads seat ids from families: when the deposit has no seat: lines", () => {
    expect(parsePanelDeposit(familiesOnlyDeposit())?.seatIds).toEqual(["grok", "claude", "codex"]);
  });
});

describe("evaluatePanelSeatDelivery (#3979 panel consumption)", () => {
  it("does not count fabricated handbacks as posted same-round siblings", () => {
    const verdict = evaluatePanelSeatDelivery({
      issueNumber: 3979,
      round: 1,
      inputCeilingCommentId: CEILING,
      expectedSeats: [{ seatId: "grok" }, { seatId: "claude" }, { seatId: "codex" }],
      verification: {
        kind: "thread",
        status: "ok",
        issueNumber: 3979,
        comments: [
          { id: CEILING, body: deposit().body },
          { id: 5918223700, body: critic(5918223700, "claude").body },
          { id: 5918226494, body: critic(5918226494, "codex").body },
        ],
      },
      handbacks: [
        {
          seatId: "grok",
          hostSuccess: true,
          claimedCommentId: 5470572756,
          toolCallCount: 0,
        },
        { seatId: "claude", hostSuccess: true, claimedCommentId: 5918223700, toolCallCount: 40 },
        { seatId: "codex", hostSuccess: true, claimedCommentId: 5918226494, toolCallCount: 38 },
      ],
    });

    expect(verdict.verifiedPostedSeatIds).toEqual(["claude", "codex"]);
    expect(verdict.dispatchFailedSeatIds).toEqual(["grok"]);
    expect(verdict.allExpectedVerified).toBe(false);
    const grok = verdict.rows.find((row) => row.seatId === "grok");
    expect(grok?.countsAsPostedSibling).toBe(false);
    expect(grok?.verdict.deliveryStatus).toBe("dispatch-failure");
  });

  it("partial-work nonexistent artifact handback fails closed on the panel path", () => {
    const verdict = evaluatePanelSeatDeliveryFromThread({
      issueNumber: 3979,
      comments: [deposit()],
      handbacks: [
        {
          seatId: "grok",
          hostSuccess: true,
          claimedCommentId: 5470174383,
          toolCallCount: 4,
        },
      ],
    });
    expect(verdict).not.toBeNull();
    expect(verdict?.verifiedPostedSeatIds).toEqual([]);
    expect(verdict?.dispatchFailedSeatIds).toContain("grok");
    expect(verdict?.rows.every((row) => !row.countsAsPostedSibling)).toBe(true);
  });

  it("unavailable thread reads leave seats unverifiable and unposted", () => {
    const verdict = evaluatePanelSeatDeliveryFromThread({
      issueNumber: 3979,
      comments: [deposit(), critic(5918223700, "grok")],
      verificationStatus: "unavailable",
      unavailableReason: "rate limited",
      handbacks: [
        { seatId: "grok", hostSuccess: true, claimedCommentId: 5918223700 },
        { seatId: "claude", hostSuccess: true, claimedCommentId: 1 },
        { seatId: "codex", hostSuccess: true, claimedCommentId: 2 },
      ],
    });
    expect(verdict?.unverifiableSeatIds).toEqual(["grok", "claude", "codex"]);
    expect(verdict?.verifiedPostedSeatIds).toEqual([]);
  });

  it("unavailable read with a missing handback stays unverifiable (not dispatch-failure)", () => {
    const verdict = evaluatePanelSeatDeliveryFromThread({
      issueNumber: 3979,
      comments: [deposit()],
      verificationStatus: "unavailable",
      unavailableReason: "rate limited",
      handbacks: [{ seatId: "claude", hostSuccess: true, claimedCommentId: 1 }],
    });
    expect(verdict?.unverifiableSeatIds).toEqual(["grok", "claude", "codex"]);
    expect(verdict?.dispatchFailedSeatIds).toEqual([]);
    expect(verdict?.verifiedPostedSeatIds).toEqual([]);
  });

  it("does not let child handbacks shrink the expected seat set", () => {
    const verdict = evaluatePanelSeatDeliveryFromThread({
      issueNumber: 3979,
      comments: [familiesOnlyDeposit()],
      handbacks: [
        {
          seatId: "grok",
          hostSuccess: true,
          claimedCommentId: 5470572756,
          toolCallCount: 0,
        },
      ],
    });
    expect(verdict).not.toBeNull();
    expect(verdict?.rows.map((row) => row.seatId)).toEqual(["grok", "claude", "codex"]);
    expect(verdict?.allExpectedVerified).toBe(false);
    expect(verdict?.dispatchFailedSeatIds).toEqual(["grok", "claude", "codex"]);
  });

  it("counts only obligation-bound parent reads when all seats posted", () => {
    const comments = [
      deposit(),
      critic(5918223700, "grok"),
      critic(5918226494, "codex"),
      critic(5918299614, "claude"),
    ];
    const verdict = evaluatePanelSeatDeliveryFromThread({
      issueNumber: 3979,
      comments,
      handbacks: [
        { seatId: "grok", hostSuccess: true, claimedCommentId: 5918223700 },
        { seatId: "claude", hostSuccess: true, claimedCommentId: 5918299614 },
        { seatId: "codex", hostSuccess: true, claimedCommentId: 5918226494 },
      ],
    });
    expect(verdict?.allExpectedVerified).toBe(true);
    expect(new Set(verdict?.verifiedPostedSeatIds)).toEqual(new Set(["grok", "claude", "codex"]));
  });

  it("families-only deposits still verify handbacks (no null skip)", () => {
    const verdict = evaluatePanelSeatDeliveryFromThread({
      issueNumber: 3979,
      comments: [familiesOnlyDeposit()],
      handbacks: [
        {
          seatId: "grok",
          hostSuccess: true,
          claimedCommentId: 5470572756,
          toolCallCount: 0,
        },
      ],
    });
    expect(verdict).not.toBeNull();
    expect(verdict?.dispatchFailedSeatIds).toContain("grok");
    expect(verdict?.verifiedPostedSeatIds).toEqual([]);
  });

  it("missing handback does not count an earlier matching comment as delivered", () => {
    const verdict = evaluatePanelSeatDelivery({
      issueNumber: 3979,
      round: 1,
      inputCeilingCommentId: CEILING,
      expectedSeats: [{ seatId: "grok" }, { seatId: "claude" }],
      verification: {
        kind: "thread",
        status: "ok",
        issueNumber: 3979,
        comments: [
          { id: CEILING, body: deposit().body },
          { id: 5918223700, body: critic(5918223700, "grok").body },
          { id: 5918299614, body: critic(5918299614, "claude").body },
        ],
      },
      handbacks: [{ seatId: "claude", hostSuccess: true, claimedCommentId: 5918299614 }],
    });
    expect(verdict.verifiedPostedSeatIds).toEqual(["claude"]);
    expect(verdict.dispatchFailedSeatIds).toContain("grok");
    const grok = verdict.rows.find((row) => row.seatId === "grok");
    expect(grok?.countsAsPostedSibling).toBe(false);
    expect(grok?.verdict.failClass).toBe("missing");
  });

  it("repeat dispatch: nonexistent handback claim does not credit earlier matching comment", () => {
    const verdict = evaluatePanelSeatDelivery({
      issueNumber: 3979,
      round: 1,
      inputCeilingCommentId: CEILING,
      expectedSeats: [{ seatId: "grok" }, { seatId: "claude" }],
      verification: {
        kind: "thread",
        status: "ok",
        issueNumber: 3979,
        comments: [
          { id: CEILING, body: deposit().body },
          { id: 5918223700, body: critic(5918223700, "grok").body },
          { id: 5918299614, body: critic(5918299614, "claude").body },
        ],
      },
      handbacks: [
        {
          seatId: "grok",
          hostSuccess: true,
          claimedCommentId: 5470572756,
          toolCallCount: 0,
        },
        { seatId: "claude", hostSuccess: true, claimedCommentId: 5918299614 },
      ],
    });
    expect(verdict.verifiedPostedSeatIds).toEqual(["claude"]);
    expect(verdict.dispatchFailedSeatIds).toContain("grok");
    const grok = verdict.rows.find((row) => row.seatId === "grok");
    expect(grok?.countsAsPostedSibling).toBe(false);
    expect(grok?.verdict.accepted).toBe(false);
    expect(grok?.verdict.failClass).toBe("mismatch");
  });
});
