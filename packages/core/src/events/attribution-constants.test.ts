import { describe, expect, it } from "vitest";
import {
  ALL_ATTRIBUTION_EVENT_NAMES,
  ATTRIBUTION_EVENT_NAMES,
  ATTRIBUTION_REQUIRED_PAYLOAD,
} from "./attribution-constants.js";

describe("attribution constants", () => {
  it("registers required payload keys for every attribution event name", () => {
    for (const name of ALL_ATTRIBUTION_EVENT_NAMES) {
      expect(ATTRIBUTION_REQUIRED_PAYLOAD[name]?.length).toBeGreaterThan(0);
      expect(ATTRIBUTION_REQUIRED_PAYLOAD[name]).toContain("signal_class");
    }
    expect(ALL_ATTRIBUTION_EVENT_NAMES).toContain(ATTRIBUTION_EVENT_NAMES.valueGateCatch);
  });
});
