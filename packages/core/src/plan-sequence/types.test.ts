import { describe, expect, it } from "vitest";
import { createPlanSequence, parsePlanSequence } from "./types.js";

describe("plan-sequence types", () => {
  it("rejects empty entries", () => {
    expect(() =>
      createPlanSequence({
        sequence_id: "x",
        sequence_kind: "delivery",
        authorized_by: "t",
        entries: [],
      }),
    ).toThrow(/non-empty/);
  });

  it("parsePlanSequence requires sequence_id", () => {
    expect(() =>
      parsePlanSequence({ sequence_kind: "delivery", entries: [{ id: "a", kind: "pr" }] }),
    ).toThrow(/sequence_id/);
  });
});
