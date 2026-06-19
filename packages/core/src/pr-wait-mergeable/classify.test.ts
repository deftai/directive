import { describe, expect, it } from "vitest";
import { classifyMonitorOutcome, parseMonitorPayload } from "./classify.js";
import { EXIT_CONFIG_ERROR, EXIT_MERGED, EXIT_TIMEOUT_OR_ESCALATION } from "./constants.js";

describe("parseMonitorPayload", () => {
  it("returns empty object for blank stdout", () => {
    expect(parseMonitorPayload("")).toEqual({});
    expect(parseMonitorPayload("   ")).toEqual({});
  });

  it("returns empty object for invalid JSON", () => {
    expect(parseMonitorPayload("not-json")).toEqual({});
  });

  it("parses dict payload", () => {
    expect(parseMonitorPayload('{"monitor_result":"CLEAN"}')).toEqual({
      monitor_result: "CLEAN",
    });
  });

  it("returns empty object for non-object JSON", () => {
    expect(parseMonitorPayload("[1,2]")).toEqual({});
  });
});

describe("classifyMonitorOutcome", () => {
  it("maps clean to exit merged path", () => {
    expect(classifyMonitorOutcome(0, {})).toEqual(["clean", EXIT_MERGED]);
  });

  it("maps cap-reached", () => {
    expect(classifyMonitorOutcome(1, {})).toEqual(["cap-reached", EXIT_TIMEOUT_OR_ESCALATION]);
  });

  it("maps config error", () => {
    expect(classifyMonitorOutcome(2, {})).toEqual(["config-error", EXIT_CONFIG_ERROR]);
  });

  it("maps sibling merged", () => {
    const payload = {
      readiness: { partial_data: { merged: true, pr_state: "closed" } },
    };
    expect(classifyMonitorOutcome(3, payload)).toEqual(["merged-by-sibling", EXIT_MERGED]);
  });

  it("maps pr closed without merge", () => {
    const payload = {
      readiness: { partial_data: { merged: false, pr_state: "closed" } },
    };
    expect(classifyMonitorOutcome(3, payload)).toEqual(["pr-closed", EXIT_TIMEOUT_OR_ESCALATION]);
  });

  it("maps unknown monitor exit to config error", () => {
    expect(classifyMonitorOutcome(99, {})).toEqual(["config-error", EXIT_CONFIG_ERROR]);
  });
});
