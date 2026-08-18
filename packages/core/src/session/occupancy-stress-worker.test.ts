import { describe, expect, it } from "vitest";
import { runOccupancyStressRounds } from "./occupancy-stress-worker.js";

describe("occupancy-stress-worker", () => {
  it("exports the child-process stress runner", () => {
    expect(typeof runOccupancyStressRounds).toBe("function");
  });
});
