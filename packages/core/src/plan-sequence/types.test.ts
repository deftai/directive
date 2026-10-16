import { describe, expect, it } from "vitest";
import {
  advancePlanSequence,
  createPlanSequence,
  isClosedPlanSequenceShape,
  parsePlanSequence,
} from "./types.js";

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

  it("create/parse/advance round-trip generation and source_revision (#3907)", () => {
    const created = createPlanSequence({
      sequence_id: "g",
      sequence_kind: "delivery",
      authorized_by: "t",
      entries: [
        { id: "a", kind: "pr" },
        { id: "b", kind: "pr" },
      ],
      source_revision: "base",
    });
    expect(created.generation).toBe(0);
    expect(created.source_revision).toBe("base");
    const advanced = advancePlanSequence(created);
    expect(advanced.generation).toBe(1);
    expect(advanced.source_revision).toBe("base");
    const parsed = parsePlanSequence({
      ...advanced,
      generation: 4,
      source_revision: "deadbeef",
    });
    expect(parsed.generation).toBe(4);
    expect(parsed.source_revision).toBe("deadbeef");
    const { generation, ...withoutGeneration } = created;
    expect(generation).toBe(0);
    expect(parsePlanSequence(withoutGeneration).generation).toBe(0);
    expect(isClosedPlanSequenceShape(created)).toBe(true);
    expect(isClosedPlanSequenceShape(JSON.parse(JSON.stringify(parsed)) as unknown)).toBe(true);
    expect(isClosedPlanSequenceShape({ ...created, extra_authority: true })).toBe(false);
    expect(parsePlanSequence({ ...created, generation: -1 }).generation).toBe(0);
    expect(parsePlanSequence({ ...created, generation: 1.5 }).generation).toBe(0);
    expect(() =>
      parsePlanSequence({ sequence_id: "x", sequence_kind: "delivery", entries: [null] }),
    ).toThrow(/entries\[0\] must be an object/);
    expect(() =>
      parsePlanSequence({
        sequence_id: "x",
        sequence_kind: "delivery",
        entries: [{ kind: "pr" }],
      }),
    ).toThrow(/requires id and kind/);
  });
});
