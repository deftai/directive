import { describe, expect, it } from "vitest";
import { cadenceIntervalAfterPoll, cadenceIntervals } from "./cadence.js";

describe("cadence branch edges (#448 coverage hairline)", () => {
  it("expands empty cadence to empty intervals", () => {
    expect(cadenceIntervals([])).toEqual([]);
  });

  it("defaults empty cadence after-poll interval to 60s", () => {
    expect(cadenceIntervalAfterPoll(1, [])).toBe(60);
  });

  it("clamps pollIndex below 1 to first interval", () => {
    expect(
      cadenceIntervalAfterPoll(0, [
        [5, 1],
        [30, 1],
      ]),
    ).toBe(5);
    expect(
      cadenceIntervalAfterPoll(-3, [
        [5, 1],
        [30, 1],
      ]),
    ).toBe(5);
  });

  it("repeats final tier once configured repeats are exhausted", () => {
    expect(
      cadenceIntervalAfterPoll(99, [
        [5, 2],
        [30, 1],
      ]),
    ).toBe(30);
  });
});
