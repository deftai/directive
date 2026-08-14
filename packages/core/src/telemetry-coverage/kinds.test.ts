/**
 * Tests for event-kind ↔ emitter-method mapping (#3362).
 */
import { describe, expect, it } from "vitest";
import {
  ENROLLED_FIELD_FIXTURE_KINDS,
  EVENT_KIND_TO_EMITTER_METHODS,
  isKindEmitterMethod,
  kindForMethod,
  methodsForKind,
  RUN_SUMMARY_EVENT_KINDS,
} from "./kinds.js";

describe("telemetry-coverage kinds (#3362)", () => {
  it("enrolls every schema kind in the shared harness list", () => {
    expect([...ENROLLED_FIELD_FIXTURE_KINDS].sort()).toEqual([...RUN_SUMMARY_EVENT_KINDS].sort());
  });

  it("maps every schema kind to at least one emitter method", () => {
    for (const kind of RUN_SUMMARY_EVENT_KINDS) {
      expect(methodsForKind(kind).length, kind).toBeGreaterThan(0);
      expect(EVENT_KIND_TO_EMITTER_METHODS[kind]).toEqual(methodsForKind(kind));
    }
    expect(methodsForKind("not-a-kind")).toEqual([]);
  });

  it("round-trips method names to kinds and skips the generic emit", () => {
    expect(kindForMethod("emitSessionStart")).toBe("session_start");
    expect(kindForMethod("emitKnownToolTurnDenominator")).toBe("tool_turn_denominator");
    expect(kindForMethod("emitGhostKind")).toBeUndefined();
    expect(isKindEmitterMethod("emitSessionStart")).toBe(true);
    expect(isKindEmitterMethod("emit")).toBe(false);
  });
});
