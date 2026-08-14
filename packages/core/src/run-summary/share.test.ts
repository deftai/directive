import { describe, expect, it } from "vitest";
import { computeRitualGateShare, parseRunSummaryJsonl, readToolTurnDenominator } from "./share.js";
import { RUN_SUMMARY_STDOUT_PREFIX } from "./types.js";

describe("computeRitualGateShare (#3320)", () => {
  it("is unevaluable for an empty stream", () => {
    expect(computeRitualGateShare([])).toEqual({
      evaluable: false,
      ritualGateCount: 0,
      totalToolTurns: null,
      share: null,
    });
  });

  it("computes share from check_invocation count and emitted denominator", () => {
    const share = computeRitualGateShare(
      parseRunSummaryJsonl(
        [
          JSON.stringify({ event: "session_start", session_id: "s1", payload: {} }),
          JSON.stringify({ event: "check_invocation", session_id: "s1", payload: {} }),
          JSON.stringify({ event: "check_invocation", session_id: "s1", payload: {} }),
          JSON.stringify({
            event: "tool_turn_denominator",
            session_id: "s1",
            total_tool_turns: 8,
            payload: { total_tool_turns: 8 },
          }),
        ].join("\n"),
      ),
    );
    expect(share.evaluable).toBe(true);
    expect(share.ritualGateCount).toBe(2);
    expect(share.totalToolTurns).toBe(8);
    expect(share.share).toBe(0.25);
  });

  it("is unevaluable when check counts exist but denominator is absent", () => {
    const share = computeRitualGateShare(
      parseRunSummaryJsonl(
        [
          JSON.stringify({ event: "session_start", session_id: "s1", payload: {} }),
          JSON.stringify({ event: "check_invocation", session_id: "s1", payload: {} }),
          JSON.stringify({ event: "check_invocation", session_id: "s1", payload: {} }),
        ].join("\n"),
      ),
    );
    expect(share.evaluable).toBe(false);
    expect(share.ritualGateCount).toBe(2);
    expect(share.share).toBeNull();
    expect(share.totalToolTurns).toBeNull();
  });

  it("rejects a zero or non-finite denominator instead of inventing a share", () => {
    const zero = computeRitualGateShare(
      parseRunSummaryJsonl(
        JSON.stringify({
          event: "tool_turn_denominator",
          session_id: "s1",
          payload: { total_tool_turns: 0 },
        }),
      ),
    );
    expect(zero.evaluable).toBe(false);
    expect(zero.share).toBeNull();

    const nan = computeRitualGateShare(
      parseRunSummaryJsonl(
        JSON.stringify({
          event: "check_invocation",
          session_id: "s1",
          total_tool_turns: Number.NaN,
          payload: {},
        }),
      ),
    );
    expect(nan.evaluable).toBe(false);
  });

  it("accepts a positive fractional host budget as the share denominator (#3356)", () => {
    const share = computeRitualGateShare(
      parseRunSummaryJsonl(
        JSON.stringify({
          event: "check_invocation",
          session_id: "s1",
          total_tool_turns: 2.5,
          payload: {},
        }),
      ),
    );
    expect(share.evaluable).toBe(true);
    expect(share.totalToolTurns).toBe(2.5);
    expect(share.share).toBe(0.4);
  });

  it("parses DEFT-TLM stdout capture and skips malformed lines", () => {
    const share = computeRitualGateShare(
      parseRunSummaryJsonl(
        [
          "",
          "not-json",
          `${RUN_SUMMARY_STDOUT_PREFIX}${JSON.stringify({ event: "check_invocation", session_id: "s1", payload: {} })}`,
          JSON.stringify({ event: "check_invocation" }),
          JSON.stringify(null),
          JSON.stringify({
            event: "tool_turn_denominator",
            session_id: "s1",
            payload: { total_tool_turns: 5 },
          }),
        ].join("\n"),
      ),
    );
    expect(share.evaluable).toBe(true);
    expect(share.ritualGateCount).toBe(1);
    expect(share.totalToolTurns).toBe(5);
  });

  it("uses the latest session_start and ignores earlier session counts", () => {
    const share = computeRitualGateShare(
      parseRunSummaryJsonl(
        [
          JSON.stringify({ event: "session_start", session_id: "old", payload: {} }),
          JSON.stringify({ event: "check_invocation", session_id: "old", payload: {} }),
          JSON.stringify({ event: "check_invocation", session_id: "old", payload: {} }),
          JSON.stringify({
            event: "tool_turn_denominator",
            session_id: "old",
            payload: { total_tool_turns: 4 },
          }),
          JSON.stringify({ event: "session_start", session_id: "new", payload: {} }),
          JSON.stringify({ event: "check_invocation", session_id: "new", payload: {} }),
          JSON.stringify({
            event: "tool_turn_denominator",
            session_id: "new",
            payload: { total_tool_turns: 10 },
          }),
        ].join("\n"),
      ),
    );
    expect(share.ritualGateCount).toBe(1);
    expect(share.totalToolTurns).toBe(10);
    expect(share.share).toBe(0.1);
  });

  it("reads payload-only denominator and ignores non-object input", () => {
    expect(readToolTurnDenominator(null)).toBeUndefined();
    expect(readToolTurnDenominator(["x"])).toBeUndefined();
    expect(
      readToolTurnDenominator({
        event: "check_invocation",
        session_id: "s",
        payload: { total_tool_turns: 7 },
      }),
    ).toBe(7);
    expect(
      readToolTurnDenominator({
        event: "check_invocation",
        session_id: "s",
        payload: "nope",
      }),
    ).toBeUndefined();
  });
});
