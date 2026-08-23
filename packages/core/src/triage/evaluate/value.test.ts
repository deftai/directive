import { describe, expect, it } from "vitest";
import {
  assertNoReservedClearance,
  buildValueAdvice,
  formatValueField,
  ReservedClearanceError,
} from "./value.js";

describe("value advice", () => {
  it("recommends critique without reserved clearance grammar", () => {
    const advice = buildValueAdvice({
      number: 1,
      state: "open",
      title: "t",
      body: "",
      labels: ["design-critique:mechanism-shaped"],
      htmlUrl: null,
      pullRequest: false,
      duplicateOf: null,
    });
    expect(advice["critique-recommend"]).toBe(true);
    expect(formatValueField(advice)).toContain("critique-recommend: true");
    expect(() =>
      assertNoReservedClearance("design-critique: warranted, because x", "test"),
    ).toThrow(ReservedClearanceError);
  });
});
