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

  it("does not parse a non-string sequence_kind as a sequence (#4843)", () => {
    const base = {
      sequence_id: "undefined",
      entries: [{ id: "m0-gap", kind: "story" as const, issue: 285 }],
    };
    for (const sequence_kind of [undefined, null, 1, { k: "delivery" }, false]) {
      expect(() => parsePlanSequence({ ...base, sequence_kind })).toThrow(
        /plan-sequence: sequence_kind required/,
      );
    }
    expect(parsePlanSequence({ ...base, sequence_kind: "" }).sequence_kind).toBe("");
  });
});
