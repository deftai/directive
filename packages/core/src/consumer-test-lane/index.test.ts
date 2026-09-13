import { describe, expect, it } from "vitest";
import * as lane from "./index.js";

describe("consumer-test-lane index re-exports (#4386)", () => {
  it("exports evaluate and the gate id", () => {
    expect(typeof lane.evaluate).toBe("function");
    expect(lane.CONSUMER_TEST_LANE_GATE_ID).toBe("verify:consumer-test-lane");
  });
});
