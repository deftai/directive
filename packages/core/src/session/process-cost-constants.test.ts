import { describe, expect, it } from "vitest";
import {
  PROCESS_COST_EVENT_NAMES,
  PROCESS_COST_REQUIRED_PAYLOAD,
} from "./process-cost-constants.js";

describe("process-cost-constants (#2994)", () => {
  it("exports registry-compliant process-cost event names", () => {
    const namePattern = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)+$/;
    expect(PROCESS_COST_EVENT_NAMES.sessionStart).toMatch(namePattern);
    expect(PROCESS_COST_EVENT_NAMES.sessionRitualBlocked).toMatch(namePattern);
    expect(PROCESS_COST_EVENT_NAMES.sessionStart).toBe("session:start");
    expect(PROCESS_COST_EVENT_NAMES.sessionRitualBlocked).toBe("session:ritual-blocked");
  });

  it("requires ceremony_tier/duration_ms/exit_code on session:start", () => {
    expect(PROCESS_COST_REQUIRED_PAYLOAD[PROCESS_COST_EVENT_NAMES.sessionStart]).toEqual([
      "ceremony_tier",
      "duration_ms",
      "exit_code",
    ]);
  });

  it("requires tool_name/code on session:ritual-blocked", () => {
    expect(
      PROCESS_COST_REQUIRED_PAYLOAD[PROCESS_COST_EVENT_NAMES.sessionRitualBlocked],
    ).toEqual(["tool_name", "code"]);
  });
});
