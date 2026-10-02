import { describe, expect, it } from "vitest";
import {
  acceptDispatchPostcondition,
  commentBindsObligation,
  type EnvelopePostcondition,
} from "./index.js";

describe("dispatch-postcondition barrel (#3979)", () => {
  it("re-exports acceptDispatchPostcondition and fails closed on fabricated handback", () => {
    const postcondition: EnvelopePostcondition = {
      artifactClass: "comment-id",
      obligation: {
        issueNumber: 3979,
        round: 1,
        seatId: "grok",
        inputCeilingCommentId: 100,
      },
    };
    const result = acceptDispatchPostcondition({
      postcondition,
      verification: { kind: "thread", status: "ok", issueNumber: 3979, comments: [] },
      handback: {
        hostSuccess: true,
        claimedCommentId: 5470572756,
        toolCallCount: 0,
      },
    });
    expect(result.accepted).toBe(false);
    expect(result.deliveryStatus).toBe("dispatch-failure");
    expect(result.failClass).toBe("missing");
  });

  it("re-exports commentBindsObligation for obligation-bound critic bodies", () => {
    expect(
      commentBindsObligation(
        {
          id: 200,
          body: "role: critic\nround: 1\nseat: grok\n",
        },
        {
          issueNumber: 3979,
          round: 1,
          seatId: "grok",
          inputCeilingCommentId: 100,
        },
      ),
    ).toBe(true);
  });
});
